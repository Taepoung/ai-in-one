/**
 * **Node 가 이름을 모르는 오류는 번호로 읽게 한다** (사용자, 2026-11-18).
 *
 * 윈도우에서 libuv 가 못 옮긴 오류는 `Unknown system error -122` 처럼 **윈도우 오류 번호에
 * 빼기를 붙여** 온다 — 같은 말이 두 번 찍히고 무엇인지 안 읽힌다. «Windows 오류 122» 로
 * 바꿔 두면 그 번호로 찾아볼 수 있다. 다른 OS 는 그대로 둔다(번호의 뜻이 다르다).
 */
export function readableError(err: unknown, platform: string = process.platform): string {
  const message = err instanceof Error ? err.message : String(err);
  if (platform !== "win32") return message;
  const m = /^Unknown system error -(\d+): Unknown system error -\1(, )?(.*)$/.exec(message);
  return m ? `Windows 오류 ${m[1]}${m[3] ? ` (${m[3]})` : ""}` : message;
}

/** 오류에 붙은 칸 — 어느 시스템 호출이 어느 파일에서 났나. 없으면 빈 글 */
export function errorFields(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown; dest?: unknown };
  const bits = (["code", "errno", "syscall", "path", "dest"] as const)
    .filter((k) => e[k] !== undefined)
    .map((k) => `${k}=${String(e[k])}`);
  return bits.length > 0 ? ` (${bits.join(" · ")})` : "";
}
