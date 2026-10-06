use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub max_tokens: Option<u64>,
    pub total_processed_tokens: Option<u64>,
}
impl ContextUsage {
    pub(crate) fn from_update(params: &Value) -> Option<Self> {
        let usage = &params["tokenUsage"];
        let used_tokens = usage["last"]["totalTokens"].as_u64().filter(|n| *n > 0)?;
        Some(Self {
            used_tokens,
            max_tokens: usage["modelContextWindow"].as_u64().filter(|n| *n > 0),
            total_processed_tokens: usage["total"]["totalTokens"]
                .as_u64()
                .filter(|n| *n > used_tokens),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token_update(last: i64, total: i64, window: Value) -> Value {
        json!({"threadId":"t","turnId":"u","tokenUsage":{
            "last":{"totalTokens":last,"inputTokens":last,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},
            "total":{"totalTokens":total,"inputTokens":total,"cachedInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},
            "modelContextWindow":window}})
    }
    #[test]
    fn context_reads_last_turn_tokens_against_the_window() {
        assert_eq!(
            ContextUsage::from_update(&token_update(20575, 41150, json!(258400))),
            Some(ContextUsage {
                used_tokens: 20575,
                max_tokens: Some(258400),
                total_processed_tokens: Some(41150),
            })
        );
        assert_eq!(
            ContextUsage::from_update(&token_update(20575, 20575, Value::Null)),
            Some(ContextUsage {
                used_tokens: 20575,
                max_tokens: None,
                total_processed_tokens: None,
            })
        );
        assert_eq!(
            ContextUsage::from_update(&token_update(20575, 100, json!(0))),
            Some(ContextUsage {
                used_tokens: 20575,
                max_tokens: None,
                total_processed_tokens: None,
            })
        );
        assert_eq!(
            ContextUsage::from_update(&token_update(0, 41150, json!(258400))),
            None
        );
        assert_eq!(
            ContextUsage::from_update(&token_update(-5, 41150, json!(258400))),
            None
        );
        assert_eq!(ContextUsage::from_update(&json!({"threadId":"t"})), None);
    }
}
