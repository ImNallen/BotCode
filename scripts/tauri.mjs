import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const host = "127.0.0.1";
const args = process.argv.slice(2);

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, host);
  });
}

if (args[0] === "dev") {
  let port = 1420;
  while (!(await isFree(port))) port++;
  const build = {
    devUrl: `http://${host}:${port}`,
    beforeDevCommand: `pnpm dev --port ${port}`,
  };
  args.push("--config", JSON.stringify({ build }));
  if (port !== 1420) console.log(`Port 1420 is in use. Using ${port}.`);
}

// Windows cannot spawn the tauri.cmd shim without a shell, which would mangle the JSON config.
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
spawn(process.execPath, [cli, ...args], { stdio: "inherit" }).on(
  "exit",
  (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  },
);
