// Ported from T3 Code v0.0.45 packages/contracts/src/editor.ts, packages/shared/src/editor.ts and apps/server/src/process/externalLauncher.ts (MIT).
use crate::{domain::*, repo, vcs};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    num::NonZeroU32,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditorId {
    Cursor,
    Trae,
    Kiro,
    Vscode,
    VscodeInsiders,
    Vscodium,
    Zed,
    Antigravity,
    Idea,
    Aqua,
    Clion,
    Datagrip,
    Dataspell,
    Goland,
    Phpstorm,
    Pycharm,
    Rider,
    Rubymine,
    Rustrover,
    Webstorm,
    FileManager,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: NonZeroU32,
    pub column: Option<NonZeroU32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenTarget {
    /// `path` is checkout-relative; "" means the checkout root itself.
    Workspace {
        workspace_id: WorkspaceId,
        thread_id: Option<ThreadId>,
        path: String,
    },
    /// An absolute path that a message in this thread names.
    ChatLink { thread_id: ThreadId, path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchStyle {
    DirectPath,
    Goto,
    LineColumn,
    FileManager,
}

struct Editor {
    id: EditorId,
    label: &'static str,
    commands: &'static [&'static str],
    base_args: &'static [&'static str],
    style: LaunchStyle,
    /// `<name>.app` bundles under ~/Applications and /Applications holding the CLI.
    bundles: &'static [&'static str],
    /// Kiro's bundled binary is the IDE itself, so the CLI's `ide` subcommand must go.
    bundle_drops_base_args: bool,
}

const fn editor_entry(
    id: EditorId,
    label: &'static str,
    commands: &'static [&'static str],
    style: LaunchStyle,
    bundles: &'static [&'static str],
) -> Editor {
    Editor {
        id,
        label,
        commands,
        base_args: &[],
        style,
        bundles,
        bundle_drops_base_args: false,
    }
}
const fn jetbrains(
    id: EditorId,
    label: &'static str,
    commands: &'static [&'static str],
    bundles: &'static [&'static str],
) -> Editor {
    editor_entry(id, label, commands, LaunchStyle::LineColumn, bundles)
}

const EDITORS: [Editor; 21] = {
    use EditorId::*;
    use LaunchStyle::*;
    [
        Editor {
            // File and workspace opens must target the IDE even when the Agents Window is active.
            base_args: &["--classic"],
            ..editor_entry(Cursor, "Cursor", &["cursor"], Goto, &["Cursor"])
        },
        editor_entry(Trae, "Trae", &["trae"], Goto, &["Trae"]),
        Editor {
            base_args: &["ide"],
            bundle_drops_base_args: true,
            ..editor_entry(Kiro, "Kiro", &["kiro"], Goto, &["Kiro"])
        },
        editor_entry(Vscode, "VS Code", &["code"], Goto, &["Visual Studio Code"]),
        editor_entry(
            VscodeInsiders,
            "VS Code Insiders",
            &["code-insiders"],
            Goto,
            &["Visual Studio Code - Insiders"],
        ),
        editor_entry(Vscodium, "VSCodium", &["codium"], Goto, &["VSCodium"]),
        editor_entry(Zed, "Zed", &["zed", "zeditor"], DirectPath, &["Zed"]),
        // `agy` is the standalone CLI and `Antigravity.app` is the Hub, not the IDE.
        editor_entry(
            Antigravity,
            "Antigravity",
            &["antigravity-ide", "agy-ide"],
            Goto,
            &["Antigravity IDE"],
        ),
        jetbrains(
            Idea,
            "IntelliJ IDEA",
            &["idea"],
            &[
                "IntelliJ IDEA",
                "IntelliJ IDEA CE",
                "IntelliJ IDEA Ultimate",
            ],
        ),
        jetbrains(Aqua, "Aqua", &["aqua"], &["Aqua"]),
        jetbrains(Clion, "CLion", &["clion"], &["CLion"]),
        jetbrains(Datagrip, "DataGrip", &["datagrip"], &["DataGrip"]),
        jetbrains(Dataspell, "DataSpell", &["dataspell"], &["DataSpell"]),
        jetbrains(Goland, "GoLand", &["goland"], &["GoLand"]),
        jetbrains(Phpstorm, "PhpStorm", &["phpstorm"], &["PhpStorm"]),
        jetbrains(Pycharm, "PyCharm", &["pycharm"], &["PyCharm", "PyCharm CE"]),
        jetbrains(Rider, "Rider", &["rider"], &["Rider", "JetBrains Rider"]),
        jetbrains(Rubymine, "RubyMine", &["rubymine"], &["RubyMine"]),
        jetbrains(Rustrover, "RustRover", &["rustrover"], &["RustRover"]),
        jetbrains(Webstorm, "WebStorm", &["webstorm"], &["WebStorm"]),
        editor_entry(
            EditorId::FileManager,
            "File Manager",
            &[],
            LaunchStyle::FileManager,
            &[],
        ),
    ]
};

const OPEN: &str = "/usr/bin/open";

fn editor(id: EditorId) -> &'static Editor {
    EDITORS
        .iter()
        .find(|e| e.id == id)
        .expect("every EditorId has an EDITORS entry")
}

struct Roots {
    bins: Vec<PathBuf>,
    applications: Vec<PathBuf>,
    toolbox_scripts: Option<PathBuf>,
}
impl Roots {
    fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self {
            bins: vcs::bin_dirs(),
            applications: home
                .iter()
                .map(|home| home.join("Applications"))
                .chain([PathBuf::from("/Applications")])
                .collect(),
            toolbox_scripts: home
                .map(|home| home.join("Library/Application Support/JetBrains/Toolbox/scripts")),
        }
    }
}

struct Resolved {
    program: PathBuf,
    base_args: &'static [&'static str],
}

fn resolve(editor: &Editor, roots: &Roots) -> Option<Resolved> {
    let command = editor.commands.first().copied().unwrap_or_default();
    let in_bundle = match editor.style {
        LaunchStyle::FileManager => {
            return Some(Resolved {
                program: OPEN.into(),
                base_args: &[],
            });
        }
        LaunchStyle::Goto => vec![
            format!("Resources/app/bin/{command}"),
            "Resources/app/bin/code".into(),
        ],
        LaunchStyle::DirectPath => vec!["MacOS/cli".into()],
        LaunchStyle::LineColumn => vec![format!("MacOS/{command}")],
    };
    // The bundle's own launcher comes before PATH, unlike T3: a PATH command can be an
    // unrelated shim, such as Cursor's agent CLI in ~/.local/bin, which exits 1 without the IDE.
    let mut in_bundles = Vec::new();
    for root in &roots.applications {
        for name in editor.bundles {
            let contents = root.join(format!("{name}.app/Contents"));
            in_bundles.extend(in_bundle.iter().map(|binary| contents.join(binary)));
        }
    }
    if let Some(program) = in_bundles.into_iter().find(|path| vcs::is_executable(path)) {
        return Some(Resolved {
            program,
            base_args: if editor.bundle_drops_base_args {
                &[]
            } else {
                editor.base_args
            },
        });
    }
    let toolbox = roots
        .toolbox_scripts
        .iter()
        .filter(|_| editor.style == LaunchStyle::LineColumn)
        .map(|dir| dir.join(command));
    let program = editor
        .commands
        .iter()
        .flat_map(|command| roots.bins.iter().map(move |dir| dir.join(command)))
        .chain(toolbox)
        .find(|path| vcs::is_executable(path))?;
    Some(Resolved {
        program,
        base_args: editor.base_args,
    })
}

fn available_in(roots: &Roots) -> Vec<EditorId> {
    EDITORS
        .iter()
        .filter(|editor| resolve(editor, roots).is_some())
        .map(|editor| editor.id)
        .collect()
}
pub fn available_editors() -> Vec<EditorId> {
    available_in(&Roots::from_env())
}

fn launch_args(
    id: EditorId,
    base_args: &[&str],
    path: &Path,
    position: Option<Position>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = base_args.iter().map(OsString::from).collect();
    let target = |position: Position| {
        let mut target = path.as_os_str().to_owned();
        target.push(format!(":{}", position.line));
        if let Some(column) = position.column {
            target.push(format!(":{column}"));
        }
        target
    };
    match (editor(id).style, position) {
        (LaunchStyle::DirectPath, Some(position)) => args.push(target(position)),
        (LaunchStyle::Goto, Some(position)) => args.extend(["--goto".into(), target(position)]),
        (LaunchStyle::LineColumn, Some(Position { line, column })) => {
            args.extend(["--line".into(), line.to_string().into()]);
            // JetBrains counts columns from 0, unlike the 1-based columns links and the
            // other editors use. Observed in Rider 2026: `--column 6` placed the caret at 7.
            if let Some(column) = column {
                args.extend(["--column".into(), (column.get() - 1).to_string().into()]);
            }
            args.push(path.into());
        }
        (LaunchStyle::FileManager, _) | (_, None) => args.push(path.into()),
    }
    args
}

pub(crate) fn launch(id: EditorId, path: &Path, position: Option<Position>) -> Result<()> {
    let editor = editor(id);
    let resolved = resolve(editor, &Roots::from_env()).ok_or_else(|| {
        AppError::new(
            "editor_unavailable",
            format!("{} is not installed.", editor.label),
        )
    })?;
    let (program, args) = command_line(
        editor.style,
        resolved.program,
        launch_args(id, resolved.base_args, path, position),
    );
    spawn_and_watch(&program, &args, editor.label)
}
/// A JetBrains bundle binary is the IDE itself. Started directly, it would run as Bot Code's
/// child and macOS would ask for its file access in Bot Code's name, so it goes through
/// LaunchServices as JetBrains Toolbox's own launcher scripts do. `-n` lets the new launcher
/// hand the file to an IDE that is already running.
fn command_line(
    style: LaunchStyle,
    program: PathBuf,
    args: Vec<OsString>,
) -> (PathBuf, Vec<OsString>) {
    if style != LaunchStyle::LineColumn
        || !program.to_string_lossy().contains(".app/Contents/MacOS/")
    {
        return (program, args);
    }
    let mut open_args: Vec<OsString> = vec!["-na".into(), program.into(), "--args".into()];
    open_args.extend(args);
    (OPEN.into(), open_args)
}
fn spawn_and_watch(program: &Path, args: &[OsString], label: &str) -> Result<()> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| AppError::new("editor_launch", format!("Could not start {label}: {e}")))?;
    // CLI launchers hand off and exit at once, while a JetBrains binary may run as the IDE.
    // Waiting briefly surfaces a launcher that failed without blocking on one that did not.
    let deadline = std::time::Instant::now() + LAUNCH_GRACE;
    while std::time::Instant::now() < deadline {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                return Err(AppError::new(
                    "editor_launch",
                    format!("{label} could not open the file ({status})."),
                ));
            }
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    std::thread::spawn(move || child.wait());
    Ok(())
}
const LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

pub(crate) async fn reveal(path: &Path) -> Result<()> {
    let status = tokio::process::Command::new(OPEN)
        .arg("-R")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    if !status.success() {
        return Err(AppError::new(
            "open_failed",
            format!("Could not reveal {} in Finder.", path.display()),
        ));
    }
    Ok(())
}

pub(crate) fn checkout_path(root: &Path, path: &str) -> Result<PathBuf> {
    if path.is_empty() {
        return repo::existing(root);
    }
    repo::contained(root, path)
}

pub(crate) fn chat_link_path(thread: &ThreadSnapshot, path: &str) -> Result<PathBuf> {
    // A turn's opening message is its prompt; only steering messages become UserInput items.
    let mut texts = thread.turns.iter().flat_map(|turn| {
        let items = turn.items.iter().filter_map(|item| match item {
            Item::UserInput { text, .. }
            | Item::Assistant { text, .. }
            | Item::Plan { text, .. } => Some(text.as_str()),
            _ => None,
        });
        std::iter::once(turn.prompt.as_str()).chain(items)
    });
    if !Path::new(path).is_absolute() || !texts.any(|text| names(text, path)) {
        return Err(AppError::new(
            "invalid_path",
            "Only files named in this conversation can be opened.",
        ));
    }
    repo::existing(Path::new(path))
}

/// Whether `text` names `path` as a whole path, not as a prefix of a longer one, so naming
/// `/a/bc` does not also name `/a/b` or `/`. Markdown hrefs write spaces as `%20`.
fn names(text: &str, path: &str) -> bool {
    let encoded = path.replace(' ', "%20");
    [path, encoded.as_str()].into_iter().any(|needle| {
        text.match_indices(needle).any(|(start, _)| {
            let before = &text[..start];
            let starts = !before.chars().next_back().is_some_and(continues_path)
                || before.ends_with("file://");
            let mut after = text[start + needle.len()..].chars();
            let ends = match after.next() {
                None => true,
                Some('.') => !after.next().is_some_and(continues_path),
                Some(c) => !continues_path(c),
            };
            starts && ends
        })
    })
}
fn continues_path(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '/' | '\\' | '.' | '_' | '-' | '~' | '%')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn args(id: EditorId, base: &[&str], position: Option<(u32, Option<u32>)>) -> Vec<String> {
        let position = position.map(|(line, column)| Position {
            line: NonZeroU32::new(line).unwrap(),
            column: column.and_then(NonZeroU32::new),
        });
        launch_args(id, base, Path::new("/repo/a b.rs"), position)
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect()
    }

    #[test]
    fn editor_ids_match_t3_in_order() {
        let ids: Vec<_> = EDITORS
            .iter()
            .map(|e| serde_json::to_value(e.id).unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "cursor",
                "trae",
                "kiro",
                "vscode",
                "vscode-insiders",
                "vscodium",
                "zed",
                "antigravity",
                "idea",
                "aqua",
                "clion",
                "datagrip",
                "dataspell",
                "goland",
                "phpstorm",
                "pycharm",
                "rider",
                "rubymine",
                "rustrover",
                "webstorm",
                "file-manager",
            ]
        );
        assert_eq!(
            serde_json::from_str::<EditorId>("\"vscode-insiders\"").unwrap(),
            EditorId::VscodeInsiders
        );
    }

    #[test]
    fn launch_args_follow_each_style() {
        use EditorId::*;
        assert_eq!(args(Zed, &[], None), ["/repo/a b.rs"]);
        assert_eq!(args(Zed, &[], Some((12, None))), ["/repo/a b.rs:12"]);
        assert_eq!(args(Zed, &[], Some((12, Some(4)))), ["/repo/a b.rs:12:4"]);
        assert_eq!(
            args(Cursor, &["--classic"], None),
            ["--classic", "/repo/a b.rs"]
        );
        assert_eq!(
            args(Cursor, &["--classic"], Some((12, None))),
            ["--classic", "--goto", "/repo/a b.rs:12"]
        );
        assert_eq!(
            args(Vscode, &[], Some((12, Some(4)))),
            ["--goto", "/repo/a b.rs:12:4"]
        );
        assert_eq!(args(Rider, &[], None), ["/repo/a b.rs"]);
        assert_eq!(
            args(Rider, &[], Some((12, None))),
            ["--line", "12", "/repo/a b.rs"]
        );
        assert_eq!(
            args(Rider, &[], Some((12, Some(4)))),
            ["--line", "12", "--column", "3", "/repo/a b.rs"]
        );
        assert_eq!(
            args(FileManager, &[], Some((12, Some(4)))),
            ["/repo/a b.rs"]
        );
    }

    #[test]
    fn positions_reject_zero_and_default_a_missing_column() {
        let position: Position = serde_json::from_str(r#"{"line":12}"#).unwrap();
        assert_eq!(position.line.get(), 12);
        assert_eq!(position.column, None);
        assert!(serde_json::from_str::<Position>(r#"{"line":0,"column":null}"#).is_err());
    }

    fn touch(path: &Path, mode: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn detection_reads_path_app_bundles_and_toolbox_and_needs_the_executable_bit() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let apps = dir.path().join("Applications");
        let toolbox = dir.path().join("toolbox");
        let roots = Roots {
            bins: vec![bin.clone()],
            applications: vec![apps.clone()],
            toolbox_scripts: Some(toolbox.clone()),
        };
        assert_eq!(available_in(&roots), [EditorId::FileManager]);

        touch(&bin.join("zeditor"), 0o755);
        touch(&bin.join("code"), 0o644);
        touch(
            &apps.join("Cursor.app/Contents/Resources/app/bin/cursor"),
            0o755,
        );
        touch(&apps.join("Rider.app/Contents/MacOS/rider"), 0o755);
        touch(
            &apps.join("Kiro.app/Contents/Resources/app/bin/code"),
            0o755,
        );
        touch(&toolbox.join("goland"), 0o755);
        assert_eq!(
            available_in(&roots),
            [
                EditorId::Cursor,
                EditorId::Kiro,
                EditorId::Zed,
                EditorId::Goland,
                EditorId::Rider,
                EditorId::FileManager,
            ]
        );

        let resolved = |id| resolve(editor(id), &roots).unwrap();
        assert_eq!(resolved(EditorId::Zed).program, bin.join("zeditor"));
        let cursor = resolved(EditorId::Cursor);
        assert_eq!(
            cursor.program,
            apps.join("Cursor.app/Contents/Resources/app/bin/cursor")
        );
        assert_eq!(cursor.base_args, ["--classic"]);
        assert!(
            resolved(EditorId::Kiro).base_args.is_empty(),
            "Kiro's bundled binary takes no `ide` subcommand"
        );
        assert_eq!(resolved(EditorId::FileManager).program, Path::new(OPEN));

        touch(&bin.join("cursor"), 0o755);
        touch(&bin.join("kiro"), 0o755);
        assert_eq!(
            resolved(EditorId::Cursor).program,
            apps.join("Cursor.app/Contents/Resources/app/bin/cursor"),
            "the bundle's launcher wins over a PATH shim of the same name"
        );
        assert!(resolved(EditorId::Kiro).base_args.is_empty());
        std::fs::remove_dir_all(apps.join("Kiro.app")).unwrap();
        assert_eq!(resolved(EditorId::Kiro).program, bin.join("kiro"));
        assert_eq!(resolved(EditorId::Kiro).base_args, ["ide"]);
    }

    #[test]
    fn jetbrains_bundle_binaries_launch_through_launchservices() {
        let rider = PathBuf::from("/Applications/Rider.app/Contents/MacOS/rider");
        let (program, args) = command_line(
            LaunchStyle::LineColumn,
            rider,
            vec!["--line".into(), "12".into(), "/repo/a b.rs".into()],
        );
        assert_eq!(program, Path::new(OPEN));
        assert_eq!(
            args,
            [
                "-na",
                "/Applications/Rider.app/Contents/MacOS/rider",
                "--args",
                "--line",
                "12",
                "/repo/a b.rs"
            ]
            .map(OsString::from)
        );
        let toolbox =
            PathBuf::from("/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/rider");
        assert_eq!(
            command_line(
                LaunchStyle::LineColumn,
                toolbox.clone(),
                vec!["/repo/a.rs".into()]
            ),
            (toolbox, vec![OsString::from("/repo/a.rs")])
        );
        let zed = PathBuf::from("/Applications/Zed.app/Contents/MacOS/cli");
        assert_eq!(
            command_line(
                LaunchStyle::DirectPath,
                zed.clone(),
                vec!["/repo/a.rs".into()]
            ),
            (zed, vec![OsString::from("/repo/a.rs")])
        );
    }

    #[test]
    fn a_launcher_that_exits_nonzero_reports_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let failing = dir.path().join("fails");
        std::fs::write(&failing, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = spawn_and_watch(&failing, &[], "Cursor").unwrap_err();
        assert_eq!(error.code, "editor_launch");
        assert_eq!(
            error.message,
            "Cursor could not open the file (exit status: 1)."
        );
        let succeeding = dir.path().join("succeeds");
        std::fs::write(&succeeding, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&succeeding, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(spawn_and_watch(&succeeding, &[], "Cursor").is_ok());
    }

    #[test]
    fn a_path_is_named_only_as_a_whole_path() {
        let text = "Edited [notes](/tmp/my%20notes.md:3) and `/tmp/src/lib.rs`. See file:///tmp/x.";
        assert!(names(text, "/tmp/my notes.md"));
        assert!(names(text, "/tmp/src/lib.rs"));
        assert!(names(text, "/tmp/x"));
        assert!(!names(text, "/tmp/src"));
        assert!(!names(text, "/tmp/src/lib"));
        assert!(!names(text, "/"));
        assert!(!names(text, "/src/lib.rs"));
        assert!(!names(text, "/tmp/my notes"));
    }
}
