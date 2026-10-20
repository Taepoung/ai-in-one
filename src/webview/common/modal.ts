/**
 * ★ **창 공통 — 모달**.
 */
import { el } from "./dom.js";
import { screens } from "./screens.js";

/**
 * 팝업을 **그 화면 위에** 띄운다 (기본은 채팅).
 *
 * 🔴 화면마다 따로 띄우는 이유: `.modal` 은 `position: absolute` 라 **가장
 * 가까운 자리 잡힌 조상**을 기준으로 선다. `.screen` 이 그것이다 — 다른 데
 * 붙이면 화면이 미끄러질 때 팝업만 제자리에 남는다.
 */
export function showModal(node: HTMLElement, where: HTMLElement = screens.chat): void {
  closeModal();
  where.append(
    el("div", { class: "modal-veil", onclick: () => closeModal() }),
    el("div", { class: "modal" }, node),
  );
}

/** 팝업과 덮개를 함께 걷는다 — **어느 화면에 떠 있든** */
export function closeModal(): void {
  for (const n of document.querySelectorAll(".modal-veil, .modal")) n.remove();
}
