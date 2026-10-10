#!/usr/bin/env python3
import os
import pathlib
import socketserver
import subprocess
import sys
import threading
import time

root = pathlib.Path(sys.argv[1]).resolve()


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        reader = client.makefile("rb", buffering=0)
        size = int(reader.read(4), 16)
        request = reader.read(size - 4)
        with (root / "clone-connections.log").open("ab") as log:
            log.write(request + b"\n")
        while not (root / "release-clone").exists():
            time.sleep(.05)
        env = dict(os.environ)
        if b"version=2" in request:
            env["GIT_PROTOCOL"] = "version=2"
        process = subprocess.Popen(["git", "upload-pack", "--strict", str(root / "clone-source" / ".git")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)

        def incoming():
            try:
                while packet := reader.read(65536):
                    process.stdin.write(packet)
                    process.stdin.flush()
            except (OSError, BrokenPipeError):
                pass
            finally:
                process.stdin.close()

        thread = threading.Thread(target=incoming, daemon=True)
        thread.start()
        try:
            while packet := process.stdout.read1(65536):
                client.sendall(packet)
                time.sleep(.04)
        except OSError:
            process.terminate()
        finally:
            process.wait()


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


with Server(("127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 0), Handler) as server:
    (root / "clone-port").write_text(str(server.server_address[1]))
    server.serve_forever()
