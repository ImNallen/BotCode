use std::{
    process::Command,
    time::{Duration, Instant},
};
use z1_core::*;
fn git(path: &std::path::Path, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(AppError::new(
            "git",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    Ok(())
}
async fn wait(app: &App, id: ThreadId, receipt: &Receipt) -> Result<(ThreadSnapshot, bool)> {
    let started = Instant::now();
    let mut incremental = false;
    loop {
        let snapshot = app.thread(id.clone()).await?;
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == receipt.turn_id)
            .ok_or_else(|| AppError::new("smoke", "Turn disappeared."))?;
        incremental |= turn
            .items
            .iter()
            .any(|i| matches!(i,Item::Assistant{complete:false,text,..} if !text.is_empty()));
        if !turn.execution.active() {
            if !matches!(turn.execution, Execution::Completed) {
                return Err(AppError::new("smoke", serde_json::to_string(turn)?));
            }
            return Ok((snapshot, incremental));
        }
        if started.elapsed() > Duration::from_secs(120) {
            app.shutdown().await?;
            return Err(AppError::new(
                "smoke",
                "Timed out waiting for real Codex completion.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("z1-smoke-{}", uuid::Uuid::new_v4()));
    let repository = root.join("repository");
    std::fs::create_dir_all(&repository)?;
    std::fs::write(
        repository.join("README.md"),
        "# Disposable Z1 smoke checkout\n",
    )?;
    git(&repository, &["init", "-q"])?;
    git(&repository, &["add", "README.md"])?;
    git(
        &repository,
        &[
            "-c",
            "user.name=Z1 Smoke",
            "-c",
            "user.email=z1@example.invalid",
            "commit",
            "-qm",
            "initial",
        ],
    )?;
    let mut config = RuntimeConfig::from_environment()?;
    config.data_dir = root.join("state");
    let app = App::open(config.clone()).await?;
    let workspace = app.open_workspace(repository.clone()).await?;
    let view = app.workspace_view(workspace.id.clone()).await?;
    assert_eq!(view.files, vec!["README.md"]);
    let thread = app.create_thread(workspace.id).await?;
    let receipt=app.submit(thread.id.clone(),"smoke-first".into(),"Do not use any tools or change files. Reply with Z1_CORE_OK followed by roughly 100 words about local applications.".into()).await?;
    let (first, streamed) = wait(&app, thread.id.clone(), &receipt).await?;
    let native = first
        .native_thread_id
        .clone()
        .ok_or("native thread id missing")?;
    assert!(
        first.turns[0]
            .items
            .iter()
            .any(|i| matches!(i,Item::Assistant{text,..} if text.contains("Z1_CORE_OK")))
    );
    assert!(
        streamed,
        "Real assistant text must appear before the final item."
    );
    app.shutdown().await?;
    let app = App::open(config).await?;
    let restored = app.thread(thread.id.clone()).await?;
    assert_eq!(restored.native_thread_id.as_deref(), Some(native.as_str()));
    assert_eq!(restored.turns.len(), 1);
    app.open_thread(thread.id.clone()).await?;
    for _ in 0..300 {
        if matches!(
            app.thread(thread.id.clone()).await?.session,
            SessionState::Ready
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let receipt = app
        .submit(
            thread.id.clone(),
            "smoke-second".into(),
            "Do not use tools or change files. Reply exactly Z1_RESUMED_OK.".into(),
        )
        .await?;
    let (second, _) = wait(&app, thread.id, &receipt).await?;
    assert_eq!(second.native_thread_id.as_deref(), Some(native.as_str()));
    assert_eq!(second.turns.len(), 2);
    assert!(
        second.turns[1]
            .items
            .iter()
            .any(|i| matches!(i,Item::Assistant{text,..} if text.contains("Z1_RESUMED_OK")))
    );
    app.shutdown().await?;
    assert_eq!(
        std::fs::read_to_string(repository.join("README.md"))?,
        "# Disposable Z1 smoke checkout\n"
    );
    let status = Command::new("git")
        .arg("-C")
        .arg(&repository)
        .args(["status", "--porcelain"])
        .output()?;
    assert!(status.stdout.is_empty());
    println!(
        "{}",
        serde_json::json!({"result":"passed","streamed":streamed,"nativeThreadId":native,"restoredTurns":second.turns.len(),"repositoryUnchanged":true,"stateDirectory":root.join("state")})
    );
    Ok(())
}
