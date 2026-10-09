<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Bot Code logo" width="120" height="120" />
</p>

# Bot Code

A desktop workspace for coding with Codex.

Bot Code brings your conversations, files, Git diffs, terminals, and browser preview into one app. It runs on macOS and Windows and uses your installed Codex CLI and account. The interface follows T3 Code's layout, with conversations in the sidebar, chat in the center, and tools in an optional right panel.

## What you can do

- Work in a Git repository or a separate worktree, with a conversation for each task.
- Start without a project when you need a scratch folder.
- Search saved conversations by title or message text, including history from earlier app sessions.
- Give Codex context through file mentions, skills, images, and other attachments.
- Browse and edit files, inspect changes, and run commands in a terminal.
- Preview a website or local dev server without leaving the conversation.
- Commit changes, open GitHub pull requests, submit reviews and comments, reply to review conversations, and resolve or reopen them when GitHub permits.
- Inspect Codex subscription limits, token history, and API-equivalent cost estimates.

Conversations survive restarting the app. You can choose the model, reasoning effort, and permissions for each conversation.

## Run locally

Install these before you start:

- Node.js 22.18 or newer and pnpm 10.32.1.
- Rust 1.89 or newer and Git.
- The Codex CLI, signed in to your account.
- The [Tauri prerequisites for your platform](https://v2.tauri.app/start/prerequisites/). macOS needs Xcode Command Line Tools. Windows needs Microsoft C++ Build Tools and WebView2.

From the root of this repository, run:

```sh
pnpm install
pnpm tauri dev
```

The desktop app opens after the first build. `pnpm dev` starts only the frontend, which needs the native runtime to work.

For GitHub pull requests and reviews, also install the GitHub CLI and run `gh auth login`.

macOS has been checked in the native app. Windows has CI build and unit-test coverage, but its native interface still needs verification.

## Start your first conversation

1. Choose **Add project** and select a Git repository, or choose **Start without a project**.
2. Choose your model and permissions in the composer.
3. Describe the task and press **Enter** to send. **Shift+Enter** adds a new line.
4. Follow Codex's work in the conversation. Open the right tools panel to inspect files, diffs, or a preview.

Type `@` to add a file, `$` to select a skill, or `/` to open commands. While Codex works, you can queue a follow-up or steer the current turn.

The [user guide](docs/user-guide.md) covers attachments, planning, approvals, worktrees, pull requests, settings, and recovery.

## Useful shortcuts

| Action                       | macOS                | Windows          |
| ---------------------------- | -------------------- | ---------------- |
| Open the command palette     | Command + K          | Ctrl + K         |
| Find a file                  | Command + P          | Ctrl + P         |
| Search project contents      | Command + Shift + F  | Ctrl + Shift + F |
| Toggle the terminal          | Command + J          | Ctrl + J         |
| Start a scratch conversation | Command + Option + N | Ctrl + Alt + N   |
| Open settings                | Command + ,          | Ctrl + ,         |

Change these in **Settings > Keyboard shortcuts**. A focused terminal keeps its own input shortcuts.

## Your data

Bot Code stores conversation history, settings, worktrees, and attachments in `~/.z1`, retained from its earlier name. Set `BOT_CODE_DATA_DIR` to use another directory.

Your Codex account and credentials stay with the Codex CLI. See [storage and recovery](docs/user-guide.md#state-and-recovery) for cleanup options and what survives a restart.

## For contributors

Bot Code is built with Rust, Tauri 2, React, and SQLite. The [architecture notes](docs/architecture.md) explain how the app fits together. The [UI baseline](docs/ui-baseline.md) describes its layout and interaction conventions.

See [builds and checks](docs/user-guide.md#build-and-check-the-app) for development commands and [verification records](docs/verification.md) for native app checks.

AI coding assistants use [AGENTS.md](AGENTS.md) for repository instructions.
