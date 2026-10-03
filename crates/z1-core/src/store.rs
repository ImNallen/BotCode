use crate::domain::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
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
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=1;")?;
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
