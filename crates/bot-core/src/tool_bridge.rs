// Ported from T3 Code v0.0.45 apps/server/src/mcp/McpHttpServer.ts.
use crate::{
    AppError, Result, ToolCall, ToolResult,
    codex::tools::Caller,
    tools::{INPUT_LIMIT, OUTPUT_LIMIT},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot},
    task::{JoinHandle, JoinSet},
};

const SOCKET_FRAME_LIMIT: usize = OUTPUT_LIMIT + 4096;
const MAX_CONNECTIONS: usize = 32;

#[derive(Serialize, Deserialize)]
pub(crate) struct BridgeRequest {
    pub credential: String,
    pub operation: BridgeOperation,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub(crate) enum BridgeOperation {
    List,
    Call { caller: Caller, call: ToolCall },
}
pub(crate) struct Envelope {
    pub request: BridgeRequest,
    pub reply: oneshot::Sender<Result<Value>>,
}

pub(crate) struct BridgeServer {
    directory: tempfile::TempDir,
    task: JoinHandle<()>,
}
impl BridgeServer {
    pub fn open(data_dir: &Path) -> Result<(Self, mpsc::Receiver<Envelope>)> {
        let directory = if data_dir.as_os_str().as_bytes().len() + 28 < 104 {
            tempfile::Builder::new()
                .prefix(".agent-tools-")
                .tempdir_in(data_dir)?
        } else {
            tempfile::Builder::new()
                .prefix("botcode-agent-")
                .tempdir_in("/tmp")?
        };
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
        let listener = UnixListener::bind(directory.path().join("socket"))?;
        std::fs::set_permissions(
            directory.path().join("socket"),
            std::fs::Permissions::from_mode(0o600),
        )?;
        let (incoming, receiver) = mpsc::channel(MAX_CONNECTIONS);
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                        let Ok((stream, _)) = accepted else { break };
                        let incoming = incoming.clone();
                        connections.spawn(async move { let _ = serve_connection(stream, incoming).await; });
                    }
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok((Self { directory, task }, receiver))
    }
    pub fn path(&self) -> PathBuf {
        self.directory.path().join("socket")
    }
}
impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve_connection(stream: UnixStream, incoming: mpsc::Sender<Envelope>) -> Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let request = tokio::time::timeout(
        Duration::from_secs(5),
        read_json_line(&mut reader, INPUT_LIMIT),
    )
    .await
    .map_err(|_| AppError::new("tool_timeout", "Agent bridge request timed out."))??
    .ok_or_else(|| AppError::new("tool_wire", "Agent bridge closed before its request."))?;
    let request: BridgeRequest = serde_json::from_value(request)?;
    let (reply, answer) = oneshot::channel();
    incoming
        .send(Envelope { request, reply })
        .await
        .map_err(|_| AppError::new("closed", "Bot Code tool owner is closed."))?;
    let response = tokio::select! {
        result = answer => result.unwrap_or_else(|_| Err(AppError::new("tool_expired", "The tool session expired."))),
        _ = reader.fill_buf() => return Ok(()),
    };
    write_json_line(
        &mut write,
        &serde_json::to_value(response)?,
        SOCKET_FRAME_LIMIT,
    )
    .await
}

pub(crate) fn mcp_result(result: ToolResult) -> Value {
    json!({"content": result.content, "isError": !result.success})
}

pub async fn run_agent_tools_stdio() -> Result<()> {
    let socket = std::env::var_os("BOT_CODE_AGENT_SOCKET")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::new("agent_tools", "Agent bridge socket is missing."))?;
    let credential = std::env::var("BOT_CODE_AGENT_TOKEN")
        .map_err(|_| AppError::new("agent_tools", "Agent bridge credential is missing."))?;
    if credential.len() != 64 || !credential.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::new(
            "agent_tools",
            "Agent bridge credential is invalid.",
        ));
    }
    serve_stdio(
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        socket,
        credential,
    )
    .await
}

async fn serve_stdio<R, W>(
    mut reader: R,
    mut writer: W,
    socket: PathBuf,
    credential: String,
) -> Result<()>
where
    R: AsyncBufRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin,
{
    struct ReaderTask(JoinHandle<()>);
    impl Drop for ReaderTask {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let (frames, mut incoming) = mpsc::channel(32);
    let _reader_task = ReaderTask(tokio::spawn(async move {
        loop {
            let frame = read_json_line(&mut reader, INPUT_LIMIT).await;
            let done = !matches!(frame, Ok(Some(_)));
            if frames.send(frame).await.is_err() || done {
                break;
            }
        }
    }));
    let mut calls = JoinSet::new();
    let mut routes = std::collections::HashMap::new();
    let mut serial = 0_u64;
    loop {
        tokio::select! {
            frame = incoming.recv() => {
                let Some(frame) = frame else { break };
                let Some(frame) = frame? else { break };
                let Some(id) = frame.get("id").cloned() else {
                    if frame["method"] == "notifications/cancelled" {
                        let key = frame["params"]["requestId"].to_string();
                        if let Some((_, abort)) = routes.remove(&key) { tokio::task::AbortHandle::abort(&abort); }
                    }
                    continue;
                };
                if !(id.is_string() || id.is_i64() || id.is_u64()) || frame["jsonrpc"] != "2.0" {
                    write_json_line(&mut writer, &error(id, -32600, "Invalid JSON-RPC request."), SOCKET_FRAME_LIMIT).await?;
                    continue;
                }
                let key = id.to_string();
                if routes.contains_key(&key) {
                    write_json_line(&mut writer, &error(id, -32600, "Duplicate in-flight request ID."), SOCKET_FRAME_LIMIT).await?;
                    continue;
                }
                let immediate = match frame["method"].as_str() {
                    Some("initialize") => {
                        let version = frame["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26");
                        let version = match version { "2024-11-05" | "2025-03-26" | "2025-06-18" => version, _ => "2025-03-26" };
                        Some(ok(id.clone(), json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"botcode","version":env!("CARGO_PKG_VERSION")}})))
                    }
                    Some("ping") => Some(ok(id.clone(), json!({}))),
                    Some("tools/list" | "tools/call") => None,
                    _ => Some(error(id.clone(), -32601, "Unsupported MCP method.")),
                };
                if let Some(response) = immediate {
                    write_json_line(&mut writer, &response, SOCKET_FRAME_LIMIT).await?;
                    continue;
                }
                if calls.len() >= MAX_CONNECTIONS {
                    write_json_line(&mut writer, &error(id, -32000, "Too many active MCP requests."), SOCKET_FRAME_LIMIT).await?;
                    continue;
                }
                let socket = socket.clone();
                let credential = credential.clone();
                serial += 1;
                let ticket = serial;
                let abort = calls.spawn(async move {
                    let response = handle_tool_request(&socket, credential, &frame).await;
                    (key, ticket, response)
                });
                routes.insert(id.to_string(), (ticket, abort));
            }
            Some(completion) = calls.join_next(), if !calls.is_empty() => {
                if let Ok((key, ticket, response)) = completion
                    && routes.get(&key).is_some_and(|(current, _)| *current == ticket)
                {
                    routes.remove(&key);
                    write_json_line(&mut writer, &response, SOCKET_FRAME_LIMIT).await?;
                }
            }
        }
    }
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    Ok(())
}

async fn handle_tool_request(socket: &Path, credential: String, frame: &Value) -> Value {
    let id = frame["id"].clone();
    let operation = if frame["method"] == "tools/list" {
        BridgeOperation::List
    } else {
        let params = &frame["params"];
        let caller = match crate::codex::tools::mcp_caller(&params["_meta"]) {
            Ok(caller) => caller,
            Err(problem) => return error(id, -32602, &problem.message),
        };
        let Some(name) = params["name"]
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= 64)
        else {
            return error(id, -32602, "Tool name is missing or invalid.");
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        BridgeOperation::Call {
            caller,
            call: ToolCall {
                name: name.into(),
                arguments,
            },
        }
    };
    let request = BridgeRequest {
        credential,
        operation,
    };
    match tokio::time::timeout(Duration::from_secs(65), forward(socket, request)).await {
        Ok(Ok(value)) => ok(id, value),
        Ok(Err(problem)) => error(id, -32000, &problem.message),
        Err(_) => error(id, -32000, "Bot Code tool timed out."),
    }
}

async fn forward(socket: &Path, request: BridgeRequest) -> Result<Value> {
    let stream = UnixStream::connect(socket).await?;
    let (read, mut write) = stream.into_split();
    write_json_line(&mut write, &serde_json::to_value(request)?, INPUT_LIMIT).await?;
    let response = read_json_line(&mut BufReader::new(read), SOCKET_FRAME_LIMIT)
        .await?
        .ok_or_else(|| AppError::new("tool_expired", "Bot Code tool session closed."))?;
    serde_json::from_value::<Result<Value>>(response)?
}

fn ok(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":result})
}
fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code, "message":message}})
}

async fn read_json_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    let count = (&mut *reader)
        .take((limit + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await?;
    if count == 0 {
        return Ok(None);
    }
    if count > limit || bytes.last() != Some(&b'\n') {
        return Err(AppError::new(
            "tool_wire",
            "Agent tool JSON line is incomplete or exceeds its limit.",
        ));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}
async fn write_json_line<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &Value,
    limit: usize,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err(AppError::new(
            "tool_wire",
            "Agent tool response exceeds its limit.",
        ));
    }
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolContent;

    #[tokio::test]
    async fn framing_bounds_the_actual_line_and_rejects_partial_frames() {
        assert!(
            read_json_line(&mut BufReader::new(&b"{\"large\":\"123456\"}\n"[..]), 8)
                .await
                .is_err()
        );
        assert!(
            read_json_line(&mut BufReader::new(&b"{}"[..]), 8)
                .await
                .is_err()
        );
        assert_eq!(
            read_json_line(&mut BufReader::new(&b"{}\n"[..]), 8)
                .await
                .unwrap(),
            Some(json!({}))
        );
    }

    #[tokio::test]
    async fn stdio_roundtrip_preserves_scope_metadata_and_mcp_images() {
        let directory = tempfile::tempdir().unwrap();
        let (server, mut incoming) = BridgeServer::open(directory.path()).unwrap();
        assert_eq!(
            std::fs::metadata(server.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let (client, bridge) = tokio::io::duplex(16384);
        let (read, write) = tokio::io::split(bridge);
        let task = tokio::spawn(serve_stdio(
            BufReader::new(read),
            write,
            server.path(),
            "a".repeat(64),
        ));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut reader = BufReader::new(client_read);
        write_json_line(&mut client_write, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}), INPUT_LIMIT).await.unwrap();
        assert_eq!(
            read_json_line(&mut reader, 16384).await.unwrap().unwrap()["result"]["serverInfo"]["name"],
            "botcode"
        );
        write_json_line(&mut client_write, &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"preview_snapshot","arguments":{},"_meta":{"x-codex-turn-metadata":{"thread_id":"native-thread","turn_id":"native-turn","unnecessary":"ignored"},"callId":"call-1"}}}), INPUT_LIMIT).await.unwrap();
        let request = incoming.recv().await.unwrap();
        assert_eq!(request.request.credential, "a".repeat(64));
        let BridgeOperation::Call { caller, call } = request.request.operation else {
            panic!("call expected")
        };
        assert_eq!(caller.native_thread, "native-thread");
        assert_eq!(caller.native_turn, "native-turn");
        assert_eq!(caller.call_id, "call-1");
        assert_eq!(call.name, "preview_snapshot");
        client_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        request
            .reply
            .send(Ok(mcp_result(ToolResult {
                success: true,
                content: vec![ToolContent::Image {
                    data: "cG5n".into(),
                    mime_type: "image/png".into(),
                }],
            })))
            .unwrap();
        let response = read_json_line(&mut reader, 16384).await.unwrap().unwrap();
        assert_eq!(response["id"], 2);
        assert_eq!(
            response["result"]["content"][0],
            json!({"type":"image","data":"cG5n","mimeType":"image/png"})
        );
        assert_eq!(response["result"]["isError"], false);
        client_write
            .write_all(b"\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let response = read_json_line(&mut reader, 16384).await.unwrap().unwrap();
        assert_eq!(response["id"], 3);
        assert_eq!(response["result"], json!({}));
        client_write.shutdown().await.unwrap();
        task.await.unwrap().unwrap();
    }
}
