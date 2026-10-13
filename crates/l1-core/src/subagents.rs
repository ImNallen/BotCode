// Ported from pingdotgg/t3code v0.0.45 packages/client-runtime/src/state/subagentRuntime.ts and apps/server/src/provider/Layers/CodexAdapter.ts (MIT).
use crate::{Item, SubAgentActivity, Turn, TurnId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const SUMMARY_CHAR_LIMIT: usize = 180;
const ROSTER_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Running,
    Waiting,
    Idle,
    Failed,
    Interrupted,
}
impl SubagentStatus {
    pub fn active(self) -> bool {
        matches!(self, Self::Running | Self::Waiting)
    }
    pub fn terminal(self) -> bool {
        matches!(self, Self::Failed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    pub spawn_turn_id: TurnId,
    pub title: String,
    pub role: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub status: SubagentStatus,
    pub activation_count: u32,
    pub total_tokens: Option<u64>,
    pub progress: Option<String>,
    pub started_at_ms: u64,
    pub completed_at_ms: Option<u64>,
    pub updated_at_ms: u64,
}
impl Subagent {
    fn registered(id: String, agent_path: &str, spawn_turn_id: TurnId, now: u64) -> Self {
        let leaf = agent_path
            .rsplit('/')
            .find(|segment| !segment.is_empty())
            .map(str::to_owned);
        Self {
            title: leaf.clone().unwrap_or_else(|| id.clone()),
            role: leaf.unwrap_or_else(|| "general-purpose".into()),
            id,
            spawn_turn_id,
            model: None,
            effort: None,
            status: SubagentStatus::Running,
            activation_count: 1,
            total_tokens: None,
            progress: None,
            started_at_ms: now,
            completed_at_ms: None,
            updated_at_ms: now,
        }
    }
    fn set_status(&mut self, status: SubagentStatus, now: u64) -> bool {
        if self.status == status || (self.status.terminal() && status.terminal()) {
            return false;
        }
        if (self.status.terminal() || self.status == SubagentStatus::Idle)
            && status == SubagentStatus::Running
        {
            self.activation_count += 1;
            self.completed_at_ms = None;
            self.started_at_ms = now;
        }
        if status.terminal() {
            self.completed_at_ms = Some(now);
        }
        self.status = status;
        true
    }
    fn progressed(&mut self, now: u64) -> bool {
        self.status == SubagentStatus::Waiting && self.set_status(SubagentStatus::Running, now)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Roster(Vec<Subagent>);

pub(crate) struct ActivityItem {
    child: String,
    activity: SubAgentActivity,
    agent_path: String,
    model: Option<String>,
    effort: Option<String>,
}
fn is_root_activity(child: &str, root_native: Option<&str>, agent_path: &str) -> bool {
    root_native == Some(child) || matches!(agent_path, "/root" | "/")
}

impl ActivityItem {
    pub(crate) fn parse(item: &Value, owner_native: &str) -> Option<Self> {
        if item.get("type")?.as_str()? != "subAgentActivity" {
            return None;
        }
        let child = text(item, "agentThreadId")?;
        let agent_path = item
            .get("agentPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if is_root_activity(&child, Some(owner_native), agent_path) {
            return None;
        }
        Some(Self {
            child,
            activity: serde_json::from_value(item.get("kind")?.clone()).ok()?,
            agent_path: agent_path.into(),
            model: text(item, "model"),
            effort: text(item, "reasoningEffort"),
        })
    }
}

pub(crate) enum ChildEvent {
    Status(SubagentStatus),
    Tokens(u64),
    Settings {
        model: Option<String>,
        effort: Option<String>,
    },
    Progress(String),
    ActivityItem(ActivityItem),
}
impl ChildEvent {
    pub(crate) fn parse(method: &str, params: &Value) -> Option<Self> {
        use SubagentStatus::*;
        Some(match method {
            "turn/started" => Self::Status(Running),
            "turn/completed" => Self::Status(
                match params.pointer("/turn/status").and_then(Value::as_str) {
                    Some("failed") => Failed,
                    Some("interrupted") => Interrupted,
                    _ => Idle,
                },
            ),
            "thread/status/changed" => {
                let status = params.get("status")?;
                Self::Status(match status.get("type")?.as_str()? {
                    "systemError" => Failed,
                    "active" => {
                        let waiting = status
                            .get("activeFlags")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .any(|flag| {
                                matches!(
                                    flag.as_str(),
                                    Some("waitingOnApproval" | "waitingOnUserInput")
                                )
                            });
                        if waiting { Waiting } else { Running }
                    }
                    // Codex 0.162 reports a child idle before its first turn starts,
                    // which T3 counts as a second run. turn/completed reports idle.
                    _ => return None,
                })
            }
            "thread/closed" => Self::Status(Interrupted),
            "error" if params.get("willRetry").and_then(Value::as_bool) != Some(true) => {
                Self::Status(Failed)
            }
            // `total` is cumulative per child; `last` shrinks on follow-ups.
            "thread/tokenUsage/updated" => {
                Self::Tokens(params.pointer("/tokenUsage/total/totalTokens")?.as_u64()?)
            }
            "thread/settings/updated" => Self::Settings {
                model: params.get("threadSettings").and_then(|s| text(s, "model")),
                effort: params.get("threadSettings").and_then(|s| text(s, "effort")),
            },
            "model/rerouted" => Self::Settings {
                model: text(params, "toModel"),
                effort: None,
            },
            "item/started" | "item/completed" => {
                let item = params.get("item")?;
                if item.get("type")?.as_str()? == "subAgentActivity" {
                    return ActivityItem::parse(item, params.get("threadId")?.as_str()?)
                        .map(Self::ActivityItem);
                }
                Self::Progress(progress_summary(item)?)
            }
            _ => return None,
        })
    }
}

impl Roster {
    pub fn agents(&self) -> &[Subagent] {
        &self.0
    }
    pub(crate) fn owns(&self, child: &str) -> bool {
        self.0.iter().any(|agent| agent.id == child)
    }
    pub(crate) fn apply_activity(&mut self, spawn: ActivityItem, turn: &TurnId, now: u64) -> bool {
        let Some(agent) = self.0.iter_mut().find(|agent| agent.id == spawn.child) else {
            if spawn.activity != SubAgentActivity::Started {
                return false;
            }
            self.0.push(Subagent {
                model: spawn.model,
                effort: spawn.effort,
                ..Subagent::registered(spawn.child, &spawn.agent_path, turn.clone(), now)
            });
            self.cap();
            return true;
        };
        let changed = match spawn.activity {
            SubAgentActivity::Started => {
                let model = agent.model.is_none() && spawn.model.is_some();
                let effort = agent.effort.is_none() && spawn.effort.is_some();
                if model {
                    agent.model = spawn.model;
                }
                if effort {
                    agent.effort = spawn.effort;
                }
                model || effort
            }
            SubAgentActivity::Interrupted => agent.set_status(SubagentStatus::Interrupted, now),
            SubAgentActivity::Interacted | SubAgentActivity::Completed => false,
        };
        if changed {
            agent.updated_at_ms = now;
        }
        changed
    }
    pub(crate) fn apply(&mut self, child: &str, event: ChildEvent, now: u64) -> bool {
        let Some(agent) = self.0.iter_mut().find(|agent| agent.id == child) else {
            return false;
        };
        let changed = match event {
            ChildEvent::ActivityItem(spawn) => {
                let turn = agent.spawn_turn_id.clone();
                return self.apply_activity(spawn, &turn, now);
            }
            ChildEvent::Status(status) => agent.set_status(status, now),
            ChildEvent::Tokens(total) => {
                let total = agent.total_tokens.map_or(total, |known| known.max(total));
                let changed = agent.total_tokens != Some(total);
                agent.total_tokens = Some(total);
                changed | agent.progressed(now)
            }
            ChildEvent::Settings { model, effort } => {
                let mut changed = false;
                for (slot, value) in [(&mut agent.model, model), (&mut agent.effort, effort)] {
                    if value.is_some() && *slot != value {
                        *slot = value;
                        changed = true;
                    }
                }
                changed
            }
            ChildEvent::Progress(summary) => {
                let summary = bounded(summary);
                let changed = agent.progress.as_ref() != Some(&summary);
                agent.progress = Some(summary);
                changed | agent.progressed(now)
            }
        };
        if changed {
            agent.updated_at_ms = now;
        }
        changed
    }
    pub(crate) fn backfill(&mut self, root_native: Option<&str>, turns: &[Turn]) {
        if !self.0.is_empty() {
            return;
        }
        for turn in turns {
            let start = turn.started_at_ms.unwrap_or_default();
            let end = turn.completed_at_ms.unwrap_or(start);
            for item in &turn.items {
                let Item::SubAgentActivity {
                    activity,
                    agent_path,
                    agent_thread_id: child,
                    ..
                } = item
                else {
                    continue;
                };
                if is_root_activity(child, root_native, agent_path) {
                    continue;
                }
                match (activity, self.0.iter_mut().find(|agent| agent.id == *child)) {
                    (SubAgentActivity::Started, None) => self.0.push(Subagent {
                        updated_at_ms: end,
                        ..Subagent::registered(child.clone(), agent_path, turn.id.clone(), start)
                    }),
                    (SubAgentActivity::Completed, Some(agent)) => {
                        agent.status = SubagentStatus::Idle;
                        agent.completed_at_ms = None;
                        agent.updated_at_ms = end;
                    }
                    (SubAgentActivity::Interrupted, Some(agent)) => {
                        agent.status = SubagentStatus::Interrupted;
                        agent.completed_at_ms = Some(end);
                        agent.updated_at_ms = end;
                    }
                    _ => {}
                }
            }
        }
        self.session_ended();
        self.cap();
    }
    pub(crate) fn session_ended(&mut self) {
        for agent in &mut self.0 {
            if agent.status.active() {
                agent.status = SubagentStatus::Interrupted;
                agent.completed_at_ms = agent.completed_at_ms.or(Some(agent.updated_at_ms));
            }
        }
    }
    pub(crate) fn retain_spawned_in(&mut self, turns: &HashSet<TurnId>) {
        self.0.retain(|agent| turns.contains(&agent.spawn_turn_id));
    }
    fn cap(&mut self) {
        while self.0.len() > ROSTER_LIMIT {
            let rank = |agent: &Subagent| match agent.status {
                status if status.active() => 0,
                SubagentStatus::Idle => 1,
                _ => 2,
            };
            let evict = (0..self.0.len())
                .max_by_key(|&i| {
                    let agent = &self.0[i];
                    (rank(agent), std::cmp::Reverse(agent.updated_at_ms))
                })
                .unwrap();
            self.0.remove(evict);
        }
    }
}
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn bounded(value: String) -> String {
    if value.chars().count() <= SUMMARY_CHAR_LIMIT {
        return value;
    }
    let mut cut: String = value.chars().take(SUMMARY_CHAR_LIMIT - 1).collect();
    cut.push('…');
    cut
}

fn progress_summary(item: &Value) -> Option<String> {
    let kind = item.get("type")?.as_str()?;
    if let Some(summary) = ["command", "title", "query"]
        .into_iter()
        .find_map(|key| item.get(key).and_then(Value::as_str))
    {
        return Some(summary.into());
    }
    Some(canonical_item_type(kind).replace('_', " "))
}

fn canonical_item_type(raw: &str) -> &'static str {
    let mut words = String::new();
    let mut previous: Option<char> = None;
    for c in raw.trim().chars() {
        if c.is_ascii_uppercase()
            && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            words.push(' ');
        }
        words.push(if matches!(c, '.' | '_' | '/' | '-') {
            ' '
        } else {
            c
        });
        previous = Some(c);
    }
    let kind = words
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let has = |needle: &str| kind.contains(needle);
    if has("user") {
        "user_message"
    } else if has("agent message") || has("assistant") {
        "assistant_message"
    } else if has("reasoning") || has("thought") {
        "reasoning"
    } else if has("plan") || has("todo") {
        "plan"
    } else if has("command") {
        "command_execution"
    } else if has("file change") || has("patch") || has("edit") {
        "file_change"
    } else if has("mcp") {
        "mcp_tool_call"
    } else if has("dynamic tool") {
        "dynamic_tool_call"
    } else if has("collab") {
        "collab_agent_tool_call"
    } else if has("web search") {
        "web_search"
    } else if has("image") {
        "image_view"
    } else if has("review entered") {
        "review_entered"
    } else if has("review exited") {
        "review_exited"
    } else if has("compact") {
        "context_compaction"
    } else if has("error") {
        "error"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn notify(roster: &mut Roster, child: &str, method: &str, mut params: Value, now: u64) {
        params["threadId"] = child.into();
        if let Some(event) = ChildEvent::parse(method, &params) {
            roster.apply(child, event, now);
        }
    }
    fn spawned(owner: &str, child: &str, path: &str) -> ActivityItem {
        let item = json!({"type": "subAgentActivity", "kind": "started",
            "agentThreadId": child, "agentPath": path, "model": "gpt-6.1-sol", "reasoningEffort": "low"});
        ActivityItem::parse(&item, owner).unwrap()
    }
    fn agent<'a>(roster: &'a Roster, id: &str) -> &'a Subagent {
        roster.agents().iter().find(|a| a.id == id).unwrap()
    }

    #[test]
    fn a_resumed_child_counts_a_new_run_and_its_first_terminal_status_sticks() {
        let mut roster = Roster::default();
        let turn = TurnId::default();
        roster.apply_activity(spawned("root", "child", "/root/review"), &turn, 10);
        notify(
            &mut roster,
            "child",
            "turn/completed",
            json!({"turn": {"status": "completed"}}),
            20,
        );
        notify(
            &mut roster,
            "child",
            "turn/started",
            json!({"turn": {}}),
            30,
        );
        let resumed = agent(&roster, "child");
        assert_eq!(
            (
                resumed.status,
                resumed.activation_count,
                resumed.started_at_ms
            ),
            (SubagentStatus::Running, 2, 30)
        );
        notify(
            &mut roster,
            "child",
            "thread/status/changed",
            json!({"status": {"type": "active", "activeFlags": ["waitingOnApproval"]}}),
            35,
        );
        assert_eq!(agent(&roster, "child").status, SubagentStatus::Waiting);
        notify(
            &mut roster,
            "child",
            "error",
            json!({"willRetry": true}),
            38,
        );
        assert_eq!(agent(&roster, "child").status, SubagentStatus::Waiting);
        notify(
            &mut roster,
            "child",
            "error",
            json!({"willRetry": false}),
            40,
        );
        notify(&mut roster, "child", "thread/closed", json!({}), 50);
        let failed = agent(&roster, "child");
        assert_eq!(
            (failed.status, failed.completed_at_ms),
            (SubagentStatus::Failed, Some(40))
        );
    }

    #[test]
    fn a_grandchild_joins_the_roster_under_its_parents_spawn_turn() {
        let mut roster = Roster::default();
        let turn = TurnId::default();
        roster.apply_activity(spawned("root", "child", "/root/review"), &turn, 10);
        let item = json!({"type": "subAgentActivity", "kind": "started",
            "agentThreadId": "grandchild", "agentPath": "/root/review/lint", "model": null, "reasoningEffort": null});
        notify(
            &mut roster,
            "child",
            "item/started",
            json!({"item": item}),
            20,
        );
        notify(
            &mut roster,
            "grandchild",
            "item/completed",
            json!({"item": {"type": "commandExecution", "command": "cargo clippy"}}),
            30,
        );
        let grandchild = agent(&roster, "grandchild");
        assert_eq!(
            (
                grandchild.title.as_str(),
                &grandchild.spawn_turn_id,
                grandchild.progress.as_deref()
            ),
            ("lint", &turn, Some("cargo clippy"))
        );
        assert!(
            ActivityItem::parse(
                &json!({"type": "subAgentActivity", "kind": "interacted",
            "agentThreadId": "root", "agentPath": "/root"}),
                "root"
            )
            .is_none()
        );
    }
}
