// Ported from T3 Code v0.0.45 apps/server/src/provider/CodexDeveloperInstructions.ts and McpHttpServer.ts.
use crate::{AppError, Result, ToolCall, ToolContent, ToolResult, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Caller {
    pub native_thread: String,
    pub native_turn: String,
    pub call_id: String,
}
impl Caller {
    fn checked(self) -> Result<Self> {
        if [&self.native_thread, &self.native_turn, &self.call_id]
            .iter()
            .any(|id| id.is_empty() || id.len() > 256)
        {
            return Err(AppError::new(
                "tool_wire",
                "Tool call is missing a bounded thread, turn, or call ID.",
            ));
        }
        Ok(self)
    }
}

pub(crate) fn dynamic_call(params: Value) -> Result<(Caller, ToolCall)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Params {
        thread_id: String,
        turn_id: String,
        call_id: String,
        namespace: Option<String>,
        tool: String,
        arguments: Value,
    }
    let params: Params =
        serde_json::from_value(params).map_err(|error| AppError::new("tool_wire", error))?;
    if params.namespace.is_some() {
        return Err(AppError::new(
            "tool_namespace",
            "Bot Code dynamic tools have no namespace.",
        ));
    }
    let caller = Caller {
        native_thread: params.thread_id,
        native_turn: params.turn_id,
        call_id: params.call_id,
    }
    .checked()?;
    Ok((
        caller,
        ToolCall {
            name: params.tool,
            arguments: params.arguments,
        },
    ))
}

pub(crate) fn mcp_caller(meta: &Value) -> Result<Caller> {
    let turn = &meta["x-codex-turn-metadata"];
    Caller {
        native_thread: turn["thread_id"].as_str().unwrap_or_default().into(),
        native_turn: turn["turn_id"].as_str().unwrap_or_default().into(),
        call_id: meta["callId"].as_str().unwrap_or_default().into(),
    }
    .checked()
}

pub(crate) fn dynamic_specs(specs: &[ToolSpec]) -> Value {
    Value::Array(
        specs
            .iter()
            .map(|spec| {
                json!({
                    "type": "function", "name": spec.name, "description": spec.description,
                    "inputSchema": spec.input_schema, "deferLoading": false
                })
            })
            .collect(),
    )
}

pub(crate) fn dynamic_result(result: ToolResult) -> Value {
    let content: Vec<_> = result
        .content
        .into_iter()
        .map(|item| match item {
            ToolContent::Text { text } => json!({"type":"inputText", "text":text}),
            ToolContent::Image { data, mime_type } => {
                json!({"type":"inputImage", "imageUrl":format!("data:{mime_type};base64,{data}")})
            }
        })
        .collect();
    json!({"success": result.success, "contentItems": content})
}

pub(crate) fn stdio_config(
    executable: &std::path::Path,
    socket: &std::path::Path,
    credential: &str,
    specs: &[ToolSpec],
) -> Value {
    let approvals: serde_json::Map<_, _> = specs
        .iter()
        .map(|spec| (spec.name.clone(), json!({"approval_mode":"approve"})))
        .collect();
    json!({"mcp_servers.botcode": {
        "command": executable, "args": ["--agent-tools"],
        "env": {"BOT_CODE_AGENT_SOCKET": socket, "BOT_CODE_AGENT_TOKEN": credential},
        "startup_timeout_sec": 10, "tool_timeout_sec": 65,
        "tools": approvals
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_encodings_preserve_typed_results_and_truthful_specs() {
        let result = ToolResult {
            success: true,
            content: vec![ToolContent::Image {
                data: "cG5n".into(),
                mime_type: "image/png".into(),
            }],
        };
        assert_eq!(
            dynamic_result(result)["contentItems"][0],
            json!({"type":"inputImage", "imageUrl":"data:image/png;base64,cG5n"})
        );
        let specs = crate::pull_request_tool_specs();
        assert_eq!(dynamic_specs(&specs)[0]["type"], "function");
        let config = stdio_config(
            std::path::Path::new("/binary"),
            std::path::Path::new("/socket"),
            "secret",
            &specs,
        );
        assert_eq!(
            config["mcp_servers.botcode"]["tools"]["unlink_pull_request"]["approval_mode"],
            "approve"
        );
        assert!(!specs[0].annotations.read_only_hint);
        assert!(!specs[1].annotations.destructive_hint);
    }
    #[test]
    fn accepted_near_limit_result_fits_codex_item_notification() {
        let content = ToolResult::text("x".repeat(crate::tools::OUTPUT_LIMIT - 256)).bounded();
        assert!(content.success);
        let result = dynamic_result(content);
        let notification = json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"call","type":"dynamicToolCall","tool":"preview_evaluate","arguments":{"script":"x".repeat(crate::tools::INPUT_LIMIT-128)},"contentItems":result["contentItems"],"success":result["success"],"status":"completed"}}});
        assert!(serde_json::to_vec(&notification).unwrap().len() < super::super::FRAME_LIMIT);
        assert!(
            !ToolResult::text("x".repeat(crate::tools::OUTPUT_LIMIT))
                .bounded()
                .success
        );
    }
}
