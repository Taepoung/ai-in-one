/**
 * **메세지 id** — 여러 기능이 같이 쓴다 (리팩토링 ②, 2026-10-20).
 *
 * `roomManager.ts` 안에 있었는데, MCP 도구층을 떼어내니 둘이 같이 쓰는 것이
 * 됐다. 한쪽이 다른 쪽을 import 하면 순환이 생기므로 따로 둔다.
 */
export function messageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
