/**
 * **끝내는 단추의 자리** — 물러나는 것은 왼쪽, 진행하는 것은 오른쪽 (2026-09-28).
 *
 * 🔴 자리마다 제각각이었다:
 *
 * ```
 * 방 만들기   [취소] [만들기★]        ← 맞음
 * 방 나가기   [나가기★] [취소]        ← 반대
 * 봇 부르기   [부르기★] [취소]        ← 반대
 * 분기        [분기하기★] [취소]      ← 반대
 * ```
 *
 * 한 앱 안에서 «끝내는 단추»의 자리가 다르면 **손이 기억하지 못한다** — 누를
 * 때마다 읽어야 하고, 급할 때 엉뚱한 것을 누른다. 나가기·분기는 되돌릴 수
 * 없는 것들이라 그 대가가 크다.
 *
 * ★ **규칙은 «강조가 오른쪽»이 아니라 «진행이 오른쪽»이다.** 강조가 없는 줄도
 * 있다(방 정보의 `[닫기] [참여자 보기]`). 기준은 **무엇을 하느냐**다.
 *
 * ★ 권한 카드(`.approval`)는 **안 잰다.** 거기 단추는 에이전트가 준 옵션을
 * 그대로 늘어놓는 것이라 순서가 우리 것이 아니다 — 우리가 바꾸면 «에이전트가
 * 뭐라고 했는지»가 흐려진다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
// 화면 코드는 창마다 나뉘어 있다(webview 나누기, 2026-10-20) — 폴더 전체를 한 글로 본다
const src = fs.readdirSync(path.join(ROOT, "src", "webview"), { recursive: true })
  .filter((f) => String(f).endsWith(".ts")).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, "src", "webview", String(f)), "utf8")).join("\n");
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

/** «물러나는» 단추의 글자 — 이것들은 왼쪽에 있어야 한다 */
const BACK_OFF = ["취소", "닫기", "기본값으로"];

/*
 * 소스를 읽어서 잰다. jsdom 으로는 이 카드들을 다 띄울 수 없고(여섯 화면에
 * 흩어져 있다), 우리가 재려는 것은 **쓰여 있는 순서**이지 그려진 모습이 아니다.
 */
const rows = [...src.matchAll(/class: "(?:card-)?actions"[\s\S]*?\n(\s*)\),/g)]
  .map((m) => m[0])
  .filter((r) => /text: "/.test(r));

console.log(`\n[단추 줄 ${rows.length}개를 찾았다]`);

let checked = 0;
for (const row of rows) {
  const labels = [...row.matchAll(/text: "([^"]+)"/g)].map((m) => m[1]);
  if (labels.length < 2) continue;

  const backAt = labels.findIndex((t) => BACK_OFF.includes(t));
  if (backAt < 0) continue;   // 물러나는 단추가 없는 줄은 잴 것이 없다

  checked++;
  console.log(`   ${labels.join(" / ")}`);
  ok(backAt === 0,
     `★ «${labels[backAt]}» 가 맨 왼쪽 (${labels.join(" / ")})`);
}

ok(checked >= 4, `★ 실제로 여러 줄을 쟀다 (${checked}개) — 안 걸리면 이 검사는 아무것도 안 지킨다`);

console.log("\n[★ 강조 단추는 맨 오른쪽]");
{
  /*
   * 갈라 묻는 줄(`[기록만 두고] [대화 넘겨서★]`)처럼 «진행»이 둘일 수 있다.
   * 그때도 **권하는 쪽이 오른쪽 끝**이어야 손이 같은 자리를 찾는다.
   */
  let seen = 0;
  for (const row of rows) {
    const labels = [...row.matchAll(/text: "([^"]+)"/g)].map((m) => m[1]);
    if (labels.length < 2) continue;

    /*
     * 🔴 **갈라 묻는 줄은 소스로 못 가린다.** 분기 카드는
     * `lossy ? [기록만, 대화 넘겨서★] : [분기하기★]` 라 **세 글자가 다 적혀
     * 있는데 실행 때는 둘 중 하나만** 그려진다. 소스를 읽는 검사로는 어느
     * 갈래인지 알 수 없으므로, 여기서 우기면 **없는 버그를 만들어낸다.**
     *
     * 건너뛰되 앞의 «물러나는 것이 맨 왼쪽»은 그 줄에서도 잰다 — `취소` 는
     * 갈래 **밖**에 있어서 소스 순서가 곧 실행 순서다.
     */
    // 갈래를 **단추 배열**로 내는 것만 건너뛴다 — `post({...})` 안의 전개는 갈래가 아니다
    if (/\.\.\.\([^)]*\?\s*\[/.test(row)) continue;

    // 이 줄에 강조가 있나 — `class: "primary"` 가 붙은 단추의 글자를 찾는다
    const hit = /class: "primary",\s*\n\s*text: "([^"]+)"/.exec(row)
      ?? /class: "primary", text: "([^"]+)"/.exec(row);
    if (!hit) continue;
    seen++;
    ok(labels.at(-1) === hit[1],
       `★ «${hit[1]}» 가 맨 오른쪽 (${labels.join(" / ")})`);
  }
  ok(seen >= 3, `★ 강조가 든 줄도 여럿 쟀다 (${seen}개)`);
}

console.log("\n전부 통과");
