/**
 * **이름 없는 오류를 사람 말로** (사용자, 2026-11-18: *"AI in One: Unknown system error -122:
 * Unknown system error -122, write"* · *"다른 환경에서 쓰다가 계속 저게 뜨던데? 클로드만
 * 사용하고 있었어"*).
 *
 * 리눅스의 122 는 `EDQUOT`(디스크 할당량 초과)인데 Node 가 그 이름을 모른다. 무엇이 찼는지
 * 말하고, 저장할 때마다 같은 팝업이 쌓이지 않게 한다.
 */
import * as util from "node:util";
import { errorFields, popupDue, readableError } from "../src/vscode/errorText.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

console.log("\n[전제 — Node 는 EDQUOT 를 모른다]");
ok(![...util.getSystemErrorMap().values()].some(([n]) => n === "EDQUOT"),
   "Node 오류 지도에 EDQUOT 가 없다 — 생기면 이 번역은 필요 없어진다");

console.log("\n[★ 디스크 할당량 초과]");
const e = Object.assign(new Error("Unknown system error -122: Unknown system error -122, write"),
  { errno: -122, code: "Unknown system error -122", syscall: "write" });
const linux = readableError(e, "linux");
ok(/디스크 할당량이 찼습니다/.test(linux) && linux.endsWith("(EDQUOT · write)"), `★ 리눅스 122 는 할당량 초과 (${linux})`);
const mac = readableError(new Error("Unknown system error -69: Unknown system error -69, write"), "darwin");
ok(/디스크 할당량/.test(mac), "★ macOS 는 69 가 같은 것");
ok(readableError(e, "darwin") === e.message, "번호의 뜻은 OS 마다 다르다 — macOS 의 122 는 넘겨짚지 않는다");
ok(readableError(e, "win32") === e.message, "윈도우도 그대로");
ok(readableError(new Error("Unknown system error -999, open"), "linux") === "Unknown system error -999, open", "모르는 번호는 그대로");
ok(readableError(new Error("ENOENT: no such file"), "linux") === "ENOENT: no such file", "이름 있는 오류는 그대로");

console.log("\n[★ 출력 창에 남길 칸]");
ok(errorFields(e) === " (code=Unknown system error -122 · errno=-122 · syscall=write)", `★ (${errorFields(e)})`);
ok(errorFields(Object.assign(new Error("x"), { path: "/home/a/x.json" })) === " (path=/home/a/x.json)", "★ 파일 자리도");
ok(errorFields(new Error("x")) === "" && errorFields("x") === "", "칸이 없으면 빈 글");

console.log("\n[★ 같은 팝업은 1분에 한 번]");
const seen = new Map<string, number>();
ok(popupDue(seen, "가", 0), "처음은 띄운다");
ok(!popupDue(seen, "가", 30_000), "★ 1분 안의 같은 글은 안 띄운다");
ok(popupDue(seen, "나", 30_000), "다른 글은 띄운다");
ok(popupDue(seen, "가", 60_000), "1분 지나면 다시");
console.log("\n전부 통과");
