// Ports T3 Code v0.0.45 apps/server/src/project/NewProject.ts (MIT).
use crate::{AppError, Result, Workspace, vcs};
use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectResult {
    pub workspace: Workspace,
    pub commit_error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct NewProjectFolder {
    pub root: PathBuf,
    pub commit_error: Option<String>,
}

pub(crate) fn validate_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.encode_utf16().count() > 200 {
        return Err(AppError::new(
            "invalid_label",
            "Project name must contain between 1 and 200 characters.",
        ));
    }
    Ok(name)
}

fn folder_name(name: &str) -> String {
    let normalized: String = name
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .flat_map(char::to_lowercase)
        .collect();
    let mut slug = String::new();
    for c in normalized.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.truncate(64);
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        return "project".into();
    }
    let reserved = matches!(slug, "con" | "prn" | "aux" | "nul")
        || ((slug.starts_with("com") || slug.starts_with("lpt"))
            && slug.len() == 4
            && matches!(slug.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        format!("{slug}-project")
    } else {
        slug.into()
    }
}

fn icon_svg(name: &str) -> String {
    const BACKGROUNDS: [&str; 15] = [
        "#dc2626", "#ea580c", "#d97706", "#16a34a", "#059669", "#0d9488", "#0891b2", "#0284c7",
        "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#c026d3", "#db2777", "#e11d48",
    ];
    static WORDS: std::sync::OnceLock<RegexMatcher> = std::sync::OnceLock::new();
    let words = WORDS.get_or_init(|| RegexMatcher::new(r"[\p{L}\p{N}]+").unwrap());
    let mut initials = String::new();
    let mut count = 0;
    words
        .find_iter(name.as_bytes(), |word| {
            initials.push(name[word.start()..word.end()].chars().next().unwrap());
            count += 1;
            count < 2
        })
        .unwrap();
    let mut initials = initials.to_uppercase();
    if initials.is_empty() {
        initials = name.trim().chars().next().unwrap_or('?').to_string();
    }
    let hash = name
        .chars()
        .fold(0u32, |hash, c| hash.wrapping_mul(31).wrapping_add(c as u32));
    let background = BACKGROUNDS[hash as usize % BACKGROUNDS.len()];
    let size = if initials.encode_utf16().count() > 1 {
        26
    } else {
        32
    };
    let initials = initials
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n  <rect width=\"64\" height=\"64\" rx=\"14\" fill=\"{background}\"/>\n  <text x=\"32\" y=\"32\" dy=\"0.35em\" text-anchor=\"middle\" font-family=\"ui-sans-serif, system-ui, -apple-system, sans-serif\" font-size=\"{size}\" font-weight=\"600\" fill=\"#ffffff\">{initials}</text>\n</svg>\n"
    )
}

fn describe_commit_failure(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if [
        "identity unknown",
        "tell me who you are",
        "no name was given",
        "no email was given",
    ]
    .iter()
    .any(|message| lower.contains(message))
    {
        return "Git has no name or email on this machine. Set user.name and user.email, then commit.".into();
    }
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("Git could not make the first commit.")
        .into()
}

struct Git<'a> {
    root: &'a Path,
    config: &'a [&'a str],
}
impl Git<'_> {
    async fn run(&self, args: &[&str], seconds: u64) -> Result<vcs::Output> {
        let mut configured = Vec::new();
        for value in self.config {
            configured.extend(["-c", *value]);
        }
        configured.extend_from_slice(args);
        vcs::Tool {
            program: Path::new("git"),
            cwd: self.root,
        }
        .run(&configured, Duration::from_secs(seconds))
        .await
    }
    async fn execute(&self, args: &[&str]) -> Result<()> {
        let output = self.run(args, 10).await?;
        if output.code != Some(0) {
            return Err(AppError::new("git", output.stderr.trim()));
        }
        Ok(())
    }
}

pub(crate) async fn create_folder(
    root: &Path,
    name: &str,
    git_config: &[&str],
) -> Result<NewProjectFolder> {
    let name = validate_name(name)?;
    std::fs::create_dir_all(root)?;
    let slug = folder_name(name);
    let mut claimed = None;
    for attempt in 1..=100 {
        let candidate = root.join(if attempt == 1 {
            slug.clone()
        } else {
            format!("{slug}-{attempt}")
        });
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                claimed = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let root = claimed.ok_or_else(|| {
        AppError::new(
            "project_exists",
            format!("Every folder name for \"{slug}\" is taken."),
        )
    })?;
    let initialized = async {
        let git = Git { root: &root, config: git_config };
        let branch = git.run(&["config", "--get", "init.defaultBranch"], 10).await.ok().filter(|output| output.code == Some(0)).map(|output| output.stdout.trim().to_owned()).unwrap_or_else(|| "main".into());
        git.execute(&["init", &format!("--initial-branch={branch}")]).await?;
        std::fs::write(root.join("README.md"), format!("<img src=\"assets/icon.svg\" width=\"64\" height=\"64\" alt=\"\">\n\n# {name}\n\nCreated in [T3 Code](https://t3.codes).\n"))?;
        std::fs::create_dir(root.join("assets"))?;
        std::fs::write(root.join("assets/icon.svg"), icon_svg(name))?;
        git.execute(&["add", "--force", "--", "README.md", "assets/icon.svg"]).await?;
        let commit_error = match git.run(&["commit", "--message", "Initial commit"], 30).await {
            Ok(output) if output.code == Some(0) => None,
            Ok(output) => Some(describe_commit_failure(&output.stderr)),
            Err(error) => Some(error.message),
        };
        Ok(commit_error)
    }.await;
    match initialized {
        Ok(commit_error) => Ok(NewProjectFolder { root, commit_error }),
        Err(error) => {
            let _ = std::fs::remove_dir_all(root);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: tempfile::TempDir,
        config: Vec<String>,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let hooks = dir.path().join("hooks");
            std::fs::create_dir(&hooks).unwrap();
            Self {
                config: vec![
                    "user.name=Project Test".into(),
                    "user.email=project@example.invalid".into(),
                    "user.useConfigOnly=true".into(),
                    "commit.gpgSign=false".into(),
                    "init.defaultBranch=main".into(),
                    format!("init.templateDir={}", hooks.display()),
                    format!("core.hooksPath={}", hooks.display()),
                ],
                dir,
            }
        }
        fn root(&self) -> PathBuf {
            self.dir.path().join("projects")
        }
        async fn create(&self, name: &str) -> Result<NewProjectFolder> {
            let config: Vec<_> = self.config.iter().map(String::as_str).collect();
            create_folder(&self.root(), name, &config).await
        }
        fn git(&self, root: &Path, args: &[&str]) -> String {
            let output = crate::process::command("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        }
    }

    #[tokio::test]
    async fn creates_committed_starter_files_with_reference_content() {
        let mut f = Fixture::new();
        let ignored = f.dir.path().join("ignore");
        std::fs::write(&ignored, "*.svg\nREADME.md\n").unwrap();
        f.config
            .push(format!("core.excludesFile={}", ignored.display()));
        let project = f.create("  Café Project  ").await.unwrap();
        assert!(project.commit_error.is_none());
        assert_eq!(project.root, f.root().join("cafe-project"));
        assert_eq!(
            std::fs::read_to_string(project.root.join("README.md")).unwrap(),
            "<img src=\"assets/icon.svg\" width=\"64\" height=\"64\" alt=\"\">\n\n# Café Project\n\nCreated in [T3 Code](https://t3.codes).\n"
        );
        assert_eq!(
            std::fs::read_to_string(project.root.join("assets/icon.svg")).unwrap(),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n  <rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#e11d48\"/>\n  <text x=\"32\" y=\"32\" dy=\"0.35em\" text-anchor=\"middle\" font-family=\"ui-sans-serif, system-ui, -apple-system, sans-serif\" font-size=\"26\" font-weight=\"600\" fill=\"#ffffff\">CP</text>\n</svg>\n"
        );
        assert_eq!(
            f.git(&project.root, &["ls-tree", "-r", "--name-only", "HEAD"]),
            "README.md\nassets/icon.svg\n"
        );
        assert_eq!(
            f.git(&project.root, &["log", "-1", "--format=%s"]),
            "Initial commit\n"
        );
        assert_eq!(f.git(&project.root, &["status", "--porcelain"]), "");
        assert_eq!(
            f.git(&project.root, &["branch", "--show-current"]),
            "main\n"
        );
    }

    #[tokio::test]
    async fn respects_configured_default_branch() {
        let mut f = Fixture::new();
        f.config.push("init.defaultBranch=trunk".into());
        let project = f.create("Branch").await.unwrap();
        assert_eq!(
            f.git(&project.root, &["branch", "--show-current"]),
            "trunk\n"
        );
    }

    #[tokio::test]
    async fn failed_identity_keeps_an_openable_repository_and_staged_starter_files() {
        let mut f = Fixture::new();
        f.config.extend(["user.name=".into(), "user.email=".into()]);
        let project = f.create("No identity").await.unwrap();
        assert_eq!(
            project.commit_error.as_deref(),
            Some(
                "Git has no name or email on this machine. Set user.name and user.email, then commit."
            )
        );
        assert_eq!(
            crate::repo::open(&project.root).unwrap(),
            dunce::canonicalize(&project.root).unwrap()
        );
        assert_eq!(
            f.git(&project.root, &["diff", "--cached", "--name-only"]),
            "README.md\nassets/icon.svg\n"
        );
        assert!(project.root.join("README.md").is_file());
        assert!(project.root.join("assets/icon.svg").is_file());
    }

    #[tokio::test]
    async fn signing_failure_keeps_staged_starter_files() {
        let mut f = Fixture::new();
        f.config.extend([
            "commit.gpgSign=true".into(),
            format!("gpg.program={}", f.dir.path().join("missing-gpg").display()),
        ]);
        let project = f.create("Signing").await.unwrap();
        assert!(
            project
                .commit_error
                .unwrap()
                .contains("failed to write commit object")
        );
        assert_eq!(
            f.git(&project.root, &["diff", "--cached", "--name-only"]),
            "README.md\nassets/icon.svg\n"
        );
    }

    #[tokio::test]
    async fn concurrent_names_claim_separate_folders_without_replacing_existing_files() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root().join("same")).unwrap();
        std::fs::write(f.root().join("same/keep"), "keep").unwrap();
        let (first, second) = tokio::join!(f.create("Same"), f.create("Same"));
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first.root, second.root);
        let mut names = [
            first.root.file_name().unwrap(),
            second.root.file_name().unwrap(),
        ];
        names.sort();
        assert_eq!(names, ["same-2", "same-3"]);
        assert_eq!(
            std::fs::read_to_string(f.root().join("same/keep")).unwrap(),
            "keep"
        );
    }

    #[tokio::test]
    async fn initialization_failure_removes_only_the_folder_it_claimed() {
        let mut f = Fixture::new();
        std::fs::create_dir_all(f.root().join("broken")).unwrap();
        std::fs::write(f.root().join("broken/keep"), "keep").unwrap();
        f.config.push("init.defaultBranch=bad..branch".into());
        assert_eq!(f.create("Broken").await.unwrap_err().code, "git");
        assert!(!f.root().join("broken-2").exists());
        assert_eq!(
            std::fs::read_to_string(f.root().join("broken/keep")).unwrap(),
            "keep"
        );
    }

    #[tokio::test]
    async fn collision_limit_and_invalid_names_do_not_modify_existing_folders() {
        let f = Fixture::new();
        assert_eq!(f.create("  ").await.unwrap_err().code, "invalid_label");
        assert_eq!(
            f.create(&"a".repeat(201)).await.unwrap_err().code,
            "invalid_label"
        );
        assert!(!f.root().exists());
        for attempt in 1..=100 {
            std::fs::create_dir_all(f.root().join(if attempt == 1 {
                "taken".into()
            } else {
                format!("taken-{attempt}")
            }))
            .unwrap();
        }
        assert_eq!(f.create("Taken").await.unwrap_err().code, "project_exists");
        assert_eq!(std::fs::read_dir(f.root()).unwrap().count(), 100);
    }

    #[test]
    fn unicode_folder_names_match_reference_and_remain_portable() {
        for (name, expected) in [
            ("Hello, World!", "hello-world"),
            ("Café", "cafe"),
            ("Ｆｏｏ ①", "foo-1"),
            ("🚀项目", "project"),
            ("CON", "con-project"),
            ("lpt9", "lpt9-project"),
            ("com0", "com0"),
            (".. /../ Outside", "outside"),
        ] {
            assert_eq!(folder_name(name), expected);
        }
        assert_eq!(
            folder_name(&format!("{}-z", "a".repeat(63))),
            "a".repeat(63)
        );
        assert_eq!(folder_name(&"a".repeat(100)), "a".repeat(64));
        assert!(icon_svg("<&>").contains("&lt;</text>"));
        assert!(icon_svg("🚀").contains("font-size=\"26\""));
        assert!(icon_svg("\u{0345}a b").contains(">AB</text>"));
    }

    fn runtime_config(f: &Fixture) -> crate::RuntimeConfig {
        crate::RuntimeConfig {
            data_dir: f.dir.path().join("state"),
            codex_binary: f.dir.path().join("no-codex"),
            gh_binary: f.dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(1),
            shell: None,
        }
    }

    #[tokio::test]
    async fn app_registers_a_project_with_its_trimmed_name() {
        let f = Fixture::new();
        let app = crate::App::open(runtime_config(&f)).await.unwrap();
        assert_eq!(app.new_projects_root(), f.dir.path().join("state/projects"));
        let result = app
            .create_new_project("  Friendly Name  ".into())
            .await
            .unwrap();
        assert_eq!(result.workspace.label, "Friendly Name");
        assert_eq!(
            result.workspace.root,
            dunce::canonicalize(f.dir.path().join("state/projects/friendly-name")).unwrap()
        );
        assert_eq!(result.workspace.kind, crate::WorkspaceKind::Repository);
        assert_eq!(
            app.list_workspaces()
                .await
                .unwrap()
                .iter()
                .find(|w| w.id == result.workspace.id)
                .unwrap()
                .label,
            "Friendly Name"
        );
        assert_eq!(
            serde_json::to_value(&result).unwrap()["commitError"],
            result
                .commit_error
                .map_or(serde_json::Value::Null, serde_json::Value::String)
        );
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn registration_failure_removes_the_new_folder() {
        let f = Fixture::new();
        let app = crate::App::open(runtime_config(&f)).await.unwrap();
        let root = app.new_projects_root();
        std::fs::create_dir_all(root.join("keep")).unwrap();
        std::fs::write(root.join("keep/file"), "keep").unwrap();
        app.shutdown().await.unwrap();
        assert!(
            app.create_new_project("Registration failure".into())
                .await
                .is_err()
        );
        assert!(!root.join("registration-failure").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("keep/file")).unwrap(),
            "keep"
        );
    }
}
