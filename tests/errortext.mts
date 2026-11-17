/**
 * **이름 없는 오류를 번호로 읽게** (사용자, 2026-11-18: *"AI in One: Unknown system error -122:
 * Unknown system error -122, write"*).
 *
 * 그 한 줄로는 무엇이 어디서 났는지 안 읽혔다. 윈도우에서는 «Windows 오류 122» 로 바꾸고,
 * 출력 창에는 오류의 칸(code · syscall · path)을 함께 적는다.
 */
import { errorFields, readableError } from "../src/vscode/errorText.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

console.log("\n[★ 윈도우의 이름 없는 오류]");
const e = Object.assign(new Error("Unknown system error -122: Unknown system error -122, write"),
  { errno: -122, code: "Unknown system error -122", syscall: "write" });
ok(readableError(e, "win32") === "Windows 오류 122 (write)", `★ 번호로 (${readableError(e, "win32")})`);
ok(readableError(e, "linux") === e.message, "다른 OS 는 그대로 — 번호의 뜻이 다르다");
ok(readableError(new Error("ENOENT: no such file"), "win32") === "ENOENT: no such file", "이름 있는 오류는 그대로");
ok(readableError("그냥 글", "win32") === "그냥 글", "Error 가 아니어도");

console.log("\n[★ 출력 창에 남길 칸]");
ok(errorFields(e) === " (code=Unknown system error -122 · errno=-122 · syscall=write)", `★ (${errorFields(e)})`);
ok(errorFields(Object.assign(new Error("x"), { path: "C:\a.zip" })) === " (path=C:\a.zip)", "★ 파일 자리도");
ok(errorFields(new Error("x")) === "" && errorFields("x") === "", "칸이 없으면 빈 글");
console.log("\n전부 통과");
