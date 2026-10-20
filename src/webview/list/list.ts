/**
 * ★ **목록 화면** — 방 목록 · 방 메뉴.
 */
import type { RoomMeta } from "../../core/types.js";
import { forkLabel, orderRooms } from "../../protocol.js";
import { openRoom, peekRoom } from "../chat/chat.js";
import { jumpToOrigin } from "../chat/fork.js";
import { el, icon, replace } from "../common/dom.js";
import { S, boot, post, statuses } from "../common/state.js";
import { kindIcon, shortenPath, statusText, when, whoText, whoTitle } from "../common/text.js";
import { filteredMetas, hitsNode } from "./search.js";

// ── 목록 ────────────────────────────────────────────────────────────────

export const roomsEl = document.getElementById("rooms")!;

export const filterEl = document.getElementById("filter") as HTMLInputElement;

export const onlyHereEl = document.getElementById("only-here")!;

/**
 * 다른 워크스페이스의 방을 구분한다 (B5).
 *
 * 방은 전역 저장소에 있어서 **다른 프로젝트에서 만든 방도 목록에 보인다.**
 * 숨기지는 않는다 — 어제 하던 걸 이어서 보고 싶을 때가 있다. 대신 눈에 띄게 한다.
 */
/** 이 방이 **지금 열린 폴더**의 것인가 (B5). 폴더가 없으면 가릴 게 없다 */
function isHere(m: RoomMeta): boolean {
  return !boot.hasWorkspace || m.cwd === boot.cwd;
}

export function renderList(): void {
  const shown = filteredMetas();

  // 검색 중이면 제목 매치를 먼저, 그 아래에 대화 매치를 붙인다
  if (S.filterText.trim()) {
    replace(
      roomsEl,
      ...(shown.length
        ? [
            el("div", { class: "hits-head", text: `방 ${shown.length}개` }),
            ...orderRooms(shown, boot.cwd).map(roomNode),
          ]
        : []),
      hitsNode(),
    );
    return;
  }

  if (S.metas.length === 0) {
    replace(
      roomsEl,
      el(
        "div",
        { class: "empty" },
        el("p", { text: "아직 대화가 없습니다." }),
        el("p", { class: "dim" }, "오른쪽 위 ", icon("add"), " 로 시작하세요."),
      ),
    );
    return;
  }

  replace(roomsEl, ...orderRooms(S.onlyHere ? shown.filter(isHere) : shown, boot.cwd).map(roomNode));
}

function roomNode(m: RoomMeta): HTMLElement {
  {
    {
      const busy = statuses.get(m.id);
      const lineage = forkLabel(m, S.metas);
      // 왼쪽은 **지금 무슨 일이 있는지**가 먼저다. 조용하면 누구와 얘기하는지.
      const left = el("span", { class: "room-who" });
      if (busy && busy !== "idle" && busy !== "error") {
        left.append(el("span", { class: "busy", text: statusText(busy) }));
      } else if (m.draftPreview) {
        left.append(el("span", { class: "draft", text: "초안:" }), ` ${m.draftPreview}`);
      } else {
        left.textContent = whoText(m);
        left.title = whoTitle(m);
      }

      return el(
        "button",
        {
          class: "room",
          "data-id": m.id,
          onclick: () => openRoom(m.id),
          /*
           * ★ **우클릭도 같은 메뉴를 연다** (2026-10-13).
           *
           * 여태 「…」 단추뿐이었다. 그런데 목록에서 **행을 우클릭**하는 것은
           * 메신저·파일 목록 어디서나 하는 몸짓이고, 안 받으면 브라우저
           * 기본 메뉴가 뜬다 — 우리 것이 아닌 메뉴가.
           */
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            openRoomMenu(e, m);
          },
        },
        el("span", { class: "room-icon" }, icon(kindIcon(m.kind))),
        el(
          "span",
          { class: "room-main" },
          el(
            "span",
            { class: "room-top" },
            el("span", { class: "room-title", text: m.title }),
            el("span", { class: "room-time", text: when(m.lastActivityAt) }),
          ),
          el(
            "span",
            { class: "room-sub" },
            left,
            el("span", {
              class: isHere(m) ? "room-cwd" : "room-cwd elsewhere",
              text: shortenPath(m.cwd),
              title: m.cwd,
            }),
          ),
          // 계보 배지 (D3). 트리 들여쓰기 대신 한 줄로 — 분기는 많아야 두세 개다
          lineage &&
            el("span", {
              class: "room-fork",
              text: lineage,
              title: "원본으로 가기",
              // 행 전체가 버튼이라 그냥 두면 이 방이 열린다
              onclick: (ev: Event) => {
                ev.stopPropagation();
                jumpToOrigin(m);
              },
            }),
        ),
        m.unread > 0 && el("span", { class: "badge", text: String(m.unread) }),
        el(
          "span",
          {
            class: "room-more",
            title: "더 보기",
            // 행 전체가 버튼이라 안쪽 클릭이 방을 열어버린다
            onclick: (e: Event) => {
              e.stopPropagation();
              openRoomMenu(e, m);
            },
          },
          icon("kebab-vertical"),
        ),
      );
    }
  }
}

/**
 * 목록에서 바로 이름을 바꾸거나 나간다 (B4·B13).
 *
 * 이름을 바꾸려고 방에 들어갔다 나오게 하면 번거롭다 — 목록에서 보이는 이름이니
 * 목록에서 고칠 수 있어야 한다.
 */
function openRoomMenu(e: Event, m: RoomMeta): void {
  roomsEl.querySelector(".menu")?.remove();

  const close = () => roomsEl.querySelector(".menu")?.remove();
  const menu = el(
    "div",
    { class: "menu" },
    el("button", {
      /* ★ 붙이지 않고 연다 — 읽기만 할 사람에게 17초를 물리지 않는다 */
      text: "기록만 읽기",
      onclick: () => {
        close();
        peekRoom(m.id);
      },
    }),
    el("button", {
      text: "이름 바꾸기",
      onclick: () => {
        close();
        renameInList(m);
      },
    }),
    el("hr"),
    el("button", {
      class: "danger",
      text: "방 나가기 (세션도 삭제)",
      onclick: () => {
        close();
        confirmLeaveFromList(m);
      },
    }),
  );

  const row = (e.currentTarget as HTMLElement).closest(".room") as HTMLElement;
  menu.style.top = `${row.offsetTop + row.offsetHeight - 6}px`;
  roomsEl.append(menu);
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

export function renameInList(m: RoomMeta): void {
  const row = [...roomsEl.querySelectorAll<HTMLElement>(".room")].find(
    (n) => n.dataset.id === m.id,
  );
  const titleEl = row?.querySelector<HTMLElement>(".room-title");
  if (!titleEl) return;

  const input = el("input", { type: "text", class: "rename", value: m.title }) as HTMLInputElement;
  const commit = (save: boolean) => {
    const title = input.value.trim();
    if (save && title && title !== m.title) post({ t: "rename", roomId: m.id, title });
    else renderList();
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) commit(true);
    if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
  titleEl.replaceChildren(input);
  input.focus();
  input.select();
}

function confirmLeaveFromList(m: RoomMeta): void {
  const row = [...roomsEl.querySelectorAll<HTMLElement>(".room")].find(
    (n) => n.dataset.id === m.id,
  );
  if (!row) return;

  const card = el(
    "div",
    { class: "card inline" },
    el("div", { class: "card-title", text: `«${m.title}» 방을 나갈까요?` }),
    el("div", { class: "dim", text: "대화 기록과 에이전트 쪽 세션이 함께 지워집니다." }),
    el(
      "div",
      { class: "card-actions" },
      el("button", { text: "취소", onclick: () => renderList() }),
      el("button", {
        class: "primary",
        text: "나가기",
        onclick: () => post({ t: "leave", roomId: m.id }),
      }),
    ),
  );
  row.after(card);
}
