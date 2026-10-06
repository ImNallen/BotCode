use crate::{codex::Codex, domain::Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Primary,
    Secondary,
}
const SLOTS: [(Slot, &str); 2] = [(Slot::Primary, "primary"), (Slot::Secondary, "secondary")];
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Session,
    Weekly,
    Monthly,
}
const SESSION_MINS: u64 = 5 * 60;
const WEEK_MINS: u64 = 7 * 24 * 60;
const MONTH_MINS: u64 = 30 * 24 * 60;
impl WindowKind {
    fn of(mins: u64) -> Self {
        if mins >= MONTH_MINS {
            Self::Monthly
        } else if mins >= WEEK_MINS {
            Self::Weekly
        } else {
            Self::Session
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    slot: Slot,
    kind: WindowKind,
    used_percent: u8,
    duration_mins: u64,
    resets_at_ms: Option<u64>,
}
impl LimitWindow {
    fn resolve(
        slot: Slot,
        wire: &Value,
        previous: Option<&LimitWindow>,
        plan_type: Option<&str>,
    ) -> Option<Self> {
        let used = wire["usedPercent"].as_f64()?;
        let duration_mins = wire["windowDurationMins"]
            .as_u64()
            .or(previous.map(|w| w.duration_mins))
            .unwrap_or(match slot {
                Slot::Primary if matches!(plan_type, Some("free" | "go")) => MONTH_MINS,
                Slot::Primary => SESSION_MINS,
                Slot::Secondary => WEEK_MINS,
            });
        Some(Self {
            slot,
            kind: WindowKind::of(duration_mins),
            used_percent: used.clamp(0.0, 100.0).round() as u8,
            duration_mins,
            resets_at_ms: wire["resetsAt"]
                .as_u64()
                .filter(|s| *s > 0)
                .map(|s| s * 1000)
                .or(previous.and_then(|w| w.resets_at_ms)),
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum UsageLimits {
    Reported {
        plan: Option<String>,
        windows: Vec<LimitWindow>,
    },
    Unsupported,
    Failed {
        message: String,
    },
}
impl UsageLimits {
    pub(crate) fn after_failure(current: &mut Option<UsageLimits>, message: &str) -> bool {
        if matches!(current, Some(UsageLimits::Reported { .. })) {
            return false;
        }
        let next = Some(UsageLimits::Failed {
            message: message.into(),
        });
        let changed = *current != next;
        *current = next;
        changed
    }
    /// Updates are sparse, so they only merge into a full read.
    pub(crate) fn apply_update(current: &mut Option<UsageLimits>, params: &Value) -> bool {
        let snapshot = &params["rateLimits"];
        let Some(UsageLimits::Reported { plan, windows }) = current else {
            return false;
        };
        if !is_codex(snapshot) {
            return false;
        }
        let plan_type = snapshot["planType"].as_str();
        let mut next = windows.clone();
        for (slot, key) in SLOTS {
            let index = next.iter().position(|w| w.slot == slot);
            if let Some(window) =
                LimitWindow::resolve(slot, &snapshot[key], index.map(|i| &next[i]), plan_type)
            {
                match index {
                    Some(i) => next[i] = window,
                    None => next.push(window),
                }
            }
        }
        next.sort_by_key(|w| w.duration_mins);
        let next_plan = plan_type
            .and_then(plan_label)
            .map(str::to_owned)
            .or_else(|| plan.clone());
        let changed = next != *windows || next_plan != *plan;
        *windows = next;
        *plan = next_plan;
        changed
    }
}
pub(crate) async fn read(provider: &Codex) -> Result<UsageLimits> {
    let account = provider
        .request("account/read", json!({"refreshToken": false}))
        .await?;
    let account = &account["account"];
    if account.is_null() {
        return Ok(UsageLimits::Failed {
            message: "Codex is not signed in.".into(),
        });
    }
    if account["type"] != "chatgpt" {
        return Ok(UsageLimits::Unsupported);
    }
    let response = provider
        .request("account/rateLimits/read", Value::Null)
        .await?;
    Ok(report(&response, account["planType"].as_str()))
}
fn report(response: &Value, account_plan: Option<&str>) -> UsageLimits {
    let by_id = &response["rateLimitsByLimitId"]["codex"];
    let snapshot = if by_id.is_object() {
        by_id
    } else if is_codex(&response["rateLimits"]) {
        &response["rateLimits"]
    } else {
        &Value::Null
    };
    let plan_type = account_plan.or(snapshot["planType"].as_str());
    let mut windows: Vec<_> = SLOTS
        .into_iter()
        .filter_map(|(slot, key)| LimitWindow::resolve(slot, &snapshot[key], None, plan_type))
        .collect();
    windows.sort_by_key(|w| w.duration_mins);
    UsageLimits::Reported {
        plan: plan_type.and_then(plan_label).map(str::to_owned),
        windows,
    }
}
fn is_codex(snapshot: &Value) -> bool {
    snapshot["limitId"].as_str().is_none_or(|id| id == "codex")
}
fn plan_label(plan_type: &str) -> Option<&'static str> {
    Some(match plan_type {
        "free" => "ChatGPT Free Subscription",
        "go" => "ChatGPT Go Subscription",
        "plus" => "ChatGPT Plus Subscription",
        "pro" => "ChatGPT Pro 20x Subscription",
        "prolite" => "ChatGPT Pro 5x Subscription",
        "promax" => "ChatGPT Pro Max Subscription",
        "team" => "ChatGPT Team Subscription",
        "self_serve_business_prolite" | "self_serve_business_usage_based" | "business" => {
            "ChatGPT Business Subscription"
        }
        "ent26" | "enterprise_cbp_automation" | "enterprise_cbp_usage_based" | "enterprise" => {
            "ChatGPT Enterprise Subscription"
        }
        "edu" | "edu_plus" | "edu_pro" => "ChatGPT Edu Subscription",
        "unknown" => "ChatGPT Subscription",
        _ => return None,
    })
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
    fn window(
        slot: Slot,
        kind: WindowKind,
        used_percent: u8,
        duration_mins: u64,
        resets_at_ms: Option<u64>,
    ) -> LimitWindow {
        LimitWindow {
            slot,
            kind,
            used_percent,
            duration_mins,
            resets_at_ms,
        }
    }
    fn weekly(used_percent: u8) -> LimitWindow {
        window(
            Slot::Primary,
            WindowKind::Weekly,
            used_percent,
            10080,
            Some(1_791_580_401_000),
        )
    }
    fn pro(windows: Vec<LimitWindow>) -> Option<UsageLimits> {
        Some(UsageLimits::Reported {
            plan: Some("ChatGPT Pro 20x Subscription".into()),
            windows,
        })
    }
    fn update(snapshot: Value) -> Value {
        json!({ "rateLimits": snapshot })
    }
    #[test]
    fn reported_limits_match_the_wire_contract() {
        assert_eq!(
            serde_json::to_value(pro(vec![weekly(44)]).unwrap()).unwrap(),
            json!({"kind":"reported","plan":"ChatGPT Pro 20x Subscription","windows":[{"slot":"primary","kind":"weekly","usedPercent":44,"durationMins":10080,"resetsAtMs":1791580401000u64}]})
        );
        assert_eq!(
            serde_json::to_value(UsageLimits::Unsupported).unwrap(),
            json!({"kind":"unsupported"})
        );
        assert_eq!(
            serde_json::to_value(UsageLimits::Failed {
                message: "Codex is not signed in.".into()
            })
            .unwrap(),
            json!({"kind":"failed","message":"Codex is not signed in."})
        );
    }
    #[test]
    fn windows_fall_back_by_slot_and_plan_and_clamp_usage() {
        let bare = json!({"usedPercent": 130});
        assert_eq!(
            LimitWindow::resolve(Slot::Primary, &bare, None, Some("pro")),
            Some(window(Slot::Primary, WindowKind::Session, 100, 300, None))
        );
        assert_eq!(
            LimitWindow::resolve(
                Slot::Primary,
                &json!({"usedPercent": -3}),
                None,
                Some("free")
            ),
            Some(window(Slot::Primary, WindowKind::Monthly, 0, 43200, None))
        );
        assert_eq!(
            LimitWindow::resolve(Slot::Primary, &bare, None, Some("go"))
                .unwrap()
                .duration_mins,
            43200
        );
        assert_eq!(
            LimitWindow::resolve(Slot::Secondary, &bare, None, Some("free")),
            Some(window(
                Slot::Secondary,
                WindowKind::Weekly,
                100,
                10080,
                None
            ))
        );
        assert_eq!(
            LimitWindow::resolve(
                Slot::Primary,
                &json!({"usedPercent": 47}),
                Some(&weekly(44)),
                None
            ),
            Some(weekly(47))
        );
        assert_eq!(
            LimitWindow::resolve(
                Slot::Secondary,
                &json!({"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1791470000}),
                None,
                None
            ),
            Some(window(
                Slot::Secondary,
                WindowKind::Session,
                3,
                300,
                Some(1_791_470_000_000)
            ))
        );
        assert_eq!(
            LimitWindow::resolve(Slot::Primary, &Value::Null, None, None),
            None
        );
    }
    #[test]
    fn reads_only_the_codex_bucket() {
        let codex = json!({"limitId":"codex","planType":"pro","primary":{"usedPercent":44,"windowDurationMins":10080,"resetsAt":1791580401},"secondary":null});
        let other = json!({"limitId":"base_model_inference","primary":{"usedPercent":99,"windowDurationMins":300,"resetsAt":1791500000}});
        assert_eq!(
            Some(report(
                &json!({"rateLimits": other, "rateLimitsByLimitId": {"codex": codex, "base_model_inference": other}}),
                Some("pro")
            )),
            pro(vec![weekly(44)])
        );
        assert_eq!(
            Some(report(&json!({ "rateLimits": codex }), None)),
            pro(vec![weekly(44)])
        );
        assert_eq!(
            report(&json!({ "rateLimits": other }), Some("plus")),
            UsageLimits::Reported {
                plan: Some("ChatGPT Plus Subscription".into()),
                windows: vec![]
            }
        );
    }
    #[test]
    fn updates_merge_slots_into_a_read_and_report_real_changes() {
        let mut limits = pro(vec![weekly(44)]);
        let tick = update(
            json!({"limitId":"codex","primary":{"usedPercent":47},"secondary":{"usedPercent":3,"windowDurationMins":300,"resetsAt":1791470000},"planType":null}),
        );
        assert!(UsageLimits::apply_update(&mut limits, &tick));
        let merged = pro(vec![
            window(
                Slot::Secondary,
                WindowKind::Session,
                3,
                300,
                Some(1_791_470_000_000),
            ),
            weekly(47),
        ]);
        assert_eq!(limits, merged);
        for noop in [
            tick,
            update(json!({"limitId":"base_model_inference","primary":{"usedPercent":99}})),
            update(json!({"limitId":"codex","primary":null,"secondary":null,"planType":null})),
            update(json!({"primary":{"usedPercent":47}})),
        ] {
            assert!(!UsageLimits::apply_update(&mut limits, &noop));
            assert_eq!(limits, merged);
        }
        assert!(UsageLimits::apply_update(
            &mut limits,
            &update(json!({"limitId":"codex","planType":"plus"}))
        ));
        assert_eq!(
            limits,
            Some(UsageLimits::Reported {
                plan: Some("ChatGPT Plus Subscription".into()),
                windows: vec![
                    window(
                        Slot::Secondary,
                        WindowKind::Session,
                        3,
                        300,
                        Some(1_791_470_000_000)
                    ),
                    weekly(47),
                ]
            })
        );
        let tick = update(json!({"limitId":"codex","primary":{"usedPercent":5}}));
        for mut ignored in [
            None,
            Some(UsageLimits::Unsupported),
            Some(UsageLimits::Failed {
                message: "Usage service unavailable".into(),
            }),
        ] {
            let before = ignored.clone();
            assert!(!UsageLimits::apply_update(&mut ignored, &tick));
            assert_eq!(ignored, before);
        }
    }
    #[test]
    fn failure_keeps_a_report_and_replaces_anything_else() {
        let mut limits = pro(vec![weekly(44)]);
        assert!(!UsageLimits::after_failure(
            &mut limits,
            "Usage service unavailable"
        ));
        assert_eq!(limits, pro(vec![weekly(44)]));
        let failed = Some(UsageLimits::Failed {
            message: "Usage service unavailable".into(),
        });
        for mut limits in [None, Some(UsageLimits::Unsupported)] {
            assert!(UsageLimits::after_failure(
                &mut limits,
                "Usage service unavailable"
            ));
            assert_eq!(limits, failed);
        }
        let mut limits = failed.clone();
        assert!(!UsageLimits::after_failure(
            &mut limits,
            "Usage service unavailable"
        ));
        assert!(UsageLimits::after_failure(&mut limits, "Codex exited."));
        assert_eq!(
            limits,
            Some(UsageLimits::Failed {
                message: "Codex exited.".into()
            })
        );
    }
    #[test]
    fn plan_labels_follow_t3() {
        assert_eq!(plan_label("pro"), Some("ChatGPT Pro 20x Subscription"));
        assert_eq!(plan_label("edu_plus"), Some("ChatGPT Edu Subscription"));
        assert_eq!(plan_label("mystery"), None);
    }
}
