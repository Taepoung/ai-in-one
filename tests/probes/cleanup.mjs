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
/**
 * `--codex-all` : Codex 세션을 **전부** 지운다 (임시폴더 것만이 아니라).
 *
 * 🔴 Codex 는 **파일과 sqlite 인덱스 둘**에 산다. 파일만 지우면 목록엔 뜨는데
 * 열면 «파일이 없다» 가 난다 — 실제로 한 번 그렇게 만들었다. 둘을 **같이**
 * 지운다.
 *
 * ⚠️ 이건 **사용자의 진짜 대화**다. 우리가 만든 찌꺼기가 아니다.
 */
const ALL_CODEX = process.argv.includes("--codex-all");
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
    if (ALL_CODEX || fromTemp(text)) plan.codex.push(full);
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

/*
 * ★ **Codex 는 인덱스도 같이 지운다** (2026-09-30).
 *
 * 🔴 파일만 지웠다가 DB 행이 붕 떴다 — 확장 목록에는 뜨는데 열면 «파일이
 * 없다» 가 난다. 그리고 **우리 앱으로 나가도 같은 일이 난다**: Codex 어댑터의
 * `session/delete` 가 파일만 지우고 인덱스는 안 건드린다(`leavereal.mts` 실측).
 *
 * 그래서 «파일이 실제로 없는 행» 을 싹 걷는다 — 우리가 지운 것이든 어댑터가
 * 반만 지운 것이든, **열 수 없는 행**이라는 점은 같다.
 */
if (plan.codex.length > 0) {
  const { DatabaseSync } = await import("node:sqlite");
  const cx = path.join(HOME, ".codex");
  let ids = [];
  try {
    const db = new DatabaseSync(path.join(cx, "state_5.sqlite"), { readOnly: true });
    ids = db.prepare("select id, rollout_path from threads").all()
      .filter((r) => !r.rollout_path || !fs.existsSync(r.rollout_path))
      .map((r) => r.id);
    db.close();
  } catch (e) { console.log(`   인덱스를 못 읽었다: ${e.message}`); }

  let rows = 0;
  for (const name of fs.readdirSync(cx).filter((f) => f.endsWith(".sqlite"))) {
    let db;
    try { db = new DatabaseSync(path.join(cx, name)); } catch { continue; }
    try {
      for (const { name: t } of db.prepare(
        "select name from sqlite_master where type='table'").all()) {
        for (const col of ["id", "thread_id"]) {
          const has = db.prepare(`pragma table_info("${t}")`).all().some((d) => d.name === col);
          if (!has) continue;
          for (const id of ids) {
            try {
              rows += db.prepare(`delete from "${t}" where "${col}" = ?`).run(id).changes;
            } catch { /* 그 표엔 없다 */ }
          }
        }
      }
    } catch (e) { console.log(`   ${name}: ${e.message}`); }
    try { db.close(); } catch { /* 이미 닫혔다 */ }
  }
  if (rows) console.log(`   Codex 인덱스에서 ${rows}행 지움 (붕 뜬 스레드 ${ids.length}개)`);
}
for (const d of plan.slug) {
  try { fs.rmSync(d, { recursive: true }); gone++; } catch (e) { console.log(`   못 지움: ${d} (${e.code})`); }
}
console.log(`\n치웠다: ${gone}/${total}`);
