/**
 * **검사가 남긴 찌꺼기를 치운다** (2026-09-30).
 *
 * 사용자 확인: *"테스트 하면서 codex에도 세션이 쌓인거 같은데 (원래 지워져야
 * 정상)"* · *"Claude code도 마찬가지고, (세션이 사라지지만 폴더가 남아서
 * cli에서는 볼 수 있을 지도)"* · *"2일전 활성 세션"*.
 *
 * 세 가지가 남아 있었다:
 *
 * ```
 * ① ~/.codex/sessions/…      임시폴더에서 만든 Codex 세션     우리가 안 치웠다
 * ② ~/.claude/projects/…     임시폴더 슬러그 (세션은 0개)     폴더만 남았다
 * ③ ~/.claude/projects/…     **껍데기** — 대화가 0줄인 세션   지워도 파일이 남는다
 * ```
 *
 * ③이 «2일전 활성 세션» 의 정체다. `session/delete` 는 대화를 지우고
 * `--resume` 도 막지만 **파일은 남긴다**(`last-prompt`·`cost-state` 만 들어
 * 있다). CLI 목록에는 그게 여전히 세션으로 보인다.
 *
 * ⚠️ **사용자의 진짜 대화는 건드리지 않는다.** 지우는 것은
 *   · 임시폴더(`aio-…`)에서 만든 것, 또는
 *   · **대화 메시지가 한 줄도 없는** 껍데기
 * 뿐이고, **한 시간 안에 손댄 것은 뺀다** — 지금 도는 세션을 지우면 그 판이
 * 통째로 깨진다(`all.mjs` 의 찌꺼기 청소와 같은 규칙).
 *
 * ```
 * node tests/probes/cleanup.mjs         무엇을 지울지 보여주기만 한다
 * node tests/probes/cleanup.mjs --yes   실제로 지운다
 * ```
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GO = process.argv.includes("--yes");
const HOUR = 60 * 60 * 1000;
const HOME = os.homedir();

const fresh = (p) => {
  try { return Date.now() - fs.statSync(p).mtimeMs < HOUR; } catch { return true; }
};

/** 임시폴더에서 만든 흔적인가 */
const fromTemp = (s) => /aio-[a-z0-9]+-[A-Za-z0-9]+/.test(s);

/**
 * 대화가 한 줄도 없는 «껍데기» 인가.
 *
 * 실제 대화 줄은 `type` 이 `user`·`assistant` 다. 껍데기에는 `last-prompt`·
 * `atis-latch`·`cost-state` 만 들어 있다 — 지운 세션이 남긴 부스러기다.
 */
function isHusk(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  if (text.length > 20000) return false;            // 큰 것은 볼 것도 없다
  let said = 0, lines = 0;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    lines++;
    let d;
    try { d = JSON.parse(s); } catch { return false; }
    if (d.type === "user" || d.type === "assistant") said++;
  }
  return lines > 0 && said === 0;
}

const plan = { codex: [], slug: [], husk: [] };

// ── ① Codex 세션 — 임시폴더에서 만든 것 ──────────────────────────
const cxRoot = path.join(HOME, ".codex", "sessions");
const walk = (dir) => {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith(".jsonl")) continue;
    if (fresh(full)) continue;
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (fromTemp(text)) plan.codex.push(full);
  }
};
walk(cxRoot);

// ── ②③ Claude 프로젝트 ──────────────────────────────────────────
const clRoot = path.join(HOME, ".claude", "projects");
let slugs = [];
try { slugs = fs.readdirSync(clRoot); } catch { /* 없으면 없는 대로 */ }
for (const slug of slugs) {
  const dir = path.join(clRoot, slug);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }

  // ② 임시폴더 슬러그는 통째로
  if (fromTemp(slug)) {
    if (!fresh(dir)) plan.slug.push(dir);
    continue;
  }
  // ③ 진짜 프로젝트 안의 껍데기만
  for (const f of files) {
    const full = path.join(dir, f);
    if (fresh(full)) continue;
    if (isHusk(full)) plan.husk.push(full);
  }
}

const show = (label, list, how = (x) => path.basename(x)) => {
  console.log(`\n[${label}] ${list.length}개`);
  for (const x of list.slice(0, 10)) console.log(`   ${how(x)}`);
  if (list.length > 10) console.log(`   … 그리고 ${list.length - 10}개 더`);
};

show("① Codex 세션 (임시폴더에서 만든 것)", plan.codex);
show("② Claude 임시폴더 슬러그", plan.slug);
show("③ Claude 껍데기 (대화 0줄)", plan.husk,
     (x) => `${path.basename(path.dirname(x))}/${path.basename(x)}`);

const total = plan.codex.length + plan.slug.length + plan.husk.length;
if (!GO) {
  console.log(`\n합계 ${total}개. **아직 안 지웠다** — 지우려면 \`--yes\` 를 붙인다.`);
  process.exit(0);
}

let gone = 0;
for (const f of [...plan.codex, ...plan.husk]) {
  try { fs.rmSync(f); gone++; } catch (e) { console.log(`   못 지움: ${f} (${e.code})`); }
}
for (const d of plan.slug) {
  try { fs.rmSync(d, { recursive: true }); gone++; } catch (e) { console.log(`   못 지움: ${d} (${e.code})`); }
}
console.log(`\n치웠다: ${gone}/${total}`);
