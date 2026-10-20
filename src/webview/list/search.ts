/**
 * ★ **목록 화면 — 검색** (H).
 */
import type { RoomMeta } from "../../core/types.js";
import { openRoom } from "../chat/chat.js";
import { el } from "../common/dom.js";
import { S, agentById, post } from "../common/state.js";
import { when } from "../common/text.js";
import { renderList } from "./list.js";

let searchTimer: ReturnType<typeof setTimeout> | undefined;

export function onFilterInput(value: string): void {
  S.filterText = value;
  clearTimeout(searchTimer);

  if (!value.trim()) {
    S.hits = null;
    renderList();
    return;
  }

  // 제목 필터는 즉시, 전문 검색은 디바운스 — 타이핑마다 전 방을 훑을 이유가 없다
  renderList();
  searchTimer = setTimeout(() => post({ t: "search", query: value }), 220);
}

export function filteredMetas(): RoomMeta[] {
  const needle = S.filterText.trim().toLowerCase();
  if (!needle) return S.metas;
  return S.metas.filter((m) => {
    const agent = agentById.get(m.agentIds[0] ?? "");
    return (
      m.title.toLowerCase().includes(needle) ||
      (agent?.label ?? "").toLowerCase().includes(needle)
    );
  });
}

export function hitsNode(): HTMLElement {
  const wrap = el("div", { class: "hits" });
  if (S.hits === null) {
    return el("div", { class: "hits" }, el("p", { class: "dim", text: "대화를 찾는 중…" }));
  }
  if (S.hits.length === 0) {
    return el("div", { class: "hits" }, el("p", { class: "dim", text: "대화에서 찾지 못했습니다." }));
  }

  wrap.append(el("div", { class: "hits-head", text: `대화 ${S.hits.length}건` }));
  for (const h of S.hits) {
    wrap.append(
      el(
        "button",
        {
          class: "hit",
          onclick: () => {
            // 결과를 누르면 그 방의 그 메시지로 (H3)
            S.jumpToMessageId = h.messageId;
            openRoom(h.roomId);
          },
        },
        el(
          "span",
          { class: "hit-top" },
          el("span", { class: "hit-room", text: h.roomTitle }),
          el("span", { class: "room-time", text: when(h.createdAt) }),
        ),
        markedSnippet(h.snippet, S.filterText.trim()),
      ),
    );
  }
  return wrap;
}

/** 찾은 말을 굵게. `innerHTML` 없이 노드로 짓는다 */
function markedSnippet(text: string, needle: string): HTMLElement {
  const line = el("span", { class: "hit-snippet" });
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0 || !needle) {
    line.textContent = text;
    return line;
  }
  line.append(
    text.slice(0, at),
    el("mark", { text: text.slice(at, at + needle.length) }),
    text.slice(at + needle.length),
  );
  return line;
}
