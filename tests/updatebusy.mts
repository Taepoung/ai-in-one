/**
 * **업데이트는 도는 것을 내리고 받는다** (사용자, 2026-11-19).
 *
 * 사용자: *"Claude을(를) 받지 못했습니다: npm error code EBUSY … copyfile"* ·
 * *"업데이트 누르면 세션들 내리고 업데이트 하면안됨?"*. 윈도우는 **도는 실행파일을 못
 * 덮어쓴다** — 붙잡은 것은 열린 방들과 Chrome 이 띄운 `claude.exe --chrome-native-host`
 * 였다. 지우기는 이미 내리고 시작했는데 업데이트는 안 그랬다.
 *
 * 여기서는 **진짜로 붙잡는다** — 받아둔 자리에 실행파일을 두고 띄운 채로, 그 파일을
 * 덮어쓰는 «npm» 을 물린다. 윈도우에서만 잰다(다른 OS 는 도는 파일도 갈아 끼운다).
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirFor, install, splitSpec, statusOf, type Run } from "../src/core/install/agentInstaller.js";
import { DEFAULT_AGENTS } from "../src/agents/index.js";
import { NODE_PIN } from "../src/core/install/nodePin.js";
import { nodeBinDir } from "../src/core/install/agentInstaller.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("  (윈도우에서만 — 다른 OS 는 도는 파일도 갈아 끼운다)");
    return;
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-busy-"));
  /* Node 는 받아진 척 — 안 그러면 install 이 nodejs.org 에서 진짜로 받는다 */
  fs.mkdirSync(path.join(root, "node"), { recursive: true });
  fs.writeFileSync(path.join(root, "node", "aio-node.json"), JSON.stringify({ version: NODE_PIN.version }));
  fs.mkdirSync(nodeBinDir(root), { recursive: true });
  fs.writeFileSync(path.join(nodeBinDir(root), "node.exe"), "");

  const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
  const dir = dirFor(root, claude.id);
  const { name, version } = splitSpec(claude.pkg!.spec!);
  const tree = (v: string) => {
    const home = path.join(dir, "node_modules", ...name.split("/"));
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ name, version: v }));
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, claude.pkg!.bin + ".cmd"), "");
  };
  tree("0.0.1");

  /* 받아둔 자리에서 «claude.exe» 가 돈다 — 진짜 실행파일(node)을 옮겨 띄운다 */
  const exe = path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.copyFileSync(process.execPath, exe);
  const held = spawn(exe, ["-e", "setInterval(() => {}, 1000)", "--", "--chrome-native-host"], { stdio: "ignore" });
  await nap(800);
  ok(held.exitCode === null, "붙잡는 것이 돈다");
  let blocked = false;
  try { fs.copyFileSync(process.execPath, exe); } catch (e) { blocked = /EBUSY|EPERM/.test(String(e)); }
  ok(blocked, "★ 돌고 있으면 덮어쓰지 못한다 — 사용자가 본 EBUSY 그대로");

  const lines: string[] = [];
  /** npm 흉내 — 실행파일을 새 것으로 덮어쓰고 새 판을 적는다 */
  const npm: Run = async () => {
    try {
      fs.copyFileSync(process.execPath, exe);
    } catch (e) {
      return { code: 1, say: `npm error code EBUSY\nnpm error syscall copyfile — ${String(e)}` };
    }
    tree(version);
    return { code: 0, say: "changed 1 package" };
  };
  const r = await install(dir, claude.pkg!, npm, (l) => lines.push(l));
  console.log(`   ${lines.join(" · ")} → ${r.ok ? "받았다" : r.say}`);
  ok(r.ok, "★ **업데이트가 된다** — 도는 것을 먼저 내렸다");
  ok(lines.some((l) => l.includes("내렸습니다")), "★ 내렸다고 말한다");
  await nap(300);
  ok(held.exitCode !== null || held.killed || held.signalCode !== null, "★ 붙잡던 것은 내려갔다");
  ok(!statusOf(dir, claude.pkg!).stale, "새 판이다");

  try { held.kill(); } catch { /* 이미 갔다 */ }
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n업데이트 — 다 통과");
}

main().catch((e) => { console.error(e); process.exit(1); });
