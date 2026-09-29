/**
 * **핀을 올리기 전에 probe 를 전부 돌린다.**
 *
 * probe 는 진짜 CLI 를 띄우므로 `npm test` 에 안 넣는다(§검사 규칙). 그런데
 * **어댑터 핀을 올릴 때는 바로 이것들이 판정단**이다 — 우리가 «그렇다» 고
 * 적어둔 실측이 새 판에서도 «그렇다» 인지가 곧 올려도 되는지다.
 *
 * ```
 * node tests/probes/sweep.mjs            0.81.2 (지금 핀) 로 돌린다
 * node tests/probes/sweep.mjs 0.84.0     올리려는 판으로 돌린다
 * ```
 *
 * 각 probe 는 `AIO_ACP_VERSION` 을 읽는다. 둘을 따로 돌려 **줄 단위로
 * 비교**하는 것이 목적이라, 여기서는 판정을 하지 않고 **본 것을 적기만**
 * 한다 — `NO` 가 몇 개인지, 터졌는지, 얼마나 걸렸는지.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = process.argv[2] ?? "0.81.2";
const ONLY = process.argv.slice(3);
const PER_PROBE_MS = 15 * 60 * 1000;

/** 스스로 두 판을 띄우는 것들 — 판을 하나로 묶으면 뜻이 없어진다 */
const SKIP = new Set(["sweep.mjs", "bumpver.cjs", "bumpsafe.cjs", "aliasreal.cjs"]);
/** 사람이 봐야 뜻이 있는 것 */
const MANUAL = new Set(["delsess2.cjs", "steercli.cjs", "steersdk.mjs"]);

const files = fs
  .readdirSync(here)
  .filter((f) => /\.(cjs|mjs)$/.test(f) && !SKIP.has(f) && !MANUAL.has(f))
  .filter((f) => ONLY.length === 0 || ONLY.includes(f))
  .sort();

const outDir = path.join(here, "..", "..", ".probe-out", VERSION);
fs.mkdirSync(outDir, { recursive: true });

function run(file) {
  return new Promise((done) => {
    const started = Date.now();
    const proc = spawn(process.execPath, [path.join(here, file)], {
      cwd: path.join(here, "..", ".."),
      env: { ...process.env, AIO_ACP_VERSION: VERSION },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c) => { out += c; });
    proc.stderr.on("data", (c) => { out += c; });
    const killer = setTimeout(() => { out += "\n[sweep] 시간 초과로 끊음\n"; proc.kill(); }, PER_PROBE_MS);
    proc.on("close", (code) => {
      clearTimeout(killer);
      fs.writeFileSync(path.join(outDir, file + ".txt"), out, "utf8");
      const lines = out.split("\n");
      const no = lines.filter((l) => /^\s*NO\s+-/.test(l));
      const ok = lines.filter((l) => /^\s*OK\s+-/.test(l));
      done({
        file, code, ms: Date.now() - started,
        ok: ok.length, no: no.length,
        noLines: no.map((l) => l.trim()),
        threw: /실패:|Error:|timeout/.test(out) && ok.length === 0,
      });
    });
  });
}

console.log(`\n=== probe 쓸기 · 어댑터 ${VERSION} · ${files.length}개 ===`);
console.log(`(기록: ${path.relative(process.cwd(), outDir)})\n`);

const rows = [];
for (const f of files) {
  process.stdout.write(`  ${f.padEnd(20)} … `);
  const r = await run(f);
  rows.push(r);
  const secs = (r.ms / 1000).toFixed(0);
  console.log(
    `OK ${String(r.ok).padStart(2)} · NO ${String(r.no).padStart(2)} · ` +
    `exit ${String(r.code).padStart(3)} · ${secs}s` +
    (r.threw ? "  ← 아무것도 못 쟀다" : ""),
  );
  for (const l of r.noLines) console.log(`       ${l}`);
}

console.log(`\n=== 요약 (${VERSION}) ===`);
const bad = rows.filter((r) => r.no > 0 || r.threw);
console.log(`  잰 것 ${rows.length}개 · OK ${rows.reduce((a, r) => a + r.ok, 0)} · NO ${rows.reduce((a, r) => a + r.no, 0)}`);
if (bad.length === 0) console.log("  NO 가 하나도 없다");
else for (const r of bad) console.log(`  ${r.file}: NO ${r.no}${r.threw ? " · 못 쟀다" : ""}`);
