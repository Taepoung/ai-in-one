/**
 * **글꼴 크기는 VSCode 를 따른다** (2026-09-29).
 *
 * 사용자 물음: *"폰트 사이즈를 조정할 수 있는 곳은 없나? 사용자가 조정할 수
 * 있는 부분은 아닌가"*.
 *
 * 🔴 **없었다.** 글꼴 **모양**은 `--vscode-font-family` 로 받아 쓰면서 **크기**
 * 는 `style.css` 73 곳에 `px` 로 박아뒀다. 그래서 VSCode 글꼴을 키운 사람에게
 * 우리 패널만 작게 남았고, 키울 방법이 **아예 없었다** — 전체 확대(`Ctrl` `+`)
 * 는 편집기까지 같이 커지므로 «패널만» 이 안 된다.
 *
 * 박힌 값은 여섯 가지뿐이라(9·10·11·12·13·14) **13 을 기준으로 한 사다리**로
 * 묶었다. VSCode 가 13px 를 주면 지금과 한 픽셀도 안 달라지고, 키우면 여섯
 * 칸이 비율을 지키며 같이 커진다.
 *
 * 이 검사가 붙잡는 것은 **두 가지**다:
 *
 * ```
 * ① 사다리가 실제로 VSCode 값에 매달려 있나   — 안 그러면 따라가지 않는다
 * ② px 를 다시 박은 곳이 생기지 않았나        — 한 곳만 박혀도 그 줄만 안 큰다
 * ```
 *
 * ②가 진짜다. 73 곳을 고쳐놔도 다음 사람이 `font-size: 11px` 한 줄을 새로
 * 적으면 **그 줄만 안 커진다.** 그런 어긋남은 눈으로 잡기 어렵다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const css = fs.readFileSync(path.join(ROOT, "src", "webview", "style.css"), "utf8");

console.log("\n[★ 사다리가 VSCode 값에 매달려 있다]");
{
  ok(/--fs:\s*var\(--vscode-font-size/.test(css),
     "★ **기준이 `--vscode-font-size`** — 여기가 끊기면 아무것도 안 따라간다");
  ok(/--fs:\s*var\(--vscode-font-size,\s*13px\)/.test(css),
     "★ 못 받으면 13px — 지금 쓰던 값이 그대로 폴백이다");

  for (const n of [9, 10, 11, 12, 14]) {
    const re = new RegExp(`--fs-${n}:\\s*calc\\(var\\(--fs\\) \\* ${n} / 13\\)`);
    ok(re.test(css), `★ --fs-${n} 이 --fs 에서 나온다 (${n}/13)`);
  }
  ok(/--fs-13:\s*var\(--fs\)/.test(css), "★ --fs-13 은 기준 그대로다");
}

console.log("\n[★ px 를 다시 박은 곳이 없다]");
{
  /*
   * 🔴 한 곳만 박혀도 **그 줄만 안 커진다.** 나머지가 다 커진 화면에서 한 줄만
   * 작게 남는 것은 눈으로 잡기 어렵다 — «원래 작은 글씨인가» 로 지나간다.
   */
  const stuck = [...css.matchAll(/font-size:\s*(\d+)px/g)];
  const lines = stuck.map((m) => css.slice(0, m.index).split("\n").length);
  if (stuck.length > 0) console.log(`   박힌 곳: ${lines.join(", ")} 줄`);
  ok(stuck.length === 0,
     `★ **px 로 박은 font-size 가 없다** (${stuck.length}곳) — 있으면 그 줄만 안 큰다`);

  const ladder = (css.match(/font-size:\s*var\(--fs-/g) ?? []).length;
  const rel = (css.match(/font-size:\s*(inherit|[\d.]+em)/g) ?? []).length;
  console.log(`   사다리 ${ladder}곳 · 상대값(em·inherit) ${rel}곳`);
  ok(ladder > 60, `★ 사다리를 실제로 쓰고 있다 (${ladder}곳)`);
  /*
   * `em` 과 `inherit` 은 **이미 물려받는다** — 부모가 사다리를 쓰므로 같이
   * 커진다. 바꿀 필요가 없었고, 바꾸면 오히려 비율이 깨진다.
   */
  ok(rel > 0, `★ 상대값은 그대로 뒀다 (${rel}곳) — 이미 따라 커진다`);
}

console.log("\n[★ 커지면 여섯 칸이 «비율을 지키며» 같이 커진다]");
{
  /*
   * 사다리를 «그냥 큰 값» 으로 적어두면(예: 전부 14px) 위계가 무너진다.
   * 13 → 16 으로 키웠을 때 10 이 12.3 이 되는지, 즉 **간격이 같은 비율로**
   * 벌어지는지를 계산으로 확인한다.
   */
  const at = (base, n) => (n === 13 ? base : (base * n) / 13);
  for (const base of [13, 16, 20]) {
    const row = [9, 10, 11, 12, 13, 14].map((n) => at(base, n).toFixed(1));
    console.log(`   --fs ${String(base).padStart(2)}px → ${row.join(" / ")}`);
  }
  ok(at(13, 11) === 11, "★ 13px 일 때는 **지금과 똑같다** — 한 픽셀도 안 달라진다");
  ok(at(26, 11) === 22, "★ 두 배로 키우면 두 배가 된다 — 위계가 유지된다");
  ok(at(16, 10) < at(16, 11), "★ 커져도 순서는 안 바뀐다");
}

console.log("\n전부 통과");
