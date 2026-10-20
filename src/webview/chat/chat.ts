/**
 * ★ **채팅 화면 — 뼈대** · 방 열기 · 나가기 · 초안.
 */
import { parseCompose } from "../../core/mentions.js";
import { hasManyBots, type Room } from "../../core/types.js";
import { attachFiles, paintChips } from "./attach.js";
import {
  busyAmong,
  caretAfter,
  closePicker,
  makeChipBox,
  movePicker,
  paintCompose,
  paintPicker,
  paintSendButton,
  paintStaged,
  readTokens,
  refreshMentionChips,
} from "./compose.js";
import { nodeCache, paintChat } from "./paint.js";
import { scrollIntoPlace } from "./scroll.js";
import { el, icon, replace } from "../common/dom.js";
import { go, paintScreens, screens } from "../common/screens.js";
import { PAGE, S, post } from "../common/state.js";
import { autoGrow } from "../common/text.js";
import { closeDrawer, paintDrawer } from "../drawer/drawer.js";
import { joined } from "../join/join.js";
import { paintPermissionSheet, togglePermissionSheet } from "../perm/perm.js";

/**
 * 뷰를 켜고 끈다 (§5).
 *
 * 입력창 모양이 바뀌므로(칩 상자 ↔ 한 줄 입력) `renderChat` 이 **다시 붙인다** —
 * 그 판단은 이미 «단체방인가»로 하고 있어서 여기서 따로 할 일이 없다.
 */
export function openBotView(botId: string | null): void {
  S.viewBotId = botId;
  closeDrawer();
  renderChat();
}

// ── 채팅 ────────────────────────────────────────────────────────────────

let draftTimer: ReturnType<typeof setTimeout> | undefined;

export function openRoom(roomId: string): void {
  // 뷰는 **그 방 안의 상태**다 — 다른 방에 들고 가면 엉뚱한 봇을 가리킨다
  S.viewBotId = null;
  /*
   * ★ **들어올 때마다 백 개부터** (사용자, 2026-10-15) — *"방을 나갔다가
   * 들어오면 다시 최근 100개만 로딩하고"*.
   *
   * 🔴 방을 **바꿀 때**만 되돌리면, 나갔다 **같은 방**으로 돌아올 때는 아까
   * 펴둔 만큼이 그대로 다시 그려진다 — 가장 비싼 순간(캐시가 식은 뒤)에
   * 제일 많이 짓는 셈이다.
   */
  S.shownCount = PAGE;
  S.joinFails = new Map();
  S.joinSteps = new Map();
  // 제대로 들어가는 길이다 — 「기록만」 표시는 여기서 풀린다
  S.peeking = null;
  post({ t: "open", roomId });
  /*
   * ★ **붙는 동안은 붙는 화면에 선다** (2026-10-13).
   *
   * 한 번 들어갔던 방은 다시 안 세운다 — 세션이 이미 붙어 있어 **한 프레임
   * 번쩍하고 사라질** 뿐이다.
   */
  go(joined.has(roomId) ? "chat" : "joining");
}

/**
 * ★ **기록만 읽는다** (2026-10-13).
 *
 * 세션을 안 붙이고 연다. 「잠깐 뭐라고 했더라」 보러 들어온 사람에게
 * **Antigravity 17초**를 물릴 이유가 없다 — 기록은 우리 것이라 CLI 가
 * 없어도 읽힌다. 입력창은 `renderChat` 이 세션 없음을 보고 잠근다.
 */
export function peekRoom(roomId: string): void {
  S.viewBotId = null;
  S.joinFails = new Map();
  S.shownCount = PAGE;
  S.peeking = roomId;
  post({ t: "peek", roomId });
  go("chat");
}

export function leaveChat(): void {
  S.viewBotId = null;
  flushDraft();
  post({ t: "back" });
  S.room = null;
  S.chat = null;
  /*
   * ★ **딸린 화면들을 비운다** (2026-09-30).
   *
   * 권한·참여자·모델고르기는 **그 방의 것**이다. 화면으로 빼면서 내용이
   * 스택 밖에 남게 됐는데, 안 비우면 다음 방에서 열었을 때 **앞 방의 봇
   * 이름이 한 순간 스친다** — 다시 그리기 전까지.
   */
  for (const s of [screens.perm, screens.bots, screens.fix, screens.invite]) s.replaceChildren();
  S.stack = ["list"];
  paintScreens();
}

function flushDraft(): void {
  if (!S.room || !S.chat) return;
  clearTimeout(draftTimer);
  post({ t: "draft", roomId: S.room.id, text: S.chat.box.value });
}

/**
 * 채팅 화면의 고정 부분.
 *
 * **입력창을 다시 만들지 않으려고 붙잡아 둔다.** 스트리밍 중에는 방 갱신이
 * 초당 열몇 번 오는데, 그때마다 화면을 통째로 갈아끼우면 **답변을 기다리며
 * 타이핑하던 글자와 포커스가 날아간다.**
 */
export interface ChatEls {
  roomId: string;
  head: HTMLElement;
  /**
   * ★ **부딪힘 띠** — 승인 큐 바로 아래 (§4.3).
   *
   * 🔴 **입력창이 보이는 자리여야 한다.** 막을 수 있는 층은 사람뿐이라,
   * 「@베타 api.ts 고쳐줘」를 **치기 전에** 보이는 것이 유일한 진짜 예방이다.
   * 서랍에 넣으면 열어볼 생각이 든 시점에 이미 늦는다.
   */
  clash: HTMLElement;
  list: HTMLElement;
  /**
   * ★ **«읽던 자리로»** — 찾아가기로 화면이 움직였을 때만 뜬다 (2026-09-23).
   *
   * 대화 **아래**에 둔다. 위에 두면 막 스크롤해 온 자리를 또 가리고, 돌아갈
   * 방향(아래)과 단추 자리가 어긋난다.
   */
  back: HTMLElement;
  /**
   * ★ **«맨 아래로»** — 위로 올라가 있을 때만 뜬다 (사용자, 2026-10-15).
   *
   * «읽던 자리로»와 **같은 자리, 같은 모양**이다 — 하는 일이 같으므로(아래로
   * 데려다준다) 모양이 둘이면 읽는 사람이 둘을 외운다.
   *
   * 🔴 **둘이 같이 뜨지 않는다.** 찾아가기로 움직인 참이면 돌아갈 곳은
   * «읽던 자리»지 바닥이 아니다 — 그때는 그쪽이 이긴다.
   */
  down: HTMLElement;
  status: HTMLElement;
  chips: HTMLElement;
  box: HTMLTextAreaElement;
  perm: HTMLElement;
  /** 중단 — 보내기 바로 왼쪽. 턴이 도는 동안에만 보인다 (2026-10-13) */
  stop: HTMLButtonElement;
  /** 단체방의 «누구에게 가나» 줄 (v2.0). 1:1에서는 숨어 있다 */
  compose: HTMLElement;
  /**
   * ★ **올려둔 한 칸, 또는 치워둔 글** — 입력창 바로 위 (v3.0 1-E).
   *
   * 🔴 **접거나 작게 하지 않는다.** 올려두고 잊으면 10분 뒤 뜬금없이 나가서
   * «이게 왜 나가?»가 된다. 계속 보이는 것이 이 줄의 값이다.
   */
  staged: HTMLElement;
  /**
   * **승인 큐** — 헤더 바로 아래 (D1).
   *
   * 🔴 카드를 대화 맨 아래에 쌓았더니 **둘만 넘어가도 답할 것이 뭔지 흐려졌고**,
   * 대화는 자동으로 바닥까지 스크롤되는데 카드는 그 아래라 오히려 밀렸다.
   * 답해야 하는 것은 **대화와 같이 흐르면 안 된다** — 붙박이여야 한다.
   */
  queue: HTMLElement;
}

export function renderChat(): void {
  const r = S.room;
  if (!r) return;
  /*
   * 🔴 **봇이 하나에서 둘이 되면 입력창을 갈아 끼워야 한다.**
   *
   * `mountChat`은 붙이는 순간에 «단체방인가»를 보고 `textarea`와 칩 상자 중
   * 하나를 고른다. 그런데 방은 **도중에 바뀜다** — 1:1에서 봇을 부르면
   * 그 자리에서 단체방이 된다(§4.2). 다시 붙이지 않으면 `textarea`가 남아
   * **@로 지목할 수가 없어 사실상 단체방이 아니게 된다.**
   */
  // 방에서 나간 봇을 보고 있었으면 뷰를 푼다 — 빈 화면을 보여줄 수는 없다
  if (S.viewBotId && !r.participants.some((b) => b.id === S.viewBotId)) S.viewBotId = null;

  // **뷰에서는 1:1 모양이다** — 그 봇에게만 가므로 `@`를 칠 이유가 없다 (§5)
  const wantChips = hasManyBots(r) && S.viewBotId === null;
  const hasChips = S.chat?.box.classList.contains("chipbox") === true;
  if (S.chat?.roomId !== r.id || wantChips !== hasChips) {
    /*
     * 다시 붙이면 `screens.chat`을 통째로 갈아끼우므로 **열려 있던 것까지
     * 같이 날아간다.** 하필 그 순간이 «서랍에서 봇을 부른 직후»라,
     * 부르자마자 보던 화면이 사라지게 된다. 되살려둔다.
     */
    const wasDrawer = screens.bots.firstElementChild !== null;
    const wasSheet = screens.perm.firstElementChild !== null;
    mountChat(r);
    paintChat(r);
    if (wasDrawer) paintDrawer(r);
    if (wasSheet) paintPermissionSheet(r);
    return;
  }
  refreshMentionChips(r);
  paintChat(r);
  paintStaged(r);
  paintSendButton(r);
}

function mountChat(r: Room): void {
  // 방이 바뀌면 이전 방의 말풍선을 들고 있을 이유가 없다
  nodeCache.clear();

  /**
   * ★ **지금 방.** 처리기 안에서는 `r` 대신 이것을 쓴다.
   *
   * 🔴 `r` 은 **붙일 때의 방이고 그 뒤로 안 바뀐다.** 다시 붙는 것은 방이
   * 바뀌거나 1:1↔단체가 뒤집힐 때뿐이라, **이름을 바꿔도 그대로다.** 그래서
   * 여기 걸린 처리기들이 옛 이름이 박힌 방을 계속 봤다:
   *
   * ```
   * 멘션 자동완성       고른 이름이 화면 어디에도 없는 이름이었다
   * «누구에게 가나» 줄  옛 이름으로 «…에게 갑니다»
   * 권한 설정 시트      열 때마다 옛 이름                  ← 열려 있으면 갱신되는데
   *                                                          «열 때»가 옛 방이었다
   * ```
   *
   * 열려 있는 동안은 `paintChat` 이 갱신해 주므로 **«열 때»만 어긋났다** —
   * 그래서 더 찾기 어려웠다.
   */
  const live = (): Room => (S.room?.id === r.id ? S.room : r);

  const head = el("header", { class: "bar" });
  const queue = el("div", { class: "approvals", hidden: true });
  const clash = el("div", { class: "clashes", hidden: true });
  const list = el("div", { class: "messages" });
  const back = el("div", { class: "back-jump", hidden: true });
  const down = el("div", { class: "back-jump to-bottom", hidden: true });
  const status = el("div", { class: "status" });
  /*
   * 단체방에서만 칩 상자다 — 봇이 하나인데 `@`를 치게 할 이유가 없다.
   *
   * ★ **봇별 뷰에서도 아니다** (v2.1) — 그 봇에게만 가므로 지목할 것이 없다.
   * 🔴 `renderChat` 의 «다시 붙일까» 판단과 **같은 식이어야 한다.** 한쪽만
   * 고쳤더니 다시 붙기는 하는데 **또 칩 상자로** 붙었다.
   */
  const group = hasManyBots(r) && S.viewBotId === null;
  const box = (group
    ? makeChipBox()
    : el("textarea", { rows: 1, placeholder: "메시지 입력…" })) as HTMLTextAreaElement;
  const perm = el("button", { class: "icon perm" }, icon("shield"));
  /*
   * ★ **중단 — 입력창 바로 위, 오른쪽에 떠 있는다** (2026-10-13).
   *
   * 사용자: *"중단을 입력창 바로위 오른쪽에 붙이는건 어때? 필요할때만 나오는
   * 방식?"* / *"빨간색 버튼으로"* / *"스크롤 왼쪽"*.
   *
   * ⏪ 말풍선 아래였다 — 답이 길어질수록 **밀려 내려가고** 스크롤하면 사라진다.
   * ⏪ 입력줄 안에도 넣어봤다 — 뜨고 질 때마다 **입력창 너비가 38px 씩 움직여서**
   *    타이핑하던 글자가 밀린다.
   *
   * 그래서 **자리를 안 먹게 띄운다**(`.stop-row` 는 높이 0). 나타나도 아무것도
   * 안 밀리고, 대화의 오른쪽 아래 — 스크롤바 왼쪽 — 에 떠 있는다.
   * 도는 동안에만 보인다: `paintStatus` 가 켜고 끈다.
   */
  const stop = el("button", {
    class: "stop", hidden: true,
    onclick: () => post({ t: "stopAll", roomId: r.id }),
  }, icon("debug-stop"), el("span", { class: "stop-say" })) as HTMLButtonElement;
  const stopRow = el("div", { class: "stop-row" }, stop);
  const chips = el("div", { class: "chips", hidden: true });
  const compose = el("div", { class: "compose-note", hidden: true });
  const staged = el("div", { class: "staged-row", hidden: true });

  if (!group) {
    box.value = r.draft ?? "";
    autoGrow(box);
  }

  const send = () => {
    /*
     * 🔴 **단추를 끄는 것만으로는 부족하다.** 엔터는 이 함수를 바로 부른다 —
     * 끈 단추를 지나쳐 들어온다. 규칙은 한 자리에서 지킨다.
     */
    if (live().staged) { paintSendButton(live()); return; }
    if (group) {
      const tokens = readTokens(box);
      const parsed = parseCompose(tokens, live().participants);
      // 막힐 줄을 알고 보내지 않는다 — 화면이 먼저 말해준다
      if (parsed.blocked) { paintCompose(live(), box); return; }
      if (parsed.blocks.length === 0 && S.pending.length === 0) return;
      // 다음번 «직전 그룹»은 지금 보낸 첫 블록이다
      S.lastGroup = parsed.blocks[0]?.botIds ?? [];
      const attachments = S.pending;
      S.pending = [];
      paintChips();
      box.replaceChildren();
      closePicker();
      paintCompose(live(), box);
      /*
       * ★ **바쁘면 보내는 대신 올려둔다** (v3.0 1-E).
       *
       * ⏪ 예전에는 그냥 보냈고 코어가 **저절로** 줄에 세웠다. 그게 엇갈림을
       * 만들었다 — 10분짜리 일이 끝난 뒤에 «그거 말고 이거»가 나가서 이미
       * 끝난 일에 대한 정정이 날아갔다.
       *
       * 🔴 **한 명이라도 바쁘면 통째로** 올려둔다. 반만 나가면 «반만 나간 것»을
       * 사용자가 알아야 하고, 그걸 말해주려면 결국 «줄 서 있음» 표시가 다시
       * 필요해진다.
       */
      const held = busyAmong(live(), parsed.blocks.flatMap((b) => b.botIds));
      post({
        t: held.length > 0 ? "stage" : "sendCompose",
        roomId: r.id,
        tokens,
        ...(attachments.length ? { attachments } : {}),
      });
      return;
    }

    const text = box.value.trim();
    // 첨부만 보내는 것도 메신저에서는 자연스럽다
    if (!text && S.pending.length === 0) return;
    const attachments = S.pending;
    S.pending = [];
    paintChips();
    box.value = "";
    autoGrow(box);

    /*
     * ★ **뷰에서 친 말은 «@그봇»을 붙인 것으로 간다** (§5).
     *
     * 🔴 `send` 에 봇 칸을 새로 파지 않는다. 멘션 경로(`sendCompose`)가 이미
     * 라우팅·분리 저장·전달 표시를 다 하고 있어서, 길을 하나 더 내면 **둘이
     * 어긋날 자리**만 생긴다. 뷰는 «칩을 대신 꽂아 주는 것»일 뿐이다.
     */
    if (S.viewBotId) {
      const held = busyAmong(live(), [S.viewBotId]);
      post({
        t: held.length > 0 ? "stage" : "sendCompose",
        roomId: r.id,
        tokens: [{ kind: "mention", botId: S.viewBotId }, { kind: "text", text: ` ${text}` }],
        ...(attachments.length ? { attachments } : {}),
      });
      return;
    }

    // 1:1 — 그 하나가 바쁘면 올려둔다
    if (busyAmong(live(), live().participants.map((b) => b.id)).length > 0) {
      post({
        t: "stage",
        roomId: r.id,
        tokens: [{ kind: "text", text }],
        ...(attachments.length ? { attachments } : {}),
      });
      return;
    }

    post({
      t: "send",
      roomId: r.id,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
  };

  box.addEventListener("input", () => {
    if (group) {
      const now = live();
      paintPicker(now, box);
      paintCompose(now, box);
      return;
    }
    autoGrow(box);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => post({ t: "draft", roomId: r.id, text: box.value }), 400);
  });
  box.addEventListener("keydown", (e) => {
    /*
     * ★ **목록이 열려 있으면 Enter는 «고르기»다** (§4.1.2).
     *
     * 안 나누면 봇을 고르려다 메시지가 날아간다. 그래서 이 가지가
     * 한글 조합 검사보다 **먼저** 온다 — 목록이 열려 있는 동안에는
     * 전송이란 게 아예 없다.
     */
    if (S.pickerRows.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePicker(S.pickerAt + 1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePicker(S.pickerAt - 1); return; }
      if (e.key === "Escape") { e.preventDefault(); closePicker(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        e.preventDefault();
        S.pickerRows[S.pickerAt]?.();
        return;
      }
    }
    // **한글 입력 중의 Enter는 조합 확정이다.** 여기서 보내면 글자가 잘린다.
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    send();
  });
  // 붙여넣기는 **글자로만** — 칩으로 자동 변환하지 않는다(§4.1.2).
  // 웹에서 복사한 서식이 그대로 들어오면 토큰을 읽을 수 없게 된다.
  if (group) {
    box.addEventListener("paste", (e) => {
      const ev = e as ClipboardEvent;
      const text = ev.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      ev.preventDefault();
      box.ownerDocument.getSelection()?.getRangeAt(0).deleteContents();
      const node = box.ownerDocument.createTextNode(text);
      box.ownerDocument.getSelection()?.getRangeAt(0).insertNode(node);
      caretAfter(box, node);
      box.dispatchEvent(new Event("input"));
    });
    box.addEventListener("blur", () => setTimeout(closePicker, 120));
  }

  // 스크린샷 붙여넣기 (I1) — 코딩 대화에서 가장 많이 쓰는 경로다
  box.addEventListener("paste", (e) => {
    const files = [...((e as ClipboardEvent).clipboardData?.items ?? [])]
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    void attachFiles(r.id, files);
  });

  // 권한 설정은 ⋮ 안에 숨기지 않는다 — **켜둔 걸 잊으면 안 되는 종류**다.
  // 입력창 옆이면 보낼 때마다 눈에 들어온다.
  perm.setAttribute("title", "권한 설정");
  perm.addEventListener("click", () => togglePermissionSheet(live()));

  replace(
    screens.chat,
    head,
    clash,
    list,
    /*
     * ★ **대화의 바닥에 떠 있는다** (사용자, 2026-10-15).
     *
     * 높이 0 이라 **자리를 안 먹고**, 떠 있는 단추만 대화 위로 올라온다.
     *
     * ⏪ 받침을 **입력창 바로 위**에 뒀다가 물렀다 — 사용자: *"전부 중단
     * 알약이 아래 바가 올라와도 (승인 바 혹은 아래로 내리기 바) 위치가
     * 고정되어서 가리는 문제가 있어"*. 🔴 단추는 받침에서 **위로** 뜨는데
     * 받침이 띠들 **아래**에 있어서, 띠가 서면 그 위에 포개졌다.
     *
     * 목록 바로 뒤에 두면 띠가 설 때마다 목록이 줄고 받침도 **같이 올라간다**
     * — 자리를 손으로 계산하지 않아도 늘 «대화의 바닥»이다.
     */
    stopRow,
    back,
    down,
    status,
    compose,
    staged,
    chips,
    /* ★ **승인은 입력창 바로 위** (§5-M) — 눈이 가 있는 자리다 */
    queue,
    /*
     * ★ **기록만 읽는 방에는 입력창이 없다** (사용자, 2026-10-15).
     *
     * 🔴 **지우지 않고 감춘다.** `chat.box` 를 여러 곳이 들여다보므로
     * (초안·멘션·보내기 단추) 아예 안 만들면 거기서 터진다. 감추면 자리도
     * 안 먹고 손도 안 닿는다 — «있는데 안 되는 것»이 아니라 **없는 것**이다.
     */
    el(
      "div",
      { class: "composer", hidden: S.peeking === r.id },
      el(
        "button",
        { class: "icon", title: "첨부", onclick: () => post({ t: "pickAttachment", roomId: r.id }) },
        icon("add"),
      ),
      perm,
      box,
      el("button", { class: "icon send", title: "보내기", onclick: send }, icon("send")),
    ),
  );

  S.chat = {
    roomId: r.id, head, queue, clash, list, back, down, status, chips, box, perm,
    compose, staged, stop,
  };
  // 방을 갈아타면 돌아갈 자리도 사라진다 — 남의 방 스크롤 값이다
  S.backTo = undefined;
  S.pending = [];
  paintChips();
  // 단체방에서는 **봇마다 에이전트가 다르다** — 전부 물어봐야 누가 뭐를 못 하는지 안다
  for (const agentId of new Set(r.participants.map((b) => b.agentId))) {
    post({ t: "needCaps", agentId });
  }
  // 권한 시트가 봇마다 모드를 보여주므로 **봇마다** 묻는다 — 같은 에이전트라도
  // 세션이 다르면 고른 값이 다르다(B1)
  for (const b of r.participants) {
    post({ t: "needConfig", agentId: b.agentId, roomId: r.id, botId: b.id });
  }
  // 방에 **들어올 때 한 번만** 자리를 잡는다. 갱신마다 하면 화면이 계속 끌려간다.
  paintChat(r);
  paintStaged(r);
  // 🔴 다시 붙이는 길에서도 칠한다 — 안 하면 **방을 옮겼을 때만** 단추가 산다
  paintSendButton(r);
  scrollIntoPlace(list);
}
