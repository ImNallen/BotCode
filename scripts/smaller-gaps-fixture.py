#!/usr/bin/env python3
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import time


def timestamp(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event(at, input_tokens, cached, cache_write, output, reasoning):
    return {
        "timestamp": timestamp(at),
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "last_token_usage": {
                    "input_tokens": input_tokens,
                    "cached_input_tokens": cached,
                    "cache_write_input_tokens": cache_write,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                }
            },
        },
    }


def context(model):
    return {"type": "turn_context", "payload": {"model": model}}


def prepare(directory, pr_code=False):
    source = Path(__file__).resolve().parents[1]
    subprocess.run(
        ["python3", str(source / "scripts/pr-handoff-fixture.py"), str(directory)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    home = directory / "codex-home"
    sessions = home / "sessions"
    sessions.mkdir(parents=True)
    now = datetime.now(timezone.utc)
    first = event(now - timedelta(days=1, hours=2), 1000, 200, 0, 100, 40)
    records = [
        {"timestamp": timestamp(now - timedelta(days=2)), "type": "session_meta", "payload": {"id": "outside-bot-session"}},
        context("gpt-fixture-a"),
        first,
        first,
        event(now - timedelta(hours=2), 2000, 500, 0, 200, 50),
        context("gpt-fixture-b"),
        event(now - timedelta(hours=1), 500, 100, 50, 50, 20),
        context("unknown-fixture"),
        event(now - timedelta(minutes=30), 100, 0, 0, 10, 0),
    ]
    rollout = sessions / "rollout-fixture.jsonl"
    rollout.write_text("".join(json.dumps(row) + "\n" for row in records))
    rates = {
        model: {
            "input_cost_per_token": 0.000002,
            "cache_read_input_token_cost": 0.0000005,
            "cache_creation_input_token_cost": 0.000003,
            "output_cost_per_token": 0.000008,
        }
        for model in ("gpt-fixture-a", "gpt-fixture-b")
    }
    (directory / "fixture-rates.json").write_text(json.dumps({
        "version": 1,
        "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        "fetchedAtMs": int(time.time() * 1000),
        "document": rates,
    }, indent=2))
    manifest = json.loads((directory / "manifest.json").read_text())
    manifest.update({
        "codexHome": str(home),
        "rollout": str(rollout),
        "usageExpected": {
            "tokens": 3960,
            "uncachedInput": 2750,
            "cachedInput": 800,
            "cacheCreation": 50,
            "output": 360,
            "reasoning": 110,
            "estimatedCostUsd": 0.00865,
            "unpricedTokens": 110,
            "past24hTokens": 2860,
        },
    })
    if pr_code:
        repo = directory / "repo"

        def git(*arguments):
            return subprocess.check_output(["git", "-C", str(repo), *arguments]).decode().strip()

        git("checkout", "feature")
        (repo / "calculate.ts").write_text("export const value = 2;\n")
        git("add", "calculate.ts")
        git("commit", "-qm", "Update calculation")
        first = git("rev-parse", "HEAD")
        (repo / "note.md").write_text("This change is in the latest commit only.\n")
        git("add", "note.md")
        git("commit", "-qm", "Document calculation")
        latest = git("rev-parse", "HEAD")
        git("checkout", "main")
        remote = directory / "remote.git"
        subprocess.run(["git", "--git-dir", str(remote), "fetch", str(repo), "feature:feature"], check=True)
        subprocess.run(["git", "--git-dir", str(remote), "update-ref", "refs/pull/41/head", latest], check=True)
        files = [
            {"filename": "calculate.ts", "status": "added", "additions": 1, "deletions": 0,
             "patch": "@@ -0,0 +1 @@\n+export const value = 2;"},
            {"filename": "note.md", "status": "added", "additions": 1, "deletions": 0,
             "patch": "@@ -0,0 +1 @@\n+This change is in the latest commit only."},
        ]
        state_path = directory / "gh.json"
        state = json.loads(state_path.read_text())
        state.update({
            "head": latest, "files": files, "additions": 2, "deletions": 0, "changedFiles": 2,
            "viewedStates": {file["filename"]: "UNVIEWED" for file in files},
            "commits": [
                {"oid": oid, "messageHeadline": headline, "committedDate": at,
                 "author": {"name": "Contributor", "user": {"login": "contributor"}}}
                for oid, headline, at in [
                    (first, "Update calculation", "2026-10-08T12:00:00Z"),
                    (latest, "Document calculation", "2026-10-09T12:00:00Z"),
                ]
            ],
            "commitFiles": {
                first: [{"filename": "calculate.ts", "status": "modified", "additions": 1, "deletions": 1,
                         "patch": "@@ -1 +1 @@\n-export const calculate = (n: number) => n + 1;\n+export const value = 2;"}],
                latest: [files[1]],
            },
        })
        state_path.write_text(json.dumps(state, indent=2))
        (directory / "baseline-gh.json").write_text(json.dumps(state, indent=2))
        manifest.update({"head": latest, "commitA": first, "commitB": latest})
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def append(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    at = datetime.now(timezone.utc) - timedelta(seconds=1)
    with Path(manifest["rollout"]).open("a") as stream:
        stream.write(json.dumps(context("gpt-fixture-a")) + "\n")
        stream.write(json.dumps(event(at, 10000, 2000, 0, 1000, 500)) + "\n")
    print(json.dumps({"tokensAdded": 11000, "tokens": 14960, "past24hTokens": 13860, "estimatedCostUsd": 0.03365}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare disposable native feature-gap fixtures.")
    parser.add_argument("action", choices=("prepare", "prepare-pr-code", "append-usage"))
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    if arguments.action in ("prepare", "prepare-pr-code"):
        prepare(arguments.directory.resolve(), pr_code=arguments.action == "prepare-pr-code")
    else:
        append(arguments.directory.resolve())
