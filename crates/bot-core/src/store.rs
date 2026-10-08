use crate::PullRequestKey;
use crate::pr_review::{PrChangeResult, PrOperation, PrReviewChange};
use crate::{
    domain::*,
    pull_requests::{CachedPr, Membership},
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
pub struct Store {
    db: Connection,
    _lock: std::fs::File,
}
impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("runtime.lock"))?;
        lock.try_lock().map_err(|_| {
            AppError::new(
                "already_running",
                "Another Bot Code runtime owns this data directory.",
            )
        })?;
        let db = Connection::open(dir.join("z1.sqlite"))?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 3 {
            return Err(AppError::new(
                "unsupported_schema",
                "This data directory was saved by a newer Bot Code. Open it with that version.",
            ));
        }
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        if version < 2 {
            db.execute_batch("BEGIN; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE review_dispositions(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, pr_id TEXT NOT NULL, finding_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id,pr_id,finding_id)); PRAGMA user_version=2; COMMIT;")?;
        }
        if version < 3 {
            db.execute_batch("BEGIN;
                ALTER TABLE threads ADD COLUMN pr_generation INTEGER NOT NULL DEFAULT 0;
                CREATE TABLE pull_requests(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE thread_pull_requests(thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, pr_key TEXT NOT NULL REFERENCES pull_requests(key), generation INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id,pr_key));
                CREATE INDEX pr_membership ON thread_pull_requests(pr_key,state);
                CREATE TABLE pull_request_operations(request_id TEXT PRIMARY KEY, pr_key TEXT NOT NULL REFERENCES pull_requests(key), action_digest TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
                PRAGMA user_version=3; COMMIT;")?;
        }
        db.execute(
            "UPDATE pull_request_operations SET state='uncertain' WHERE state='started'",
            [],
        )?;
        Ok(Self { db, _lock: lock })
    }
    pub fn close(self) -> Result<()> {
        drop(self.db);
        self._lock.unlock()?;
        Ok(())
    }
    pub fn pull_requests(&self) -> Result<Vec<CachedPr>> {
        let mut statement = self.db.prepare("SELECT data FROM pull_requests")?;
        let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn pr_memberships(&self) -> Result<Vec<Membership>> {
        let mut statement = self.db.prepare("SELECT data FROM thread_pull_requests")?;
        let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn pr_generations(&self) -> Result<Vec<(ThreadId, u64)>> {
        let mut statement = self.db.prepare("SELECT id,pr_generation FROM threads")?;
        let rows =
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.map(|r| {
            let (id, generation) = r?;
            Ok((
                serde_json::from_value(serde_json::Value::String(id))?,
                generation as u64,
            ))
        })
        .collect()
    }
    pub fn save_pull_request(
        &mut self,
        record: &CachedPr,
        membership: Option<&Membership>,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO pull_requests(key,revision,data) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,data=excluded.data", params![record.key.as_str(), record.revision as i64, serde_json::to_string(record)?])?;
        if let Some(member) = membership {
            tx.execute("INSERT INTO thread_pull_requests(thread_id,pr_key,generation,state,data) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(thread_id,pr_key) DO UPDATE SET generation=excluded.generation,state=excluded.state,data=excluded.data", params![member.thread.to_string(), member.key.as_str(), member.generation as i64, if member.source.is_some() { "linked" } else { "dismissed" }, serde_json::to_string(member)?])?;
            tx.execute(
                "UPDATE threads SET pr_generation=?2 WHERE id=?1",
                params![member.thread.to_string(), member.generation as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn pending_lifecycle_operations(&self) -> Result<Vec<PrOperation>> {
        let mut statement = self.db.prepare("SELECT data FROM pull_request_operations WHERE state IN ('started','uncertain','pending')")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut pending = vec![];
        for row in rows {
            let operation: PrOperation = serde_json::from_str(&row?)?;
            if operation.input.action.is_lifecycle() {
                pending.push(operation);
            }
        }
        Ok(pending)
    }
    pub fn pr_operation(&self, input: &PrReviewChange) -> Result<Option<PrChangeResult>> {
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT action_digest,data FROM pull_request_operations WHERE request_id=?1",
                [&input.request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((digest, data)) = row else {
            return Ok(None);
        };
        if digest != format!("{:x}", Sha256::digest(serde_json::to_vec(input)?)) {
            return Err(AppError::new(
                "pr_request_conflict",
                "This request ID was used for a different pull request command.",
            ));
        }
        let receipt: PrOperation = serde_json::from_str(&data)?;
        if receipt.input != *input {
            return Err(AppError::new(
                "pr_request_conflict",
                "This request ID was used for a different pull request command.",
            ));
        }
        Ok(Some(receipt.result))
    }
    pub fn saved_pr_operation(
        &self,
        key: &PullRequestKey,
        request_id: &str,
    ) -> Result<PrOperation> {
        let data: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM pull_request_operations WHERE request_id=?1 AND pr_key=?2",
                params![request_id, key.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let operation: PrOperation = serde_json::from_str(&data.ok_or_else(|| {
            AppError::new(
                "pr_receipt_missing",
                "No lifecycle receipt exists for this pull request.",
            )
        })?)?;
        self.pr_operation(&operation.input)?;
        Ok(operation)
    }
    pub fn start_pr_operation(&self, input: &PrReviewChange) -> Result<()> {
        let result=PrChangeResult::Uncertain{message:"This operation started without a confirmed result. Check GitHub before submitting again.".into()};
        self.db.execute("INSERT INTO pull_request_operations(request_id,pr_key,action_digest,state,data) VALUES(?1,?2,?3,'started',?4)",params![input.request_id,input.target.key.as_str(),format!("{:x}",Sha256::digest(serde_json::to_vec(input)?)),serde_json::to_string(&PrOperation{input:input.clone(),result})?])?;
        Ok(())
    }
    pub fn finish_pr_operation(
        &self,
        input: &PrReviewChange,
        result: &PrChangeResult,
    ) -> Result<()> {
        self.finish_pr_operations(&[(input, result)])
    }
    pub fn finish_pr_operations(
        &self,
        operations: &[(&PrReviewChange, &PrChangeResult)],
    ) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        for &(input, result) in operations {
            let previous = self.pr_operation(input)?.ok_or_else(|| {
                AppError::new("pr_receipt_missing", "The pull request receipt is missing.")
            })?;
            if !previous.pending() {
                continue;
            }
            tx.execute(
                "UPDATE pull_request_operations SET state=?2,data=?3 WHERE request_id=?1",
                params![
                    input.request_id,
                    match result {
                        PrChangeResult::Applied { .. }
                        | PrChangeResult::Confirmed { .. }
                        | PrChangeResult::Superseded { .. } => "applied",
                        PrChangeResult::Accepted { .. } => "pending",
                        PrChangeResult::Refused { .. } => "refused",
                        PrChangeResult::Uncertain { .. } => "uncertain",
                    },
                    serde_json::to_string(&PrOperation {
                        input: input.clone(),
                        result: result.clone()
                    })?
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        let mut s = self
            .db
            .prepare("SELECT data FROM workspaces ORDER BY rowid")?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|v| Ok(serde_json::from_str(&v?)?)).collect()
    }
    pub fn threads(&self) -> Result<Vec<ThreadSnapshot>> {
        let mut s = self.db.prepare("SELECT data FROM threads ORDER BY rowid")?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|v| Ok(serde_json::from_str(&v?)?)).collect()
    }
    pub fn workspace(&self, w: &Workspace) -> Result<()> {
        self.db.execute(
            "INSERT INTO workspaces(id,root,data) VALUES(?1,?2,?3)",
            params![
                w.id.to_string(),
                w.root.to_string_lossy(),
                serde_json::to_string(w)?
            ],
        )?;
        Ok(())
    }
    pub fn update_workspace(&self, w: &Workspace) -> Result<()> {
        self.db.execute(
            "UPDATE workspaces SET data=?2 WHERE id=?1",
            params![w.id.to_string(), serde_json::to_string(w)?],
        )?;
        Ok(())
    }
    pub fn remove_workspace(&mut self, id: &WorkspaceId) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM threads WHERE workspace_id=?1",
            [id.to_string()],
        )?;
        tx.execute("DELETE FROM workspaces WHERE id=?1", [id.to_string()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn save(&mut self, t: &ThreadSnapshot) -> Result<()> {
        self.db.execute("INSERT INTO threads(id,workspace_id,data) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![t.id.to_string(),t.workspace_id.to_string(),serde_json::to_string(t)?])?;
        Ok(())
    }
    pub fn ui_state(&self) -> Result<BTreeMap<String, String>> {
        let mut s = self.db.prepare("SELECT key,value FROM ui_state")?;
        let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    pub fn review_disposition(
        &self,
        workspace: &WorkspaceId,
        observation: &ReviewObservation,
    ) -> Result<Option<SavedDisposition>> {
        let data: Option<String> = self.db.query_row("SELECT data FROM review_dispositions WHERE workspace_id=?1 AND pr_id=?2 AND finding_id=?3", params![workspace.to_string(), observation.pr_id, observation.finding_id], |row| row.get(0)).optional()?;
        data.map(|data| serde_json::from_str(&data).map_err(Into::into))
            .transpose()
    }
    pub fn set_review_disposition(
        &self,
        workspace: &WorkspaceId,
        input: &SetReviewDisposition,
    ) -> Result<Option<SavedDisposition>> {
        let current = self.review_disposition(workspace, &input.observation)?;
        let next = input.choice.clone().map(|choice| SavedDisposition {
            observation: input.observation.clone(),
            choice,
        });
        if current == next {
            return Ok(current);
        }
        if current != input.expected {
            return Err(AppError::new(
                "review_decision_conflict",
                "This finding has a newer local decision. Refresh reviews before changing it.",
            ));
        }
        match &next {
            Some(saved) => {
                self.db.execute("INSERT INTO review_dispositions(workspace_id,pr_id,finding_id,data) VALUES(?1,?2,?3,?4) ON CONFLICT(workspace_id,pr_id,finding_id) DO UPDATE SET data=excluded.data", params![workspace.to_string(), input.observation.pr_id, input.observation.finding_id, serde_json::to_string(saved)?])?;
            }
            None => {
                self.db.execute("DELETE FROM review_dispositions WHERE workspace_id=?1 AND pr_id=?2 AND finding_id=?3", params![workspace.to_string(), input.observation.pr_id, input.observation.finding_id])?;
            }
        }
        Ok(next)
    }
    pub fn set_ui_state(&self, key: &str, value: Option<&str>) -> Result<()> {
        match value {
            Some(v) => self.db.execute("INSERT INTO ui_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, v])?,
            None => self.db.execute("DELETE FROM ui_state WHERE key=?1", [key])?,
        };
        Ok(())
    }
    pub fn delete_thread(&mut self, thread: &ThreadSnapshot) -> Result<()> {
        let tx = self.db.transaction()?;
        let turn_ids: Vec<String> = thread
            .turns
            .iter()
            .map(|turn| turn.id.to_string())
            .collect();
        let receipts: Vec<(String, String)> = {
            let mut query = tx.prepare("SELECT request_id, data FROM receipts")?;
            query
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?
        };
        for (id, data) in receipts {
            let receipt: Receipt = serde_json::from_str(&data)?;
            if turn_ids.contains(&receipt.turn_id.to_string()) {
                tx.execute("DELETE FROM receipts WHERE request_id=?1", [id])?;
            }
        }
        let terminal_state: Option<String> = tx
            .query_row(
                "SELECT value FROM ui_state WHERE key='z1:terminal-state'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(value) = terminal_state
            && let Ok(mut state) = serde_json::from_str::<serde_json::Value>(&value)
            && let Some(states) = state.as_object_mut()
            && states.remove(&thread.id.to_string()).is_some()
        {
            tx.execute(
                "UPDATE ui_state SET value=?1 WHERE key='z1:terminal-state'",
                [serde_json::to_string(&state)?],
            )?;
        }
        tx.execute("DELETE FROM threads WHERE id=?1", [thread.id.to_string()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn receipt(&self, id: &str, input: &str) -> Result<Option<Receipt>> {
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT input,data FROM receipts WHERE request_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            Some((saved, data)) if saved == input => Ok(Some(serde_json::from_str(&data)?)),
            Some(_) => Err(AppError::new(
                "request_conflict",
                "This operation ID was already used for different input.",
            )),
            None => Ok(None),
        }
    }
    pub fn accept(&mut self, t: &ThreadSnapshot, id: &str, input: &str, r: &Receipt) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE threads SET data=?2 WHERE id=?1",
            params![t.id.to_string(), serde_json::to_string(t)?],
        )?;
        tx.execute(
            "INSERT INTO receipts(request_id,input,data) VALUES(?1,?2,?3)",
            params![id, input, serde_json::to_string(r)?],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> Workspace {
        Workspace {
            id: WorkspaceId::default(),
            root: "/fixture".into(),
            label: "Fixture".into(),
            kind: WorkspaceKind::Repository,
        }
    }
    #[cfg(unix)]
    #[test]
    fn shutdown_releases_lock_even_when_a_child_inherits_its_file_description() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let inherited_fd = unsafe { libc::dup(store._lock.as_raw_fd()) };
        assert!(inherited_fd >= 0);
        let inherited = unsafe { std::fs::File::from_raw_fd(inherited_fd) };
        drop(store);
        assert_eq!(
            Store::open(dir.path()).err().unwrap().code,
            "already_running"
        );
        inherited.unlock().unwrap();
        drop(inherited);
        let store = Store::open(dir.path()).unwrap();
        let inherited = store._lock.try_clone().unwrap();
        store.close().unwrap();
        let reopened = Store::open(dir.path()).unwrap();
        drop(inherited);
        assert!(Store::open(dir.path()).is_err());
        reopened.close().unwrap();
    }
    #[test]
    fn migration_preserves_older_data_and_refuses_future_schema() {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("z1.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL); CREATE TABLE threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL); CREATE TABLE receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE ui_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO ui_state VALUES('old','preserved'); PRAGMA user_version=1;").unwrap();
        drop(db);
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(
            store.ui_state().unwrap().get("old").map(String::as_str),
            Some("preserved")
        );
        assert_eq!(
            store
                .db
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            3
        );
        let inherited = store._lock.try_clone().unwrap();
        store.close().unwrap();
        let db = Connection::open(dir.path().join("z1.sqlite")).unwrap();
        db.execute_batch("PRAGMA user_version=99;").unwrap();
        drop(db);
        assert_eq!(
            Store::open(dir.path()).err().unwrap().code,
            "unsupported_schema"
        );
        drop(inherited);
        let db = Connection::open(dir.path().join("z1.sqlite")).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            99
        );
    }
    #[test]
    fn disposition_storage_errors_do_not_report_saved_success() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let workspace = workspace();
        store.workspace(&workspace).unwrap();
        let input = SetReviewDisposition {
            observation: ReviewObservation {
                pr_id: "PR_test".into(),
                finding_id: "THREAD_test".into(),
                head_sha: "a".repeat(40),
                content_digest: "b".repeat(64),
            },
            expected: None,
            choice: Some(ReviewChoice::Fix),
        };
        store.db.execute_batch("PRAGMA query_only=ON;").unwrap();
        assert_eq!(
            store
                .set_review_disposition(&workspace.id, &input)
                .unwrap_err()
                .code,
            "storage"
        );
        assert!(
            store
                .review_disposition(&workspace.id, &input.observation)
                .unwrap()
                .is_none()
        );
    }
}
