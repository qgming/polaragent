// 启动一次真实应用，验证 P2-2 的启动清理对**真实数据目录**生效。
// 只看两件事：陈旧 .tmp 是否被清掉、进程能否正常退出（不卡在 before-quit 的清理上）。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const PORT = 19377;
const TMP = path.join(os.tmpdir(), "oint-startup-probe");
const USER_DATA = path.join(TMP, "userdata");
const OINT_HOME = path.join(os.homedir(), ".oint");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempFiles() {
  try {
    return fs.readdirSync(OINT_HOME).filter((n) => n.endsWith(".tmp"));
  } catch {
    return [];
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const before = tempFiles();
console.log(`启动前：真实数据目录里有 ${before.length} 个 .tmp`);

const env = { ...process.env, OINT_HOME };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

let exited = false;
let exitInfo = null;
child.on("exit", (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
});

try {
  // 等界面起来（说明启动流程已跑过 ensureAppDirs → purgeStaleTempFiles）
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !ready) {
    if (exited) throw new Error(`应用提前退出 ${JSON.stringify(exitInfo)}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      ready = list.some((item) => item.type === "page");
    } catch {
      /* 端口未就绪 */
    }
    if (!ready) await sleep(400);
  }
  if (!ready) throw new Error("等待界面超时");

  // 再等一拍，确保 startup 里的清理已经跑完
  await sleep(1500);
  const after = tempFiles();
  console.log(`启动后：${after.length} 个 .tmp`);
  const removed = before.filter((name) => !after.includes(name));
  console.log(`清掉 ${removed.length} 个：${removed.join(", ") || "(无)"}`);

  // 正常退出（走 before-quit 的清理路径），验证它不会卡住
  child.kill("SIGTERM");
  const exitDeadline = Date.now() + 15_000;
  while (!exited && Date.now() < exitDeadline) await sleep(300);
  console.log(
    exited
      ? `退出正常：${JSON.stringify(exitInfo)}`
      : "退出超时 —— before-quit 的清理可能卡住了",
  );

  const ok = removed.length === before.length && exited;
  console.log(ok ? "\n启动清理 + 退出流程：通过" : "\n启动清理 + 退出流程：未通过");
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.log(`探针异常：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (!exited) child.kill("SIGKILL");
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
}
