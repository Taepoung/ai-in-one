/**
 * ★ **Node 가 이름을 모르는 오류를 사람 말로** (사용자, 2026-11-18: *"다른 환경에서 쓰다가
 * 계속 저게 뜨던데? 클로드만 사용하고 있었어"* — `Unknown system error -122, write`).
 *
 * 🔴 Node(libuv)는 **`EDQUOT`(디스크 할당량 초과)를 모른다** — 오류 지도에 없다(Node 24 실측).
 * 그래서 리눅스의 122 가 `Unknown system error -122` 로 온다. 사용자 한도가 걸린 서버에서
 * 할당량이 차면 저장할 때마다 이게 뜬다. 무엇이 찼는지 말해야 사용자가 손을 쓸 수 있다.
 *
 * 번호의 뜻은 **OS 마다 다르다** — 리눅스 122 · macOS 69 가 같은 `EDQUOT` 다. 모르는 번호는
 * 그대로 둔다(넘겨짚지 않는다).
 */
const UNNAMED: Record<string, Record<number, string>> = {
  linux: { 122: "EDQUOT" },
  darwin: { 69: "EDQUOT" },
};
const SAY: Record<string, string> = {
  EDQUOT: "디스크 할당량이 찼습니다 — 이 기계에서 쓸 수 있는 저장 공간 한도를 넘었습니다. "
    + "파일을 지워 자리를 비우거나 관리자에게 한도를 늘려 달라고 하세요",
};

export function readableError(err: unknown, platform: string = process.platform): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = /^Unknown system error -(\d+)(?:: Unknown system error -\1)?(?:, (.*))?$/.exec(message);
  if (!m) return message;
  const name = UNNAMED[platform]?.[Number(m[1])];
  if (!name) return message;
  return `${SAY[name] ?? name} (${name}${m[2] ? ` · ${m[2]}` : ""})`;
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

/**
 * ★ **같은 팝업은 잠깐 한 번만** (사용자, 2026-11-18: *"계속 저게 뜨던데"*).
 *
 * 디스크가 차면 저장할 때마다 같은 오류가 난다 — 팝업이 줄지어 쌓여 일을 못 한다. 같은 글은
 * `ms` 안에 한 번만 띄운다. 출력 창에는 **매번** 남는다(여기는 띄울지만 정한다).
 */
export const POPUP_QUIET_MS = 60_000;

export function popupDue(seen: Map<string, number>, text: string, now: number, ms = POPUP_QUIET_MS): boolean {
  const last = seen.get(text);
  if (last !== undefined && now - last < ms) return false;
  seen.set(text, now);
  return true;
}
