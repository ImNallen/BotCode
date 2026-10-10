use crate::{AppError, Item, Result, ThreadId, ThreadSnapshot, Workspace, WorkspaceId};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageSource {
    User,
    Assistant,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessageMatch {
    pub thread_id: ThreadId,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub workspace_label: String,
    pub updated_at_ms: Option<u64>,
    pub revision: u64,
    pub source: MessageSource,
    pub snippet: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessageSearch {
    pub matches: Vec<ThreadMessageMatch>,
    pub has_more: bool,
}
#[derive(Clone)]
pub(crate) struct ThreadSearch {
    path: PathBuf,
    slot: Arc<Semaphore>,
}
impl ThreadSearch {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            slot: Arc::new(Semaphore::new(1)),
        }
    }
    pub(crate) async fn search(&self, query: String) -> Result<ThreadMessageSearch> {
        let words = terms(&query)?;
        let permit = self
            .slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| AppError::new("search", e))?;
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            scan(&path, &words)
        })
        .await
        .map_err(|e| AppError::new("search", e))?
    }
}
fn mark(c: char) -> bool {
    is_combining_mark(c)
}
// ECMAScript whitespace, including BOM but excluding Unicode NEXT LINE.
fn whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn normalize(text: &str) -> String {
    let folded: String = text
        .nfkd()
        .filter(|c| !mark(*c))
        .collect::<String>()
        .to_lowercase();
    folded
        .split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn terms(query: &str) -> Result<Vec<String>> {
    let query = query.trim_matches(whitespace);
    if !(2..=200).contains(&query.chars().count()) {
        return Err(AppError::new(
            "invalid_query",
            "Search requires 2–200 characters.",
        ));
    }
    let words: Vec<_> = normalize(query)
        .split(' ')
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect();
    if words.is_empty() {
        return Err(AppError::new("invalid_query", "Enter searchable text."));
    }
    Ok(words)
}
fn matches(text: &str, words: &[String]) -> bool {
    let folded = normalize(text);
    words.iter().all(|word| folded.contains(word))
}
fn scan(path: &Path, words: &[String]) -> Result<ThreadMessageSearch> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    let mut statement = connection.prepare(
        "SELECT t.data, w.data FROM threads t JOIN workspaces w ON w.id = t.workspace_id",
    )?;
    let mut rows = statement.query([])?;
    let mut result = ThreadMessageSearch {
        matches: Vec::with_capacity(51),
        has_more: false,
    };
    while let Some(row) = rows.next()? {
        let thread: ThreadSnapshot = serde_json::from_str(&row.get::<_, String>(0)?)?;
        if thread.archived() || matches(&thread.title, words) {
            continue;
        }
        let found = thread.turns.iter().find_map(|turn| {
            if matches(&turn.prompt, words) {
                return Some((MessageSource::User, turn.prompt.as_str()));
            }
            turn.items.iter().find_map(|item| match item {
                Item::UserInput { text, .. } if matches(text, words) => {
                    Some((MessageSource::User, text.as_str()))
                }
                Item::Assistant { text, .. } if matches(text, words) => {
                    Some((MessageSource::Assistant, text.as_str()))
                }
                _ => None,
            })
        });
        let Some((source, text)) = found else {
            continue;
        };
        let workspace: Workspace = serde_json::from_str(&row.get::<_, String>(1)?)?;
        result.matches.push(ThreadMessageMatch {
            thread_id: thread.id.clone(),
            workspace_id: thread.workspace_id.clone(),
            title: thread.title.clone(),
            workspace_label: workspace.label,
            updated_at_ms: thread
                .turns
                .iter()
                .rev()
                .find_map(|turn| turn.started_at_ms),
            revision: thread.revision,
            source,
            snippet: snippet(text, &words[0]),
        });
        result.matches.sort_by(|a, b| {
            b.updated_at_ms
                .unwrap_or(0)
                .cmp(&a.updated_at_ms.unwrap_or(0))
                .then_with(|| a.thread_id.to_string().cmp(&b.thread_id.to_string()))
        });
        if result.matches.len() > 50 {
            result.matches.pop();
            result.has_more = true;
        }
    }
    Ok(result)
}
fn normalized_positions(text: &str) -> (String, Vec<usize>) {
    let mut decomposed = String::new();
    let mut original_positions = Vec::new();
    for (index, c) in text.chars().enumerate() {
        for c in c.to_string().nfkd().filter(|c| !mark(*c)) {
            decomposed.push(c);
            for lower in c.to_lowercase() {
                original_positions.extend(std::iter::repeat_n(index, lower.len_utf8()));
            }
        }
    }
    let lower = decomposed.to_lowercase();
    let mut folded = String::new();
    let mut positions = Vec::new();
    let mut pending_space = None;
    for (offset, c) in lower.char_indices() {
        let original = original_positions[offset];
        if whitespace(c) {
            if !folded.is_empty() && pending_space.is_none() {
                pending_space = Some(original);
            }
        } else {
            if let Some(space) = pending_space.take() {
                folded.push(' ');
                positions.push(space);
            }
            folded.push(c);
            positions.extend(std::iter::repeat_n(original, c.len_utf8()));
        }
    }
    (folded, positions)
}
fn snippet(text: &str, word: &str) -> String {
    let display = text
        .split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let chars: Vec<char> = display.chars().collect();
    let (folded, positions) = normalized_positions(&display);
    let position = folded
        .find(word)
        .and_then(|offset| positions.get(offset))
        .copied()
        .unwrap_or(0);
    let mut boundaries = vec![0];
    let mut count = 0;
    for grapheme in display.graphemes(true) {
        count += grapheme.chars().count();
        boundaries.push(count);
    }
    let desired_start = position.saturating_sub(45);
    let start = boundaries
        .iter()
        .copied()
        .take_while(|boundary| *boundary <= desired_start)
        .last()
        .unwrap_or(0);
    let leading = usize::from(start > 0);
    let mut end = boundaries
        .iter()
        .copied()
        .take_while(|boundary| *boundary <= start + 240 - leading)
        .last()
        .unwrap_or(start);
    if end < chars.len() {
        end = boundaries
            .iter()
            .copied()
            .take_while(|boundary| *boundary <= start + 239 - leading)
            .last()
            .unwrap_or(start);
    }
    format!(
        "{}{}{}",
        if leading > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;
    pub(super) fn thread() -> ThreadSnapshot {
        ThreadSnapshot {
            worktree_setup: None,
            created_at_ms: Some(1000),
            latest_user_activity_at_ms: Some(2000),
            unsettled_at_ms: None,
            id: ThreadId::default(),
            workspace_id: WorkspaceId::default(),
            title: "Settlement".into(),
            native_thread_id: None,
            revision: 1,
            session: SessionState::Dormant,
            settings: SessionSettings::default(),
            checkout: Checkout::Local,
            turns: vec![Turn {
                id: TurnId::default(),
                prompt: "Accepted work".into(),
                context: None,
                native_turn_id: None,
                delivery: Delivery::Accepted,
                execution: Execution::Completed,
                items: vec![],
                settings: None,
                started_at_ms: Some(2000),
                completed_at_ms: Some(3000),
                attachments: vec![],
                checkpoint: TurnCheckpoint::default(),
                tasks: None,
            }],
            approvals: vec![],
            user_questions: vec![],
            diagnostic: None,
            placement: Placement::Auto,
            snooze: None,
            context: None,
            pending_revert: None,
            last_revert: None,
        }
    }

    #[test]
    fn snippet_after_compatibility_whitespace() {
        let text = format!("{}needle", "¨".repeat(300));
        assert!(
            snippet(&text, "needle").contains("needle"),
            "snippet must contain needle"
        );
    }
    #[test]
    fn normalized_offsets_follow_whitespace_and_contextual_lowercase() {
        for text in [
            "  needle",
            "a  needle",
            "¨¨needle",
            "\u{a0}\u{3000}needle",
            "ΟΣ  needle",
            "a\u{903}b\u{20dd} needle",
            "👨‍👩‍👧‍👦 needle",
            "\u{85}needle",
            "\u{feff}needle",
        ] {
            let (folded, positions) = normalized_positions(text);
            assert_eq!(folded, normalize(text));
            let offset = folded.find("needle").unwrap();
            let original: String = text.chars().skip(positions[offset]).take(6).collect();
            assert_eq!(original, "needle");
            assert!(snippet(text, "needle").contains("needle"));
        }
    }
    #[test]
    fn unicode_and_bounds() {
        for (text, expected) in [
            ("Ｃａｆé  Login", "cafe login"),
            ("ΟΣ", "ος"),
            ("a\u{903}b\u{20dd}", "ab"),
            ("\u{feff}HELLO\u{a0}there", "hello there"),
        ] {
            assert_eq!(normalize(text), expected);
            assert_eq!(normalized_positions(text).0, expected);
        }
        assert!(matches("login café", &terms("cafe login").unwrap()));
        assert!(!matches("café only", &terms("cafe login").unwrap()));
        for query in ["", "a", "\u{301}\u{903}"] {
            assert!(terms(query).is_err());
        }
        assert!(terms(&"😀".repeat(200)).is_ok());
        assert!(terms(&"😀".repeat(201)).is_err());
        let excerpt = snippet(
            &format!("{} café {}", "😀".repeat(300), "🦀".repeat(300)),
            "cafe",
        );
        assert!(excerpt.contains("café"));
        assert_eq!(excerpt.chars().count(), 240);
        let family = "👨‍👩‍👧‍👦";
        let text = format!("{} needle {}", family.repeat(40), "e\u{301}".repeat(200));
        let excerpt = snippet(&text, "needle");
        assert!(excerpt.chars().count() <= 240);
        assert!(excerpt.contains("needle"));
        assert!(!excerpt.trim_matches('…').ends_with('\u{200d}'));
        assert!(!excerpt.trim_matches('…').starts_with('\u{301}'));
        assert!(
            snippet(&format!("a{}", "\u{301}".repeat(300)), "a")
                .chars()
                .count()
                <= 240
        );
    }
}

#[cfg(test)]
mod persisted_tests {
    use super::*;
    use crate::*;
    fn thread(workspace: &WorkspaceId, title: &str, text: &str, time: u64) -> ThreadSnapshot {
        let mut thread = super::tests::thread();
        thread.workspace_id = workspace.clone();
        thread.title = title.into();
        thread.turns[0].prompt = text.into();
        thread.turns[0].started_at_ms = Some(time);
        thread
    }
    #[tokio::test]
    async fn persisted_lifecycle_and_cold_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = Workspace {
            id: WorkspaceId::default(),
            root: dir.path().join("repository"),
            label: "Project".into(),
            kind: WorkspaceKind::Repository,
            favicon_path: None,
            project_icon: None,
        };
        std::fs::create_dir(&workspace.root).unwrap();
        let mut store = crate::store::Store::open(dir.path()).unwrap();
        store.workspace(&workspace).unwrap();
        let mut target = thread(&workspace.id, "Unopened", "Saved café LOGIN", 10);
        store.save(&target).unwrap();
        let search = ThreadSearch::new(dir.path().join("z1.sqlite"));
        let result = search.search("cafe login".into()).await.unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].thread_id, target.id);
        target.placement = Placement::Archived {
            at_ms: 20,
            restore: LivePlacement::Auto,
        };
        store.save(&target).unwrap();
        assert!(
            search
                .search("cafe login".into())
                .await
                .unwrap()
                .matches
                .is_empty()
        );
        target.placement = Placement::Auto;
        store.save(&target).unwrap();
        assert_eq!(
            search
                .search("cafe login".into())
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        target.turns[0].prompt = "cafe".into();
        target.turns[0].items = vec![
            Item::Assistant {
                id: "answer".into(),
                text: "login".into(),
                complete: true,
            },
            Item::Command {
                id: "tool".into(),
                command: "cafe login".into(),
                output: "cafe login".into(),
                status: "completed".into(),
            },
        ];
        store.save(&target).unwrap();
        assert!(
            search
                .search("cafe login".into())
                .await
                .unwrap()
                .matches
                .is_empty()
        );
        target.turns[0].items.push(Item::UserInput {
            id: "steer".into(),
            text: "login café".into(),
            attachments: vec![],
            context: None,
            delivery: Delivery::Accepted,
        });
        store.save(&target).unwrap();
        assert!(matches!(
            search.search("cafe login".into()).await.unwrap().matches[0].source,
            MessageSource::User
        ));
        target.turns[0].items.push(Item::Assistant {
            id: "assistant".into(),
            text: "unique answer".into(),
            complete: true,
        });
        store.save(&target).unwrap();
        assert!(matches!(
            search.search("unique answer".into()).await.unwrap().matches[0].source,
            MessageSource::Assistant
        ));
        target.turns.clear();
        target.revision += 1;
        store.save(&target).unwrap();
        assert!(
            search
                .search("cafe login".into())
                .await
                .unwrap()
                .matches
                .is_empty()
        );
        target = thread(&workspace.id, "Unopened", "Saved café LOGIN", 10);
        store.save(&target).unwrap();
        store.close().unwrap();
        let config = || RuntimeConfig {
            data_dir: dir.path().into(),
            codex_binary: dir.path().join("no-codex"),
            gh_binary: dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(1),
            shell: None,
        };
        let app = App::open(config()).await.unwrap();
        assert_eq!(
            app.search_thread_messages("cafe login".into())
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        app.shutdown().await.unwrap();
        let app = App::open(config()).await.unwrap();
        assert_eq!(
            app.search_thread_messages("cafe login".into())
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        app.shutdown().await.unwrap();
        let mut store = crate::store::Store::open(dir.path()).unwrap();
        store.delete_thread(&target).unwrap();
        assert!(
            search
                .search("cafe login".into())
                .await
                .unwrap()
                .matches
                .is_empty()
        );
        store.save(&target).unwrap();
        store.remove_workspace(&workspace.id).unwrap();
        assert!(
            search
                .search("cafe login".into())
                .await
                .unwrap()
                .matches
                .is_empty()
        );
    }
    #[tokio::test]
    async fn cap_excludes_titles_and_keeps_best_fifty_across_projects() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::store::Store::open(dir.path()).unwrap();
        for project in 0..2 {
            let workspace = Workspace {
                id: WorkspaceId::default(),
                root: dir.path().join(format!("p{project}")),
                label: format!("P{project}"),
                kind: WorkspaceKind::Repository,
                favicon_path: None,
                project_icon: None,
            };
            store.workspace(&workspace).unwrap();
            for i in 0..60 {
                let thread = thread(
                    &workspace.id,
                    if i < 5 { "needle title" } else { "other" },
                    "needle text",
                    i + project * 60,
                );
                store.save(&thread).unwrap();
            }
        }
        let search = ThreadSearch::new(dir.path().join("z1.sqlite"));
        let result = search.search("needle".into()).await.unwrap();
        assert_eq!(result.matches.len(), 50);
        assert!(result.has_more);
        assert_eq!(result.matches[0].updated_at_ms, Some(119));
        assert!(result.matches.iter().all(|row| row.title == "other"));
    }
}
