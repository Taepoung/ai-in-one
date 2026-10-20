/**
 * **우리가 부르는 아이콘 이름이 실재하나** (2026-09-30).
 *
 * 🔴 권한·참여자를 화면으로 빼면서 머리줄에 `icon("back")` 을 달았다.
 * **그런 codicon 은 없다** — 빈 `<i>` 가 붙어서 **뒤로가기 버튼이 통째로
 * 안 보였다.** 사용자가 «뒤로 나오는 버튼이 안보임» 으로 알려줬다.
 *
 * 채팅 머리줄은 처음부터 `arrow-left` 를 쓰고 있었다. 옆에 답이 있는데
 * 그럴듯한 이름을 지어 부른 것이다.
 *
 * 이런 종류는 **눈으로만 잡힌다** — 타입도 통과하고, 검사도 «버튼이 있나» 는
 * 통과한다(엘리먼트는 있으니까). 그래서 이름 자체를 대조한다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

const css = fs.readFileSync(
  path.join(ROOT, "node_modules", "@vscode", "codicons", "dist", "codicon.css"), "utf8");
// 화면 코드는 창마다 나뉘어 있다(webview 나누기, 2026-10-20) — 폴더 전체를 한 글로 본다
const src = fs.readdirSync(path.join(ROOT, "src", "webview"), { recursive: true })
  .filter((f) => String(f).endsWith(".ts")).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, "src", "webview", String(f)), "utf8")).join("\n");

const used = [...new Set([...src.matchAll(/icon\("([a-z0-9-]+)"\)/g)].map((m) => m[1]))].sort();
const real = new Set([...css.matchAll(/\.codicon-([a-z0-9-]+):/g)].map((m) => m[1]));

console.log(`\n[★ 부르는 이름 ${used.length}개 · codicon 이 아는 이름 ${real.size}개]`);
const bad = used.filter((n) => !real.has(n));
if (bad.length > 0) console.log(`   없는 이름: ${bad.join(", ")}`);
ok(real.size > 100, `★ codicon 목록을 읽었다 (${real.size}개) — 못 읽고 통과하면 뜻이 없다`);
ok(bad.length === 0,
   `★ **전부 실재한다** (${bad.length}개 어긋남) — 없는 이름은 빈 칸으로 그려져 단추가 사라진다`);

/*
 * ★ **뒤로가기는 한 가지로.** 화면마다 다른 화살표를 쓰면 «다른 동작인가» 로
 * 읽힌다. 채팅이 쓰던 것에 맞춘다.
 */
const backs = [...src.matchAll(/title: "(돌아가기|목록|목록으로)"[^}]*\}, icon\("([a-z-]+)"\)/g)]
  .map((m) => m[2]);
console.log(`   뒤로가기에 쓰는 아이콘: ${[...new Set(backs)].join(", ")}`);
ok(backs.length > 0, "★ 뒤로가기 단추를 찾았다");
ok(new Set(backs).size === 1, `★ **한 가지로 통일** (${[...new Set(backs)].join(", ")})`);

console.log("\n전부 통과");
