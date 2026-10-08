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


def prepare(directory):
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
    parser.add_argument("action", choices=("prepare", "append-usage"))
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    if arguments.action == "prepare":
        prepare(arguments.directory.resolve())
    else:
        append(arguments.directory.resolve())
