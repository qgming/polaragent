const { spawn } = require("node:child_process");
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2).filter((arg) => {
  if (arg === "--dev") {
    env.VITE_DEV_SERVER_URL ||= "http://127.0.0.1:1420";
    return false;
  }
  return true;
});

const child = spawn(electronPath, args,
{
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
