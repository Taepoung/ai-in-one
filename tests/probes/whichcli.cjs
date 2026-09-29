/**
 * **어댑터는 어느 `claude` 를 실행하나** (2026-09-29).
 *
 * 사용자 물음: *"사용자가 가진 cli를 쓰는거 아니야?"*
 *
 * 패키지 안에 `claude.exe` 가 들어 있는 것은 확인했다. 그런데 **들어 있는
 * 것과 그것을 쓰는 것은 다른 얘기다** — SDK 가 PATH 의 `claude` 를 먼저
 * 찾아볼 수도 있다. 코드를 읽어 짐작하지 말고 **띄워놓고 본다.**
 *
 *   `…/_npx/<해시>/node_modules/@anthropic-ai/…/claude.exe`  → 우리가 들고 온 것
 *   `C:/Users/…/.local/bin/claude`                            → 사용자 것
 *
 * 🔴 처음엔 «명령줄에 claude 가 든 프로세스» 를 다 긁었다. 그랬더니 지금 이
 * 작업을 하고 있는 Claude Code 자신과 VSCode 확장까지 32개가 걸려서 아무것도
 * 못 가렸다 — **넓게 재면 답이 안 나온다.** 우리가 띄운 것의 자손만 본다.
 */
const { spawn, execSync } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aio-which-"));
const CMD = process.platform === "win32" ? "npx.cmd" : "npx";
const proc = spawn(CMD, ["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"], {
  cwd, shell: true, stdio: ["pipe", "pipe", "pipe"],
});

let seq = 0, buf = "";
const waiting = new Map();
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { ok, bad } = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) bad(new Error(JSON.stringify(m.error))); else ok(m.result);
    } else if (m.method === "session/request_permission") {
      const o = m.params?.options?.[0];
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: o?.optionId } } });
    } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
proc.stderr.resume();
const call = (method, params) => new Promise((ok, bad) => {
  const id = ++seq; waiting.set(id, { ok, bad });
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error("timeout"))), 180000);
});

/** 프로세스 나무에서 `rootPid` 아래 전부 */
function descendants(rootPid) {
  const ps =
    "Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | " +
    "ConvertTo-Json -Depth 3 -Compress";
  const out = execSync("powershell -NoProfile -Command \"" + ps + "\"", {
    encoding: "utf8", maxBuffer: 120 * 1024 * 1024,
  });
  const all = JSON.parse(out || "[]");
  const rows = Array.isArray(all) ? all : [all];
  const kids = new Map();
  for (const r of rows) {
    const p = Number(r.ParentProcessId);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(r);
  }
  const found = [];
  const walk = (pid, depth) => {
    for (const r of kids.get(Number(pid)) || []) {
      found.push({ ...r, depth });
      walk(r.ProcessId, depth + 1);
    }
  };
  walk(rootPid, 0);
  return found;
}

(async () => {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  const sess = await call("session/new", { cwd, mcpServers: [] });
  console.log("세션 " + sess.sessionId);

  // 프롬프트를 실제로 보낸다 — 세션만 열고는 안 띄울 수도 있다
  const asking = call("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: "1+1 만 답해" }],
  });
  await new Promise((r) => setTimeout(r, 4000));

  const rows = descendants(proc.pid);
  console.log("\n[우리가 띄운 npx(" + proc.pid + ")의 자손 " + rows.length + "개]");
  const hits = [];
  for (const r of rows) {
    const exe = String(r.ExecutablePath || "");
    const cl = String(r.CommandLine || "");
    console.log("  " + "  ".repeat(r.depth) + (exe || "(경로없음)"));
    if (/claude/i.test(exe)) hits.push({ exe, cl });
  }

  console.log("\n[그중 실행파일 이름에 «claude» 가 든 것 " + hits.length + "개]");
  for (const r of hits) console.log("  " + r.exe);

  const bundled = hits.filter((r) => /_npx|node_modules/i.test(r.exe));
  const users = hits.filter((r) => /\.local|AppData\\Roaming\\npm|Program Files/i.test(r.exe));

  console.log("\n[판정]");
  console.log("  패키지에 든 것 : " + bundled.length + "개");
  console.log("  사용자 것      : " + users.length + "개");
  console.log(
    bundled.length && !users.length
      ? "  → **패키지에 든 claude 를 쓴다** — 사용자 CLI 와 무관하다"
      : users.length && !bundled.length
        ? "  → **사용자 CLI 를 쓴다** — 사용자가 올리면 따라 올라간다"
        : "  → 위 경로를 직접 읽어야 한다",
  );

  await asking.catch(() => undefined);
  proc.kill();
})().catch((e) => {
  console.error("실패:", (e && e.message) || e);
  proc.kill();
  process.exit(1);
});
