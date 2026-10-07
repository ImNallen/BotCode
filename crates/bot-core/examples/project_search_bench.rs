use bot_core::*;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Pass the disposable 50,002-file repository path.")?,
    );
    for iteration in 0..5 {
        let state = tempfile::tempdir()?;
        let app = App::open(RuntimeConfig {
            data_dir: state.path().to_owned(),
            codex_binary: "/usr/bin/false".into(),
            gh_binary: "/usr/bin/false".into(),
            network_timeout: Duration::from_secs(1),
            shell: None,
        })
        .await?;
        let workspace = app.open_workspace(root.clone()).await?;
        let start = Instant::now();
        let view = app.workspace_view(workspace.id.clone(), None).await?;
        assert_eq!(view.files.len(), 50_002);
        assert_eq!(view.file_coverage, SearchCoverage::Complete);
        assert!(
            view.files
                .iter()
                .all(|path| !path.contains("ignored") && !path.starts_with(".git/"))
        );
        println!(
            "{iteration}\tcold_workspace_ms\t{:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        let start = Instant::now();
        let payload = serde_json::to_vec(&view)?;
        println!(
            "{iteration}\tworkspace_json_ms\t{:.3}\tbytes\t{}",
            start.elapsed().as_secs_f64() * 1000.0,
            payload.len()
        );
        for (sequence, label, query, limit) in [
            (1, "picker_ms", "file-099", 200),
            (2, "mention_ms", "file-099", 50),
        ] {
            let start = Instant::now();
            let paths = app
                .search_paths(
                    workspace.id.clone(),
                    None,
                    "benchmark".into(),
                    sequence,
                    PathSearchInput {
                        query: query.into(),
                        limit,
                        refresh: false,
                    },
                )
                .await?;
            assert_eq!(paths.indexed_files, 50_002);
            assert_eq!(paths.generation, 1);
            assert_eq!(paths.index_coverage, SearchCoverage::Complete);
            assert_eq!(paths.paths.len(), limit);
            assert!(paths.truncated);
            println!(
                "{iteration}\t{label}\t{:.3}\tpaths\t{}",
                start.elapsed().as_secs_f64() * 1000.0,
                paths.paths.len()
            );
        }
        for (sequence, label, query) in [
            (3, "absent_content_ms", "absent_content_a3819"),
            (4, "tail_content_ms", "project_content_target_7c391"),
            (5, "capped_content_ms", "common_search_sentinel"),
        ] {
            let start = Instant::now();
            let result = app
                .search_contents(
                    workspace.id.clone(),
                    None,
                    "benchmark".into(),
                    sequence,
                    ContentSearchInput {
                        query: query.into(),
                        case_sensitive: false,
                        whole_word: false,
                        use_regex: false,
                        refresh: false,
                    },
                )
                .await?;
            assert_eq!(result.index_coverage, SearchCoverage::Complete);
            assert_eq!(result.skipped_files, 0);
            if sequence == 3 {
                assert!(result.matches.is_empty());
                assert_eq!(result.coverage, SearchCoverage::Complete);
                assert_eq!(result.searched_files, 50_002);
            }
            if sequence == 4 {
                assert_eq!(result.matches.len(), 1);
                assert_eq!(result.matches[0].path, "shard-499/file-099.txt");
                assert_eq!(result.matches[0].line_number, 321);
                assert_eq!(result.coverage, SearchCoverage::Complete);
            }
            if sequence == 5 {
                assert_eq!(result.matches.len(), 500);
                assert!(matches!(result.coverage, SearchCoverage::Limited { .. }));
            }
            println!(
                "{iteration}\t{label}\t{:.3}\tmatches\t{}\tsearched\t{}\tskipped\t{}\tcoverage\t{}",
                start.elapsed().as_secs_f64() * 1000.0,
                result.matches.len(),
                result.searched_files,
                result.skipped_files,
                serde_json::to_string(&result.coverage)?
            );
        }
        app.shutdown().await?;
    }
    Ok(())
}
