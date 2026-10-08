// Ported from T3 Code v0.0.45 apps/server/src/mcp/toolkits/pullRequests/tools.ts and McpHttpServer.ts.
use super::*;
use crate::{
    AgentTools, Registration, ToolContext, ToolResult,
    codex::tools::{self as adapter, Caller},
    tool_bridge::{BridgeOperation, BridgeServer, Envelope, mcp_result},
    tools::{AGENT_TOOL_GUIDANCE, Action, EXECUTION_TIMEOUT_SECONDS, PR_TOOL_GUIDANCE, Registry},
};
use sha2::{Digest, Sha256};
use tokio::task::{AbortHandle, JoinSet};
#[cfg(test)]
mod tests;

const MAX_JOBS: usize = 8;
const MAX_CALLS_PER_TURN: usize = 1024;
const DECLARATION_KEY: &str = "agent-tools.dynamic.";

struct Scope {
    thread: ThreadId,
    epoch: u64,
}
pub(super) enum ToolReply {
    Dynamic {
        request: Value,
    },
    Mcp {
        credential: String,
        reply: oneshot::Sender<Result<Value>>,
    },
}
impl ToolReply {
    fn is_closed(&self) -> bool {
        match self {
            Self::Mcp { reply, .. } => reply.is_closed(),
            Self::Dynamic { .. } => false,
        }
    }
    async fn closed(&mut self) {
        match self {
            Self::Mcp { reply, .. } => reply.closed().await,
            Self::Dynamic { .. } => std::future::pending().await,
        }
    }
}
type CallKey = (ThreadId, TurnId, String);
pub(super) struct ToolCompletion {
    context: ToolContext,
    caller: Caller,
    reply: ToolReply,
    result: ToolResult,
}
pub(super) struct ToolWork {
    registry: Registry,
    registration: Registration,
    server: Option<BridgeServer>,
    pub incoming: mpsc::Receiver<Envelope>,
    pub jobs: JoinSet<ToolCompletion>,
    running: HashMap<CallKey, AbortHandle>,
    credentials: HashMap<String, Scope>,
    sessions: HashMap<ThreadId, String>,
    declarations: BTreeMap<String, String>,
    fingerprint: String,
    seen: HashMap<ThreadId, (TurnId, HashSet<String>)>,
}
impl ToolWork {
    pub fn new(config: &RuntimeConfig, tools: AgentTools, store: &Store) -> Result<Self> {
        let registry = Registry::new(tools.backend)?;
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&registry.specs)?));
        let (server, incoming) = match tools.registration {
            Registration::Stdio { .. } => {
                let (server, incoming) = BridgeServer::open(&config.data_dir)?;
                (Some(server), incoming)
            }
            Registration::Dynamic => (None, mpsc::channel(1).1),
        };
        let declarations = store
            .ui_state()?
            .into_iter()
            .filter_map(|(key, value)| {
                key.strip_prefix(DECLARATION_KEY)
                    .map(|native| (native.to_owned(), value))
            })
            .collect();
        Ok(Self {
            registry,
            registration: tools.registration,
            server,
            incoming,
            jobs: JoinSet::new(),
            running: HashMap::new(),
            credentials: HashMap::new(),
            sessions: HashMap::new(),
            declarations,
            fingerprint,
            seen: HashMap::new(),
        })
    }
    fn config(&mut self, thread: &ThreadId, epoch: u64) -> Option<Value> {
        let Registration::Stdio { executable } = &self.registration else {
            return None;
        };
        let credential = self.sessions.entry(thread.clone()).or_insert_with(|| {
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
        });
        self.credentials
            .entry(credential.clone())
            .or_insert_with(|| Scope {
                thread: thread.clone(),
                epoch,
            });
        Some(adapter::stdio_config(
            executable,
            &self.server.as_ref().unwrap().path(),
            credential,
            &self.registry.specs,
        ))
    }
    pub fn guidance(&self, native: &str) -> Option<&'static str> {
        if matches!(self.registration, Registration::Dynamic)
            && self.declarations.get(native) != Some(&self.fingerprint)
        {
            return None;
        }
        Some(
            if self
                .registry
                .specs
                .iter()
                .any(|spec| spec.name.starts_with("preview_"))
            {
                AGENT_TOOL_GUIDANCE
            } else {
                PR_TOOL_GUIDANCE
            },
        )
    }
    pub fn revoke(&mut self) {
        self.jobs.abort_all();
        self.running.clear();
        self.credentials.clear();
        self.sessions.clear();
        self.seen.clear();
    }
    pub fn cancel_thread(&mut self, thread: &ThreadId) {
        self.running.retain(|(id, _, _), abort| {
            if id != thread {
                return true;
            }
            abort.abort();
            false
        });
    }
    pub fn cancel_turn(&mut self, thread: &ThreadId, turn: &TurnId) {
        self.running.retain(|(id, target, _), abort| {
            if id != thread || target != turn {
                return true;
            }
            abort.abort();
            false
        });
    }
}
impl Owner {
    pub(super) fn tools_thread_params(
        &mut self,
        thread: &ThreadId,
        params: &mut Value,
        creating: bool,
    ) {
        match &self.tools.registration {
            Registration::Dynamic if creating => {
                params["dynamicTools"] = adapter::dynamic_specs(&self.tools.registry.specs)
            }
            Registration::Dynamic => {}
            Registration::Stdio { .. } => {
                params["config"] = self.tools.config(thread, self.epoch).unwrap();
            }
        }
    }
    pub(super) fn tools_prepared(&mut self, native: &str, created: bool) -> Result<()> {
        if created && matches!(self.tools.registration, Registration::Dynamic) {
            self.store.set_ui_state(
                &format!("{DECLARATION_KEY}{native}"),
                Some(&self.tools.fingerprint),
            )?;
            self.tools
                .declarations
                .insert(native.into(), self.tools.fingerprint.clone());
        }
        Ok(())
    }
    pub(super) fn tools_forked(
        &mut self,
        source: Option<&str>,
        native: Option<&str>,
    ) -> Result<()> {
        if let (Some(source), Some(native)) = (source, native)
            && let Some(declaration) = self.tools.declarations.get(source).cloned()
        {
            self.store
                .set_ui_state(&format!("{DECLARATION_KEY}{native}"), Some(&declaration))?;
            self.tools.declarations.insert(native.into(), declaration);
        }
        Ok(())
    }
    fn tool_context(&self, thread: &ThreadId, epoch: u64, caller: &Caller) -> Result<ToolContext> {
        if epoch != self.epoch || self.provider.is_none() {
            return Err(AppError::new(
                "tool_expired",
                "This tool session expired after Codex restarted.",
            ));
        }
        let target = self.thread(thread)?;
        if target.native_thread_id.as_deref() != Some(caller.native_thread.as_str())
            || matches!(target.session, SessionState::Interrupting)
        {
            return Err(AppError::new(
                "tool_scope",
                "Tool call does not belong to this live conversation.",
            ));
        }
        let turn = target
            .turns
            .iter()
            .rev()
            .find(|turn| turn.execution.active())
            .filter(|turn| turn.native_turn_id.as_deref() == Some(caller.native_turn.as_str()))
            .ok_or_else(|| {
                AppError::new(
                    "tool_turn",
                    "Tool call does not belong to the active acknowledged turn.",
                )
            })?;
        Ok(ToolContext {
            thread_id: thread.clone(),
            turn_id: turn.id.clone(),
            session_epoch: epoch,
            call_id: caller.call_id.clone(),
        })
    }
    pub(super) async fn dynamic_tool(&mut self, request: Value, params: Value) -> Result<()> {
        let (caller, call) = match adapter::dynamic_call(params) {
            Ok(decoded) => decoded,
            Err(problem) => {
                if let Some(provider) = &self.provider {
                    provider.invalid_request(request, &problem.message).await?;
                }
                return Ok(());
            }
        };
        let target = self
            .threads
            .values()
            .find(|thread| {
                thread.native_thread_id.as_deref() == Some(caller.native_thread.as_str())
            })
            .map(|thread| thread.id.clone());
        let reply = ToolReply::Dynamic { request };
        let context = match target
            .and_then(|thread| self.tool_context(&thread, self.epoch, &caller).ok())
        {
            Some(context)
                if matches!(self.tools.registration, Registration::Dynamic)
                    && self.tools.declarations.get(&caller.native_thread)
                        == Some(&self.tools.fingerprint) =>
            {
                context
            }
            _ => return self
                .send_tool_result(
                    reply,
                    ToolResult::failure(
                        "This dynamic tool call is outside its registered live thread and turn.",
                    ),
                )
                .await,
        };
        self.dispatch_tool(context, caller, call, reply).await
    }
    pub(super) async fn mcp_tool(&mut self, envelope: Envelope) -> Result<()> {
        let Envelope { request, reply } = envelope;
        let Some(scope) = self
            .tools
            .credentials
            .get(&request.credential)
            .filter(|scope| scope.epoch == self.epoch)
        else {
            let _ = reply.send(Err(AppError::new(
                "tool_expired",
                "Agent tool credential expired or is unknown.",
            )));
            return Ok(());
        };
        let thread = scope.thread.clone();
        let epoch = scope.epoch;
        match request.operation {
            BridgeOperation::List => {
                let result = self
                    .thread(&thread)
                    .map(|_| json!({"tools":self.tools.registry.specs}));
                let _ = reply.send(result);
                Ok(())
            }
            BridgeOperation::Call { caller, call } => {
                let reply = ToolReply::Mcp {
                    credential: request.credential,
                    reply,
                };
                match self.tool_context(&thread, epoch, &caller) {
                    Ok(context) => self.dispatch_tool(context, caller, call, reply).await,
                    Err(problem) => {
                        self.send_tool_result(reply, ToolResult::failure(problem.message))
                            .await
                    }
                }
            }
        }
    }
    async fn dispatch_tool(
        &mut self,
        context: ToolContext,
        caller: Caller,
        call: crate::ToolCall,
        reply: ToolReply,
    ) -> Result<()> {
        if reply.is_closed() {
            return Ok(());
        }
        let seen = self
            .tools
            .seen
            .entry(context.thread_id.clone())
            .or_insert_with(|| (context.turn_id.clone(), HashSet::new()));
        if seen.0 != context.turn_id {
            *seen = (context.turn_id.clone(), HashSet::new());
        }
        if seen.1.len() >= MAX_CALLS_PER_TURN || !seen.1.insert(context.call_id.clone()) {
            return self
                .send_tool_result(
                    reply,
                    ToolResult::failure(
                        "Duplicate tool call or this turn's tool call limit was reached.",
                    ),
                )
                .await;
        }
        let action = match self.tools.registry.decode(call) {
            Ok(action) => action,
            Err(problem) => {
                return self
                    .send_tool_result(reply, ToolResult::failure(problem.message))
                    .await;
            }
        };
        match action {
            Action::Preview(call) => {
                if self.tools.jobs.len() >= MAX_JOBS {
                    return self
                        .send_tool_result(
                            reply,
                            ToolResult::failure(
                                "The preview has eight active calls. Wait for one to finish.",
                            ),
                        )
                        .await;
                }
                let backend = self.tools.registry.backend.as_ref().unwrap().clone();
                let key = (
                    context.thread_id.clone(),
                    context.turn_id.clone(),
                    context.call_id.clone(),
                );
                let abort = self.tools.jobs.spawn(async move {
                    let mut reply = reply;
                    if reply.is_closed() { return ToolCompletion { context, caller, reply, result:ToolResult::failure("The tool caller disconnected.") } }
                    let result = tokio::select! {
                        result = tokio::time::timeout(Duration::from_secs(EXECUTION_TIMEOUT_SECONDS), backend.execute(context.clone(), call)) => match result {
                            Ok(Ok(result)) => result.bounded(),
                            Ok(Err(problem)) => ToolResult::failure(problem.message),
                            Err(_) => ToolResult::failure(format!("Preview tool timed out after {EXECUTION_TIMEOUT_SECONDS} seconds.")),
                        },
                        _ = reply.closed() => ToolResult::failure("The tool caller disconnected."),
                    };
                    ToolCompletion { context, caller, reply, result }
                });
                self.tools.running.insert(key, abort);
                Ok(())
            }
            action => {
                let result = self
                    .pr_tool(&context.thread_id, action)
                    .unwrap_or_else(|problem| ToolResult::failure(problem.message));
                self.send_tool_result(reply, result).await
            }
        }
    }
    fn pr_tool(&mut self, thread: &ThreadId, action: Action) -> Result<ToolResult> {
        let result = match action {
            Action::Link(key) => {
                let already_linked = self
                    .pr_summary(thread)
                    .links
                    .iter()
                    .any(|link| link.pr.key == key);
                if !already_linked {
                    self.pr_membership(thread, key.clone(), Some(PrLinkSource::AgentDiscovered))?;
                }
                json!({"url":key.url(), "alreadyLinked":already_linked})
            }
            Action::Unlink(key) => {
                let was_linked = self
                    .pr_summary(thread)
                    .links
                    .iter()
                    .any(|link| link.pr.key == key);
                if was_linked {
                    self.pr_membership(thread, key.clone(), None)?;
                }
                json!({"url":key.url(), "wasLinked":was_linked})
            }
            Action::List => {
                let summary = self.pr_summary(thread);
                let links: Vec<_> = summary.links.iter().take(200).map(|link| {
                    let state = link.pr.snapshot.as_ref().map(|snapshot| match snapshot.lifecycle { crate::PrLifecycle::Open { .. } => "open", crate::PrLifecycle::Closed { .. } => "closed", crate::PrLifecycle::Merged { .. } => "merged" }).unwrap_or("unknown");
                    json!({"url":link.pr.key.url(),"title":link.pr.snapshot.as_ref().map(|snapshot| &snapshot.title),"state":state,"source":link.source,"linkedAt":link.linked_at})
                }).collect();
                json!({"pullRequests":links,"truncated":summary.links.len()>200})
            }
            Action::Preview(_) => unreachable!(),
        };
        Ok(ToolResult::text(serde_json::to_string(&result)?).bounded())
    }
    pub(super) async fn finish_tool(
        &mut self,
        completion: std::result::Result<ToolCompletion, tokio::task::JoinError>,
    ) -> Result<()> {
        let Ok(ToolCompletion {
            context,
            caller,
            reply,
            result,
        }) = completion
        else {
            return Ok(());
        };
        self.tools.running.remove(&(
            context.thread_id.clone(),
            context.turn_id.clone(),
            context.call_id.clone(),
        ));
        let current = self
            .tool_context(&context.thread_id, context.session_epoch, &caller)
            .is_ok_and(|current| current.turn_id == context.turn_id);
        let scope_current = match &reply {
            ToolReply::Dynamic { .. } => true,
            ToolReply::Mcp { credential, .. } => {
                self.tools.credentials.get(credential).is_some_and(|scope| {
                    scope.epoch == context.session_epoch && scope.thread == context.thread_id
                })
            }
        };
        if current && scope_current {
            self.send_tool_result(reply, result).await
        } else {
            Ok(())
        }
    }
    async fn send_tool_result(&mut self, reply: ToolReply, result: ToolResult) -> Result<()> {
        match reply {
            ToolReply::Dynamic { request } => {
                if let Some(provider) = &self.provider {
                    provider
                        .respond(request, adapter::dynamic_result(result.bounded()))
                        .await?;
                }
            }
            ToolReply::Mcp { reply, .. } => {
                let _ = reply.send(Ok(mcp_result(result.bounded())));
            }
        }
        Ok(())
    }
}
