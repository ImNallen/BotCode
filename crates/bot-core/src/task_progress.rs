// Adapted from pingdotgg/t3code v0.0.45 apps/web/src/session-logic.ts (MIT).
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub step: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    explanation: Option<String>,
    steps: Vec<TaskStep>,
    first_observed_at_ms: u64,
    timings: Vec<TaskTiming>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskTiming {
    step: String,
    occurrence: usize,
    started_at_ms: Option<u64>,
    completed_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskUpdate {
    pub thread_id: String,
    pub turn_id: String,
    pub explanation: Option<String>,
    pub plan: Vec<TaskUpdateStep>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TaskUpdateStep {
    pub step: String,
    pub status: TaskStatus,
}

impl TaskProgress {
    pub fn steps(&self) -> &[TaskStep] {
        &self.steps
    }
}

impl TaskUpdate {
    pub(crate) fn parse(value: serde_json::Value) -> Option<Self> {
        let mut update: Self = serde_json::from_value(value).ok()?;
        if update.thread_id.is_empty() || update.turn_id.is_empty() {
            return None;
        }
        update.explanation = update.explanation.and_then(|text| {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        });
        for step in &mut update.plan {
            step.step = match step.step.trim() {
                "" => "step".into(),
                text => text.into(),
            };
        }
        Some(update)
    }
}

impl crate::Turn {
    pub(crate) fn update_tasks(&mut self, update: TaskUpdate, at_ms: u64) -> bool {
        if update.plan.is_empty() {
            return self.tasks.take().is_some();
        }
        let steps: Vec<_> = update
            .plan
            .into_iter()
            .map(|step| TaskStep {
                step: step.step,
                status: step.status,
                duration_ms: None,
            })
            .collect();
        if self.tasks.as_ref().is_some_and(|tasks| {
            tasks.explanation == update.explanation
                && tasks
                    .steps
                    .iter()
                    .map(|s| (&s.step, s.status))
                    .eq(steps.iter().map(|s| (&s.step, s.status)))
        }) {
            return false;
        }
        let tasks = self.tasks.get_or_insert_with(|| TaskProgress {
            explanation: None,
            steps: vec![],
            first_observed_at_ms: at_ms,
            timings: vec![],
        });
        tasks.explanation = update.explanation;
        let mut occurrences = HashMap::new();
        for step in &steps {
            let occurrence = occurrences.entry(step.step.as_str()).or_insert(0);
            let index = tasks
                .timings
                .iter()
                .position(|timing| timing.step == step.step && timing.occurrence == *occurrence);
            let timing = match index {
                Some(index) => &mut tasks.timings[index],
                None => {
                    tasks.timings.push(TaskTiming {
                        step: step.step.clone(),
                        occurrence: *occurrence,
                        started_at_ms: None,
                        completed_at_ms: None,
                    });
                    tasks.timings.last_mut().unwrap()
                }
            };
            *occurrence += 1;
            match step.status {
                TaskStatus::InProgress => {
                    timing.started_at_ms.get_or_insert(at_ms);
                }
                TaskStatus::Completed => {
                    timing.completed_at_ms.get_or_insert(at_ms);
                }
                TaskStatus::Pending => {}
            }
        }
        let mut completed: Vec<_> = tasks
            .timings
            .iter()
            .filter(|timing| timing.completed_at_ms.is_some())
            .collect();
        completed.sort_by_key(|timing| timing.completed_at_ms);
        let mut previous = tasks.first_observed_at_ms;
        let mut durations = HashMap::new();
        for timing in completed {
            let end = timing.completed_at_ms.unwrap();
            let start = timing.started_at_ms.unwrap_or(previous);
            if end > start {
                durations.insert((timing.step.as_str(), timing.occurrence), end - start);
            }
            previous = end;
        }
        let mut occurrences = HashMap::new();
        tasks.steps = steps
            .into_iter()
            .map(|mut step| {
                let occurrence = occurrences.entry(step.step.clone()).or_insert(0);
                if step.status == TaskStatus::Completed {
                    step.duration_ms = durations.get(&(step.step.as_str(), *occurrence)).copied();
                }
                *occurrence += 1;
                step
            })
            .collect();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;
    use serde_json::json;

    fn turn() -> Turn {
        Turn {
            id: TurnId::default(),
            prompt: String::new(),
            context: None,
            native_turn_id: Some("turn".into()),
            delivery: Delivery::Accepted,
            execution: Execution::Running,
            items: vec![],
            settings: None,
            started_at_ms: Some(0),
            completed_at_ms: None,
            attachments: vec![],
            checkpoint: TurnCheckpoint::default(),
            tasks: None,
        }
    }
    fn update(turn: &mut Turn, steps: &[(&str, &str)], at: u64) -> bool {
        let value = json!({"threadId":"thread","turnId":"turn","explanation":"  checklist  ","plan":steps.iter().map(|(step,status)|json!({"step":step,"status":status})).collect::<Vec<_>>()});
        turn.update_tasks(TaskUpdate::parse(value).unwrap(), at)
    }
    #[test]
    fn atomic_replacements_keep_first_timing_and_duplicate_occurrences() {
        let mut turn = turn();
        assert!(update(
            &mut turn,
            &[
                ("same", "inProgress"),
                ("same", "pending"),
                ("last", "pending")
            ],
            100
        ));
        assert!(!update(
            &mut turn,
            &[
                ("same", "inProgress"),
                ("same", "pending"),
                ("last", "pending")
            ],
            150
        ));
        update(
            &mut turn,
            &[
                ("same", "completed"),
                ("same", "inProgress"),
                ("last", "pending"),
            ],
            200,
        );
        update(
            &mut turn,
            &[
                ("same", "completed"),
                ("same", "completed"),
                ("last", "completed"),
            ],
            300,
        );
        let tasks = turn.tasks.as_ref().unwrap();
        assert_eq!(tasks.explanation.as_deref(), Some("checklist"));
        assert_eq!(
            tasks
                .steps
                .iter()
                .map(|s| s.duration_ms)
                .collect::<Vec<_>>(),
            [Some(100), Some(100), None]
        );
        let text = serde_json::to_string(&turn).unwrap();
        let mut restored: Turn = serde_json::from_str(&text).unwrap();
        update(&mut restored, &[("last", "pending")], 400);
        update(
            &mut restored,
            &[("same", "completed"), ("same", "completed")],
            500,
        );
        assert_eq!(
            restored
                .tasks
                .unwrap()
                .steps
                .iter()
                .map(|s| s.duration_ms)
                .collect::<Vec<_>>(),
            [Some(100), Some(100)]
        );
    }
    #[test]
    fn removal_and_reorder_preserve_completion_order_and_empty_resets_evidence() {
        let mut turn = turn();
        update(
            &mut turn,
            &[("A", "pending"), ("B", "pending"), ("C", "pending")],
            100,
        );
        update(&mut turn, &[("B", "completed")], 200);
        update(
            &mut turn,
            &[("C", "completed"), ("A", "completed"), ("B", "completed")],
            300,
        );
        assert_eq!(
            turn.tasks
                .as_ref()
                .unwrap()
                .steps
                .iter()
                .map(|s| s.duration_ms)
                .collect::<Vec<_>>(),
            [None, Some(100), Some(100)]
        );
        assert!(update(&mut turn, &[], 400));
        assert!(turn.tasks.is_none());
        assert!(!update(&mut turn, &[], 500));
        update(&mut turn, &[("B", "inProgress")], 600);
        update(&mut turn, &[("B", "completed")], 700);
        assert_eq!(turn.tasks.unwrap().steps[0].duration_ms, Some(100));
    }
    #[test]
    fn parser_rejects_whole_invalid_list_and_normalizes_reference_text() {
        for plan in [
            json!([{"step":"valid","status":"pending"},{"step":"bad","status":"in_progress"}]),
            json!([{"step":5,"status":"pending"}]),
            json!(null),
        ] {
            assert!(
                TaskUpdate::parse(json!({"threadId":"thread","turnId":"turn","plan":plan}))
                    .is_none()
            );
        }
        let update = TaskUpdate::parse(json!({"threadId":"thread","turnId":"turn","explanation":"   ","plan":[{"step":"  ","status":"pending"}]})).unwrap();
        assert_eq!(update.explanation, None);
        assert_eq!(update.plan[0].step, "step");
    }
    #[test]
    fn old_turn_snapshots_default_to_no_execution_tasks() {
        let mut value = serde_json::to_value(turn()).unwrap();
        value.as_object_mut().unwrap().remove("tasks");
        let restored: Turn = serde_json::from_value(value).unwrap();
        assert!(restored.tasks.is_none());
    }
    #[test]
    fn zero_or_backward_observations_do_not_create_durations() {
        let mut turn = turn();
        update(&mut turn, &[("A", "inProgress"), ("B", "pending")], 100);
        update(&mut turn, &[("A", "completed"), ("B", "completed")], 90);
        assert!(
            turn.tasks
                .unwrap()
                .steps
                .iter()
                .all(|s| s.duration_ms.is_none())
        );
    }
}
