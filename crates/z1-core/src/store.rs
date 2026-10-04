use crate::domain::*;
use rusqlite::{Connection, OptionalExtension, params};
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
                "Another Z1 Code runtime owns this data directory.",
            )
        })?;
        let db = Connection::open(dir.join("z1.sqlite"))?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 2 {
            return Err(AppError::new(
                "unsupported_schema",
                "This data directory was saved by a newer Z1 Code. Open it with that version.",
            ));
        }
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        if version < 2 {
            db.execute_batch("BEGIN; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE review_dispositions(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, pr_id TEXT NOT NULL, finding_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id,pr_id,finding_id)); PRAGMA user_version=2; COMMIT;")?;
        }
        Ok(Self { db, _lock: lock })
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
            2
        );
        drop(store);
        let db = Connection::open(dir.path().join("z1.sqlite")).unwrap();
        db.execute_batch("PRAGMA user_version=99;").unwrap();
        drop(db);
        assert_eq!(
            Store::open(dir.path()).err().unwrap().code,
            "unsupported_schema"
        );
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
            branch: "fixture".into(),
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
