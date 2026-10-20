/**
 * ★ **창 공통 — 자잘한 글 도우미** (상태 글 · 경로 줄이기 · 누가 · 언제).
 */
import type { RoomMeta, RoomStatus } from "../../core/types.js";
import { agentById } from "./state.js";

// ── 자잘한 것 ───────────────────────────────────────────────────────────

export function autoGrow(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
}

export function statusText(s: RoomStatus): string {
  return {
    idle: "",
    connecting: "연결 중…",
    waiting: "생각하는 중…",
    streaming: "답하는 중…",
    tool: "작업하는 중…",
    permission: "권한을 기다리는 중",
    asking: "질문에 답을 기다리는 중",
    error: "오류",
  }[s];
}

export function shortenPath(p: string): string {
  const cut = p.replace(/\\/g, "/").split("/");
  return cut.length > 3 ? `…/${cut.slice(-2).join("/")}` : p;
}

/**
 * 제목 아래 줄의 «누구와» (B5) — `Claude · Opus 5`.
 *
 * 색 점을 뺀 자리를 메운다. 로드맵에서 점을 뺀 이유는 `●●`(봇 둘)와
 * `●●●`(작업 중)이 시각적으로 충돌해서였는데, 그러고 나니 목록만 봐서는
 * **어느 에이전트인지 알 수가 없었다.** 글자로 쓰면 충돌하지 않는다.
 *
 * 모델은 세션이 실제로 쓰는 값이라(`BotInstance.modelLabel`) 한 번도 안 연
 * 방에는 없다 — 그러면 에이전트 이름만 나온다.
 */
/**
 * 목록 둘째 줄 — 「구현 · Opus 5, 리뷰어 · Sonnet 5」.
 *
 * 🔴 여태 **에이전트 이름**을 썼다. 그런데 봇 이름은 사용자가 정하는 것이고
 * **부를 때 쓰는 이름도 그쪽이다**(멘션). 「구현」과 「리뷰어」로 갈라 놓고
 * 목록에서 «Claude, Codex» 만 보면 **어느 방이 무슨 방이었는지 알 수가 없다.**
 *
 * 이름을 안 바꾼 봇은 기본값이 에이전트 이름이라 **예전과 똑같이 보인다.**
 * 바꾼 경우에만 달라지고, 에이전트는 툴팁에 남는다(§0 — 접는 건 되지만
 * 버리는 건 안 된다).
 */
export function whoText(m: RoomMeta): string {
  return m.agentIds
    .map((id, i) => m.names?.[i] || (agentById.get(id)?.label ?? id))
    .join(", ");
}

/**
 * 툴팁 — 「구현 (Claude · Opus 5)」.
 *
 * 🔴 **줄에서 뺀 것은 여기 남긴다**(§0 뺄셈 규칙). 목록 둘째 줄은 **부를
 * 이름만** 두기로 했는데(줄이 길어지면 정작 이름이 안 읽힌다), 모델과
 * 에이전트는 **버리는 게 아니라 접는 것**이다.
 */
export function whoTitle(m: RoomMeta): string {
  return m.agentIds
    .map((id, i) => {
      const agent = agentById.get(id)?.label ?? id;
      const model = m.models?.[i];
      const sub = model ? `${agent} · ${model}` : agent;
      const name = m.names?.[i];
      return name && name !== agent ? `${name} (${sub})` : sub;
    })
    .join(", ");
}

/** 방 유형 아이콘 (B5). 색이 아니라 모양으로 구분한다 */
export function kindIcon(kind: RoomMeta["kind"]): string {
  return kind === "group" ? "organization" : kind === "shared" ? "sync" : "comment";
}

export function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
