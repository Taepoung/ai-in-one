/**
 * ★ **채팅 화면 — 방 안에서 찾기** (H4).
 */
import { scrollInside } from "./scroll.js";
import { el, icon } from "../common/dom.js";
import { screens } from "../common/screens.js";
import { S } from "../common/state.js";

// ── 방 안에서 찾기 (H4) ─────────────────────────────────────────────────

let findMatches: HTMLElement[] = [];

let findAt = -1;

export function openFind(): void {
  const c = S.chat;
  if (!c) return;
  const existing = screens.chat.querySelector<HTMLInputElement>(".find input");
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }

  const input = el("input", { type: "text", placeholder: "이 방에서 찾기" }) as HTMLInputElement;
  const count = el("span", { class: "find-count", text: "" });
  const step = (by: number) => {
    if (findMatches.length === 0) return;
    findMatches[findAt]?.classList.remove("current");
    findAt = (findAt + by + findMatches.length) % findMatches.length;
    const node = findMatches[findAt]!;
    node.classList.add("current");
    if (c.list) scrollInside(c.list, node, "center");
    count.textContent = `${findAt + 1}/${findMatches.length}`;
  };

  const bar = el(
    "div",
    { class: "find" },
    icon("search"),
    input,
    count,
    el("button", { class: "icon", title: "이전", onclick: () => step(-1) }, icon("chevron-up")),
    el("button", { class: "icon", title: "다음", onclick: () => step(1) }, icon("chevron-down")),
    el("button", { class: "icon", title: "닫기", onclick: closeFind }, icon("close")),
  );

  input.addEventListener("input", () => {
    clearFindMarks();
    const needle = input.value.trim().toLowerCase();
    if (!needle) {
      count.textContent = "";
      return;
    }
    for (const bubble of c.list.querySelectorAll<HTMLElement>(".bubble")) {
      if (bubble.textContent?.toLowerCase().includes(needle)) {
        bubble.classList.add("found");
        findMatches.push(bubble);
      }
    }
    findAt = -1;
    count.textContent = findMatches.length ? `0/${findMatches.length}` : "없음";
    if (findMatches.length) step(1);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") closeFind();
  });

  c.head.after(bar);
  input.focus();
}

export function closeFind(): void {
  clearFindMarks();
  screens.chat.querySelector(".find")?.remove();
}

function clearFindMarks(): void {
  for (const node of findMatches) node.classList.remove("found", "current");
  findMatches = [];
  findAt = -1;
}
