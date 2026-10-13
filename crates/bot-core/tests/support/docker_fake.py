#!/usr/bin/env python3
"""A stand-in for the docker CLI, for tests of what Bot Code asks Docker to do.

Containers live as JSON files under the state directory this script's directory names in
`state_dir`. Every call is appended to `calls.jsonl` there. `exec` answers the in-image
scripts Bot Code runs with fixed replies, a terminal shell runs the Mac's own `sh`, and the
agent is the fake Codex peer, one copy per container.
Files in the state directory steer it:

- `fail-capture-<container>`    the mirror capture fails, so every pull fails
- `probe-cpu-usec-<container>`  the CPU counter the probe reports (default: never moves)
- `probe-clients-<container>`   connected desktop clients the probe reports (default 0)
- `probe-desktop-<container>`   whether the probe reports the desktop running (default
                                follows start and stop)
"""
import json, os, pathlib, sys, time

here = pathlib.Path(__file__).resolve().parent
state = pathlib.Path((here / "state_dir").read_text().strip())
state.mkdir(parents=True, exist_ok=True)
argv = sys.argv[1:]


def log(**fields):
    with (state / "calls.jsonl").open("a") as calls:
        calls.write(json.dumps({"time": time.time(), "argv": argv, **fields}) + "\n")


def container_file(name):
    return state / f"container-{name}.json"


def load(name):
    path = container_file(name)
    return json.loads(path.read_text()) if path.exists() else None


def save(name, record):
    container_file(name).write_text(json.dumps(record))


def missing(name):
    print(f"Error: No such container: {name}", file=sys.stderr)
    sys.exit(1)


def flag(name, default=None, container=None):
    """A steering file, per container (`<name>-<container>`) or for every container."""
    for path in ([state / f"{name}-{container}"] if container else []) + [state / name]:
        if path.exists():
            return path.read_text().strip()
    return default


def inspect_json(name, record):
    return {
        "Id": "fake-" + name,
        "Name": "/" + name,
        "State": {"Status": record["status"]},
        "Config": {"Labels": record["labels"]},
    }


log()
if argv[:1] == ["info"]:
    print("29.0.0 17179869184")
elif argv[:2] == ["image", "inspect"]:
    print("sha256:fake-image")
elif argv[:2] == ["image", "ls"]:
    for tag in (flag("images") or "").split():
        print(tag)
elif argv[:2] == ["image", "rm"]:
    tags = (flag("images") or "").split()
    (state / "images").write_text(" ".join(tag for tag in tags if tag != argv[2]))
elif argv[:1] == ["build"]:
    pass
elif argv[:2] == ["container", "ls"]:
    wanted = [arg.split("=", 2) for arg in argv if arg.startswith("label=") or arg.startswith("ancestor=")]
    for path in sorted(state.glob("container-*.json")):
        record = json.loads(path.read_text())
        name = path.name[len("container-"):-len(".json")]
        ok = True
        for arg in argv:
            if arg.startswith("label="):
                key, value = arg[len("label="):].split("=", 1)
                ok &= record["labels"].get(key) == value
            if arg.startswith("ancestor="):
                ok &= record["image"] == arg[len("ancestor="):]
        if ok:
            print(name)
elif argv[:2] == ["container", "inspect"] or argv[:1] == ["inspect"]:
    names = [arg for arg in argv[1 if argv[0] == "inspect" else 2:] if not arg.startswith("-") and arg != "{{.State.Status}}"]
    records = [(name, load(name)) for name in names]
    found = [inspect_json(name, record) for name, record in records if record]
    if "-f" in argv or "--format" in argv:
        for name, record in records:
            if record:
                print(record["status"])
    else:
        print(json.dumps(found))
    for name, record in records:
        if record is None:
            print(f"Error: No such container: {name}", file=sys.stderr)
    if len(found) < len(records):
        sys.exit(1)
elif argv[:1] == ["create"]:
    name = argv[argv.index("--name") + 1]
    labels = dict(arg.split("=", 1) for i, arg in enumerate(argv) if i > 0 and argv[i - 1] == "--label")
    save(name, {"status": "created", "labels": labels, "image": argv[-1]})
    print("fake-" + name)
elif argv[:1] in (["start"], ["pause"], ["unpause"], ["stop"], ["rm"]):
    verb = argv[0]
    name = argv[-1]
    record = load(name) or missing(name)
    if verb == "rm":
        container_file(name).unlink()
        print(name)
        sys.exit(0)
    transitions = {
        "start": ({"created", "exited"}, "running"),
        "pause": ({"running"}, "paused"),
        "unpause": ({"paused"}, "running"),
        "stop": ({"running"}, "exited"),
    }
    allowed, after = transitions[verb]
    if record["status"] not in allowed:
        print(f"Error response from daemon: Container {name} is {record['status']}, cannot {verb}", file=sys.stderr)
        sys.exit(1)
    record["status"] = after
    if verb == "stop":
        (state / f"desktop-{name}").unlink(missing_ok=True)
    save(name, record)
    print(name)
elif argv[:1] == ["port"]:
    print("127.0.0.1:60800")
elif argv[:1] == ["cp"]:
    pass
elif argv[:1] == ["exec"]:
    name = next(arg for arg in argv[1:] if load(arg) is not None or arg.startswith("botcode-"))
    record = load(name) or missing(name)
    if record["status"] != "running":
        print(f"Error response from daemon: container {name} is {record['status']}, unable to exec", file=sys.stderr)
        sys.exit(1)
    command = argv[argv.index(name) + 1:]
    if command and command[0] == "/opt/botcode/bin/run":
        command = command[1:]
        if command and command[0] == "--lifeline":
            command = command[1:]
        if command and command[0] == "--":
            command = command[1:]
    log(exec=command)
    program = command[0] if command else ""
    if program == "test":
        sys.exit(0)
    elif program == "/opt/botcode/bin/sync" and command[1:2] == ["capture"]:
        if flag("fail-capture", container=name) is not None:
            print("fixture: capture failed", file=sys.stderr)
            sys.exit(1)
        print(command[2] if len(command) > 2 else "0" * 40)
    elif program == "/opt/botcode/bin/probe":
        running = flag("probe-desktop", container=name)
        if running is None:
            running = "1" if (state / f"desktop-{name}").exists() else "0"
        cpu = flag("probe-cpu-usec", "1000", container=name)
        clients = flag("probe-clients", "0", container=name)
        print(f"cpu_usec={cpu} clients={clients} desktop={running}")
    elif program == "/opt/botcode/bin/desktop" and command[1:2] == ["start"]:
        sys.stdin.read()
        (state / f"desktop-{name}").touch()
    elif program == "/opt/botcode/bin/desktop" and command[1:2] == ["stop"]:
        (state / f"desktop-{name}").unlink(missing_ok=True)
    elif program == "/opt/botcode/bin/terminal" and command[1:2] == ["shell"]:
        os.execv("/bin/sh", ["sh"])
    elif program == "/opt/botcode/bin/terminal" and command[1:2] == ["ps"]:
        pass
    elif program == "/opt/botcode/bin/agent":
        # The peer keeps its state next to itself, so each container's agent gets a copy.
        peer_dir = state / f"peer-{name}"
        peer_dir.mkdir(exist_ok=True)
        peer = peer_dir / "codex_peer.py"
        if not peer.exists():
            peer.write_bytes((here / "codex_peer.py").read_bytes())
            peer.chmod(0o755)
        os.execv(sys.executable, [sys.executable, str(peer)])
    elif program == "sh":
        sys.stdin.read()
    sys.exit(0)
else:
    print(f"fixture: unsupported docker command {argv}", file=sys.stderr)
    sys.exit(2)
