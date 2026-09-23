import type {
  Attachment,
  BotInstance,
  SearchHit,
  Message,
  Room,
  RoomMeta,
  RoomStatus,
  RoomUsage,
  PermissionRequest,
  ReviewWait,
  ToolActivity,
  Clash,
} from "../core/types.js";
import { EVERYONE, parseCompose, type ComposeToken } from "../core/mentions.js";
// 🔴 **규칙을 베끼지 않는다.** 화면이 «이렇게 됩니다»라고 약속한 이름과
//    실제로 붙는 이름이 다르면, 그 약속은 없느니만 못하다.
import { uniqueBotName, inBotView, botLabel } from "../core/types.js";
import type {
  AgentBrief,
  AskCard,
  Boot,
  ConfigOptionBrief,
  FromWebview,
  ToWebview,
} from "../protocol.js";
import { forkLabel, orderRooms } from "../protocol.js";

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const boot: Boot = JSON.parse(document.getElementById("boot")!.textContent!);

// ── 상태 ────────────────────────────────────────────────────────────────

let metas: RoomMeta[] = boot.rooms;
let room: Room | null = null;
let compactable = false;
/** 압축을 시킬 수 있는 봇들 — 에이전트마다 다르다 */
let compactableBots: string[] = [];
/**
 * 방의 컨텍스트 점유.
 *
 * **화면에 숫자로 보여주지 않는다** — 토큰·비용은 대화를 읽는 데 방해가 된다.
 * 여기 들고 있는 이유는 **압축 배너(C11)** 하나다: 컨텍스트가 90%를 넘으면
 * «대화 압축하기»를 띄운다. 그건 정보가 아니라 **할 일**이다.
 */
let usage: RoomUsage | undefined;
let firstUnreadId: string | undefined;
const statuses = new Map<string, RoomStatus>();
/**
 * 봇별 상태 — **지금 보는 방의 것만** (v2.0 준비).
 *
 * 방마다 들고 있을 이유가 없다 — 상태 줄은 열린 방에만 그려진다.
 * 목록은 합친 값하나면 충분하다.
 */
let botStatus: Record<string, RoomStatus> = {};
/**
 * **아직 안 보낸 것들** — `botId` → 줄 서 있는 메시지 id들 (§4.3).
 *
 * 상태와 같은 이유로 **지금 보는 방의 것만** 들고 있다. 큐에 쌓인 말풍선은
 * 보낸 것과 똑같이 생겨서, 이게 없으면 «보냈는데 왜 조용하지»가 된다.
 */
let queued: Record<string, string[]> = {};
/**
 * **줄 서 있는 심사들** (§4.2.2) — 지금 보는 방의 것만.
 *
 * 심사 봇의 세션은 하나라 직렬이다(B1). 기다리는 동안 **요청한 봇의 턴은
 * 얼어 있으므로**, 안 보이면 «아무 일도 안 일어난다»가 된다.
 */
let reviews: ReviewWait[] = [];
/** 지금 부딪히는 파일들 (§4.3). 방을 옮기면 갈아 끼운다 */
let clashes: Clash[] = [];
/**
 * ★ **지금 보고 있는 봇** (v2.1 · §5) — `null` 이면 방 전체.
 *
 * 🔴 **방이 아니라 필터다.** 데이터는 하나고 보는 창만 다르다. 그래서 별도
 * 화면을 만들지 않았다 — 화면을 나누면 «별개 공간»이라는 오해가 구조에서
 * 생기고, «1:1 뷰에서 보냄» 같은 표시를 만들고 싶어진다(§5가 하지 말라는 것).
 *
 * 방을 옮기면 풀린다. 뷰는 **그 방 안의 상태**다.
 */
let viewBotId: string | null = null;

/** 지금 뷰의 봇 (방에서 나갔으면 `undefined` — 그때는 뷰도 풀어야 한다) */
function viewBot(r: Room): BotInstance | undefined {
  return viewBotId ? r.participants.find((b) => b.id === viewBotId) : undefined;
}

/**
 * 뷰를 켜고 끈다 (§5).
 *
 * 입력창 모양이 바뀌므로(칩 상자 ↔ 한 줄 입력) `renderChat` 이 **다시 붙인다** —
 * 그 판단은 이미 «단체방인가»로 하고 있어서 여기서 따로 할 일이 없다.
 */
function openBotView(botId: string | null): void {
  viewBotId = botId;
  closeDrawer();
  renderChat();
}

/** 이 메시지가 **어느 봇의 줄에** 서 있나 */
function waitingFor(messageId: string): string[] {
  return Object.keys(queued).filter((id) => queued[id]?.includes(messageId));
}
const configs = new Map<string, ConfigOptionBrief[]>();
/**
 * 설정을 못 불러온 이유.
 *
 * **«아직 안 왔다» · «없다» · «실패했다» 는 서로 다른 화면이어야 한다.**
 * 셋을 하나로 뭉치면 CLI가 안 뜬 걸 *"이 에이전트는 권한 모드가 없다"* 로
 * 읽게 된다 — 사용자가 고칠 수 있는 문제인데 고칠 수 없는 것처럼 보인다.
 */
const configErrors = new Map<string, string>();

/**
 * 설정을 담는 열쇠.
 *
 * 🔴 **에이전트별로만 담으면 방끼리 섞인다.** 세션은 방마다 따로인데(B1) 값이
 * 하나면 방 A에서 계획 모드로 바꾼 게 방 B의 시트에도 «계획»로 나온다.
 * 방이 있으면 방이 열쇠고, 만들기 화면처럼 아직 방이 없을 때만 에이전트다.
 */
/**
 * 설정 캐시의 열쇠 — **봇 단위**다.
 *
 * 🔴 예전에는 `room:<roomId>` 였다. 그래서 단체방의 Claude와 Codex가 **같은
 * 칸을 나눠 썼고**, 나중에 온 쪽이 이겨서 **모델 목록이 서로 엉켰다.**
 * 설정은 세션에 걸리고 세션은 봇 단위다(B1).
 *
 * 봇을 안 주면 **방과 무관한 에이전트 기본값**이다 — 방 만들기 화면과,
 * 아직 방에 없는 에이전트를 미리 볼 때(갈아타기) 쓰는 길.
 */
function configKey(agentId: string, roomId?: string, botId?: string): string {
  return roomId && botId ? `bot:${roomId}:${botId}` : agentId;
}
function optionsFor(
  agentId: string,
  roomId?: string,
  botId?: string,
): ConfigOptionBrief[] | undefined {
  return configs.get(configKey(agentId, roomId, botId));
}
/** 답을 기다리는 카드들. 방을 나갔다 와도 남아 있어야 한다 */
const cards: AskCard[] = [];

/** 답했거나 취소된 카드를 치운다. 실제로 치웠으면 `true` (두 번 답하기 방지) */
function dropCard(id: string): boolean {
  const at = cards.findIndex((c) => c.id === id);
  if (at < 0) return false;
  cards.splice(at, 1);
  return true;
}

const agentById = new Map(boot.agents.map((a) => [a.id, a]));

// ── 화면 전환 (F8) ──────────────────────────────────────────────────────

type ScreenName = "list" | "new" | "chat";
const screens: Record<ScreenName, HTMLElement> = {
  list: document.getElementById("screen-list")!,
  new: document.getElementById("screen-new")!,
  chat: document.getElementById("screen-chat")!,
};
let stack: ScreenName[] = ["list"];

/**
 * 화면을 민다.
 *
 * 목록은 **뒤에 남아 있다** — 사라졌다 나타나면 앱이 아니라 페이지 이동처럼 보인다.
 */
function go(name: ScreenName): void {
  if (stack[stack.length - 1] === name) return;
  stack = name === "list" ? ["list"] : ["list", name];
  paintScreens();
}

function back(): void {
  if (stack.length <= 1) return;
  stack = stack.slice(0, -1);
  paintScreens();
}

function paintScreens(): void {
  const top = stack[stack.length - 1]!;
  for (const [name, el] of Object.entries(screens) as Array<[ScreenName, HTMLElement]>) {
    el.classList.toggle("active", name === top);
    el.classList.toggle("behind", name !== top && stack.includes(name));
  }
  // 첫 페인트에 심어둔 표시를 걷어낸다 — 이제 클래스가 위치를 정한다.
  screens.list.removeAttribute("data-active");
}

// 첫 페인트는 HTML의 `data-active`가 잡고 있었다. 이제 스택이 이어받는다.
paintScreens();

// ── 작은 DOM 헬퍼 ───────────────────────────────────────────────────────

type Kids = Array<Node | string | false | null | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...kids: Kids
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style") Object.assign(node.style, v as object);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) {
    if (kid === false || kid == null) continue;
    node.append(kid);
  }
  return node;
}

const icon = (name: string) => el("i", { class: `codicon codicon-${name}` });

function replace(host: HTMLElement, ...kids: Kids): void {
  host.replaceChildren(...(kids.filter((k) => k != null && k !== false) as Node[]));
}

// ── 목록 ────────────────────────────────────────────────────────────────

const roomsEl = document.getElementById("rooms")!;
document.getElementById("btn-new")!.addEventListener("click", () => openNewRoom());

const filterEl = document.getElementById("filter") as HTMLInputElement;
filterEl.addEventListener("input", () => onFilterInput(filterEl.value));
const onlyHereEl = document.getElementById("only-here")!;
onlyHereEl.addEventListener("click", () => {
  onlyHere = !onlyHere;
  onlyHereEl.setAttribute("aria-pressed", String(onlyHere));
  renderList();
});

filterEl.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  filterEl.value = "";
  onFilterInput("");
});

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

/** 현재 워크스페이스 방만 보기 토글 */
let onlyHere = false;

function renderList(): void {
  const shown = filteredMetas();

  // 검색 중이면 제목 매치를 먼저, 그 아래에 대화 매치를 붙인다
  if (filterText.trim()) {
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

  if (metas.length === 0) {
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

  replace(roomsEl, ...orderRooms(onlyHere ? shown.filter(isHere) : shown, boot.cwd).map(roomNode));
}


function roomNode(m: RoomMeta): HTMLElement {
  {
    {
      const busy = statuses.get(m.id);
      const lineage = forkLabel(m, metas);
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
        { class: "room", "data-id": m.id, onclick: () => openRoom(m.id) },
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

function renameInList(m: RoomMeta): void {
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
      el("button", {
        class: "primary",
        text: "나가기",
        onclick: () => post({ t: "leave", roomId: m.id }),
      }),
      el("button", { text: "취소", onclick: () => renderList() }),
    ),
  );
  row.after(card);
}

// ── 검색 (H) ────────────────────────────────────────────────────────────

/** 목록 화면의 필터어. 메타는 이미 메모리에 있어 사실상 공짜다 (H1) */
let filterText = "";
/** 전문 검색 결과 (H2). 비어 있지 않으면 목록 대신 결과를 그린다 */
let hits: SearchHit[] | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** 방을 열 때 점프할 메시지 (H3) */
let jumpToMessageId: string | undefined;

function onFilterInput(value: string): void {
  filterText = value;
  clearTimeout(searchTimer);

  if (!value.trim()) {
    hits = null;
    renderList();
    return;
  }

  // 제목 필터는 즉시, 전문 검색은 디바운스 — 타이핑마다 전 방을 훑을 이유가 없다
  renderList();
  searchTimer = setTimeout(() => post({ t: "search", query: value }), 220);
}

function filteredMetas(): RoomMeta[] {
  const needle = filterText.trim().toLowerCase();
  if (!needle) return metas;
  return metas.filter((m) => {
    const agent = agentById.get(m.agentIds[0] ?? "");
    return (
      m.title.toLowerCase().includes(needle) ||
      (agent?.label ?? "").toLowerCase().includes(needle)
    );
  });
}

function hitsNode(): HTMLElement {
  const wrap = el("div", { class: "hits" });
  if (hits === null) {
    return el("div", { class: "hits" }, el("p", { class: "dim", text: "대화를 찾는 중…" }));
  }
  if (hits.length === 0) {
    return el("div", { class: "hits" }, el("p", { class: "dim", text: "대화에서 찾지 못했습니다." }));
  }

  wrap.append(el("div", { class: "hits-head", text: `대화 ${hits.length}건` }));
  for (const h of hits) {
    wrap.append(
      el(
        "button",
        {
          class: "hit",
          onclick: () => {
            // 결과를 누르면 그 방의 그 메시지로 (H3)
            jumpToMessageId = h.messageId;
            openRoom(h.roomId);
          },
        },
        el(
          "span",
          { class: "hit-top" },
          el("span", { class: "hit-room", text: h.roomTitle }),
          el("span", { class: "room-time", text: when(h.createdAt) }),
        ),
        markedSnippet(h.snippet, filterText.trim()),
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

// ── 방 안에서 찾기 (H4) ─────────────────────────────────────────────────

let findMatches: HTMLElement[] = [];
let findAt = -1;

function openFind(): void {
  const c = chat;
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

function closeFind(): void {
  clearFindMarks();
  screens.chat.querySelector(".find")?.remove();
}

function clearFindMarks(): void {
  for (const node of findMatches) node.classList.remove("found", "current");
  findMatches = [];
  findAt = -1;
}

// ── 방 만들기 ───────────────────────────────────────────────────────────

/**
 * 만들려는 방의 봇들 (v2.0).
 *
 * 1:1은 **봇이 하나인 단체방**이다 — 타입을 따로 고르게 하지 않는다.
 * 라디오 버튼은 거듭때기다: 봇을 하나 더 넣으면 그게 곧 단체방이고,
 * 아이콘도 `roomKind()`가 참여자 수로 알아서 바꾼다.
 */
interface DraftBot {
  agentId: string;
  /** 모델·추론 강도 — 봇마다 따로 고른다 */
  picks: Map<string, string | boolean>;
  role: string;
  /** 부를 이름. 비우면 에이전트 이름이 된다 */
  name: string;
}
let draftBots: DraftBot[] = [newDraftBot()];

function newDraftBot(): DraftBot {
  return { agentId: boot.agents[0]?.id ?? "", picks: new Map(), role: "", name: "" };
}

/**
 * ★ **실제로 붙을 이름을 미리 계산한다** — 코어와 **같은 순서, 같은 규칙**으로.
 *
 * 이름은 방 안에서 유일해야 해서 겹치면 뒤에 수가 붙는다(`uniqueBotName`).
 * 그걸 만들고 나서야 알게 되면 **«내가 친 것과 다른 이름»** 을 방에 들어가서
 * 발견하게 된다. 미리 보여주면 고칠 기회가 있다.
 */
function draftNames(): string[] {
  const taken = new Set<string>();
  return draftBots.map((b) => {
    const label = boot.agents.find((a) => a.id === b.agentId)?.label ?? b.agentId;
    const name = uniqueBotName(b.name.trim() || label, taken);
    taken.add(name);
    return name;
  });
}
/** 방금 손대던 봇 — 빼기를 누른 뒤 범위를 안전하게 유지하려고 둔다 */
let draftAt = 0;
let draftCwd = "";

function openNewRoom(): void {
  draftCwd = "";
  /*
   * 🔴 **초안을 들고 있지 않는다.**
   *
   * 봇을 셋 넣어 방을 만든 뒤에 다시 «새 대화방»을 열면 그 셋이 그대로
   * 남아 있었다 — 방을 만드는 것은 **매번 새로 정하는 일**이지 직전을 이어가는
   * 일이 아니다. 제목·역할은 매번 비워 주면서 봇 수만 남겨두면 더 이상하다.
   */
  draftBots = [newDraftBot()];
  draftAt = 0;
  renderNew();
  go("new");
  for (const b of draftBots) if (b.agentId) post({ t: "needConfig", agentId: b.agentId });
  setTimeout(() => screens.new.querySelector<HTMLInputElement>("#new-title")?.focus(), 240);
}

function renderNew(error?: string): void {
  // 화면을 다시 만들므로 «이렇게 됩니다» 줄도 새로 모은다 — 옛 노드를 들고
  // 있으면 화면에 없는 것을 계속 고치게 된다
  draftBent.length = 0;

  const title = el("input", { type: "text", id: "new-title", placeholder: "비우면 «새 대화»" });
  const cwdInput = el("input", {
    type: "text",
    id: "new-cwd",
    value: draftCwd,
    // 워크스페이스 루트여도 없애지 않고 «현재 워크스페이스»라고 말해준다
    placeholder: "현재 워크스페이스",
  });

  const create = el("button", { class: "primary", text: "만들기" }) as HTMLButtonElement;

  /**
   * 🔴 **폴더가 없으면 고르게 한다** (B9).
   *
   * `cwd`는 워크스페이스가 없어도 홈으로 채워지므로 그대로 만들면 **에이전트가
   * 홈 디렉터리에서 돈다** — 거기서는 «워크스페이스 안/밖»(I4) 구분도 무의미해져
   * 무엇을 건드릴지 가늠할 수 없다. cwd는 어차피 방마다 정하는 값이니(CLI도
   * 세션마다 받는다) **막을 게 아니라 물어보면 된다.**
   */
  const needsFolder = () => !boot.hasWorkspace && cwdInput.value.trim() === "";
  const syncCreate = () => {
    create.disabled = needsFolder();
    create.title = needsFolder() ? "작업할 폴더를 먼저 고르세요" : "";
  };
  cwdInput.addEventListener("input", syncCreate);
  syncCreate();
  // 다 그린 뒤 한 번 — 처음부터 겹쳐 있을 수 있다 (같은 에이전트를 둘 고른 채로)
  queueMicrotask(syncDraftNames);

  create.addEventListener("click", () => {
    if (needsFolder()) return;
    create.disabled = true;
    create.textContent = "여는 중…";
    post({
      t: "createRoom",
      agentId: draftBots[0]?.agentId ?? "",
      title: title.value.trim(),
      ...(cwdInput.value.trim() ? { cwd: cwdInput.value.trim() } : {}),
      bots: draftBots.map((b) => ({
        agentId: b.agentId,
        ...(b.name.trim() ? { name: b.name.trim() } : {}),
        ...(b.role.trim() ? { rolePrompt: b.role.trim() } : {}),
        ...(b.picks.size > 0 ? { configValues: Object.fromEntries(b.picks) } : {}),
      })),
    });
  });

  replace(
    screens.new,
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "뒤로", onclick: () => back() }, icon("arrow-left")),
      el("h1", { text: "새 대화방" }),
    ),
    el(
      "div",
      { class: "form" },
      el("div", { class: "field" }, el("label", { text: "방 제목" }), title),
      ...draftBots.map((b, n) => botFieldset(b, n)),
      // 봇을 하나 더 넣으면 그게 곧 단체방이다 — 타입을 따로 고르게 하지 않는다
      el("div", { class: "row" },
        el("button", {
          class: "ghost",
          text: "+ 봇 추가",
          onclick: () => {
            draftBots.push(newDraftBot());
            draftAt = draftBots.length - 1;
            renderNew();
          },
        }),
        draftBots.length > 1
          ? el("span", { class: "dim", text: `봇 ${draftBots.length}개 — 단체방으로 만들어집니다` })
          : el("span", { class: "dim", text: "혼자 쓰면 1:1 방입니다" }),
      ),
      el(
        "div",
        { class: "field" },
        el("label", { text: "작업 디렉터리" }),
        el(
          "div",
          { class: "cwd" },
          cwdInput,
          el(
            "button",
            { class: "ghost", onclick: () => post({ t: "pickCwd" }) },
            icon("folder-opened"),
          ),
        ),
        boot.hasWorkspace
          ? null
          : el("span", {
              class: "dim",
              text: "열린 폴더가 없습니다. 에이전트가 일할 폴더를 고르세요.",
            }),
      ),
      error ? el("p", { class: "error", text: error }) : null,
      el(
        "div",
        { class: "actions" },
        el("button", { class: "ghost", text: "취소", onclick: () => back() }),
        create,
      ),
    ),
  );
}

/**
 * 봇 하나를 고르는 칸 (v2.0).
 *
 * 1:1이든 단체방이든 **같은 블록이 반복될 뿐**이다 — 모델·역할이
 * 전부 봇에 붙는 값이라(D2·B3) 봇마다 따로 받아야 한다.
 */
function botFieldset(b: DraftBot, n: number): HTMLElement {
  const label = boot.agents.find((a) => a.id === b.agentId)?.label ?? b.agentId;
  const name = el("input", {
    type: "text",
    value: b.name,
    // 비워두면 에이전트 이름이 된다 — 빈 칸이 «이름 없음»이 아니라고 말해준다
    placeholder: label,
  }) as HTMLInputElement;
  // 고유 클래스 — 봇 상자 안에는 «흐린 글씨»가 여럿이라 그것만으로는 못 고른다
  const bent = el("span", { class: "dim bot-bent", hidden: true });
  name.addEventListener("input", () => {
    b.name = name.value;
    // 앞 봇의 이름이 바뀌면 **뒤 봇의 최종 이름도 바뀐다** — 전부 다시 본다
    syncDraftNames();
  });
  draftBent.push({ b, hint: bent });

  const role = el("textarea", {
    placeholder: "예) 너는 코드 리뷰어다. 구현하지 말고 지적만 해라.",
    ...(n === 0 ? { id: "new-role" } : {}),
  }) as HTMLTextAreaElement;
  role.value = b.role;
  role.addEventListener("input", () => (b.role = role.value));

  return el(
    "fieldset",
    { class: "bot" },
    el("legend", { text: draftBots.length > 1 ? `봇 ${n + 1}` : "봇" }),
    draftBots.length > 1
      ? el("button", {
          class: "link bot-drop",
          text: "빼기",
          onclick: () => {
            draftBots.splice(n, 1);
            draftAt = Math.min(draftAt, draftBots.length - 1);
            renderNew();
          },
        })
      : null,
    el(
      "div",
      { class: "field" },
      el("label", { text: "에이전트" }),
      el("div", { class: "agents" }, ...boot.agents.map((a) => agentButton(a, b, n))),
    ),
    /*
     * ★ **부를 이름** — 에이전트 바로 아래 (v2.2 앞당김).
     *
     * 🔴 같은 에이전트로 봇을 둘 넣으면 `Claude`·`Claude 2` 가 된다. 그러면
     * **@로 지목할 때 누가 누군지 알 수가 없고**, 방에 들어가서 하나씩 고치게
     * 된다. 이름은 에이전트를 고른 «그 자리»에서 정하는 게 맞다 —
     * 기본값이 에이전트 이름이라 붙어 있어야 뜻이 통한다.
     */
    el("div", { class: "field" },
      el("label", { text: "이름 (선택)" }),
      name,
      bent),
    // 에이전트를 고른 뒤에 채워진다. 미리 받아두어 기다림이 없다 (B15)
    ...configFields(configs.get(b.agentId), b.picks),
    el("div", { class: "field" }, el("label", { text: "역할 (선택)" }), role),
  );
}

/** 겹쳐서 **수가 붙는 봇**에게만 «이렇게 됩니다»를 단다 */
const draftBent: Array<{ b: DraftBot; hint: HTMLElement }> = [];

function syncDraftNames(): void {
  const names = draftNames();
  for (const [n, { b, hint }] of draftBent.entries()) {
    const label = boot.agents.find((a) => a.id === b.agentId)?.label ?? b.agentId;
    const wanted = b.name.trim() || label;
    const got = names[n] ?? wanted;
    hint.hidden = got === wanted;
    hint.textContent = `«${wanted}»은(는) 이미 있어서 «${got}»이(가) 됩니다.`;
  }
}

function agentButton(a: AgentBrief, b: DraftBot, n: number): HTMLElement {
  return el(
    "button",
    {
      class: "agent",
      "aria-pressed": a.id === b.agentId,
      onclick: () => {
        if (a.id === b.agentId) return;
        b.agentId = a.id;
        // 모델은 에이전트마다 다르다 — 압은 것을 그대로 두면 없는 id를 보낸다
        b.picks.clear();
        draftAt = n;
        renderNew();
        if (!configs.has(a.id)) post({ t: "needConfig", agentId: a.id });
      },
    },
    el("span", { class: "dot", style: { background: a.color } }),
    el(
      "span",
      { class: "agent-main" },
      el("span", { class: "agent-name", text: a.label }),
      a.description ? el("span", { class: "agent-desc", text: a.description }) : null,
    ),
  );
}

/** 모델·추론 강도 등. 에이전트가 주는 대로 그린다 — 종류를 우리가 정하지 않는다 */
/**
 * 범주별 표시 순서 (B15).
 *
 * **에이전트가 주는 순서를 그대로 쓰면 안 된다.** 실측:
 *
 * ```
 * Claude Code   Model · Effort · Fast mode
 * Codex         Mode · Collaboration mode · Model · Reasoning effort
 * ```
 *
 * 에이전트를 바꿀 때마다 같은 자리에 다른 게 있으면 매번 다시 읽어야 한다.
 */
const CATEGORY_ORDER = ["model", "thought_level", "model_config"];

/**
 * 우리 이름으로 통일한다.
 *
 * 같은 걸 Claude는 `Effort`, Codex는 `Reasoning effort`라 부른다.
 * **의미가 또렷한 범주만** 바꾼다 — `model_config`는 잡다한 묶음이라
 * 에이전트가 붙인 이름(`Fast mode`)이 더 정확하다.
 */
const CATEGORY_LABEL: Record<string, string> = {
  model: "모델",
  thought_level: "사고 강도",
};


/**
 * 세션 설정을 그린다 (B15).
 *
 * **모델만 밖에 두고 나머지는 접는다.** 에이전트가 주는 걸 전부 펼치면
 * 방 하나 만드는 데 드롭다운 네 개를 지나야 한다 — 대부분은 기본값이면 된다.
 */
function configFields(
  options: ConfigOptionBrief[] | undefined,
  picks: Map<string, string | boolean>,
): Kids {
  if (!options) return [el("p", { class: "dim", text: "모델 목록을 불러오는 중…" })];

  // **권한 모드는 여기 없다** (D2). 방을 만들 때 정해봐야 쓰면서 바꾸게 되므로
  // **입력창 옆 권한 설정**에서 한 자리로 다룬다. 여기서는 에이전트 기본값으로 시작한다.
  const usable = options.filter(
    (o) => o.category !== "mode" && o.values && o.values.length > 0,
  );
  if (usable.length === 0) {
    return [
      el("p", {
        class: "dim",
        text: "이 에이전트는 고를 수 있는 모델을 알려주지 않습니다. 그대로 만들어도 됩니다.",
      }),
    ];
  }

  // 현재 값을 미리 담아둔다 — 손대지 않은 항목도 세션에 그대로 적용되도록
  for (const o of usable) {
    if (o.current !== undefined) picks.set(o.configId, o.current);
  }

  const rank = (o: ConfigOptionBrief) => {
    const at = CATEGORY_ORDER.indexOf(o.category ?? "");
    return at < 0 ? CATEGORY_ORDER.length : at;
  };
  const sorted = usable
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)
    .map((x) => x.o);

  const model = sorted.filter((o) => o.category === "model");
  const rest = sorted.filter((o) => o.category !== "model");
  const out: Kids = model.map((o) => configRow(o, picks));

  if (rest.length > 0) {
    out.push(
      el(
        "details",
        { class: "advanced" },
        el("summary", {}, icon("chevron-right"), " 고급 설정"),
        el("div", { class: "advanced-body" }, ...rest.map((o) => configRow(o, picks))),
      ),
    );
  }
  return out;
}

function configRow(o: ConfigOptionBrief, picks: Map<string, string | boolean>): HTMLElement {
  const select = el("select") as HTMLSelectElement;
  for (const v of o.values!) {
    select.append(el("option", { value: v.id, text: v.name, selected: v.id === o.current }));
  }
  // **설명은 에이전트가 준 걸 그대로 보여준다.** 우리가 다시 쓰면
  // 에이전트가 바뀔 때 틀린 말이 남는다.
  const hint = el("span", { class: "dim" });
  const paint = () => {
    hint.textContent = o.values!.find((v) => v.id === select.value)?.description ?? "";
    hint.hidden = hint.textContent === "";
  };
  select.addEventListener("change", () => {
    picks.set(o.configId, select.value);
    paint();
  });
  paint();

  return el("div", { class: "field" }, el("label", { text: labelOf(o) }), select, hint);
}

/** 에이전트가 뭐라 부르든 화면에서는 같은 이름이어야 한다 */
function labelOf(o: ConfigOptionBrief): string {
  return CATEGORY_LABEL[o.category ?? ""] ?? o.name;
}


// ── 채팅 ────────────────────────────────────────────────────────────────

let draftTimer: ReturnType<typeof setTimeout> | undefined;

function openRoom(roomId: string): void {
  // 뷰는 **그 방 안의 상태**다 — 다른 방에 들고 가면 엉뚱한 봇을 가리킨다
  viewBotId = null;
  post({ t: "open", roomId });
  go("chat");
}

function leaveChat(): void {
  viewBotId = null;
  flushDraft();
  post({ t: "back" });
  room = null;
  chat = null;
  back();
}

function flushDraft(): void {
  if (!room || !chat) return;
  clearTimeout(draftTimer);
  post({ t: "draft", roomId: room.id, text: chat.box.value });
}

/**
 * 채팅 화면의 고정 부분.
 *
 * **입력창을 다시 만들지 않으려고 붙잡아 둔다.** 스트리밍 중에는 방 갱신이
 * 초당 열몇 번 오는데, 그때마다 화면을 통째로 갈아끼우면 **답변을 기다리며
 * 타이핑하던 글자와 포커스가 날아간다.**
 */
interface ChatEls {
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
  status: HTMLElement;
  chips: HTMLElement;
  box: HTMLTextAreaElement;
  perm: HTMLElement;
  /** 단체방의 «누구에게 가나» 줄 (v2.0). 1:1에서는 숨어 있다 */
  compose: HTMLElement;
  /**
   * **승인 큐** — 헤더 바로 아래 (D1).
   *
   * 🔴 카드를 대화 맨 아래에 쌓았더니 **둘만 넘어가도 답할 것이 뭔지 흐려졌고**,
   * 대화는 자동으로 바닥까지 스크롤되는데 카드는 그 아래라 오히려 밀렸다.
   * 답해야 하는 것은 **대화와 같이 흐르면 안 된다** — 붙박이여야 한다.
   */
  queue: HTMLElement;
}
let chat: ChatEls | null = null;

function renderChat(): void {
  const r = room;
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
  if (viewBotId && !r.participants.some((b) => b.id === viewBotId)) viewBotId = null;

  // **뷰에서는 1:1 모양이다** — 그 봇에게만 가므로 `@`를 칠 이유가 없다 (§5)
  const wantChips = r.participants.length > 1 && viewBotId === null;
  const hasChips = chat?.box.classList.contains("chipbox") === true;
  if (chat?.roomId !== r.id || wantChips !== hasChips) {
    /*
     * 다시 붙이면 `screens.chat`을 통째로 갈아끼우므로 **열려 있던 것까지
     * 같이 날아간다.** 하필 그 순간이 «서랍에서 봇을 부른 직후»라,
     * 부르자마자 보던 화면이 사라지게 된다. 되살려둔다.
     */
    const wasDrawer = screens.chat.querySelector(".drawer") !== null;
    const wasSheet = screens.chat.querySelector(".sheet") !== null;
    mountChat(r);
    paintChat(r);
    if (wasDrawer) paintDrawer(r);
    if (wasSheet) paintPermissionSheet(r);
    return;
  }
  refreshMentionChips(r);
  paintChat(r);
}

/**
 * ★ **입력창에 이미 꽂힌 칩의 이름을 고친다** (§4.1.2).
 *
 * 🔴 칩은 `data-bot` 을 들고 있어서 **라우팅은 멀쩡하다** — 이름을 바꿔도
 * 그 봇에게 간다. 그런데 **글자는 만들 때 박아 넣은 옛 이름 그대로**라,
 * 「@구현」이라 적힌 칩을 보내면 화면에는 「@리뷰어」에게 간 것으로 나온다.
 * 보이는 것과 가는 곳이 어긋나면 **어디를 믿어야 할지 알 수 없다.**
 *
 * 글자가 실제로 다를 때만 손댄다 — contenteditable 안이라 건드리면 커서가
 * 튈 수 있고, 이름 바꾸기는 어차피 드물다.
 */
function refreshMentionChips(r: Room): void {
  const box = chat?.box;
  if (!box) return;
  for (const chip of box.querySelectorAll<HTMLElement>(".chip[data-bot]")) {
    const id = chip.getAttribute("data-bot") ?? "";
    const name = id === EVERYONE
      ? "everyone"
      : (r.participants.find((b) => b.id === id)?.name ?? id);
    const want = `@${name}`;
    if (chip.textContent !== want) chip.textContent = want;
  }
}

// ── 멘션 칩 입력창 (§4.1.2) ────────────────────────────────────────────

/**
 * **단체방의 입력창** — 칩으로 지목한다.
 *
 * 1:1에서는 안 쓴다. 봇이 하나인데 `@`를 치게 할 이유가 없다 — 지목이 뜻을 갖는
 * 것은 **고를 상대가 있을 때**부터다.
 *
 * ✅ **한글이 안 깨진다** (2026-09-21 실측, §4.1.2). 조합 이벤트가 `textarea`와
 * 한 글자도 다르지 않았고, 칩은 백스페이스 한 번에 통째로 지워진다. 그래서
 * `contenteditable`을 그대로 쓴다.
 *
 * 🔴 **칩만 멘션이다.** 직접 친 `@gmail.com`은 그냥 글자다. 칩은 `botId`를 들고
 * 있어서 **이름을 바꿔도 라우팅이 유지된다** — 보이는 이름과 가리키는 대상이
 * 따로 놀 수 있다는 뜻이고, 그게 칩을 쓰는 진짜 이유다.
 */
function makeChipBox(): HTMLElement {
  const box = el("div", {
    class: "box chipbox",
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "true",
    "data-empty": "메시지 입력…  @로 지목",
  });
  return box;
}

/**
 * **보내기 전에 누구에게 가는지 보여준다** (§4.1.2).
 *
 * «보이는데 봇은 모른다»가 이 설계의 유일한 위험이다(§4.1.1). 그런데
 * 그 간극은 **보내기 전에** 줄이는 게 제일 싸다 — 보내고 나서 «안 갔다»는
 * 이미 한 번 틀린 뒤다.
 */
function paintCompose(r: Room, box: HTMLElement): void {
  const bar = chat?.compose;
  if (!bar) return;
  box.dataset.filled = box.textContent?.trim() || box.querySelector(".chip") ? "1" : "";

  const tokens = readTokens(box);
  const parsed = parseCompose(tokens, r.participants);
  if (!box.dataset.filled) { bar.replaceChildren(); bar.hidden = true; return; }

  bar.hidden = false;
  if (parsed.blocked) {
    /*
     * ★ **아직 안 쓴 것은 잘못이 아니다.**
     *
     * 🔴 칩을 꽂자마자 빨간 «보낼 내용이 없습니다»가 떴다. 자동완성으로
     * 고르든 서랍에서 꽂든 **지목이 먼저고 지시가 나중**인데, 그 사이의
     * 한 박자를 오류로 찍은 것이다. 틀린 말은 아니지만 **사용자가 뭘 잘못한
     * 것처럼** 보이고, 매번 뜨면 진짜 경고까지 같이 무시하게 된다.
     *
     * 지목만 있으면 **다음에 할 일을 알려준다.**
     */
    const named = tokens.filter((t) => t.kind === "mention");
    const nothingYet =
      named.length > 0 &&
      tokens.every((t) => t.kind === "mention" || t.text.trim() === "");
    if (nothingYet) {
      const names = named
        .map((t) =>
          t.kind === "mention" && t.botId !== EVERYONE
            ? (r.participants.find((p) => p.id === t.botId)?.name ?? "?")
            : "전원",
        )
        .join("·");
      bar.className = "compose-note";
      bar.replaceChildren(el("span", { text: `${names}에게 — 무엇을 시킬지 적어주세요` }));
      return;
    }
    bar.className = "compose-note bad";
    bar.replaceChildren(el("span", { text: parsed.blocked }));
    return;
  }
  bar.className = "compose-note";

  /*
   * ★ **그룹을 색으로 가른다** (§4.1.2의 «실시간 하이라이트»).
   *
   * 한 번에 쓴 글이 여러 봇에게 **서로 다른 지시**로 갈라지는데, 어디서
   * 갈라지는지가 안 보였다. 요약은 «둘에게 1블록»이라고만 했지 *"어느 글이
   * 누구에게"* 는 말하지 않았다 — 줄이 몇 개만 되어도 못 따라간다.
   *
   * 🔴 **글자에는 손대지 않는다.** 칠하려면 텍스트 노드를 `<span>`으로
   * 감싸야 하는데, `contenteditable` 안에서 그러면 **한글 조합이 그 경계에서
   * 깨진다** — 칩 입력창을 쓰기로 한 근거(조합이 `textarea`와 한 글자도 다르지
   * 않다)를 우리 손으로 무너뜨리는 일이다.
   *
   * 그래서 **칩만 칠하고**(칩은 원래 엘리먼트다) 글은 **요약 줄에 옮겨 적어**
   * 같은 색을 준다. 「어느 칩 — 어떤 글 — 누구에게」가 한 줄로 맞춰진다.
   *
   * 어느 칩이 어느 그룹인지는 **코어가 알려준다**(`mentionAt`) — 화면이 다시
   * 계산하면 규칙이 두 군데 살게 된다.
   */
  const chips = [...box.querySelectorAll<HTMLElement>(".chip")];
  let seen = 0;
  const chipOfToken = new Map<number, HTMLElement>();
  for (const [n, t] of tokens.entries()) {
    if (t.kind !== "mention") continue;
    const node = chips[seen++];
    if (node) chipOfToken.set(n, node);
  }
  for (const c of chips) delete c.dataset.group;

  const rows: HTMLElement[] = [];
  parsed.blocks.forEach((b, at) => {
    const tint = String(at % GROUP_TINTS);
    for (const n of b.mentionAt) chipOfToken.get(n)?.setAttribute("data-group", tint);

    const names = b.botIds
      .map((id) => r.participants.find((p) => p.id === id)?.name ?? id)
      .join("·");
    rows.push(
      el(
        "div",
        { class: "note-row", "data-group": tint },
        el("span", { class: "to", text: names }),
        // **무엇이 갈지 그대로 보여준다** — 「어느 글이 누구에게」가 요점이다
        el("span", { class: "what", text: b.text, title: b.text }),
      ),
    );
  });

  bar.replaceChildren(
    ...rows,
    ...parsed.warnings.map((w) => el("span", { class: "bad", text: w })),
  );
}

/**
 * 그룹을 가르는 색이 몇 가지인가.
 *
 * 다 쓰면 처음으로 돌아간다 — **이웃한 그룹만 달라 보이면 된다.** 그룹이
 * 넷을 넘는 일은 드물고, 색을 무한히 늘리면 서로 구별이 안 되는 색이 나온다.
 */
const GROUP_TINTS = 4;

/** 칩 하나. `botId`가 진짜 값이고 글자는 보여주기용이다 */
function mentionChip(botId: string, name: string): HTMLElement {
  return el("span", {
    class: "chip",
    contenteditable: "false",
    "data-bot": botId,
    text: `@${name}`,
  });
}

/**
 * 입력창을 **토큰으로 읽는다** — 코어가 규칙을 적용할 수 있게 (§4.1.2).
 *
 * 화면이 하는 일은 여기까지다. «줄 맨 앞인가», «연속인가», «누가 받나»는
 * `parseCompose`가 정한다.
 */
function readTokens(box: HTMLElement): ComposeToken[] {
  const out: ComposeToken[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  const walk = (node: Node): void => {
    for (const kid of [...node.childNodes]) {
      if (kid.nodeType === Node.TEXT_NODE) {
        push((kid as Text).data.replace(/ /g, " "));
        continue;
      }
      const elm = kid as HTMLElement;
      if (elm.dataset?.bot) {
        out.push({ kind: "mention", botId: elm.dataset.bot });
        continue;
      }
      // 줄바꿈은 브라우저가 <div>·<br>로 만든다 — 글자로 되돌린다
      if (elm.tagName === "BR") { push("\n"); continue; }
      if (elm.tagName === "DIV" || elm.tagName === "P") push("\n");
      walk(elm);
    }
  };
  walk(box);
  return out;
}

/** 지금 커서 앞에 `@검색어`가 열려 있나 — 자동완성을 띄울지 정한다 */
function openQuery(box: HTMLElement): { node: Text; at: number; q: string } | null {
  const sel = box.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !box.contains(node)) return null;

  const text = (node as Text).data.slice(0, sel.anchorOffset);
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  const q = text.slice(at + 1);
  // 공백이 들어가면 더는 이름을 고르는 중이 아니다
  if (/\s/.test(q)) return null;
  return { node: node as Text, at, q };
}

/**
 * **지금 모으고 있는 그룹**의 봇들 (§4.1.2 규칙 3).
 *
 * 🔴 예전엔 **상자 안의 칩을 전부** 뺐다. 그러면 첫 줄에 `@Claude`를 쓴 뒤
 * 아래에 새 그룹을 열면 **Claude가 목록에 안 뜬다** — «다들 이거 보고,
 * Claude는 이것도»가 안 된다. 그건 단체방에서 제일 하고 싶은 일 중 하나다.
 *
 * 빼자고 정한 것은 **그 그룹**이다 — `(@Claude) @`에서 Claude가 또 뜨면 안 된다는
 * 뜻이지, 아래에서 다시 부를 수 없다는 뜻이 아니다.
 *
 * 커서 앞에서 거슬러 올라가며 **공백만 끼고 늘어선 칩**만 모은다. 글자가 끼어
 * 있으면 거기서 그룹이 끝난 것이다.
 */
function groupSoFar(box: HTMLElement, from: Node): Set<string> {
  const ids = new Set<string>();
  let node: Node | null = from;
  while (node && node !== box) {
    const prev: Node | null = node.previousSibling;
    if (!prev) {
      node = node.parentNode;
      continue;
    }
    node = prev;
    if (prev.nodeType === Node.TEXT_NODE) {
      // 공백만이면 아직 같은 그룹이다
      if ((prev as Text).data.trim() !== "") return ids;
      continue;
    }
    const elm = prev as HTMLElement;
    if (elm.dataset?.bot) {
      ids.add(elm.dataset.bot);
      continue;
    }
    if (elm.tagName === "BR") continue;
    return ids;
  }
  return ids;
}


/**
 * 자동완성 목록 (§4.1.2).
 *
 * 맨 위에 **직전 그룹**이 온다 — 같은 상대에게 이어서 말하는 것이 가장 흔한데,
 * 스티키(마지막 대상을 기억)는 «지금 누구에게 말하는지»가 숨은 상태가 되므로
 * 쓰지 않는다. `@`+Tab은 **사용자가 요청할 때만** 채워지므로 명시성을 안 잃는다.
 */
function paintPicker(r: Room, box: HTMLElement): void {
  closePicker();
  const found = openQuery(box);
  if (!found) return;

  const q = found.q.toLowerCase();
  const already = groupSoFar(box, found.node);
  const hits = r.participants.filter(
    (b) => !already.has(b.id) && b.name.toLowerCase().includes(q),
  );

  type Row = { label: string; ids: string[]; hint?: string };
  const rows: Row[] = [];
  // 글자를 치기 시작하면 직전 그룹은 사라진다 — 특정 봇을 찾는 중이므로
  if (q === "" && lastGroup.length > 0 && lastGroup.every((id) => !already.has(id))) {
    const names = lastGroup
      .map((id) => r.participants.find((b) => b.id === id)?.name)
      .filter((n): n is string => n !== undefined);
    if (names.length > 0) {
      rows.push({ label: names.map((n) => `@${n}`).join(" "), ids: [...lastGroup], hint: "직전 그룹" });
    }
  }
  for (const b of hits) rows.push({ label: `@${b.name}`, ids: [b.id] });
  if ("everyone".includes(q) && r.participants.length > 1) {
    rows.push({ label: "@everyone", ids: [EVERYONE], hint: "전원" });
  }
  // 맞는 게 없으면 목록을 닫는다. 친 글자는 그대로 남고 **칩이 아니므로 멘션도 아니다**
  if (rows.length === 0) return;

  pickerRows = rows.map((row) => () => {
    // `@검색어`를 지우고 그 자리에 칩을 넣는다
    const text = found.node;
    const rest = text.data.slice(found.at + 1 + found.q.length);
    text.data = text.data.slice(0, found.at);
    const after = box.ownerDocument.createTextNode(rest);
    let mark: Node = text;
    for (const id of row.ids) {
      const name = id === EVERYONE ? "everyone" : (r.participants.find((b) => b.id === id)?.name ?? id);
      const chip = mentionChip(id, name);
      mark.parentNode?.insertBefore(chip, mark.nextSibling);
      const gap = box.ownerDocument.createTextNode(" ");
      chip.parentNode?.insertBefore(gap, chip.nextSibling);
      mark = gap;
    }
    mark.parentNode?.insertBefore(after, mark.nextSibling);
    caretAfter(box, mark);
    closePicker();
    box.dispatchEvent(new Event("input"));
  });

  pickerAt = 0;
  const menu = el(
    "div",
    { class: "picker" },
    ...rows.map((row, n) =>
      el(
        "button",
        {
          class: n === 0 ? "on" : "",
          onclick: () => pickerRows[n]?.(),
          onmouseenter: () => movePicker(n),
        },
        el("span", { text: row.label }),
        row.hint ? el("span", { class: "dim", text: row.hint }) : null,
      ),
    ),
  );
  screens.chat.append(menu);
}

let pickerRows: Array<() => void> = [];
let pickerAt = 0;
/** 마지막으로 지목한 그룹 — 자동완성 맨 위에 올린다 */
let lastGroup: string[] = [];

function closePicker(): void {
  screens.chat.querySelector(".picker")?.remove();
  pickerRows = [];
  pickerAt = 0;
}

function movePicker(to: number): void {
  const menu = screens.chat.querySelector(".picker");
  if (!menu) return;
  const btns = [...menu.querySelectorAll("button")];
  if (btns.length === 0) return;
  pickerAt = (to + btns.length) % btns.length;
  btns.forEach((b, n) => b.classList.toggle("on", n === pickerAt));
}

/** 커서를 이 노드 뒤로 */
function caretAfter(box: HTMLElement, node: Node): void {
  const doc = box.ownerDocument;
  const range = doc.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
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
  const live = (): Room => (room?.id === r.id ? room : r);

  const head = el("header", { class: "bar" });
  const queue = el("div", { class: "approvals", hidden: true });
  const clash = el("div", { class: "clashes", hidden: true });
  const list = el("div", { class: "messages" });
  const status = el("div", { class: "status" });
  /*
   * 단체방에서만 칩 상자다 — 봇이 하나인데 `@`를 치게 할 이유가 없다.
   *
   * ★ **봇별 뷰에서도 아니다** (v2.1) — 그 봇에게만 가므로 지목할 것이 없다.
   * 🔴 `renderChat` 의 «다시 붙일까» 판단과 **같은 식이어야 한다.** 한쪽만
   * 고쳤더니 다시 붙기는 하는데 **또 칩 상자로** 붙었다.
   */
  const group = r.participants.length > 1 && viewBotId === null;
  const box = (group
    ? makeChipBox()
    : el("textarea", { rows: 1, placeholder: "메시지 입력…" })) as HTMLTextAreaElement;
  const perm = el("button", { class: "icon perm" }, icon("shield"));
  const chips = el("div", { class: "chips", hidden: true });
  const compose = el("div", { class: "compose-note", hidden: true });

  if (!group) {
    box.value = r.draft ?? "";
    autoGrow(box);
  }

  const send = () => {
    if (group) {
      const tokens = readTokens(box);
      const parsed = parseCompose(tokens, live().participants);
      // 막힐 줄을 알고 보내지 않는다 — 화면이 먼저 말해준다
      if (parsed.blocked) { paintCompose(live(), box); return; }
      if (parsed.blocks.length === 0 && pending.length === 0) return;
      // 다음번 «직전 그룹»은 지금 보낸 첫 블록이다
      lastGroup = parsed.blocks[0]?.botIds ?? [];
      const attachments = pending;
      pending = [];
      paintChips();
      box.replaceChildren();
      closePicker();
      paintCompose(live(), box);
      post({
        t: "sendCompose",
        roomId: r.id,
        tokens,
        ...(attachments.length ? { attachments } : {}),
      });
      return;
    }

    const text = box.value.trim();
    // 첨부만 보내는 것도 메신저에서는 자연스럽다
    if (!text && pending.length === 0) return;
    const attachments = pending;
    pending = [];
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
    if (viewBotId) {
      post({
        t: "sendCompose",
        roomId: r.id,
        tokens: [{ kind: "mention", botId: viewBotId }, { kind: "text", text: ` ${text}` }],
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
    if (pickerRows.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePicker(pickerAt + 1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePicker(pickerAt - 1); return; }
      if (e.key === "Escape") { e.preventDefault(); closePicker(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        e.preventDefault();
        pickerRows[pickerAt]?.();
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
    queue,
    clash,
    list,
    status,
    compose,
    chips,
    el(
      "div",
      { class: "composer" },
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

  chat = { roomId: r.id, head, queue, clash, list, status, chips, box, perm, compose };
  pending = [];
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
  scrollIntoPlace(list);
}

/**
 * «여기부터 안 갔다» 줄의 글 — **누구에게** 안 갔는지까지.
 *
 * 한 메시지가 여럿에게 갈 수 있고(`@알파 @베타`) 그중 한 쪽만 끊길 수 있다.
 * 그럴 때 «전달되지 않았습니다»만 써두면 **멀줦히 받은 봇에게까지 다시 쓰게** 된다.
 */
function lostLine(m: Message, r: Room): string {
  if (r.participants.length < 2) return "여기부터 전달되지 않았습니다";
  const ids = m.notSentTo?.length ? m.notSentTo : m.deliveredTo;
  const names = ids
    .map((id) => r.participants.find((b) => b.id === id)?.name)
    .filter((n): n is string => n !== undefined);
  return names.length > 0
    ? `여기부터 ${names.join("·")}에게 전달되지 않았습니다`
    : "여기부터 전달되지 않았습니다";
}

/**
 * ★ **받는 이를 말풍선 안에** (§4.1.1 · §4.1.2).
 *
 * 🔴 아래에 «→ Claude» 한 줄로 적어봤더니 **안 읽혔다.** 10px 회색 글씨가
 * 말풍선 밖에 붙어 있으면 눈이 그냥 지나간다 — 그런데 이건 *"화면엔 보이는데
 * 봇은 서로 모른다"* 를 막으라고 넣은 표시다. **안 읽히면 없는 것과 같다.**
 *
 * 그래서 **쓸 때 보이던 그 칩 그대로** 글 앞에 놓는다. 입력창에서 보던 것과
 * 말풍선이 같아지고(WYSIWYG), 받는 이가 **글의 일부로** 읽힌다.
 *
 * 🔴 **`Message.text` 에는 안 넣는다.** 라우팅 칩은 파서가 소비한 것이라
 * (§4.1.2) 글에는 없고, 넣으면 **에이전트에게 가는 프롬프트가 바뀐다** —
 * 게다가 여럿에게 간 블록이면 «Codex도 이걸 받았다»를 Claude에게 알려주는
 * 꼴이라 §4.1.1을 우리 손으로 깬다. **그릴 때만** 만든다.
 *
 * 1:1에서는 안 만든다 — 상대가 하나뿐이라 자명하다.
 */
function deliveryChips(m: Message, r: Room): HTMLElement | null {
  /*
   * ⏪ **«1:1에서는 칩을 안 적는다» 를 뺐다** (2026-09-23).
   *
   * 근거는 *"상대가 하나뿐이라 자명하고, 매 말풍선에 같은 이름이 붙으면 읽는
   * 데 방해만 된다"* 였다. 🔴 그런데 **1:1 방은 도중에 단체방이 된다**(§4.2) —
   * 봇을 하나 부르면 참여자가 둘이 되고, 그 순간 **지난 말풍선들이 갑자기 칩을
   * 얻었다.** 과거 기록의 생김새가 **나중 일 때문에 바뀌는** 셈이다.
   *
   * 그건 일관성이 아니라 그 반대다. **받는 이는 언제나 적는다** — 한 명이면
   * 한 장이고, 그 한 장이 나중에도 그대로 있다.
   */
  if (m.role === "system") return null;

  /*
   * ★ **봇이 봇에게 건 말도 «누구에게»를 단다** (v3.0 대비).
   *
   * 🔴 `role !== "user"` 로 잘라내고 있었다. 오늘은 맞다 — 봇의 답은
   * `deliveredTo` 가 **글쓴이 자신뿐**이라 «나에게 갔다»는 군더더기다.
   *
   * 그런데 릴레이(§7)가 들어오면 알파가 베타에게 거는 말이 생긴다. 그건
   * **«봇이 봇에게 한 말»** 이라 말풍선이고(§7의 판정), 그렇다면 사용자 말과
   * 똑같이 **받는 이가 보여야 한다** — 안 보이면 그 말풍선만 «누구에게 갔는지
   * 알 수 없는 말»이 된다. 그 차이를 적는 것이 이 줄의 존재 이유였다(§4.1.1).
   *
   * **글쓴이 자신은 뺀다.** 남는 것이 없으면 평범한 답이므로 아무것도 안 단다 —
   * 오늘 화면은 하나도 안 바뀐다.
   */
  const to = m.role === "agent"
    ? m.deliveredTo.filter((id) => id !== m.authorBotId)
    : m.deliveredTo;
  if (to.length === 0) return null;

  const lost = new Set(m.notSentTo ?? (m.sendFailed ? m.deliveredTo : []));
  const wait = new Set(waitingFor(m.id));

  const row = el("span", { class: "to-chips" });

  /*
   * ⏪ **«전원이면 `@everyone` 한 장으로» 를 뺐다** (2026-09-23).
   *
   * 짧아서 좋아 보였는데, «전원»은 **«지금 명단»에 기대는 말**이다. 명단이
   * 바뀌면 **같은 메시지가 다르게 읽힌다** — 기록이 나중 일 때문에 흔들린다.
   *
   * 개별 칩은 `deliveredTo` 그대로라 **언제 봐도 같다.** `@everyone` 으로 썼든
   * 이름을 하나씩 불렀든 **받은 사람이 같으면 같게 보이는 것**이 맞고, 그
   * «같음»은 명단이 아니라 **받은 사람 목록**이 정해야 한다.
   */
  for (const id of to) {
    /*
     * 내보낸 봇의 이름은 **안 남는다** — `removeBot`이 `participants`에서
     * 빼기 때문이다. 그래도 **자리는 남긴다**: 둘에게 간 말이 하나에게만
     * 간 것처럼 보이면 안 된다(§0의 뺄셈 규칙).
     */
    /*
     * ★ **나간 봇도 이름으로 보인다** (2026-09-23).
     *
     * 🔴 예전에는 «@나간 봇» 이라는 **익명**이었다 — `removeBot` 이
     * `participants` 에서 빼면서 이름이 통째로 사라졌기 때문이다. 그러면
     * 대화를 다시 읽을 때 *"누구한테 시킨 거였지"* 에 답할 수 없다.
     * 이제 방이 **이름만** 따로 들고 있다(`Room.left`).
     */
    const seen = botLabel(r, id);
    const state = lost.has(id) ? " lost" : wait.has(id) ? " held" : "";
    row.append(
      el("span", {
        class: `chip to${state}${seen && !seen.gone ? "" : " gone"}`,
        text: seen ? (seen.gone ? `@${seen.name} (나감)` : `@${seen.name}`) : "@나간 봇",
        title: lost.has(id)
          ? "이 봇에게는 전달되지 않았습니다"
          : wait.has(id)
            ? "아직 줄에 서 있습니다"
            : seen?.gone
              ? `${seen.name}에게 전달되었습니다 — 그 뒤 방에서 나갔습니다`
              : seen
                ? `${seen.name}에게 전달되었습니다`
                : "이 봇은 방에서 나갔습니다",
      }),
    );
  }
  return row;
}

/**
 * ★ **이 말이 누구에게 갔나** (§4.1.1 · §4.2).
 *
 * 🔴 **이 설계의 유일한 위험**이 «화면엔 다 보이는데 봇은 서로 모른다»는
 * 것이다. 우리는 멘션된 봇에게만 전달하므로(§4.1.1), 단체방의 말풍선은
 * 보이는 것보다 **좁게** 갔다. 그 차이를 안 적으면 사용자는 *"방금 Claude가
 * 한 말 이어서 해줘"* 를 Codex에게 시키고, Codex는 그 말을 본 적이 없다.
 *
 * 그래서 **보낸 쪽에 받는 이를 적는다.** 메신저의 «읽음»이 있는 자리다.
 *
 * 함께 세 가지를 한 줄에 담는다 — 셋 다 «지금 이 말이 어디까지 갔나»다:
 *
 * | 표시 | 뜻 |
 * |---|---|
 * | `→ Claude` | 갔다 |
 * | `⏳ Codex` | **아직 줄에 서 있다** — 앞 턴이 끝나면 간다 |
 * | (없음) | 못 갔다 — 위의 끊김 줄(`lostLine`)이 이미 말하고 있다 |
 *
 * 1:1에서는 **받는 이를 적지 않는다** — 상대가 하나뿐이라 자명하고, 매
 * 말풍선에 같은 이름이 붙으면 읽는 데 방해만 된다. 대기 표시는 1:1에서도
 * 나온다 — 거기서도 «보냈는데 조용하다»는 똑같이 불안하다.
 */
function deliveryNode(m: Message, r: Room): HTMLElement | null {
  if (m.role !== "user") return null;

  const here = (id: string) => r.participants.find((b) => b.id === id);
  const lost = new Set(m.notSentTo ?? (m.sendFailed ? m.deliveredTo : []));
  const wait = new Set(waitingFor(m.id));

  const held: string[] = [];
  for (const id of m.deliveredTo) {
    if (lost.has(id) || !wait.has(id)) continue;
    held.push(here(id)?.name ?? "나간 봇");
  }
  /*
   * ★ **여기는 «지나가는 것»만 맡는다.**
   *
   * 🔴 처음에는 받는 이도 여기 «→ Claude · Codex»로 적었다. 그런데 10px 회색
   * 글씨가 말풍선 **밖 아래**에 붙으니 **안 읽혔다** — §4.1.1의 유일한 위험을
   * 막으려고 넣은 표시인데, 막으려면 눈에 들어와야 한다.
   *
   * 받는 이는 **말풍선 안으로** 옮겼다(`deliveryChips`). 거기가 제자리다 —
   * 사용자가 칩으로 **직접 쓴 것**이고, 지워지지 않는 메시지의 일부다.
   * 여기 남는 것은 **곧 사라질 상태**뿐이다: 줄 서 있음, 그리고 물리기.
   */
  if (held.length === 0) return null;

  const many = r.participants.length > 1;
  const row = el("div", { class: "meta delivery" });
  {
    row.append(
      el("span", {
        class: "held",
        text: many
          ? `⏳ ${held.join(" · ")} 대기 중`
          : "⏳ 앞 대화가 끝나면 보냅니다",
        title: "앞 턴이 아직 돌고 있습니다. 끝나면 묶어서 한 번에 전달합니다.",
      }),
      /*
       * ★ **아직 안 보냈으니 뺄 수 있다** (§4.3).
       *
       * 여태 물릴 길은 «중단»뿐이었는데, 그건 **진행 중인 턴까지 끊는다** —
       * 안 보낸 한 줄을 물리려고 이미 보낸 것을 죽이는 셈이었다.
       */
      el("button", {
        class: "link",
        text: "빼기",
        title: "이 메시지를 줄에서 뺍니다. 진행 중인 답변은 그대로 둡니다.",
        onclick: () =>
          room && post({ t: "unqueue", roomId: room.id, messageId: m.id }),
      }),
    );
  }
  return row;
}

/** 앞 말풍선과 **같은 봇들에게** 못 간 것인가 — 그러면 줄을 또 그여도 소용없다 */
function lostAlike(above: Message | undefined, m: Message): boolean {
  if (!above?.sendFailed) return false;
  const key = (x: Message) => (x.notSentTo?.length ? x.notSentTo : x.deliveredTo).join();
  return key(above) === key(m);
}

/**
 * **이 말을 한 봇의 에이전트** (v2.0 준비).
 *
 * 🔴 예전에는 어느 말풍선이든 `participants[0]`의 에이전트를 썼다. 1:1에서는
 * 맞아떨어졌지만 **단체방에서는 Codex의 답에 «Claude»가 붙는다** — 이름도
 * 색깔도 전부 첫 봇 것이 된다. 실제로 그렇게 나왔다.
 *
 * 메시지는 `authorBotId`로 **누가 말했는지 이미 알고 있다.** 그걸 쓴다.
 * 모르면(시스템 메시지 등) 방의 첫 봇으로 떨어진다.
 */
function agentOf(m: Message, r: Room): AgentBrief | undefined {
  const bot = m.authorBotId
    ? r.participants.find((b) => b.id === m.authorBotId)
    : undefined;
  return agentById.get((bot ?? r.participants[0])?.agentId ?? "");
}

/**
 * **무엇에 대한 답인지 말해줘야 하나** (C4).
 *
 * 바로 위 질문 하나에 답하는 1:1 대화에서는 군더더기다. 그런데 단체방에서는
 * **다른 봇의 말이 사이에 끼어든다** — 그러면 «이게 어느 질문의 답이지»가 되고,
 * 그때는 말해줘야 한다.
 *
 * 🔴 예전에는 «둘 이상에 답할 때»만 봤다. 그건 큐잉(§4.3)만 생각한 규칙이라,
 * 하나에 답하는데 **자리가 멀어진** 경우를 놓친다.
 */
function needsAnswerNote(m: Message, all: Message[]): boolean {
  const answers = m.replyToIds ?? [];
  if (answers.length === 0) return false;
  if (answers.length > 1) return true;   // 묶여서 답한 것은 언제나 적는다

  // 바로 위가 그 질문이면 자명하다
  const at = all.findIndex((x) => x.id === m.id);
  return at <= 0 || all[at - 1]!.id !== answers[0];
}

function paintChat(r: Room): void {
  const c = chat;
  if (!c) return;
  // 헤더에 쓰는 것 — 방을 대표하는 에이전트. 말풍선은 **각자 말한 봇으로** 잎는다
  const agent = agentById.get(r.participants[0]?.agentId ?? "");

  const seen = viewBot(r);

  // 이름을 고치는 중이면 헤더를 건드리지 않는다 — 입력이 날아간다
  if (!c.head.querySelector("input") && seen) {
    /*
     * ★ **뷰 헤더에는 방 조작이 없다** (§5의 «뷰는 방이 아니다»).
     *
     * 🔴 분기·이름 바꾸기·나가기를 **비활성으로 두지 않고 아예 안 그린다.**
     * 비활성은 «여기서도 되긴 하는데 지금은 안 된다»로 읽혀서, *"단체방 전체가
     * fork되나 이 봇만 갈라지나"* 하는 바로 그 모호함을 남긴다. 없으면 질문이
     * 생기지 않는다 — 방에 대한 일은 방으로 나가서 한다.
     *
     * `←` 는 **방을 나가는 게 아니라 뷰를 푼다.**
     */
    replace(
      c.head,
      el("button", {
        class: "icon", title: "단체방으로",
        onclick: () => openBotView(null),
      }, icon("arrow-left")),
      /*
       * ★ **원본 방 이름을 봇 이름과 같이 둔다** (§5의 «단체방 X의 @codex 뷰»).
       *
       * 🔴 `@구현` 만 크게 띄우고 방 이름은 부제에 흘려뒀더니 **여기가 어디인지
       * 알기 힘들었다.** 방 제목은 평소 헤더에서 늘 그 자리에 있는 것이라,
       * 갑자기 사라지면 **다른 방으로 건너온 것처럼 읽힌다.**
       *
       * 그래서 **방 이름이 먼저, 봇이 뒤**다 — 평소 헤더와 같은 자리에 같은
       * 것이 있고 «· @구현»이 덧붙는 모양이라, 한눈에 «그 방 안의 한 갈래»로
       * 읽힌다.
       */
      el(
        "h1",
        { class: "view-head" },
        r.title,
        el("span", { class: "view-of", text: `· @${seen.name}` }),
        el("span", {
          class: "sub",
          title: r.cwd,
          text: `1:1 뷰 — ${seen.name}와(과) 주고받은 것만`,
        }),
      ),
      /*
       * ★ **분기는 있다 — 그 봇만 가른다** (v2.1).
       *
       * 🔴 로드맵은 «비활성»이라고 적어뒀다. *"단체방 전체가 fork되나, 그 봇만
       * 분리되나"* 하는 모호함 때문이었는데, **모호함을 없애는 길은 막는 것만이
       * 아니라 뜻을 정해주는 것**도 있다. 자리가 뜻을 말한다:
       *
       * ```
       * 단체방 헤더에서   방 전체가 갈라진다
       * 뷰 헤더에서       그 봇만 갈라진다
       * ```
       */
      forkHeadButton(r, seen.id),
      el(
        "button",
        { class: "icon with-count", title: `참여자 ${r.participants.length}`, onclick: () => toggleDrawer(r) },
        icon("organization"),
        el("span", { class: "count", text: String(r.participants.length) }),
      ),
    );
  } else if (!c.head.querySelector("input")) {
    replace(
      c.head,
      el("button", { class: "icon", title: "목록", onclick: leaveChat }, icon("arrow-left")),
      el(
        "h1",
        {},
        r.title,
        // 줄인 경로만 보이므로 **전체는 툴팁에** — 비슷한 폴더 두 방을 헷갈리면
        // 엉뚱한 데서 일하게 된다. 서랍에서 뻐는 대신 이 자리가 받아준다.
        el("span", {
          class: "sub",
          title: r.cwd,
          text: `${agent?.label ?? "?"} · ${shortenPath(r.cwd)}`,
        }),
      ),
      // 참여자 서랍 — 봇에 관한 것이 모이는 자리 (§4.2.1)
      el(
        "button",
        { class: "icon with-count", title: `참여자 ${r.participants.length}`, onclick: () => toggleDrawer(r) },
        icon("organization"),
        /*
         * ★ **몇 명인지 눈에 보여야 한다** (§4.2.1).
         *
         * 🔴 수가 **툴팁에만** 있었다. 단체방에서 제일 먼저 알아야 할 것이
         * «지금 몇이 듣고 있나»인데, 그걸 보려고 서랍을 열어야 했다 —
         * 멘션이 누구에게 갈지를 가늠하는 근거가 한 겹 뒤에 있었던 셈이다.
         *
         * 1:1에서는 안 붙인다 — 언제나 1이라 숫자가 뜻을 못 갖는다.
         */
        r.participants.length > 1
          ? el("span", { class: "count", text: String(r.participants.length) })
          : null,
      ),
      // 분기는 서랍 옆에 — «지금 여기서 갈라진다»는 대화를 보며 정하는 것이라
      // ⋮ 안에 두면 떠올리기 어렵다. 모든 조건은 ⋮의 «여기서 분기»와 같다.
      forkHeadButton(r),
      el(
        "button",
        { class: "icon", title: "메뉴", onclick: (e: Event) => toggleMenu(e, r) },
        icon("kebab-vertical"),
      ),
    );
  }
  // 서랍이 열려 있으면 **같이 갱신된다** — 사용량과 작업 중 표시가
  // 멈춰 있으면 서랍을 보는 동안에는 아무 일도 안 일어나는 것처럼 보인다.
  if (screens.chat.querySelector(".drawer")) paintDrawer(r);
  /*
   * ★ **권한 시트도 같이 갱신된다.**
   *
   * 서랍에서 봇을 불렀는데 시트를 열면 **아까 그 봇이 없었다** — 열던
   * 순간의 참여자로 그려둔 채로 멈춰 있었기 때문이다. 내보낸 봇이 남아
   * 있는 것도 같은 이유다. 시트는 «지금 방에 누가 있나»를 보여주는 곳이므로
   * 방이 바뀌면 따라가야 한다.
   */
  if (screens.chat.querySelector(".sheet")) paintPermissionSheet(r);

  const atBottom = stick;
  const nodes: Node[] = [];
  /*
   * ★ **뷰에서는 그 봇이 본 것만 남긴다** (§5).
   *
   * 규칙은 코어와 **같은 함수**(`inBotView`)를 쓴다. v2.0 이 «멘션된 것만
   * 전달»하므로 이 뷰가 곧 **«그 봇이 실제로 본 전부»** 인데, 규칙이 어긋나면
   * 그 약속이 바로 거짓말이 된다.
   */
  const shownMsgs = viewBotId
    ? r.messages.filter((m) => inBotView(m, viewBotId!))
    : r.messages;
  let day = "";
  /** 바로 위에 붙어 있는 메시지. 선이 끼어들면 끊긴다 */
  let above: Message | undefined;

  for (const m of shownMsgs) {
    const key = dayKey(m.createdAt);
    let broken = false;
    if (key !== day) {
      nodes.push(dayLine(m.createdAt));
      day = key;
      broken = true;
    }
    /*
     * ★ **여기부터 안 갔다** — 끊긴 자리에 줄을 그어 보여준다.
     *
     * 답하는 중에 중단하면 큐에 쌓여 있던 메시지들은 **보내지도 못한 채**
     * 남는다. 말풍선마다 작게 «안 보냈음»이 붙기는 하지만, 여럿이면 **어디서부터**
     * 끊겼는지가 안 보인다 — 앞에 보낸 것까지 안 간 줄 알고 전부 다시 쓰게 된다.
     */
    if (m.sendFailed && !lostAlike(above, m)) {
      nodes.push(el("div", { class: "cut-line lost", text: lostLine(m, r) }));
      broken = true;
    }
    if (m.id === firstUnreadId) {
      nodes.push(el("div", { class: "unread-line", text: "여기서부터 안 읽음" }));
      broken = true;
    }
    nodes.push(
      reuseOrBuild(m, agentOf(m, r), !broken && followsSame(above, m), needsAnswerNote(m, r.messages)),
    );
    above = m;
    // 물려받은 대화가 끝나는 자리에 선 하나 (D2)
    if (r.forkedAtMessageId && m.id === r.forkedAtMessageId) {
      nodes.push(forkLine(r));
      // 선이 끼어들었으므로 다음 말은 이어지는 게 아니다 — 이름을 다시 쓴다
      above = undefined;
    }
  }
  // 줄 서 있는 심사는 대화 아래에 — 이건 **기다리는 것**이지 답할 것이 아니다
  for (const w of reviews) nodes.push(reviewNode(w, r));
  // 다른 프로젝트의 방이면 열자마자 알려준다 — 엉뚱한 디렉터리에서 일하게 하면 안 된다 (B5)
  // 🔴 **열린 폴더가 없으면 «다른 프로젝트»라는 말 자체가 성립하지 않는다.**
  // `boot.cwd`는 워크스페이스가 없으면 홈으로 떨어지므로(B9), 그것만 보면
  // 사용자가 **직접 고른 폴더**를 두고 «지금 열린 프로젝트가 아니다»라고
  // 우기게 된다 — 대화 맨 위에 영영 안 사라지는 상자가 하나 생긴다.
  if (boot.hasWorkspace && r.cwd !== boot.cwd) {
    nodes.unshift(
      el(
        "div",
        { class: "banner" },
        icon("folder"),
        ` 이 방은 ${shortenPath(r.cwd)} 를 보고 있습니다 — 지금 열린 프로젝트가 아닙니다.`,
      ),
    );
  }

  // 🔴 **화면의 기록과 에이전트가 아는 것이 어긋났다** (F7).
  //
  // 예전 대화가 그대로 보이므로 말해주지 않으면 사용자는 상대가 다 안다고
  // 믿은 채로 대화한다. 비용이 드는 쪽(되먹이기)이라 **우리가 정하지 않는다.**
  if (r.contextLost) {
    const said = r.messages.filter((m) => m.role !== "system");
    const chars = said.reduce((n, m) => n + m.text.length, 0);

    /*
     * **다 안 들어갈 수도 있다.**
     *
     * 되먹임은 통째로 밀어넣으므로, 이전 세션이 이미 컨텍스트를 반 넘게 채우고
     * 있었다면 새 세션도 시작하자마자 그만큼 찬다 — 곧바로 압축이 돌거나 아예
     * 안 들어간다. **글자 수를 토큰으로 환산해 짐작하지 않는다**(에이전트마다
     * 토크나이저가 다르다). 대신 **이전 세션이 실제로 얼마나 찼었는지**를 쓴다 —
     * 그건 우리가 받아 적어둔 측정값이다.
     */
    const filled =
      r.usage?.contextUsed && r.usage.contextSize
        ? r.usage.contextUsed / r.usage.contextSize
        : 0;

    nodes.push(
      el(
        "div",
        { class: "banner warn" },
        el("span", {
          text:
            /*
             * ★ **어느 봇인지 짚는다** (B1).
             *
             * 🔴 «에이전트는»이라고만 했다. 세션은 봇 단위라 한 봇만 끊겨도
             * 이 배너가 뜨는데, 그러면 **멀쩡한 봇까지 못 미더워진다.**
             */
            (() => {
              const hit = r.participants.filter((b) => b.contextLost);
              if (r.participants.length > 1 && hit.length > 0) {
                return `${hit.map((b) => b.name).join("·")}의 세션이 끊겨 위 대화를 모릅니다. `;
              }
              return `이전 세션이 끊겨 에이전트는 위 대화를 모릅니다. `;
            })() +
            `지금까지의 대화(메시지 ${said.length}개 · 약 ${chars.toLocaleString()}자)를 ` +
            `다음 메시지에 함께 보낼까요? ` +
            `최근 것은 그대로, 오래된 긴 메시지는 가운데를 줄여서 보냅니다.` +
            (filled >= 0.5
              ? ` 이전 세션에서 컨텍스트의 ${Math.round(filled * 100)}%를 쓰고 있었습니다 —` +
                ` 다시 넣으면 곧 압축이 필요할 수 있습니다.`
              : ""),
        }),
        /*
         * **다시 붙어보는 게 먼저다.** 되면 대화가 통째로 돌아온다 —
         * 되먹임은 글자만 옮기지만 복구는 계획·메모리까지 살린다.
         *
         * 이름이 «다시 시도»인 이유: 하는 일이 **실패한 복구를 한 번 더**
         * 부르는 것뿐이다. 옆의 «대화 넘겨서 시작»과 헷갈리면 안 된다 —
         * **이것만 원래 세션을 되살리고**, 나머지 둘은 새 세션이다.
         */
        r.lostSessionId
          ? el("button", {
              class: "link",
              text: "다시 시도",
              onclick: () => post({ t: "retryResume", roomId: r.id }),
            })
          : null,
        /*
         * **둘 다 새 세션이다.** 차이는 «대화를 넘기느냐»뿐이라 이름도 그렇게 쓴다.
         *
         * 예전 이름(«이어가기» · «새로 시작»)은 앞엣것이 세션을 잇는 것처럼
         * 들렸다. 잇는 건 위의 «다시 시도»뿐이다.
         */
        el("button", {
          class: "link",
          text: "대화 넘겨서 시작",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: true }),
        }),
        el("button", {
          class: "link",
          text: "기록만 두고 시작",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: false }),
        }),
      ),
    );
  } else if (r.refeedPending) {
    // 누른 뒤에는 **약속이 살아 있다**는 걸 보여준다 — 턴을 안 쓰므로
    // 아무 표시도 없으면 «눌렀는데 아무 일도 안 일어났다»가 된다.
    /*
     * ★ **되돌릴 수 있어야 한다.**
     *
     * 분기가 예상 못 하게 폴백했을 때는 **미리 물어볼 기회가 없었다.** 그런데
     * 다행히 되먹임은 약속일 뿐 **토큰은 다음 메시지를 보낼 때까지 안 든다.**
     * 그 사이에 끌 수 있게 해두면, «물어보지 못한 경우»에도 선택은 남는다.
     */
    /*
     * ★ **분기가 폴백했을 때도 세 가지를 준다** (F7과 같은 모양).
     *
     * 예전엔 «끄기» 하나뿐이었다. 그런데 폴백은 **일시적인 실패일 수 있다** —
     * 에이전트가 잠깐 바쁜 것뿐인데 그 한 번 때문에 영영 «글자만 옮긴 방»으로
     * 살 이유가 없다. 세션 복구 실패에 «다시 시도»를 둔 것과 같은 이유다.
     */
    const stuck = r.participants.filter((b) => b.forkFallback);
    if (stuck.length > 0) {
      nodes.push(
        el(
          "div",
          { class: "banner warn" },
          el("span", {
            text:
              (r.participants.length > 1
                ? `${stuck.map((b) => b.name).join("·")}는 `
                : "") +
              "세션을 갈라내지 못해 계획·파일 기억을 물려받지 못했습니다. " +
              "다시 해보면 돌아올 수 있습니다.",
          }),
          el("button", {
            class: "link",
            text: "다시 시도",
            title: "되면 계획과 파일 기억까지 돌아옵니다",
            onclick: () => post({ t: "retryFork", roomId: r.id }),
          }),
          el("button", {
            class: "link",
            text: "대화 넘겨서 시작",
            onclick: () => post({ t: "refeed", roomId: r.id, accept: true }),
          }),
          el("button", {
            class: "link",
            text: "기록만 두고 시작",
            onclick: () => post({ t: "refeed", roomId: r.id, accept: false }),
          }),
        ),
      );
    } else
    nodes.push(
      el(
        "div",
        { class: "banner" },
        icon("history"),
        " 다음 메시지에 이전 대화가 함께 전달됩니다. ",
        el("button", {
          class: "link",
          text: "글 없이 시작",
          title: "지난 대화를 안 보냅니다 — 토큰을 아끼는 대신 상대는 위 대화를 모릅니다",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: false }),
        }),
      ),
    );
  }

  // 컨텍스트가 거의 찼다. 압축은 사용자가 직접 시킨다 (C11)
  if (compactable && usage?.contextUsed && usage.contextSize) {
    const pct = (usage.contextUsed / usage.contextSize) * 100;
    if (pct >= 90) {
      nodes.push(
        el(
          "div",
          { class: "banner warn" },
          `컨텍스트가 ${Math.round(pct)}% 찼습니다. `,
          el("button", {
            class: "link",
            text: "대화 압축하기",
            onclick: () => post({ t: "compact", roomId: r.id }),
          }),
        ),
      );
    }
  }

  paintApprovals(r);
  paintClashes(r);
  c.list.replaceChildren(...nodes);
  if (atBottom) c.list.scrollTop = c.list.scrollHeight;

  paintStatus(c.status, r, statuses.get(r.id) ?? "idle");
}

/**
 * 메시지 하나만 갱신한다 — 스트리밍의 기본 경로.
 *
 * 전체를 다시 그리면 대화가 길수록 느려진다. 바뀐 말풍선 하나만
 * 갈아끼우므로 **비용이 대화 길이와 무관하다.**
 */
function applyDelta(msg: Message): void {
  const r = room;
  if (!r) return;

  const at = r.messages.findIndex((x) => x.id === msg.id);
  if (at >= 0) r.messages[at] = msg;
  else r.messages.push(msg);

  const c = chat;
  if (!c || c.roomId !== r.id) return;

  const node = messageNode(msg, agentOf(msg, r), false, needsAnswerNote(msg, r.messages));
  const hit = nodeCache.get(msg.id);
  nodeCache.set(msg.id, { sig: sigOf(msg), node });

  // id로 들고 있는 노드를 바꾼다 — 셀렉터 이스케이프 문제가 없다.
  if (hit?.node.isConnected) {
    hit.node.replaceWith(node);
  } else {
    const frag = document.createDocumentFragment();
    const prev = r.messages[r.messages.length - 2];
    if (!prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt)) {
      frag.append(dayLine(msg.createdAt));
    }
    frag.append(node);
    // 카드는 항상 대화 아래에 남아야 한다
    const card = c.list.querySelector(".card");
    if (card) c.list.insertBefore(frag, card);
    else c.list.append(frag);
  }

  if (stick) c.list.scrollTop = c.list.scrollHeight;
}

/**
 * 상태 줄 (C10).
 *
 * ★ **봇이 여럿이면 누가 뭘 하는지 이름으로 말한다** (v2.0 준비).
 * 합친 값 하나로는 «Claude는 답하는 중, Codex는 끝남»을 말할 수가 없다.
 * 1:1에서는 이름이 군더더기라 예전처럼 상태만 쓴다.
 */
function paintStatus(bar: HTMLElement, r: Room, status: RoomStatus): void {
  /*
   * ★ **뷰에서는 그 봇 것만** (v2.1 감사 · 2026-09-23).
   *
   * 🔴 구현 뷰인데 *"Codex 답하는 중"* 이라고 떴다 — **남의 턴 이야기**다.
   * 그리고 그 옆 «중단»이 `cancel(roomId)` 이라 **방 전체를 끊었다**: 구현
   * 것만 보려고 들어온 화면에서 **리뷰어의 일을 죽이는** 단추였다.
   *
   * 뷰는 «그 봇과의 1:1처럼»이 약속이므로(§5), 여기서는 1:1 방과 **똑같이**
   * 군다 — 그 봇의 상태를 말하고, 중단도 그 봇만 끊는다.
   */
  const seen = viewBot(r);
  const shown = seen ? [seen] : r.participants;
  const many = shown.length > 1;
  const busy = shown.filter((b) => {
    const s = botStatus[b.id];
    return s !== undefined && s !== "idle" && s !== "error";
  });
  // 뷰에서는 방 상태가 아니라 **그 봇의 상태**가 기준이다
  const at = seen ? (botStatus[seen.id] ?? "idle") : status;

  const text =
    many && busy.length > 0
      ? busy
          .map((b) => `${agentById.get(b.agentId)?.label ?? b.name} ${statusText(botStatus[b.id]!)}`)
          .join(" · ")
      : statusText(at);

  const kids: Node[] = [
    el("span", { class: "typing" }, el("i"), el("i"), el("i")),
    el("span", { text }),
  ];
  // 중단은 턴이 도는 동안에만 의미가 있다
  if (at === "streaming" || at === "tool" || at === "waiting") {
    kids.push(
      el("button", {
        class: "stop",
        text: "중단",
        onclick: () => post({
          t: "cancel",
          roomId: r.id,
          ...(seen ? { botId: seen.id } : {}),
        }),
      }),
    );
  }
  bar.replaceChildren(...kids);
}

/**
 * 안 바뀐 말풍선은 그대로 다시 쓴다.
 *
 * 스트리밍 중에는 방 갱신이 초당 열몇 번 온다. 매번 전체 목록을 새로 만들면
 * **대화가 길수록 느려진다** — 실제로 바뀌는 건 대개 마지막 하나뿐이다.
 * 이미 있는 노드를 옮기는 건 공짜에 가깝다.
 */
const nodeCache = new Map<string, { sig: string; node: HTMLElement }>();

/**
 * 방 안 **모든 봇 이름**을 한 줄로. 하나라도 바뀌면 말풍선을 전부 다시 그린다.
 *
 * 이름은 드물게 바뀌고, 바뀌면 **여러 자리에 동시에** 영향을 준다.
 * 자리마다 서명을 다는 것보다 이게 안전하다.
 */
function nameStamp(): string {
  // 나간 봇 이름도 화면에 쓰인다 — 목록이 바뀌면 말풍선도 다시 그려야 한다
  return [
    ...(room?.participants ?? []).map((b) => `${b.id}=${b.name}`),
    ...(room?.left ?? []).map((b) => `${b.id}=${b.name}!`),
  ].join(";");
}

function sigOf(m: Message): string {
  // 스트리밍 중 텍스트는 뒤로만 자라므로 길이+꼬리면 변화를 잡아낸다.
  return [
    m.text.length,
    m.text.slice(-24),
    m.streaming ? 1 : 0,
    m.error ?? "",
    m.sendFailed ?? "",
    m.truncated ? 1 : 0,
    m.files?.length ?? 0,
    // 활동은 같은 id로 상태만 바뀌며 여러 번 온다 — 개수만으로는 못 잡는다
    (m.tools ?? []).map((t) => t.status).join(""),
    // 승인 결과가 나중에 그 활동에 붙는다 (D3)
    (m.tools ?? []).map((t) => t.decision?.mark ?? "").join(""),
    // 봇 수가 바뀌면 «이 봇만 중단»이 생기거나 사라진다
    manyBots() ? "m" : "",
    // 이름 옆 사용량 — **반올림한 값**만 넣는다. 토큰 하나마다 다시
    // 그리면 스트리밍 중에 말풍선을 초당 열몇 번씩 다시 만들게 된다.
    usagePct(m.authorBotId ? room?.participants.find((b) => b.id === m.authorBotId) : undefined),
    /*
     * ★ **누가 이름을 바꾸든 전부 다시 그린다.**
     *
     * 🔴 예전에는 **글쓴이 이름만** 넣었다. 그런데 말풍선 안에는 이름이 더
     * 있다 — 받는 이 칩(`@리뷰어`), «…에게 전달되지 않았습니다», 심사 대상.
     * 그것들은 **id 로만 서명에 들어가서**(`deliveredTo`) 이름을 바꿔도
     * 서명이 그대로였고, 캐시가 **옛 이름이 박힌 말풍선을 그대로 돌려줬다.**
     *
     * 자리를 하나씩 서명에 넣다 보면 **반드시 하나를 빠뜨린다.** 이름 바꾸기는
     * 드문 일이라 통째로 다시 그려도 싸다 — 도장 하나로 끝낸다.
     */
    nameStamp(),
    // 멈춰 있나 — 타이핑 점이 붙고 떨어진다
    m.authorBotId ? (botStatus[m.authorBotId] ?? "") : "",
    // 배달 표시 — 받는 이가 바뀌거나 줄에서 빠지면 다시 그려야 한다
    m.deliveredTo.join(","),
    (m.notSentTo ?? []).join(","),
    waitingFor(m.id).join(","),
  ].join(" ");
}

/**
 * **같은 사람이 이어서 말하는가** — 이름을 한 번만 쓰기 위한 판단.
 *
 * 시간이 벌어지면 다시 쓴다. 메신저에서 한참 뒤에 온 말에 이름이 없으면
 * «누가 한 말이지»가 되기 때문이다. 시스템 메시지는 대화가 아니라 **끊는다**.
 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function followsSame(above: Message | undefined, m: Message): boolean {
  if (!above || m.role !== "agent" || above.role !== "agent") return false;
  if (above.authorBotId !== m.authorBotId) return false;
  return m.createdAt - above.createdAt < GROUP_WINDOW_MS;
}

function reuseOrBuild(
  m: Message,
  agent: AgentBrief | undefined,
  grouped = false,
  noteAnswer = false,
): HTMLElement {
  // **묶임 여부도 서명에 넣는다** — 앞 메시지가 지워지면 이름이 다시 나와야 하는데
  // 캐시가 옛 모양을 그대로 돌려주면 이름 없는 말풍선이 혼자 남는다.
  const sig = `${sigOf(m)} ${grouped ? "g" : ""}${noteAnswer ? "a" : ""}`;
  const hit = nodeCache.get(m.id);
  if (hit && hit.sig === sig) return hit.node;

  const node = messageNode(m, agent, grouped, noteAnswer);
  nodeCache.set(m.id, { sig, node });
  return node;
}

/** 방에 봇이 둘 이상인가 — 말풍선 중단이 의미가 생기는 조건 (v2.0) */
const manyBots = (): boolean => (room?.participants.length ?? 1) > 1;

function messageNode(
  m: Message,
  agent: AgentBrief | undefined,
  grouped = false,
  noteAnswer = false,
): HTMLElement {
  if (m.role === "system") {
    // 압축은 메모가 아니라 **경계**다 (C11). 선으로 그어야 «이 위로는 요약»이 읽힌다.
    if (m.mark === "compaction") {
      return el("div", { class: "msg system" }, el("div", { class: "cut-line", text: m.text }));
    }
    /*
     * ★ **우리가 봇에게 물어본 것** (§4.2.2).
     *
     * 사용자가 쓴 말이 아니므로 말풍선이 아니고, 그렇다고 **숨기지도 않는다**
     * (§0). 심사에 무엇을 넘겼는지는 *"왜 저게 통과했지"* 에 답하는 근거이고,
     * **인젝션을 눈으로 확인할 수 있는 유일한 자리**이기도 하다.
     *
     * 다만 diff까지 실려 길다 — 접어서 둔다.
     */
    if (m.mark === "review") {
      const first = m.text.split("\n")[0] ?? "승인 심사";
      return el(
        "div",
        { class: "msg system" },
        el(
          "details",
          { class: "tool review" },
          el("summary", {}, icon("law"), ` ${first}`),
          el("pre", { class: "thought-body" }, el("code", { text: m.text })),
        ),
      );
    }
    return el(
      "div",
      { class: "msg system" },
      el("div", { class: `bubble${m.mark === "error" ? " error" : ""}`, text: m.text }),
    );
  }

  const node = el("div", {
    class: `msg ${m.role}${m.sendFailed ? " failed" : ""}${grouped ? " grouped" : ""}`,
  });

  // 우클릭으로 그 지점에서 분기한다 (D2)
  node.addEventListener("contextmenu", (e) => openMessageMenu(e, m));

  // 이어지는 말에는 이름을 다시 쓰지 않는다 — 같은 사람이 계속 말하는 중이다
  if (m.role === "agent" && !grouped) {
    /*
     * ★ **사용량을 이름 옆에** — 서랍을 안 열어도 보이게.
     *
     * 컨텍스트가 차고 있다는 것은 **대화 중에 알아야** 쓸모가 있다 —
     * 다 차고 나서 서랍에서 보면 이미 압축이 돌아간 뒤다.
     */
    const who = m.authorBotId
      ? room?.participants.find((b) => b.id === m.authorBotId)
      : room?.participants[0];
    /*
     * ★ **나간 봇이 한 말도 이름이 남는다** (2026-09-23).
     *
     * 🔴 `participants` 에서 빠지면 `who` 가 `undefined` 가 되어 **에이전트
     * 라벨로 떨어졌다** — 같은 에이전트로 봇이 둘이었으면 누가 한 말인지
     * 구별이 안 된다. 바로 위 주석이 걱정하던 그 상황이 **내보내기 한 번으로**
     * 생겼던 셈이다.
     */
    const goneName =
      !who && m.authorBotId && room ? botLabel(room, m.authorBotId) : undefined;
    node.append(
      el(
        "div",
        { class: "who" },
        el("span", { class: "dot", style: { background: agent?.color ?? "#888" } }),
        /*
         * 🔴 **봇 이름이지 에이전트 이름이 아니다.**
         *
         * 에이전트 라벨을 쓰고 있었는데, 그러면 같은 에이전트로 봇을 둘 두면
         * «알파»와 «알파 2»가 **둘 다 «알파»로** 보인다 — 누가 말했는지를
         * 구별할 수 없게 된다. 이름은 봇에 붙고(B1) 멘션도 그 이름으로 간다.
         */
        who?.name ?? (goneName ? `${goneName.name} (나감)` : undefined) ?? agent?.label ?? "에이전트",
        usageChip(who),
      ),
    );
  }

  /*
   * **말과 활동을 번갈아 놓는다** (C3).
   *
   * 🔴 예전에는 한 턴의 말을 통째로 한 말풍선에 넣고 활동을 전부 그 아래에
   * 쌓았다. 실제 대화는 «말하고 → 뭘 하고 → 다시 말하고» 인데 화면은
   * «다 말하고 → 그 밑에 한 일 목록»이 되어, **무엇 때문에 그렇게 했는지**가
   * 끊겼다. 활동이 글의 어디쯤이었는지는 `ToolActivity.textAt`에 있다.
   */
  /** 받는 이 칩은 **첫 말풍선에만** — 조각마다 붙으면 같은 말을 여러 번 한다 */
  let headed = false;
  for (const part of weave(m)) {
    if (part.kind === "tools") {
      node.append(toolsNode(part.tools));
      // 활동으로 끝난 턴이면 시각이 붙을 말풍선이 없다 — 활동 뒤에 단다
      if (part.last && !m.streaming) {
        node.append(el("div", { class: "row tail" }, el("span", { class: "time", text: hhmm(m.createdAt) })));
      }
      continue;
    }

    const bubble = el("div", { class: "bubble" });
    renderMarkdown(bubble, part.text);
    /*
     * **받는 이를 첫 문단 앞에 꽂는다** — 글과 한 줄로 흐르게.
     *
     * `renderBlocks`가 문단을 `<p>`로 쌓으므로, 말풍선에 그냥 붙이면 칩이
     * 자기 줄을 차지해 «머리말»처럼 보인다. 메신저의 멘션은 **문장 안에**
     * 있다. 첫 `<p>`가 없는 글(코드 블록·목록으로 시작)이면 맨 앞에 둔다.
     */
    if (!headed && room) {
      const to = deliveryChips(m, room);
      if (to) {
        const first = bubble.querySelector("p");
        if (first) first.prepend(to, " ");
        else bubble.prepend(to);
      }
      headed = true;
    }
    /*
     * 타이핑 표시와 시각은 **마지막 조각에만** — 중간에 붙으면 말이 끝난 것처럼 보인다.
     *
     * 🔴 **멈춰 있으면 점도 멈춘다.** 승인을 기다리는 동안 그 턴은 정말로
     * 멈춰 있는데(블로킹 요청이다), 점이 계속 돌면 «쓰고 있다»는 거짓말이
     * 된다 — 사용자는 **자기를 기다리는 줄 모르고** 기다리게 된다.
     */
    const stalled = m.authorBotId !== undefined && botStatus[m.authorBotId] === "permission";
    if (m.streaming && part.last && !stalled) {
      bubble.append(el("span", { class: "typing" }, el("i"), el("i"), el("i")));
    }
    node.append(
      el(
        "div",
        { class: "row" },
        bubble,
        !m.streaming && part.last ? el("span", { class: "time", text: hhmm(m.createdAt) }) : null,
      ),
    );
  }

  /*
   * ★ **말풍선에 붙는 중단.**
   *
   * 멈추고 싶어지는 순간 **보고 있는 것은 흐르는 말풍선**이다. 거기 버튼이
   * 없으면 눈을 떼고 다른 자리를 찾아야 하는데, 그 사이에 답이 끝나 버린다.
   *
   * 🔴 처음에는 **1:1에서 숨겼다** — 입력창 위의 «중단»과 하는 일이 똑같아
   * «뭐가 다르지»가 될까 봐. 그건 틀린 걱정이었다. 둘이 같은 일을 하는 것은
   * **혼란이 아니라 편의**고, 진짜 문제는 *"어디서 멈추지"* 였다.
   *
   * 봇이 여럿이면 이름을 붙인다 — 그때는 «이 봇만»이 **다른 말**이 되기 때문이다
   * (위의 것은 방 전체를 끊는다). 1:1에서는 같은 말이라 그냥 «중단»이다.
   *
   * 말풍선은 스크롤하면 사라지므로 **위의 «중단»을 없애지 않는다** — 그건
   * 언제나 닿을 수 있는 자리이고 «전부 멈춤»으로 남는다.
   */
  if (m.streaming && m.authorBotId) {
    node.append(
      el(
        "div",
        { class: "meta" },
        el("button", {
          class: "link stop-bot",
          text: manyBots() ? `${agent?.label ?? "이 봇"}만 중단` : "중단",
          title: manyBots()
            ? "이 봇의 턴만 끊습니다. 다른 봇은 계속합니다."
            : "지금 답하는 것을 끊습니다",
          onclick: () =>
            room && post({ t: "cancel", roomId: room.id, botId: m.authorBotId }),
        }),
      ),
    );
  }

  // 생각은 기본 접힘 — 읽고 싶을 때만 편다 (C2)
  if (m.thought) {
    node.append(
      el(
        "details",
        { class: "tool thought" },
        el("summary", {}, icon("lightbulb"), " 생각"),
        el("pre", { class: "thought-body" }, el("code", { text: m.thought })),
      ),
    );
  }

  // 뭐에 대한 답인지 — **자명하지 않을 때만** 보여준다 (C4). `needsAnswerNote` 참조
  if (noteAnswer) {
    const n = m.replyToIds?.length ?? 0;
    const asked =
      n === 1 ? room?.messages.find((x) => x.id === m.replyToIds![0]) : undefined;
    node.append(
      el("div", {
        class: "meta",
        text: asked
          ? `↩ «${asked.text.slice(0, 20)}${asked.text.length > 20 ? "…" : ""}»에 답합니다`
          : `↩ 질문 ${n}개에 한 번에 답합니다`,
      }),
    );
  }

  // 누구에게 갔고 누가 아직 줄에 서 있나 (§4.1.1)
  if (room) {
    const sent = deliveryNode(m, room);
    if (sent) node.append(sent);
  }

  // 계획은 **결과가 아니라 약속**이다 — 접지 않고 말풍선 아래 그대로 보여준다
  if (m.plan) node.append(planNode(m.plan));
  if (m.attachments?.length) node.append(attachmentsNode(m));
  if (m.files?.length) node.append(filesNode(m));

  if (m.truncated) node.append(el("div", { class: "meta", text: "응답이 중단되었습니다." }));
  if (m.error) node.append(el("div", { class: "meta error", text: m.error }));

  if (m.sendFailed) {
    node.append(
      el("div", { class: "meta error", text: m.sendFailed }),
      el("button", {
        class: "retry",
        text: "다시 보내기",
        onclick: () => room && post({ t: "retry", roomId: room.id, messageId: m.id }),
      }),
    );
  }

  return node;
}

/** 같은 날이면 같은 값. 날짜 구분선을 그을 자리를 이걸로 찾는다 */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLine(ts: number): HTMLElement {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);

  const label =
    dayKey(ts) === dayKey(today.getTime())
      ? "오늘"
      : dayKey(ts) === dayKey(yesterday.getTime())
        ? "어제"
        : d.getFullYear() === today.getFullYear()
          ? `${d.getMonth() + 1}월 ${d.getDate()}일`
          : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

  return el("div", { class: "day-line" }, el("span", { text: label }));
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * 에이전트가 한 일 (C3).
 *
 * **기본으로 접힌다** — 채팅은 대화를 읽는 곳이지 로그를 읽는 곳이 아니다.
 * 다만 **실패한 건 펼친 채로 둔다.** 테스트 실패나 명령 에러는 바로 보여야 한다.
 */
/**
 * 한 턴을 **말 조각과 활동 묶음**으로 쪼갠다 (C3).
 *
 * 활동이 글의 어디쯤이었는지(`textAt`)로 가른다. **옛 기록에는 그게 없다** —
 * 그때는 예전처럼 전부 맨 뒤에 모아 보여준다. 기록을 고치지 않는다.
 */
type Part =
  | { kind: "text"; text: string; last: boolean }
  | { kind: "tools"; tools: ToolActivity[]; last: boolean };

function weave(m: Message): Part[] {
  const tools = [...(m.tools ?? [])].sort(
    (a, b) => (a.textAt ?? Number.MAX_SAFE_INTEGER) - (b.textAt ?? Number.MAX_SAFE_INTEGER),
  );
  const parts: Part[] = [];
  let at = 0;

  // 같은 자리에서 연달아 일어난 것들은 **한 묶음**으로 — 줄마다 접는 건 시끄럽다
  for (let i = 0; i < tools.length; ) {
    const cut = Math.min(tools[i]!.textAt ?? m.text.length, m.text.length);
    const run: ToolActivity[] = [];
    while (i < tools.length && Math.min(tools[i]!.textAt ?? m.text.length, m.text.length) === cut) {
      run.push(tools[i]!);
      i++;
    }
    const text = m.text.slice(at, cut);
    if (text.trim()) parts.push({ kind: "text", text, last: false });
    parts.push({ kind: "tools", tools: run, last: false });
    at = cut;
  }

  const tail = m.text.slice(at);
  // 답하는 중이면 **빈 꼬리도 넣는다** — 타이핑 표시가 붙을 자리가 필요하다.
  // 끝난 응답에 빈 말풍선을 만들면 허공에 상자가 하나 뜬다.
  if (tail.trim() || parts.length === 0 || (m.streaming && parts[parts.length - 1]!.kind === "tools")) {
    parts.push({ kind: "text", text: tail, last: false });
  }

  parts[parts.length - 1]!.last = true;
  return parts;
}

function toolsNode(list: ToolActivity[]): HTMLElement {
  const tools = list;
  const failed = tools.filter((t) => t.status === "failed");
  const running = tools.some((t) => t.status === "pending" || t.status === "in_progress");

  /**
   * 한 줄 = 한 가지 일. **무엇을 했고 무엇이 나왔는지**가 보여야 한다 (C3).
   *
   * 🔴 예전에는 제목만 찍었다 — `Bash`라고만 나오면 `ls`인지 `rm -rf`인지
   * 알 수가 없다. 게다가 **자동 승인된 것은 승인 카드도 안 남으므로**
   * 여기가 유일한 흔적이다.
   *
   * ★ **접는 단위는 활동 하나다.** 묶음을 펼쳤을 때 명령과 결과가 전부 펼쳐져
   * 있으면 활동 몇 개만으로 화면이 가득 찬다. 묶음을 열면 **제목 줄만** 보이고,
   * 보고 싶은 것만 다시 편다. 실패한 것은 처음부터 펼쳐 둔다 — 왜 실패했는지가
   * 접혀 있으면 안 된다.
   */
  const row = (t: ToolActivity) => {
    /*
     * ★ **승인 결과는 그 활동 줄에 붙는다** (D3).
     *
     * 🔴 예전에는 승인할 때마다 대화에 시스템 줄이 하나씩 쌓였다. 스무 번
     * 물으면 **읽을 내 대화가 그 사이에 묻힌다.** 승인은 활동의 일종이므로
     * 그 도구 옆이 제자리다 — «무엇을 승인했나»가 한 자리에서 읽힌다.
     *
     * 봇이 정했으면 이름을 붙인다. **사람 결정과 구분되어야 한다**(§4.2.2).
     */
    const seal = t.decision
      ? el("span", {
          class: `seal ${t.decision.mark === "✓" ? "ok" : t.decision.mark === "✕" ? "no" : ""}`,
          text: `${t.decision.mark} ${t.decision.label}${t.decision.by ? ` · ${t.decision.by}` : ""}`,
          title: t.decision.by
            ? `${t.decision.by}이(가) 정했습니다`
            : "사용자가 정했습니다",
        })
      : null;

    const head: Kids = [
      icon(permIcon(t.kind)),
      ` ${t.title}`,
      seal,
      t.at ? el("span", { class: "at", text: hhmm(t.at) }) : null,
    ];

    // 보여줄 속이 없으면 접을 것도 없다 — 파일 하나면 눌러서 연다
    if (!t.command && !t.output) {
      return el(
        "button",
        {
          class: `activity ${t.status}`,
          title: t.paths?.join("\n") ?? t.title,
          onclick: () => t.paths?.length === 1 && post({ t: "openFile", path: t.paths[0]! }),
        },
        ...head,
      );
    }

    return el(
      "details",
      t.status === "failed" ? { class: `act ${t.status}`, open: true } : { class: `act ${t.status}` },
      el(
        "summary",
        { class: `activity ${t.status}`, title: t.paths?.join("\n") ?? t.title },
        icon("chevron-right"),
        ...head,
      ),
      t.command ? el("pre", { class: "act-in" }, el("code", { text: t.command })) : null,
      t.output ? el("pre", { class: "act-out" }, el("code", { text: t.output })) : null,
    );
  };

  const wrap = el("div", { class: "tool-group" });

  // 실패는 접지 않는다
  for (const t of failed) wrap.append(row(t));

  const rest = tools.filter((t) => t.status !== "failed");
  if (rest.length > 0) {
    wrap.append(
      el(
        "details",
        // 아직 도는 중이면 펼쳐둔다 — 처음부터 감추면 멈춘 것처럼 보인다
        running ? { class: "tool", open: true } : { class: "tool" },
        el("summary", {}, icon("chevron-right"), ` 활동 ${rest.length}개`),
        el("div", { class: "files" }, ...rest.map(row)),
      ),
    );
  }
  return wrap;
}

/**
 * 에이전트가 세운 계획 (계획 모드).
 *
 * 🔴 여태 **받아서 버리고 있었다** — 계획을 세우라고 시켜놓고 화면에는
 * 아무것도 안 나왔다. 항목형이면 체크리스트로, 마크다운이면 그대로 그린다.
 */
function planNode(plan: NonNullable<Message["plan"]>): HTMLElement {
  const box = el("div", { class: "plan" }, el("div", { class: "plan-head" }, icon("checklist"), " 계획"));

  if (plan.markdown) {
    const body = el("div", { class: "plan-body" });
    renderMarkdown(body, plan.markdown);
    box.append(body);
    return box;
  }

  box.append(
    el(
      "ul",
      { class: "plan-list" },
      ...(plan.entries ?? []).map((e) =>
        el("li", { class: `plan-item ${e.status}` }, icon(planIcon(e.status)), ` ${e.text}`),
      ),
    ),
  );
  return box;
}

function planIcon(status: string): string {
  if (status === "completed") return "check";
  if (status === "in_progress") return "sync";
  return "circle-outline";
}

/** 메시지를 보여주고 활동은 «자세히»로 접어 둔다 (E) */
function filesNode(m: Message): HTMLElement {
  const files = m.files ?? [];
  const changed = files.filter((f) => f.kind !== "read").length;
  const label = changed > 0 ? `파일 ${changed}개 변경` : `파일 ${files.length}개 읽음`;

  /*
   * ★ **누가 고쳤나** (§4.2).
   *
   * 봇이 여럿이면 카드가 «누구의 것»인지 말해야 한다. 이름은 바로 위
   * 말풍선에 있지만, **이어 말하면 이름이 안 나오고**(`grouped`) 카드는
   * 접혀 있어서 펼 때쯤엔 이름이 화면 밖일 수 있다. 되돌릴 일이 생겼을 때
   * 제일 먼저 묻는 게 *"누가 건드렸지"* 다.
   *
   * 봇이 하나면 안 붙인다 — 답이 하나뿐인 질문이다.
   */
  const who = manyBots() && m.authorBotId
    ? room?.participants.find((b) => b.id === m.authorBotId)?.name
    : undefined;

  return el(
    "details",
    { class: "tool" },
    el(
      "summary",
      {},
      icon("chevron-right"),
      who ? el("span", { class: "by", text: ` ${who}` }) : null,
      ` ${label}`,
    ),
    el(
      "div",
      { class: "files" },
      ...files.map((f) =>
        el("button", {
          class: "file",
          // 변경 전/후가 남아 있으면 diff로, 읽기만 했으면 파일로
          title: f.newSha256 ? "변경 내용 보기" : "파일 열기",
          text:
            `${kindMark(f.kind)} ${shortenPath(f.path)}` +
            (f.added || f.removed ? `  +${f.added ?? 0} −${f.removed ?? 0}` : ""),
          onclick: () =>
            f.newSha256 && room
              ? post({ t: "diffFile", roomId: room.id, messageId: m.id, path: f.path })
              : post({ t: "openFile", path: f.path }),
        }),
      ),
    ),
  );
}

function kindMark(kind: string): string {
  return kind === "create" ? "+" : kind === "delete" ? "−" : kind === "edit" ? "~" : "·";
}

/**
 * 에이전트 출력은 거의 항상 마크다운이다. 평문으로 흘리면 읽기가 크게 나빠진다.
 *
 * **`innerHTML`을 쓰지 않는다** — 에이전트가 만든 문자열이므로 노드로 직접 짓는다.
 * 표는 아직 다루지 않는다(백로그).
 */
function renderMarkdown(host: HTMLElement, text: string): void {
  // 펜스로 먼저 가른다. 코드 안의 `*`나 `#`이 서식으로 오해받으면 안 된다.
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = (nl >= 0 ? part.slice(0, nl) : "").trim();
      const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, "");
      host.append(codeBlock(code, lang));
      return;
    }
    if (part) renderBlocks(host, part);
  });
}

function renderBlocks(host: HTMLElement, text: string): void {
  const lines = text.split("\n");
  let para: string[] = [];
  let i = 0;

  const flush = () => {
    if (para.length === 0) return;
    const p = el("p");
    renderInline(p, para.join("\n"));
    host.append(p);
    para = [];
  };

  const bulletOf = (s: string) => /^\s*[-*+]\s+(.*)$/.exec(s);
  const numberOf = (s: string) => /^\s*\d+[.)]\s+(.*)$/.exec(s);
  const quoteOf = (s: string) => /^\s*>\s?(.*)$/.exec(s);

  while (i < lines.length) {
    const line = lines[i]!;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // 말풍선 안이라 h1으로 시작하면 너무 크다. 두 단계 낮춘다.
      const node = el(`h${Math.min(heading[1]!.length + 2, 6)}` as "h3");
      renderInline(node, heading[2]!);
      host.append(node);
      i++;
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      host.append(el("hr"));
      i++;
      continue;
    }

    const ordered = !bulletOf(line) && !!numberOf(line);
    if (bulletOf(line) || ordered) {
      flush();
      const list = el(ordered ? "ol" : "ul");
      for (;;) {
        const item = ordered ? numberOf(lines[i] ?? "") : bulletOf(lines[i] ?? "");
        if (!item) break;
        const li = el("li");
        renderInline(li, item[1]!);
        list.append(li);
        i++;
      }
      host.append(list);
      continue;
    }

    // 표 (GFM). **에이전트가 비교·요약에 자주 쓴다** — 못 그리면 `|---|---|`가
    // 그대로 나와서 정작 읽어야 할 답이 제일 안 읽힌다.
    if (isTableRow(line) && isTableRule(lines[i + 1] ?? "")) {
      flush();
      host.append(tableNode(lines, i, (next) => (i = next)));
      continue;
    }

    if (quoteOf(line)) {
      flush();
      const buf: string[] = [];
      for (;;) {
        const q = quoteOf(lines[i] ?? "");
        if (!q) break;
        buf.push(q[1]!);
        i++;
      }
      const bq = el("blockquote");
      renderBlocks(bq, buf.join("\n"));
      host.append(bq);
      continue;
    }

    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
}

/**
 * 코드 블록 하나.
 *
 * **복사 버튼이 붙는다.** 에이전트가 준 명령이나 코드를 쓰려면 드래그해서
 * 골라야 하는데, 여러 줄이면 그게 번거롭고 앞뒤 공백까지 딸려온다.
 *
 * 문법 강조는 아직 없다 — 라이브러리를 들여야 하는 일이라 따로 정한다.
 * 언어 이름은 받아서 표시만 한다.
 */
function codeBlock(code: string, lang: string): HTMLElement {
  const copy = el("button", { class: "copy", title: "복사" }, icon("copy")) as HTMLButtonElement;
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(code).then(
      () => {
        // 눌렀는지 아닌지 모르면 또 누르게 된다
        copy.replaceChildren(icon("check"));
        setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
      },
      () => {
        copy.replaceChildren(icon("error"));
        setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
      },
    );
  });

  return el(
    "div",
    { class: "code-wrap" },
    el(
      "div",
      { class: "code-bar" },
      el("span", { class: "code-lang", text: lang }),
      copy,
    ),
    el("pre", {}, el("code", { text: code })),
  );
}

/** `| a | b |` 처럼 보이는 줄인가. 파이프가 최소 하나는 있어야 한다 */
function isTableRow(line: string): boolean {
  return /\|/.test(line) && line.trim() !== "";
}

/** `|---|:--:|` 구분선. **이 줄이 있어야 표다** — 없으면 그냥 파이프 쓴 문장이다 */
function isTableRule(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/**
 * `| a | b |` 를 칸으로 쪼갠다.
 *
 * 양끝 파이프는 있어도 없어도 된다(GFM). **`\|`는 칸 구분이 아니다** —
 * 에이전트가 표 안에 코드를 넣으면서 자주 쓴다.
 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out;
}

/** 정렬은 구분선이 정한다 — `:--` 왼쪽, `--:` 오른쪽, `:-:` 가운데 */
function alignOf(rule: string): string {
  const t = rule.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : "";
}

/**
 * 표 하나를 그리고, 다음에 읽을 줄 번호를 알려준다.
 *
 * **칸 수가 안 맞아도 그린다.** 에이전트가 표를 만들다 칸을 빠뜨리는 건 흔한데,
 * 그때 표 전체를 포기하면 내용이 통째로 안 보인다 — 머리 줄 기준으로 맞춘다.
 */
function tableNode(lines: string[], start: number, done: (next: number) => void): HTMLElement {
  const head = splitRow(lines[start]!);
  const aligns = splitRow(lines[start + 1]!).map(alignOf);

  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  head.forEach((cell, c) => {
    const th = el("th");
    if (aligns[c]) th.style.textAlign = aligns[c]!;
    renderInline(th, cell.trim());
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  let i = start + 2;
  for (; i < lines.length && isTableRow(lines[i]!); i++) {
    const cells = splitRow(lines[i]!);
    const tr = el("tr");
    for (let c = 0; c < head.length; c++) {
      const td = el("td");
      if (aligns[c]) td.style.textAlign = aligns[c]!;
      renderInline(td, (cells[c] ?? "").trim());
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  done(i);

  // 좁은 폭에서 표만 가로로 스크롤된다 — 말풍선 전체가 밀리면 안 된다
  return el("div", { class: "table-wrap" }, table);
}

/**
 * `src/foo.ts:42` 같은 걸 클릭 가능하게 (E9).
 *
 * **확장자와 줄 번호가 둘 다 있을 때만** 잡는다. `1:30`(시각)이나 `a:b`를
 * 파일로 오인하면 엉뚱한 곳이 눌린다.
 */
const FILE_REF = /(^|[\s([<'"`])((?:[A-Za-z]:)?(?:[\w.~-]*[/\\])*[\w.-]+\.[A-Za-z]{1,8}):(\d+)(?::(\d+))?/g;

function linkFileRefs(host: HTMLElement, text: string): void {
  FILE_REF.lastIndex = 0;
  let last = 0;
  for (let m = FILE_REF.exec(text); m; m = FILE_REF.exec(text)) {
    const start = m.index + m[1]!.length;
    if (start > last) host.append(text.slice(last, start));
    const path = m[2]!;
    const line = Number(m[3]);
    host.append(
      el("button", {
        class: "file-ref",
        text: `${path}:${m[3]}`,
        title: "에디터에서 열기",
        onclick: () => post({ t: "openFile", path, line }),
      }),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) host.append(text.slice(last));
}

/** 인라인 서식. 한 번 훑으면서 처리한다 */
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/g;

function renderInline(host: HTMLElement, text: string): void {
  INLINE.lastIndex = 0;
  let last = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) linkFileRefs(host, text.slice(last, m.index));
    if (m[1] !== undefined) host.append(el("code", { text: m[1] }));
    else if (m[2] !== undefined) host.append(el("strong", { text: m[2] }));
    else if (m[3] !== undefined) host.append(el("strong", { text: m[3] }));
    else if (m[4] !== undefined) host.append(el("em", { text: m[4] }));
    // 링크는 http(s)만. VSCode 웹뷰가 바깥 브라우저로 열어준다.
    else if (m[5] !== undefined) host.append(el("a", { href: m[6]!, text: m[5] }));
    else if (m[7] !== undefined) host.append(el("a", { href: m[7], text: m[7] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) linkFileRefs(host, text.slice(last));
}

// ── 첨부 (I) ────────────────────────────────────────────────────────────

/** 보낼 준비가 된 첨부들. 전송하면 비워진다 */
let pending: Attachment[] = [];
/** 에이전트가 받아주는 종류 (I5). 연결 전이면 전부 허용으로 온다 */
type Caps = { image: boolean; audio: boolean; embeddedContext: boolean; fork: "yes" | "no" | "unknown" };
const ANY: Caps = { image: true, audio: true, embeddedContext: true, fork: "unknown" };

/**
 * **에이전트마다 따로 들고 있는다** (v2.0).
 *
 * ⚠ 예전엔 칸이 하나였고 `participants[0]`의 것만 담았다. 단체방에서는
 * 그게 **거짓말이 된다** — Claude·Gemini 방에서 분기 다이얼로그가 Claude를 보고
 * «그대로 갈라집니다»라고 말하는 사이 Gemini는 조용히 폴백으로 떨어졌다.
 * 잡는 것은 D1이 정한 «폴백은 미리 명시한다»이다.
 */
const capsBy = new Map<string, Caps>();
const capsOf = (agentId: string): Caps => capsBy.get(agentId) ?? ANY;
/** 방의 봇들을 합친 값 — 첨부처럼 **전원이 받아야** 보낼 수 있는 것에 쓴다 */
function capsAll(r: Room | null | undefined): Caps {
  const list = (r?.participants ?? []).map((b) => capsOf(b.agentId));
  if (list.length === 0) return ANY;
  return {
    image: list.every((c) => c.image),
    audio: list.every((c) => c.audio),
    embeddedContext: list.every((c) => c.embeddedContext),
    fork: list.every((c) => c.fork === "yes")
      ? "yes"
      : list.some((c) => c.fork === "no")
        ? "no"
        : "unknown",
  };
}

/** sha256 → data: URI. 같은 이미지를 두 번 받아오지 않는다 */
const blobCache = new Map<string, string>();
const blobWaiters = new Map<string, Array<(uri: string) => void>>();

/**
 * 비전 모델이 실제로 쓰는 해상도.
 *
 * 4K 스크린샷을 그대로 base64로 보내면 **토큰이 폭발한다**(I7). 줄여도 글자는
 * 읽히므로 손해가 없다. 캔버스가 웹뷰에 있으니 보내기 전에 여기서 줄인다.
 */
const MAX_IMAGE_EDGE = 1568;

async function attachFiles(roomId: string, files: File[]): Promise<void> {
  const items: Array<{ name: string; mimeType: string; base64: string }> = [];
  const rejected: string[] = [];

  for (const file of files) {
    const isImage = file.type.startsWith("image/");
    const isAudio = file.type.startsWith("audio/");
    // 못 받는 종류는 **보내기 전에** 말해준다 — 보내고 조용히 버리면 기다리게 된다
    const able = capsAll(room);
    if ((isImage && !able.image) || (isAudio && !able.audio)) {
      rejected.push(`${file.name} — 이 에이전트는 ${isImage ? "이미지" : "오디오"}를 받지 못합니다`);
      continue;
    }
    try {
      items.push(isImage ? await downscale(file) : await rawBytes(file));
    } catch {
      rejected.push(`${file.name} — 읽지 못했습니다`);
    }
  }

  if (rejected.length) noticeInChat(rejected.join("\n"));
  if (items.length) post({ t: "attach", roomId, items });
}

async function rawBytes(file: File): Promise<{ name: string; mimeType: string; base64: string }> {
  return {
    name: file.name,
    mimeType: file.type || "text/plain",
    base64: toBase64(await file.arrayBuffer()),
  };
}

async function downscale(file: File): Promise<{ name: string; mimeType: string; base64: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));

  // 이미 작으면 원본 그대로 — 다시 인코딩하면 오히려 커지거나 흐려진다
  if (scale === 1) {
    bitmap.close();
    return rawBytes(file);
  }

  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // PNG는 스크린샷(글자)에 유리하고, 사진은 JPEG가 훨씬 작다
  const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const url = canvas.toDataURL(mimeType, 0.85);
  return { name: file.name, mimeType, base64: url.slice(url.indexOf(",") + 1) };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  // 한 번에 넘기면 인자 개수 한도에 걸린다
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function paintChips(): void {
  const c = chat;
  if (!c) return;
  c.chips.replaceChildren(...pending.map((a) => chipNode(a, true)));
  c.chips.hidden = pending.length === 0;
}

/** 보내기 전(제거 가능)과 보낸 뒤(읽기 전용)가 같은 모양이어야 한다 */
function chipNode(a: Attachment, removable: boolean): HTMLElement {
  const node = el(
    "span",
    { class: "chip", title: `${a.name} · ${sizeText(a.byteSize)}` },
    icon(a.mimeType.startsWith("image/") ? "file-media" : "file"),
    el("span", { class: "chip-name", text: a.name }),
    el("span", { class: "chip-size", text: sizeText(a.byteSize) }),
  );

  if (removable) {
    node.append(
      el("button", {
        class: "chip-x",
        title: "빼기",
        onclick: () => {
          pending = pending.filter((x) => x !== a);
          paintChips();
        },
      }),
    );
    return node;
  }

  // 보낸 뒤: 텍스트면 앞부분을 펼쳐 볼 수 있다 (I8)
  if (!a.mimeType.startsWith("image/") && !a.mimeType.startsWith("audio/")) {
    node.classList.add("openable");
    node.addEventListener("click", () => void togglePreview(node, a));
  }
  return node;
}

/** 뭘 보냈는지 알아야 한다 — 앞 몇 줄만 (I8) */
async function togglePreview(chip: HTMLElement, a: Attachment): Promise<void> {
  const open = chip.nextElementSibling;
  if (open?.classList.contains("preview")) {
    open.remove();
    return;
  }
  const uri = await loadBlob(a);
  const text = decodeDataUri(uri).split("\n").slice(0, 12).join("\n");
  chip.after(el("pre", { class: "preview" }, el("code", { text })));
}

function decodeDataUri(uri: string): string {
  try {
    const bin = atob(uri.slice(uri.indexOf(",") + 1));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "(읽을 수 없습니다)";
  }
}

/** 이미지는 방을 열 때 한꺼번에 싣지 않는다 — 보이는 것만 가져온다 */
function loadBlob(a: Attachment): Promise<string> {
  const hit = blobCache.get(a.sha256);
  if (hit) return Promise.resolve(hit);

  return new Promise((resolve) => {
    const waiting = blobWaiters.get(a.sha256);
    if (waiting) {
      waiting.push(resolve);
      return;
    }
    blobWaiters.set(a.sha256, [resolve]);
    // 경로만 보낸 첨부는 blob이 없다. 셸이 지금 파일을 읽어 준다 (I4).
    post({ t: "needBlob", sha256: a.sha256, ...(a.path ? { path: a.path } : {}) });
  });
}

function attachmentsNode(m: Message): HTMLElement {
  const wrap = el("div", { class: "attachments" });
  for (const a of m.attachments ?? []) {
    if (a.mimeType.startsWith("image/")) {
      const img = el("img", { class: "thumb", alt: a.name, title: a.name }) as HTMLImageElement;
      img.addEventListener("click", () => img.classList.toggle("zoom"));
      void loadBlob(a).then((uri) => (img.src = uri));
      wrap.append(img);
    } else {
      wrap.append(chipNode(a, false));
    }
  }
  return wrap;
}

function sizeText(bytes: number): string {
  return bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)}KB`
      : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 방 안에 한 줄 안내를 남긴다 (오류가 아니라 알림) */
function noticeInChat(text: string): void {
  const c = chat;
  if (!c) return;
  c.list.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text })));
  if (stick) c.list.scrollTop = c.list.scrollHeight;
}

// ── 물어보는 카드 (D1·D4) ───────────────────────────────────────────────

/**
 * ★ **줄 서 있는 심사 한 줄** (§4.2.2).
 *
 * 심사 봇의 세션은 하나라 직렬이다(B1) — 그 봇이 자기 일을 하는 중이면
 * 심사는 기다려야 한다. **끼어들지 않는 것이 맞다**: 끊은 일은 자동으로
 * 다시 이어지지 않는다.
 *
 * 🔴 그런데 기다리는 동안 **요청한 봇의 턴은 얼어 있다.** 그래서 안 보이면
 * «왜 아무 일도 안 일어나지»가 되고, 그때 할 수 있는 일도 없다.
 * 보여주고, **빠져나올 길**을 준다.
 *
 * 이미 물어본 뒤(`asking`)에는 가로채기를 안 준다 — 그 턴은 이미 돌고 있고
 * 끊어도 되돌아오지 않는다. 그때는 «곧 끝난다»만 말해주면 된다.
 */
function reviewNode(w: ReviewWait, r: Room): HTMLElement {
  const name = (id: string) => r.participants.find((b) => b.id === id)?.name ?? "봇";
  const waiting = w.state === "waiting";
  return el(
    "div",
    { class: "card review-wait" },
    el(
      "div",
      { class: "card-title" },
      icon(waiting ? "watch" : "law"),
      ` ${name(w.askerBotId)}의 «${w.title}»`,
    ),
    el("div", {
      class: "dim",
      text: waiting
        ? `${name(w.judgeBotId)} 쪽이 하던 일을 끝내면 물어봅니다.`
        : `${name(w.judgeBotId)}에게 물어보는 중…`,
    }),
    waiting
      ? el(
          "div",
          { class: "card-actions" },
          el("button", {
            text: "내가 답할게",
            title: "기다리지 않고 승인 카드를 지금 띄웁니다",
            onclick: () =>
              room && post({ t: "takeOverReview", roomId: room.id, reviewId: w.id }),
          }),
        )
      : null,
  );
}

/** 큐에서 체크해 둔 것들 — 다시 그려도 살아남아야 한다 */
const ticked = new Set<string>();

/**
 * 이 요청에서 **«이번만»에 해당하는 선택지**를 찾는다.
 *
 * 🔴 **일괄 처리에는 «항상»을 쓰지 않는다.** 여러 개를 한 번에 넘길 때는
 * 하나하나를 읽지 않는다는 뜻인데, 거기에 «앞으로 전부»까지 걸면 **읽지 않은
 * 것이 영구 규칙이 된다.** «항상»은 하나씩 펴서 볼 때만 고를 수 있다 —
 * 봇 심사에 `*_once` 만 준 것과 같은 이유다(§4.2.2).
 */
function onceOption(req: PermissionRequest, allow: boolean): string | undefined {
  const want = allow ? "allow_once" : "reject_once";
  return req.options.find((o) => o.kind === want)?.optionId;
}

/**
 * ★ **승인 큐** — 헤더 바로 아래 (D1).
 *
 * 🔴 카드를 대화 맨 아래에 쌓고 있었다. 둘만 넘어가도 **답할 것이 뭔지
 * 흐려지고**, 대화는 자동으로 바닥까지 스크롤되는데 카드는 그보다 아래라
 * 오히려 밀렸다. **답해야 하는 것은 대화와 같이 흐르면 안 된다.**
 *
 * 한 줄 = 한 요청. 펴면 무엇을 승인하는지 전부 보이고(D1), 거기서는
 * 에이전트가 준 선택지를 **그대로** 고를 수 있다 — «항상»도 거기 있다.
 * 줄에서 바로 누르는 «허용/거절»은 **«이번만»** 이다.
 */
/**
 * ★ **부딪힘 띠** (§4.3 · 2026-09-22 실측).
 *
 * 무엇을 말하는가가 실측으로 바뀐 자리다. 예전 문구는 *"나중에 끝나는 쪽이 앞의
 * 변경을 덮어쓸 수 있습니다"* 였는데 **사실이 아니다** — Edit·Write는 겹치면
 * 거부당하고, 안 겹치면 둘 다 살아남는다. 진짜 일어나는 일은 **막혀서 다시 읽는
 * 것**이고, 그건 안 망가지는 대신 **조용히 느려진다.**
 *
 * 그래서 두 단계로 말한다:
 *
 * ```
 * 함께 고치는 중        아직 아무 일도 안 일어났다 — 겹치지 않으면 그냥 지나간다
 * 막혀 다시 읽는 중     에이전트가 실제로 거부당했다고 신고했다
 * ```
 *
 * ★ **«누가»는 우리만 안다.** 에이전트가 주는 사유는 *"by the user or by a
 * linter"* 라 **어느 봇인지 모른다.** 그 자리를 채우는 것이 이 띠의 값이다.
 */
function paintClashes(r: Room): void {
  const host = chat?.clash;
  if (!host) return;
  /*
   * ★ **뷰에서는 그 봇이 낀 것만** (v2.1 감사).
   *
   * 봇이 셋이면 **나와 무관한 둘이 부딪힌 것**까지 떴다. 뷰는 «그 봇과의
   * 1:1처럼»이라 남의 사정은 방으로 나가서 볼 일이다.
   */
  const only = viewBotId;
  const mine = only ? clashes.filter((c) => c.botIds.includes(only)) : clashes;
  if (mine.length === 0) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;

  const name = (id: string) => r.participants.find((b) => b.id === id)?.name ?? id;
  host.replaceChildren(
    ...mine.map((c) => {
      const who = c.botIds.map(name).join("·");
      const what = c.blocked
        ? `${c.blockedBotId ? name(c.blockedBotId) : "한쪽"}가 막혀 다시 읽는 중`
        : "함께 고치는 중";
      return el(
        "div",
        { class: c.blocked ? "clash blocked" : "clash" },
        el(
          "div",
          { class: "clash-line" },
          icon("warning"),
          el("span", { class: "clash-who", text: who }),
          el("span", { class: "clash-path", text: shortPath(c.path), title: c.path }),
          el("span", { class: "clash-what", text: what }),
        ),
        // **CLI가 준 말은 그대로 남긴다**(§0) — 접어두되 버리지 않는다
        c.reason
          ? el(
              "details",
              { class: "clash-why" },
              el("summary", {}, icon("chevron-right"), " 에이전트가 말한 사유"),
              el("pre", { text: c.reason }),
            )
          : false,
      );
    }),
  );
}

/** 띠는 한 줄이라 경로 전체를 못 담는다. 제목(`title`)에는 전체가 남는다 */
function shortPath(p: string): string {
  const cut = p.replace(/\\/g, "/").split("/");
  return cut.length > 2 ? `…/${cut.slice(-2).join("/")}` : p;
}

function paintApprovals(r: Room): void {
  const host = chat?.queue;
  if (!host) return;

  const mine = cards.filter((c) => c.roomId === r.id || c.roomId === "");
  for (const id of [...ticked]) if (!mine.some((c) => c.id === id)) ticked.delete(id);

  if (mine.length === 0) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;

  const answer = (card: AskCard, optionId?: string) => {
    if (!dropCard(card.id)) return;
    ticked.delete(card.id);
    post({ t: "answer", id: card.id, answer: { kind: "permission", optionId } });
  };
  /** 여러 개를 한 번에 — **«이번만»만** 쓴다 */
  const sweep = (list: AskCard[], allow: boolean) => {
    for (const c of list) answer(c, onceOption(c.req, allow));
    renderChat();
  };

  const many = r.participants.length > 1;
  const rows = mine.map((card) => {
    const req = card.req;
    const from = req.askerBotId
      ? r.participants.find((b) => b.id === req.askerBotId)
      : undefined;
    const asker = many ? from?.name : undefined;

    /*
     * ★ **원래 누가 심사할 것이었나** (§4.2.2의 «대상»).
     *
     * 이 줄이 **내 큐에 있다는 것 자체가** 봇 심사가 안 됐다는 뜻이다 —
     * 맡길 봇이 바쁘거나, 답을 못 읽었거나, 읽기라 안 넘겼거나. 이유는
     * 안내 줄로 한 번 지나가지만 **그건 곧 사라진다.**
     *
     * 그래서 줄에 남긴다: «리뷰어가 볼 예정이었다»를 알면 *"왜 나한테
     * 왔지"* 가 풀리고, 자주 그러면 **맡김이 헛돌고 있다**는 신호가 된다.
     *
     * 대상이 사용자면 안 적는다 — 내 큐에 있는 게 당연한 경우다.
     */
    const meantFor =
      from?.approver.kind === "bot"
        ? r.participants.find((b) => b.id === (from.approver as { botId?: string }).botId)?.name
        : undefined;
    const tick = el("input", { type: "checkbox" }) as HTMLInputElement;
    tick.checked = ticked.has(card.id);
    tick.addEventListener("change", () => {
      if (tick.checked) ticked.add(card.id);
      else ticked.delete(card.id);
      paintApprovals(r);
    });

    const quick = el(
      "span",
      { class: "quick" },
      el("button", {
        class: "primary",
        text: "허용",
        title: "이번만 허용합니다. «항상»은 펴서 고르세요.",
        onclick: () => (answer(card, onceOption(req, true)), renderChat()),
      }),
      el("button", {
        text: "거절",
        onclick: () => (answer(card, onceOption(req, false)), renderChat()),
      }),
    );

    // 펴면 **무엇을 승인하는지** 전부 (D1) — 제목만으로는 rm -rf 와 ls 가 같다
    const body = el("div", { class: "card-body" });
    if (req.command) body.append(el("pre", { class: "perm-cmd" }, el("code", { text: req.command })));
    for (const path of req.paths ?? []) {
      body.append(el("button", {
        class: "file", text: shortenPath(path), title: "에디터에서 열기",
        onclick: () => post({ t: "openFile", path }),
      }));
    }
    if (req.diff) {
      body.append(el("pre", { class: "preview" }, el("code", { text: req.diff.newText })));
    }
    body.append(
      el(
        "div",
        { class: "card-actions" },
        ...req.options.map((o) =>
          el("button", {
            class: /^allow/.test(o.kind) ? "primary" : "",
            text: o.name,
            onclick: () => (answer(card, o.optionId), renderChat()),
          }),
        ),
      ),
    );

    return el(
      "div",
      { class: "approval" },
      el(
        "div",
        { class: "approval-head" },
        tick,
        el(
          "details",
          { class: "act" },
          el(
            "summary",
            { class: "activity" },
            icon("chevron-right"),
            icon(permIcon(req.kind)),
            ` ${req.title}`,
            /*
             * ★ **누가 하려는 일인가** (§4.2.2).
             *
             * 🔴 제목만 있었다. 단체방에서 «파일 고치기»가 셋 뜨면 어느 봇
             * 것인지 알 수가 없는데, 그게 허용 여부를 가르는 첫 근거다 —
             * **리뷰어가 파일을 고치려 하면 그것부터 이상하다.**
             *
             * 1:1에서는 안 붙인다. 상대가 하나뿐이라 자명하다.
             */
            asker ? el("span", { class: "by", text: asker }) : null,
            meantFor
              ? el("span", {
                  class: "meant",
                  text: `↷ ${meantFor}`,
                  title: `원래 ${meantFor}에게 맡긴 승인입니다. 지금은 직접 답해야 합니다.`,
                })
              : null,
          ),
          body,
        ),
        quick,
      ),
    );
  });

  const picked = mine.filter((c) => ticked.has(c.id));
  host.replaceChildren(
    el(
      "div",
      { class: "approvals-head" },
      el("span", { class: "count", text: `승인 대기 ${mine.length}` }),
      picked.length > 0
        ? el("button", {
            text: `선택 ${picked.length}개 허용`,
            title: "고른 것들을 **이번만** 허용합니다",
            onclick: () => sweep(picked, true),
          })
        : null,
      picked.length > 0
        ? el("button", { text: "선택 거절", onclick: () => sweep(picked, false) })
        : null,
      /*
       * ★ **«전부 거절»도 있다.**
       *
       * 🔴 «전부 허용»만 달았다가 고쳤다. 비대칭인데다, **거절이 더 안전한
       * 쪽**이라 막아둘 이유가 없다 — 자리를 비우거나 무슨 일인지 모를 때
       * 한 번에 물릴 수 있어야 한다. 거절해도 되돌릴 수 없는 일은 안 생긴다.
       */
      mine.length > 1
        ? el("button", {
            class: "primary",
            text: "전부 허용",
            title: `${mine.length}개를 «이번만» 허용합니다. «항상»은 하나씩 펴서 고르세요.`,
            onclick: () => sweep(mine, true),
          })
        : null,
      mine.length > 1
        ? el("button", {
            text: "전부 거절",
            title: `${mine.length}개를 «이번만» 거절합니다.`,
            onclick: () => sweep(mine, false),
          })
        : null,
    ),
    ...rows,
  );
}


/**
 * 권한 설정 시트 (D2).
 *
 * **「봇 : 권한 모드 : 승인 주체」가 여기 한 자리에 있다.** 방 만들 때 정하고
 * 끝나는 게 아니라 대화 중에 바꾼다 — 리뷰만 시키다가 고치게 하는 일이 흔하다.
 *
 * 입력창 옆에 둔 이유는 자율 모드와 같다 — **켜둔 걸 잊으면 안 되는 종류**라
 * `⋮` 안에 숨기지 않는다.
 */
function togglePermissionSheet(r: Room): void {
  if (screens.chat.querySelector(".sheet")) {
    closeSheet();
    return;
  }
  paintPermissionSheet(r);
}

/** 시트와 덮개를 함께 걱는다 — 하나만 남으면 화면이 먹힌다 */
function closeSheet(): void {
  screens.chat.querySelector(".sheet-veil")?.remove();
  screens.chat.querySelector(".sheet")?.remove();
}

/**
 * 시트를 그린다 — 열려 있으면 **제자리에서 갈아 끼운다**.
 *
 * 설정은 CLI를 한 번 띄워야 오기 때문에 시트보다 늦게 도착하는 게 보통이다.
 * 처음 한 번만 그리면 그 늦은 응답이 갈 곳이 없어 시트가 *"권한 모드를 알려주지
 * 않습니다"* 에 영원히 머문다 — 실제로 Claude에서 그렇게 보였다.
 */
function paintPermissionSheet(r: Room): void {
  // 열어 보는 것 자체가 «필요하다»는 신호다. 캐시가 있으면 바로 돌아온다.
  // 봇마다다 — 같은 에이전트로 봇이 둘이면 **고른 값도 둘**이다 (B1)
  for (const b of r.participants) {
    if (!optionsFor(b.agentId, r.id, b.id)) {
      post({ t: "needConfig", agentId: b.agentId, roomId: r.id, botId: b.id });
    }
  }

  const sheet = el(
    "div",
    // 열 때만 밀려 올라온다 — 갱신 때는 `.opening` 을 뗀다 (`paintPermissionSheet` 끝)
    { class: "sheet opening" },
    el(
      "div",
      { class: "sheet-bar" },
      el("span", {}, icon("shield"), " 권한 설정"),
      el(
        "button",
        { class: "icon", title: "닫기", onclick: () => closeSheet() },
        icon("close"),
      ),
    ),
    ...r.participants.map((bot) => botPolicyBlock(r, bot)),
    sharedMemoryRow(r),
  );
  const was = screens.chat.querySelector(".sheet");
  if (was) {
    // 서랍과 같은 이유 — 갱신은 갈아끼우기라 매번 다시 올라왔다
    sheet.classList.remove("opening");
    const top = was.scrollTop;
    was.replaceWith(sheet);
    sheet.scrollTop = top;
  } else {
    /*
     * ★ **덮개를 깔고 올린다** — 서랍과 같은 이유다.
     *
     * 시트 배경은 테마에 따라 대화 배경과 거의 같은 색이 된다. 그러면
     * 시트인지 대화인지 경계가 안 보여 **위에 떠 있다는 것자체가 안 읽힌다.**
     * 그림자만으로는 부족했다 — 뒤를 깔아야 앞이 떠오른다.
     */
    screens.chat.append(
      el("div", { class: "sheet-veil", onclick: () => closeSheet() }),
      sheet,
    );
  }
}

/** 봇 하나의 설정 — 권한 모드 · 승인 주체 · 질문 */
function botPolicyBlock(r: Room, bot: BotInstance): HTMLElement {
  const agent = agentById.get(bot.agentId);
  const options = optionsFor(bot.agentId, r.id, bot.id) ?? [];
  const mode = options.find((o) => o.category === "mode");

  const rows: Kids = [];

  // ── 권한 모드 — 에이전트가 주는 목록 그대로
  if (mode?.values?.length) {
    const select = el("select") as HTMLSelectElement;
    for (const v of mode.values) {
      select.append(el("option", { value: v.id, text: v.name, selected: v.id === mode.current }));
    }
    const hint = el("span", { class: "dim" });
    const paint = () => {
      hint.textContent = mode.values!.find((v) => v.id === select.value)?.description ?? "";
      // 가로로 누운 뒤로는 한 줄로 잘린다 — **전문은 여기 남긴다**
      hint.title = hint.textContent;
      hint.hidden = hint.textContent === "";
    };
    select.addEventListener("change", () => {
      paint();
      // 🔴 **봇을 실어야 한다** — 없으면 단체방에서 첫 봇의 모드가 바뀐다
      post({ t: "setConfig", roomId: r.id, configId: mode.configId, value: select.value, botId: bot.id });
    });
    paint();
    rows.push(el("div", { class: "field" }, el("label", { text: "권한 모드" }), select, hint));
  } else {
    const err = configErrors.get(configKey(bot.agentId, r.id, bot.id));
    rows.push(
      el("p", {
        class: err ? "warn" : "dim",
        text: err
          ? err
          : optionsFor(bot.agentId, r.id, bot.id) !== undefined
            ? "이 에이전트는 권한 모드를 알려주지 않습니다."
            : "권한 모드를 불러오는 중…",
      }),
    );
    // 못 불러온 건 대개 **고치고 나면 되는** 것이다 — 방을 닫았다 열게 하지 않는다
    if (err) {
      rows.push(
        el("button", {
          class: "link",
          text: "다시 시도",
          onclick: () => {
            configs.delete(configKey(bot.agentId, r.id, bot.id));
            configErrors.delete(configKey(bot.agentId, r.id, bot.id));
            // 다시 그리면서 «불러오는 중»으로 바뀌고, 그 김에 요청도 나간다
            paintPermissionSheet(r);
          },
        }),
      );
    }
  }

  /*
   * ── 승인 주체 — 물어봐야 할 때 누구에게
   *
   * 🔴 **v2.0에서는 «사용자»뿐이다.** 봇에게 맡기는 길(§4.2.2의 심사)은
   * 코어·테스트까지 다 있지만 **v3.0으로 미뤘다.**
   *
   * 심사는 «봇이 봇에게 물어보는 것»이라 **v3.0의 정의 그 자체**고
   * («봇끼리 멘션해 주고받는다»), 붙을 배선도 §7이 v3.0으로 잡아둔 같은
   * MCP 서버다. 무엇보다 §4.1.1이 *"v2.0을 작게 유지해 빨리 내고"* 라고
   * 적어뒀는데, **제품에서 제일 위험한 면**(프롬프트 인젝션·상관된 실수)을
   * 첫 다중봇 릴리스에 실을 이유가 없다.
   *
   * 칸은 남긴다 — «대상»이라는 축이 있다는 것 자체가 D2의 모델이고,
   * 없애면 v3.0에서 다시 설명해야 한다.
   */
  const who = el("select") as HTMLSelectElement;
  who.append(el("option", { value: "user", text: "사용자", selected: true }));
  who.addEventListener("change", () =>
    post({
      t: "setPolicy",
      roomId: r.id,
      botId: bot.id,
      approver: who.value === "user" ? { kind: "user" } : { kind: "bot", botId: who.value },
    }),
  );
  rows.push(
    el(
      "div",
      { class: "field" },
      el("label", { text: "승인 주체" }),
      who,
      el("span", {
        class: "dim",
        text: "다른 봇에게 맡기는 것은 v3.0에서.",
        // 🔴 툴팁은 **보이는 글을 품어야** 한다 — 한 줄로 잘리기 때문이다
        title: "다른 봇에게 맡기는 것은 v3.0에서. 봇이 봇의 승인을 심사하는 것은 «봇 간 대화»에 속합니다.",
      }),
    ),
  );

  // ── 질문 — 에이전트가 물어볼 때
  const ask = el("select") as HTMLSelectElement;
  ask.append(el("option", { value: "ask", text: "물어봄", selected: bot.answerPolicy !== "auto" }));
  ask.append(
    el("option", { value: "auto", text: "알아서 판단", selected: bot.answerPolicy === "auto" }),
  );
  ask.addEventListener("change", () =>
    post({
      t: "setPolicy",
      roomId: r.id,
      botId: bot.id,
      answerPolicy: ask.value === "auto" ? "auto" : "ask",
    }),
  );
  rows.push(
    el(
      "div",
      { class: "field" },
      el("label", { text: "질문" }),
      ask,
      el("span", { class: "dim", text: "에이전트가 갈림길에서 물어볼 때.", title: "에이전트가 갈림길에서 물어볼 때." }),
    ),
  );

  return el(
    "div",
    { class: "sheet-bot" },
    el(
      "div",
      { class: "who" },
      el("span", { class: "dot", style: { background: agent?.color ?? "#888" } }),
      bot.name,
    ),
    /*
     * ★ **세 칸을 가로로 누인다** (v2.0).
     *
     * 봇마다 위아래로 쌓으면 봇이 셋일 때 아홉 줄이 된다 — 시트가
     * 화면을 다 먹고 **정작 비교해야 할 두 봇을 나란히 못 본다.**
     * 가로로 두면 봇 하나가 한 줄이라 «누가 무엇까지 할 수 있나»가 한눈에 들어온다.
     *
     * 좁아지면 알아서 접힌다(`flex-wrap`) — 폭을 재서 가르지 않는다.
     */
    el("div", { class: "policy" }, ...rows),
  );
}

/** 무슨 종류의 승인인지 한눈에 (D1) */
function permIcon(kind: string | undefined): string {
  switch (kind) {
    case "edit":
      return "edit";
    case "delete":
      return "trash";
    case "execute":
      return "terminal";
    case "fetch":
      return "globe";
    case "read":
    case "search":
      return "search";
    default:
      return "shield";
  }
}


// ── 메뉴 ────────────────────────────────────────────────────────────────

function toggleMenu(e: Event, r: Room): void {
  e.stopPropagation();
  const existing = screens.chat.querySelector(".menu");
  if (existing) {
    existing.remove();
    return;
  }

  const close = () => screens.chat.querySelector(".menu")?.remove();
  const item = (text: string, onclick: () => void, cls = "") =>
    el("button", { class: cls, text, onclick: () => (close(), onclick()) });


  const menu = el(
    "div",
    { class: "menu" },
    // 🔴 **⋮는 마지막 서랍이 아니다.** 한때 모델·압축·분기·계보가 전부 여기
    // 있었는데, 그것들에게 **제 자리가 생기면서** 둘 다 가진 항목이 됐다 — 같은 걸
    // 두 군데 두면 «어디서 하는 게 맞지»만 남는다. 모델·압축은 서랍으로, 분기는
    // 헤더로, 계보는 방 정보로 갔다. 여기 남는 것은 **방에 대한 설정·정보·끝내기**뿐.
    item("이름 바꾸기", () => startRename(r)),
    item("방 정보", () => showRoomInfo(r)),
    el("hr"),
    item("방 나가기 (세션도 삭제)", () => confirmLeave(r), "danger"),
  );

  screens.chat.append(menu);
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

/**
 * 방 정보 (B12).
 *
 * 방을 만들 때 정한 것들은 나중에 잊어버린다 — 어느 디렉터리인지, 역할을 뭐라 줬는지.
 * 역할은 여기서 고칠 수 있어야 한다: 바꾸면 **다음 프롬프트부터** 반영된다.
 */
/**
 * 세션 id 줄 (B12).
 *
 * **왜 보여주나** — 세션이 끊기거나 이상할 때, 이 id가 있어야 사용자가
 * 직접 확인할 수 있다. `claude --resume <id>`로 터미널에서 열어볼 수도 있고,
 * 에이전트가 남긴 기록 파일을 찾을 수도 있다. **우리 말만 믿게 하지 않는다**(§0).
 *
 * 아직 말을 안 건 세션은 **되살릴 수 없다**(첫 프롬프트 때 디스크에 남는다).
 * 그 사실을 같이 적어야 «왜 복구가 안 되지»에서 헤매지 않는다.
 */
function sessionRow(bot: BotInstance | undefined): HTMLElement | null {
  if (!bot?.sessionId) return null;

  const id = el("span", { class: "session-id", text: bot.sessionId, title: "눌러서 복사" });
  id.addEventListener("click", () => {
    void navigator.clipboard.writeText(bot.sessionId!).then(
      () => {
        const before = id.textContent;
        id.textContent = "복사했습니다";
        setTimeout(() => (id.textContent = before), 1000);
      },
      () => undefined,
    );
  });

  return el(
    "div",
    { class: "info-row" },
    el("span", { class: "dim", text: "세션" }),
    el(
      "span",
      {},
      id,
      bot.sessionPrompted
        ? null
        : el("span", { class: "dim", text: " · 아직 대화 전이라 복구 대상이 아닙니다" }),
    ),
  );
}

/**
 * 방 정보 (B12) — **방에 대한 것만**.
 *
 * 참여자 서랍과 **섞지 않는다.** 한때 서랍 머리에 얹어봤는데, 서랍은 *"이 봇이
 * 뭘 쓰고 얼마나 찼나"* 를 보러 오는 곳이라 그 앞에 방 정보가 쌓이면 **정작
 * 보러 온 봇이 아래로 밀린다.** 찾는 것이 다르면 자리도 달라야 한다.
 *
 * | 여기 | 서랍 |
 * |---|---|
 * | 작업 디렉터리 · 만든 때 · 계보 | 봇 · 모델 · 컨텍스트 · 권한 · 압축 · 역할 · 세션 |
 * | 방을 만들 때 정해진 것 | 지금 이 봇이 어떤 상태인가 |
 */
function showRoomInfo(r: Room): void {
  const row = (label: string, value: string) =>
    el("div", { class: "info-row" }, el("span", { class: "dim", text: label }), el("span", { text: value }));

  // 계보 — 어디서 갈라져 나왔고 무엇이 갈라져 나갔나 (D3)
  const kids = childrenOf(r.id);
  const lineage: Kids = [];
  if (kids.length > 0) {
    const links = el("span", { class: "forks" });
    for (const k of kids) {
      const one = el("span", { class: "link-ish", text: k.title, title: "그 방으로" });
      one.addEventListener("click", () => openRoom(k.id));
      links.append(one);
    }
    lineage.push(
      el("div", { class: "info-row" }, el("span", { class: "dim", text: `분기 ${kids.length}개` }), links),
    );
  }

  const card = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title" }, icon("info"), " 방 정보"),
    el(
      "div",
      { class: "card-body info" },
      row("작업 디렉터리", r.cwd),
      row("만든 때", new Date(r.createdAt).toLocaleString()),
      ...(r.forkedFromRoomId ? forkInfoRows(r) : []),
      ...lineage,
    ),
    el(
      "div",
      { class: "card-actions" },
      // 봇에 대한 것을 찾아 여기까지 온 사람을 **되돌려 보내지 않는다**
      el("button", { text: "참여자 보기", onclick: () => (closeModal(), paintDrawer(r)) }),
      el("button", { text: "닫기", onclick: () => closeModal() }),
    ),
  );

  /*
   * ★ **방 정보는 팔업이다** — 대화에 붙이지 않는다.
   *
   * 대화 아래에 붙는 카드들(승인·분기 다이얼로그)는 **답할 때까지 눈에
   * 보여야 하는 것**이라 거기 있는다. 방 정보는 반대다 — 보고 닫는 것이고,
   * 대화에 끼어들면 스크롤에 밀려 사라지고 기록처럼 보이기까지 한다.
   */
  screens.chat.append(
    el("div", { class: "modal-veil", onclick: () => closeModal() }),
    el("div", { class: "modal" }, card),
  );
}

/** 팔업과 덮개를 함께 걱는다 */
function closeModal(): void {
  screens.chat.querySelector(".modal-veil")?.remove();
  screens.chat.querySelector(".modal")?.remove();
}

/**
 * 역할 편집기 — **봇마다**.
 *
 * 역할은 첫 프롬프트 앞에 붙는 프리픽스라(B3) 세션에 갇힌다 — 즉 **봇의
 * 것이다.** 실측해보니 같은 폴더의 다른 세션으로 새지 않았다(§13.2).
 * 기억과 달리 역할은 봇마다 나눠 줄 수 있다 — 그래서 여기 놓는다.
 */
function roleEditor(r: Room, bot: BotInstance, more: Kids = []): HTMLElement {
  const box = el("textarea", {
    class: "role",
    placeholder: "역할 없음. 적으면 다음 프롬프트부터 반영됩니다.",
  }) as HTMLTextAreaElement;
  box.value = bot.rolePrompt ?? "";

  const save = el("button", {
    class: "primary",
    text: "역할 저장",
    onclick: () => {
      post({ t: "setRole", roomId: r.id, rolePrompt: box.value.trim(), botId: bot.id });
      save.textContent = "저장됨";
    },
  });
  /*
   * **역할 저장이 맨 오른쪽**이고 나머지는 왼쪽에 붙는다 — 역할은 «지금 쓴
   * 것을 확정»하는 것이라 입력 바로 다음이고, 나머지는 그 봇에 대한 다른 일이다.
   */
  return el(
    "div",
    { class: "role-edit" },
    box,
    el("div", { class: "card-actions role-acts" }, ...more, el("span", { class: "gap" }), save),
  );
}

function startRename(r: Room): void {
  const h1 = screens.chat.querySelector("h1");
  if (!h1) return;

  const input = el("input", { type: "text", value: r.title }) as HTMLInputElement;
  // 입력을 먼저 걷어내야 한다 — 이게 남아 있으면 `paintChat`이 헤더를 건너뛴다
  const restore = () => {
    input.remove();
    renderChat();
  };
  const commit = () => {
    const title = input.value.trim();
    const changed = title && title !== r.title;
    restore();
    if (changed) post({ t: "rename", roomId: r.id, title });
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) commit();
    if (e.key === "Escape") restore();
  });
  input.addEventListener("blur", commit);
  h1.replaceChildren(input);
  input.focus();
  input.select();
}

function confirmLeave(r: Room): void {
  const node = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title", text: `«${r.title}» 방을 나갈까요?` }),
    el("div", {
      class: "dim",
      text: "대화 기록과 에이전트 쪽 세션이 함께 지워집니다. 되돌릴 수 없습니다.",
    }),
    el(
      "div",
      { class: "card-actions" },
      el("button", {
        class: "primary",
        text: "나가기",
        onclick: () => {
          post({ t: "leave", roomId: r.id });
          room = null;
          chat = null;
          back();
        },
      }),
      el("button", { text: "취소", onclick: () => renderChat() }),
    ),
  );
  const host = screens.chat.querySelector<HTMLElement>(".messages");
  host?.append(node);
  if (host) scrollInside(host, node, "end");
}

// ── 분기 (v1.1) ─────────────────────────────────────────────────────────

/** 이 방에서 갈라져 나간 방들 (D3) */
function childrenOf(roomId: string): RoomMeta[] {
  return metas.filter((m) => m.forkedFromRoomId === roomId);
}

/**
 * 원본 방의 **분기 지점으로** 간다 (D2·D3).
 *
 * 분기한 메시지 id를 두 방이 공유하므로(코어가 id를 그대로 물려준다) 검색
 * 결과로 점프하는 것과 같은 길을 쓴다 — 짝을 따로 들고 있을 필요가 없다.
 *
 * 원본이 없어졌으면 **아무 일도 안 한다.** 분기는 유지되지만(D4) 갈 곳이 없다.
 */
function jumpToOrigin(r: { forkedFromRoomId?: string; forkedAtMessageId?: string }): void {
  if (!r.forkedFromRoomId || !metas.some((x) => x.id === r.forkedFromRoomId)) return;
  if (r.forkedAtMessageId) jumpToMessageId = r.forkedAtMessageId;
  openRoom(r.forkedFromRoomId);
}

/**
 * 헤더의 «여기서 분기» 버튼 — 서랍 버튼 옆.
 *
 * ⋮ 안에도 같은 것이 있지만, **분기는 대화를 보며 정하는 것**이라 메뉴를 열어
 * 찾게 하면 떠올리기 어렵다. 조건은 ⋮의 것과 **똑같이** 쓴다 — 한쪽에서만
 * 막히면 «왜 저기선 되는데»가 된다.
 *
 * 🔴 **못 할 때는 지우지 않고 죽여 둔다.** 버튼이 사라졌다 나타나면 헤더가
 * 들썩이고, 무엇보다 *"아까 있던 게 어디 갔지"* 가 된다. 이유는 툴팁에 적는다.
 */
function forkHeadButton(r: Room, botId?: string): HTMLElement {
  const bot = botId ? r.participants.find((b) => b.id === botId) : undefined;
  // 봇만 가를 때는 **그 봇만** 본다 — 옆 봇이 도는 건 이 갈래와 상관이 없다
  const busy = bot ? isBusyBot(bot.id) : isBusyHere(r);
  const mine = bot
    ? r.messages.filter((m) => inBotView(m, bot.id))
    : r.messages;
  const empty = !mine.some((m) => m.role !== "system");
  const why = busy
    ? "응답이 끝난 뒤에 분기할 수 있습니다"
    : empty
      ? bot ? `${bot.name}와(과) 나눈 대화가 아직 없습니다` : "아직 나눌 대화가 없습니다"
      : bot ? `${bot.name}만 갈라 새 방으로` : "여기서 분기";
  return el("button", {
    class: "icon",
    title: why,
    disabled: busy || empty,
    onclick: () => askFork(r, undefined, botId),
  }, icon("git-branch"));
}

/** 그 봇이 도는 중인가 — 방 전체가 아니라 (v2.1) */
function isBusyBot(botId: string): boolean {
  const at = botStatus[botId] ?? "idle";
  return at !== "idle" && at !== "error";
}

/**
 * 분기 물어보기 (D1).
 *
 * ⚠️ **파일은 갈라지지 않는다.** 여기가 그걸 말할 유일한 자리다 — 분기 방은
 * «평범한 새 방»이라 상단 배너를 두지 않기로 했으므로(D2), 고르는 순간에
 * 말하지 않으면 영영 말하지 않는 셈이 된다. (방 정보에도 남긴다.)
 */
function askFork(r: Room, atMessageId?: string, botId?: string): void {
  const bot = botId ? r.participants.find((b) => b.id === botId) : undefined;
  const at = atMessageId ? r.messages.findIndex((m) => m.id === atMessageId) : r.messages.length - 1;
  // **그 봇이 본 것만** 물려받는다 — 수도 그것으로 세야 말이 맞는다
  const inherited = r.messages
    .slice(0, at + 1)
    .filter((m) => m.role !== "system" && (bot ? inBotView(m, bot.id) : true)).length;

  /*
   * ★ **폴백이 될 걸 알면 누르기 전에 말한다** (§0 P5).
   *
   * 분기의 값어치는 «계획과 파일 기억까지 그대로»에 있다. 그게 안 되는 경우에
   * 같은 얼굴로 물으면, 사용자는 세션이 복제된 줄 알고 *"아까 읽은 파일"* 을
   * 가리키며 대화한다. **잃는 걸 알고 고르는 것과 모르고 고르는 것은 다르다.**
   *
   * 두 가지를 확실히 알 수 있다:
   *   · 과거 지점 — ACP에 «어느 지점에서»가 없다. **프로토콜상 언제나** 폴백
   *   · 에이전트가 분기를 광고 안 함 — 이미 붙어 있으므로 알 수 있다
   *
   * `unknown`이면 **아무 말도 안 한다.** 모르는 걸 단정하면 멀쩡한 에이전트를
   * 못 한다고 모함하게 된다.
   */
  const past = at < r.messages.length - 1;
  /*
   * ★ **누가 잃는지까지 말한다** (v2.0).
   *
   * 단체방은 봇마다 에이전트가 다르다. «일부는 잃습니다»만 써두면
   * **누구에게 다시 설명해야 하는지** 모른 채로 고르게 된다.
   *
   * 과거 지점은 프로토콜상 전원이 폴백이다 — `ForkSessionRequest`에 «어느
   * 지점에서»가 없기 때문이다. 끝에서 가를 때만 봇마다 갈린다.
   */
  const split = bot ? [bot] : r.participants;
  const losers = past
    ? split
    : split.filter((b) => capsOf(b.agentId).fork === "no");
  const lossy = losers.length > 0;
  // 봇이 하나면 이름을 안 붙인다 — 군더더기다. 조사도 그에 따라 갈린다.
  const subject =
    split.length > 1 && !past && lossy
      ? `${losers.map((b) => b.name).join("·")}는 계획과 파일 기억을`
      : "계획과 파일 기억은";
  const title = el("input", {
    type: "text",
    placeholder: bot
      ? `비우면 «${r.title} — ${bot.name}»`
      : `비우면 «${r.title.replace(/\s*\(\d+\)\s*$/, "")} (2)»`,
  }) as HTMLInputElement;

  const go = (fallback?: "refeed" | "fresh") => {
    post({
      t: "fork",
      roomId: r.id,
      ...(atMessageId ? { atMessageId } : {}),
      ...(botId ? { botId } : {}),
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
      ...(fallback ? { fallback } : {}),
    });
    renderChat();
  };

  const node = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title" }, icon("git-branch"),
       bot ? ` ${bot.name}만 갈라내기` : " 여기서 분기"),
    el("div", {
      class: "dim",
      text: bot
        /*
         * ★ **무엇이 따라가고 무엇이 안 따라가는지**를 한 줄에 담는다.
         *
         * 봇만 가르는 것은 «이사»에 가까워서, 남는 쪽이 어떻게 되는지를 같이
         * 말하지 않으면 **원본에서 그 봇이 사라지는 줄 안다.**
         */
        ? `${bot.name}와(과) 나눈 대화 ${inherited}개를 물려받아 ` +
          `${bot.name} 혼자 있는 새 방을 만듭니다. 이 방은 ${bot.name}을(를) 포함해 그대로 남습니다.`
        : `지금까지의 대화 ${inherited}개를 물려받아 새 방을 만듭니다. ` +
          `이 방은 그대로 남습니다.`,
    }),
    el("div", { class: "card-body" }, title),
    // ★ 잎는 것을 **누르기 전에** — 위 주석 참조
    lossy
      ? el(
          "div",
          { class: "warn-row" },
          icon("warning"),
          ` ${subject} 물려받지 못합니다 — 대화만 글로 옮깁니다. ` +
            (past
              ? "과거 지점은 세션을 복제할 수 없습니다."
              : `${[...new Set(losers.map((b) => agentById.get(b.agentId)?.label ?? "이 에이전트"))].join("·")}는 세션 분기를 지원하지 않습니다.`) +
            (r.participants.length > losers.length
              ? ` 나머지 봇은 그대로 갈라집니다.`
              : "") +
            " 다음 메시지에 실려 가므로 토큰이 듭니다.",
        )
      : null,
    /*
     * **fork의 목적이 코드에 대해서는 성립하지 않는다** (D1).
     * 대화는 갈라지지만 워크스페이스는 하나라, 분기 방에서 고친 파일은
     * 원본 쪽 결과도 같이 바꾼다. 격리하지 않기로 했으므로 **분명히 알린다.**
     */
    el(
      "div",
      { class: "warn-row" },
      icon("warning"),
      " 파일과 **에이전트의 기억**은 분기되지 않습니다 — 두 방이 같은 폴더를 보므로, "
        + "분기에서 «기억해»한 것이 CLAUDE.md 같은 파일에 적힐 수 있고, 그러면 원본도 읽게 됩니다.",
    ),
    el(
      "div",
      { class: "card-actions" },
      /*
       * ★ **기본은 언제나 네이티브 분기다.** 잃는 게 없고 토큰도 안 든다.
       *
       * 못 할 게 뻔한 경우에만 **둘로 갈라 묻는다.** 우리가 고르면 안 되는
       * 이유는 손해의 방향이 반대라서다 — 글로 옮기면 토큰이 들고, 백지로
       * 가면 상대가 아무것도 모른다. 어느 쪽이 나은지는 대화 길이와 지갑
       * 사정이 정하는데 **둘 다 우리가 모르는 것**이다.
       */
      ...(lossy
        ? [
            el("button", {
              class: "primary",
              text: "대화 넘겨서 분기",
              title: "지금까지의 대화를 글로 옮겨 보냅니다 — 토큰이 듭니다",
              onclick: () => go("refeed"),
            }),
            el("button", {
              text: "기록만 두고 분기",
              title: "화면에는 남지만 에이전트는 위 대화를 모릅니다",
              onclick: () => go("fresh"),
            }),
          ]
        : [el("button", { class: "primary", text: "분기하기", onclick: () => go() })]),
      el("button", { text: "취소", onclick: () => renderChat() }),
    ),
  );

  chat?.list.append(node);
  if (chat?.list) scrollInside(chat.list, node, "end");
  title.focus();
}

/**
 * 물려받은 메시지가 끝나는 자리의 **인라인 마커** (D2).
 *
 * 메신저의 «여기서부터 안 읽음» 구분선과 같은 패턴이다. 상단 배너를 쓰지
 * 않는 이유도 같다 — 분기 방은 평범한 방이고, 시간이 지나면 이 선은 위로
 * 밀려 사라진다. 그게 맞다. 식별은 목록의 계보 배지가 계속 해준다(D3).
 */
function forkLine(r: Room): HTMLElement {
  const parent = metas.find((m) => m.id === r.forkedFromRoomId);
  const node = el(
    "div",
    { class: parent ? "fork-line linked" : "fork-line" },
    el("span", { text: parent ? `↳ ${parent.title}에서 분기` : "↳ 삭제된 방에서 분기" }),
  );
  if (parent) {
    node.title = "원본의 분기 지점으로";
    node.addEventListener("click", () => jumpToOrigin(r));
  }
  return node;
}

/**
 * 말풍선에서 코드 펜스만 걷어낸다.
 *
 * 붙여넣으려는 것은 설명이 아니라 **코드**다. 펜스가 여럿이면 빈 줄로 잇는다 —
 * 어느 것 하나를 고르게 하면 «둘째 거였나»를 다시 열어봐야 한다.
 */
function codeOf(text: string): string {
  const parts = text.split("```");
  const blocks: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const part = parts[i]!;
    const nl = part.indexOf("\n");
    blocks.push((nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, ""));
  }
  return blocks.join("\n\n");
}

/** 복사하고 **복사했다고 말해준다** — 클립보드는 눈에 안 보이는 곳이라 확인이 필요하다 */
function copyThen(text: string, btn: HTMLElement, close: () => void): void {
  void navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = "복사했습니다";
      setTimeout(close, 600);
    },
    () => {
      btn.textContent = "복사하지 못했습니다";
      setTimeout(close, 1200);
    },
  );
}

/**
 * 말풍선 메뉴 — **그 메시지에 대한 것만** 둔다.
 *
 * 🔴 한때 여기에 압축·중단·참여자 서랍까지 달았다가 걷어냈다. 전부 **봇에 대한
 * 것**이라 서랍이 제자리이고, 헤더에 이미 버튼이 있는 것을 여기 또 두면 «어디서
 * 하는 게 맞지»만 남는다. 메뉴는 짧을수록 고르기 쉽다.
 *
 * 남긴 분기는 다르다 — 헤더의 것은 **대화 끝에서** 갈라지고, 여기 것은 **이
 * 지점에서** 갈라진다. 중간부터 다시 가보는 길은 여기에만 있으므로, 이름에
 * «이 메시지에서»를 넣어 차이를 드러낸다.
 */
function openMessageMenu(e: MouseEvent, m: Message): void {
  const r = room;
  if (!r) return;
  e.preventDefault();
  screens.chat.querySelector(".menu")?.remove();

  const close = () => screens.chat.querySelector(".menu")?.remove();
  const kids: Kids = [];

  // ── 복사 — 코딩 대화에서 제일 자주 하는 일
  if (m.text.trim()) {
    const copy = el("button", { text: "복사" });
    copy.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyThen(m.text, copy, close);
    });
    kids.push(copy);

    const code = codeOf(m.text);
    if (code) {
      const only = el("button", { text: "코드만 복사" });
      only.addEventListener("click", (ev) => {
        ev.stopPropagation();
        copyThen(code, only, close);
      });
      kids.push(only);
    }
  }

  /*
   * ── ★ **이 말에 얽힌 봇의 뷰로** (v2.1)
   *
   * 🔴 입구가 **참여자 서랍 하나뿐**이었다. 서랍은 «봇을 관리하는 곳»이라
   * 대화를 읽다가 *"얘랑 한 얘기만 몰아 보고 싶다"* 가 될 때 **손이 거기로
   * 안 간다** — 지금 보고 있는 말풍선이 바로 그 봇 것인데도.
   *
   * 여기가 제자리인 이유: 말풍선은 **누구 이야기인지 이미 알고 있다.** 고를
   * 것이 없으니 «이 봇과의 것만»이 한 번에 된다.
   */
  const linked = m.role === "agent"
    ? (m.authorBotId ? [m.authorBotId] : [])
    // 보낸 말은 **받은 봇들**이 얽힌 봇이다. 못 간 곳도 그 봇 이야기다(§5)
    : [...new Set([...m.deliveredTo, ...(m.notSentTo ?? [])])];
  const jumps = linked
    .filter((id) => id !== viewBotId)
    .map((id) => r.participants.find((b) => b.id === id))
    .filter((b): b is BotInstance => b !== undefined);

  if (r.participants.length > 1 && jumps.length > 0) {
    if (kids.length > 0) kids.push(el("hr"));
    for (const b of jumps) {
      kids.push(el("button", {
        text: `${b.name}와(과)의 1:1 뷰`,
        title: `${b.name}와(과) 주고받은 것만 모아 봅니다`,
        onclick: () => { close(); openBotView(b.id); },
      }));
    }
  }

  // ── 분기 — 헤더 버튼이 못 하는 것: **이 지점에서**
  if (kids.length > 0) kids.push(el("hr"));
  kids.push(
    el("button", {
      text: "이 메시지에서 분기",
      title: "여기까지를 물려받은 새 방을 만듭니다",
      onclick: () => {
        close();
        // 뷰 안에서 고른 지점이면 **그 봇만** 가른다 — 자리가 뜻을 말한다 (v2.1)
        askFork(r, m.id, viewBotId ?? undefined);
      },
    }),
  );

  const menu = el("div", { class: "menu at" }, ...kids);

  const box = screens.chat.getBoundingClientRect();
  menu.style.top = `${e.clientY - box.top}px`;
  menu.style.left = `${Math.min(e.clientX - box.left, box.width - 190)}px`;
  menu.style.right = "auto";
  screens.chat.append(menu);
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

/** 지금 이 방이 일하는 중인가 — 진행 중에는 분기를 막는다 (D4) */
function isBusyHere(r: Room): boolean {
  const s = statuses.get(r.id) ?? "idle";
  return s !== "idle" && s !== "error";
}

/**
 * **봇을 나눠도 기억은 나뉘지 않는다** — 다중 봇 방의 공지.
 *
 * 에이전트의 기억은 `~/.claude/projects/<cwd 슬러그>/memory/` 에 쌓인다(§13.2 실측).
 * **열쇠가 cwd**라서, 방을 나눠도 봇을 나눠도 폴더가 같으면 같은 기억을 읽는다.
 * 설정 디렉터리를 가르는 길은 인증이 죽어 닫혔고(자격증명을 복사하는 것은 §0 P3 위반),
 * 남는 길은 cwd를 가르는 것뿐이다.
 *
 * 그러니 **막을 수 없는 것은 말이라도 해준다**(§0). «리뷰어»와 «구현자»를
 * 한 방에 넣고 각자에게 다른 걸 시킨 사람은, 한 쪽에게 시킨 «기억해»가 다른 쪽에게
 * 넘어간 것을 **알 길이 없다** — 대화는 갈라져 보이니까.
 */
function sharedMemoryRow(r: Room): HTMLElement | null {
  if (r.participants.length < 2) return null;
  return el(
    "div",
    { class: "warn-row" },
    icon("warning"),
    " 에이전트의 기억은 봇마다 나뉘지 않습니다 — 같은 폴더를 보는 봇은 한 쪽에게 "
      + "«기억해»라고 시킨 것을 같이 읽습니다. 대화 내용 자체는 봇마다 따로입니다.",
  );
}

/**
 * 방 정보의 분기 줄 (D1·D3).
 *
 * 인라인 마커는 대화가 길어지면 위로 밀려 사라진다 — 그게 맞지만(D2), 그러면
 * **«파일은 공유된다»를 다시 볼 자리가 없어진다.** 방 정보는 그 자리다:
 * 늘 있지만 길을 막지는 않는다.
 */
function forkInfoRows(r: Room): Kids {
  const parent = metas.find((m) => m.id === r.forkedFromRoomId);
  const value = el("span", {
    class: parent ? "link-ish" : "",
    text: parent ? parent.title : "삭제된 방",
  });
  if (parent) {
    value.title = "원본의 분기 지점으로";
    value.addEventListener("click", () => jumpToOrigin(r));
  }
  return [
    el("div", { class: "info-row" }, el("span", { class: "dim", text: "분기 원본" }), value),
    el(
      "div",
      { class: "warn-row" },
      icon("warning"),
      " 파일과 에이전트의 기억은 분기되지 않습니다 — 원본 방과 같은 폴더를 봅니다. "
        + "대화 내용은 갈라집니다.",
    ),
  ];
}

// ── 참여자 서랍 ────────────────────────────────────────────────────────

/**
 * 참여자 서랍 — **봇에 관한 것이 전부 모이는 자리** (§4.2.1).
 *
 * v2.0 설계를 앞당겨 1:1에서도 연다. 봇이 하나뿐이어도 «이 봇이 무슨 모델로
 * 얼마나 차 있고 뭘 할 수 있나»를 볼 자리는 필요하고, 단체방이 되면 **줄이
 * 늘어날 뿐** 화면이 새로 생기지 않는다.
 *
 * 🔴 **입력창 옆 권한 버튼을 없애지 않는다.** 권한은 «켜둔 걸 잊으면 안 되는
 * 종류»라 보낼 때마다 눈에 들어와야 한다(D2). 서랍에도 두는 건 *"이 봇에 대해
 * 뭘 할 수 있지"* 로 찾아온 사람을 위한 것이지, 그 자리를 대신하려는 게 아니다.
 * 둘은 같은 시트를 연다 — 구현이 하나라 어긋날 수가 없다.
 */
function toggleDrawer(r: Room): void {
  const open = screens.chat.querySelector(".drawer");
  if (open) {
    closeDrawer();
    return;
  }
  paintDrawer(r);
}

function closeDrawer(): void {
  screens.chat.querySelector(".drawer-veil")?.remove();
  screens.chat.querySelector(".drawer")?.remove();
}

/**
 * 서랍을 그린다 — 시트와 같이 **제자리에서 갈아 끼운다**.
 *
 * 설정(모델 목록)은 CLI를 한 번 띄워야 오므로 서랍보다 늦게 도착한다. 처음
 * 한 번만 그리면 그 늦은 응답이 갈 곳이 없어 «모델을 알려주지 않습니다»에
 * 영원히 머문다 — 권한 시트에서 실제로 겪은 일이다.
 */
function paintDrawer(r: Room): void {
  // 봇마다다 — 같은 에이전트로 봇이 둘이면 **고른 값도 둘**이다 (B1)
  for (const b of r.participants) {
    if (!optionsFor(b.agentId, r.id, b.id)) {
      post({ t: "needConfig", agentId: b.agentId, roomId: r.id, botId: b.id });
    }
  }

  const was = screens.chat.querySelector(".drawer");

  /*
   * 🔴 **글을 쓰는 중이면 건드리지 않는다.**
   *
   * 이 함수는 상태·메시지가 올 때마다 도는데(`paintChat`), 갈아끼우면
   * **역할 입력과 이름 고치기가 통째로 날아간다.** 방 제목을 고치는 중에
   * 헤더를 안 건드리는 것과 같은 이유다.
   */
  const focus = document.activeElement;
  if (was && focus && was.contains(focus) && /^(INPUT|TEXTAREA)$/.test(focus.tagName)) return;

  const veil = el("div", { class: "drawer-veil", onclick: () => closeDrawer() });
  const drawer = el(
    "div",
    /*
     * ★ **열 때만 밀려 들어온다.**
     *
     * 🔴 `animation` 이 `.drawer` 에 붙어 있었다. 그런데 갱신은 **새 엘리먼트로
     * 갈아끼우는** 것이라, 상태가 한 번 바뀔 때마다 **서랍이 오른쪽에서 다시
     * 슬라이드됐다.** 보고 있는 중에 화면이 계속 새로 나타나는 꼴이다.
     */
    { class: was ? "drawer" : "drawer opening" },
    el(
      "div",
      { class: "sheet-bar" },
      el("span", {}, icon("organization"), ` 참여자 ${r.participants.length}`),
      el("button", { class: "icon", title: "닫기", onclick: () => closeDrawer() }, icon("close")),
    ),
    ...r.participants.map((bot) => drawerBot(r, bot)),
    sharedMemoryRow(r),
    inviteRow(r),
  );

  if (was) {
    // 갈아끼우면 스크롤이 맨 위로 돌아간다 — 보던 자리를 지킨다
    const top = was.scrollTop;
    was.replaceWith(drawer);
    drawer.scrollTop = top;
  } else {
    screens.chat.append(veil, drawer);
  }
}

/**
 * **봇 부르기** — 서랍 바닥 (v2.0).
 *
 * 1:1 방에서 누르면 그 자리에서 단체방이 된다 — 방을 새로 만들 필요가 없다.
 * 역할은 여기서 안 받는다. 부른 뒤 **그 봇의 줄에서** 적으면 된다 — 단추 하나에
 * 폼을 달면 «부르기 전에 다 정해야 한다»가 되고, 그건 사실이 아니다.
 */
function inviteRow(r: Room): HTMLElement {
  return el(
    "div",
    { class: "invite-row" },
    el("button", {
      class: "ghost",
      text: "+ 봇 부르기",
      onclick: () => (closeDrawer(), askInvite(r)),
    }),
  );
}

/**
 * **부를 봇을 고른다** (v2.0).
 *
 * 예전엔 서랍 바닥에 드롭다운 하나만 두었는데, 그러면 **에이전트밖에 못
 * 고른다.** 모델과 역할은 봇에 붙는 값인데(D2·B3) 부르고 나서 따로 찾아가
 * 정하게 하는 것은 «부를 때 정하는» 방 만들기와 엇나간다.
 *
 * 그래서 **방 만들 때와 같은 모양**을 카드로 띄운다 — 새로 배울 게 없다.
 */
function askInvite(r: Room): void {
  const draft: DraftBot = newDraftBot();
  if (!configs.has(draft.agentId)) post({ t: "needConfig", agentId: draft.agentId });

  const paint = (): void => {
    const role = el("textarea", {
      class: "role",
      placeholder: "역할 (선택) — 예) 너는 코드 리뷰어다.",
    }) as HTMLTextAreaElement;
    role.value = draft.role;
    role.addEventListener("input", () => (draft.role = role.value));

    /*
     * ★ **부를 때도 이름을 정한다** — 방 만들기와 같은 자리(에이전트 바로 아래).
     *
     * 🔴 여기서 못 정하면 **부르자마자 서랍을 열어 이름부터 고치게 된다.**
     * 특히 같은 에이전트를 하나 더 부르는 경우가 그런데, 그때가 이름이 제일
     * 필요한 순간이다 — `Claude` 와 `Claude 2` 는 구별이 안 되므로.
     */
    const label = boot.agents.find((a) => a.id === draft.agentId)?.label ?? draft.agentId;
    const taken = new Set(r.participants.map((b) => b.name));
    const name = el("input", {
      type: "text",
      class: "bot-name",
      value: draft.name,
      placeholder: uniqueBotName(label, taken),
    }) as HTMLInputElement;
    const bent = el("span", { class: "dim bot-bent", hidden: true });
    const syncName = () => {
      draft.name = name.value;
      const wanted = name.value.trim();
      if (!wanted) { bent.hidden = true; return; }
      const got = uniqueBotName(wanted, taken);
      bent.hidden = got === wanted;
      bent.textContent = `«${wanted}»은(는) 이미 있어서 «${got}»이(가) 됩니다.`;
    };
    name.addEventListener("input", syncName);
    syncName();

    const card = el(
      "div",
      { class: "card" },
      el("div", { class: "card-title" }, icon("organization"), " 봇 부르기"),
      el(
        "div",
        { class: "card-body" },
        el(
          "div",
          { class: "field" },
          el("label", { text: "에이전트" }),
          el(
            "div",
            { class: "agents" },
            ...boot.agents.map((a) =>
              el(
                "button",
                {
                  class: "agent",
                  "aria-pressed": a.id === draft.agentId,
                  onclick: () => {
                    if (a.id === draft.agentId) return;
                    draft.agentId = a.id;
                    // 모델은 에이전트마다 다르다 — 압은 것을 두면 없는 id를 보낸다
                    draft.picks.clear();
                    if (!configs.has(a.id)) post({ t: "needConfig", agentId: a.id });
                    paint();
                  },
                },
                el("span", { class: "dot", style: { background: a.color } }),
                el(
                  "span",
                  { class: "agent-main" },
                  el("span", { class: "agent-name", text: a.label }),
                  a.description ? el("span", { class: "agent-desc", text: a.description }) : null,
                ),
              ),
            ),
          ),
        ),
        el("div", { class: "field" },
          el("label", { text: "이름 (선택)" }),
          name,
          bent),
        ...configFields(configs.get(draft.agentId), draft.picks),
        role,
      ),
      // 부르기 전에 **무엇을 모를지** 알려준다 (§4.1.1)
      r.messages.some((m) => m.role !== "system")
        ? el(
            "div",
            { class: "warn-row" },
            icon("warning"),
            " 새 봇은 **위 대화를 모릅니다** — 화면에는 보이지만 전달되지는 않았습니다. "
              + "필요한 것은 부른 뒤에 다시 알려주세요.",
          )
        : null,
      el(
        "div",
        { class: "card-actions" },
        el("button", {
          class: "primary",
          text: "부르기",
          onclick: () => {
            post({
              t: "addBot",
              roomId: r.id,
              agentId: draft.agentId,
              ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
              ...(draft.role.trim() ? { rolePrompt: draft.role.trim() } : {}),
              ...(draft.picks.size > 0 ? { configValues: Object.fromEntries(draft.picks) } : {}),
            });
            renderChat();
          },
        }),
        el("button", { text: "취소", onclick: () => renderChat() }),
      ),
    );

    const old = chat?.list.querySelector(".card");
    if (old) old.replaceWith(card);
    else chat?.list.append(card);
    if (chat?.list) scrollInside(chat.list, card, "end");
  };
  paint();
}


/**
 * 봇 한 줄.
 *
 * **이름 옆이 사용량 자리다.** 컨텍스트는 세션마다 차고 세션은 봇 단위라(B1),
 * 방에 하나로 걸어두면 봇이 둘일 때 누구 숫자인지 알 수 없다 — 실제로 나중에
 * 온 봇이 앞 봇의 숫자를 덮어쓰고 있었다.
 */
/**
 * ★ **이 봇이 무엇까지 할 수 있나 — 한 줄로** (§4.2.2).
 *
 * 권한은 봇마다 다르다(D2). 그런데 여태 그걸 보려면 **봇마다 시트를 열어**
 * 세 칸을 읽어야 했다 — 봇이 넷이면 네 번이다. 「리뷰어는 읽기만, 구현 봇은
 * 편집까지」가 이 기능의 요점인데, **그 대비가 한눈에 안 보이면 요점이 없다.**
 *
 * 세 가지를 순서대로 잇는다: **모드**(무엇까지 자동) · **주체**(막히면 누가
 * 답하나) · **질문**(갈림길에서). 「봇 : 범위 : 대상」(D2)이 그대로다.
 */
function policyLine(r: Room, bot: BotInstance): string {
  const options = optionsFor(bot.agentId, r.id, bot.id);
  const mode = options?.find((o) => o.category === "mode");
  const bits: string[] = [];

  if (mode?.values?.length) {
    const now = bot.configValues?.[mode.configId] ?? mode.current;
    bits.push(mode.values.find((v) => v.id === now)?.name ?? String(now));
  } else if (options === undefined) {
    // 🔴 «아직 안 왔다»와 «없다»는 다른 화면이어야 한다 — 하나로 뭉치면
    // CLI가 안 뜬 걸 «이 에이전트는 권한 모드가 없다»로 읽게 된다
    bits.push("모드 불러오는 중…");
  }

  /*
   * 🔴 **봇 이름에 «이/가»를 붙이지 않는다.** 이름은 사용자가 짓는 말이라
   * 받침을 미리 알 수 없다 — «베타이 승인»이 된다. 분기 안내문에서 이미 한 번
   * 깨졌던 자리다. «에게»는 받침과 무관하다.
   */
  bits.push(
    bot.approver.kind === "user"
      ? "승인은 사용자에게"
      : `승인은 ${r.participants.find((b) => b.id === (bot.approver as { botId?: string }).botId)?.name ?? "다른 봇"}에게`,
  );
  bits.push(bot.answerPolicy === "auto" ? "질문은 알아서" : "질문은 물어봄");
  return bits.join(" · ");
}

/**
 * **이름을 제자리에서 고친다** (§4.2.1).
 *
 * 🔴 **이름은 라우팅이다.** 멘션 칩은 `botId`를 들고 있어서 이름을 바꿔도
 * 가리키는 대상이 안 바뀌지만, 사람이 `@`를 눌러 고를 때 보는 것은 이름이다.
 * 「Claude」와 「Claude 2」로는 누가 리뷰어인지 알 수 없다.
 */
function renameBotInline(r: Room, bot: BotInstance, host: HTMLElement): void {
  const input = el("input", { type: "text", value: bot.name }) as HTMLInputElement;

  /*
   * 🔴 **포커스를 먼저 놓아야 다시 그려진다.**
   *
   * `paintDrawer` 에는 «입력 중이면 건드리지 않는다»는 규칙이 있다 — 안 그러면
   * 상태가 올 때마다 **치던 글자가 통째로 날아가기** 때문이다. 그런데 이
   * 입력창이 포커스를 쥔 채로 부르면 **그 규칙에 우리가 걸린다**: 서랍이
   * 안 그려지고, 이어서 방 갱신이 와도 또 안 그려져서 **엔터를 쳐도 아무 일도
   * 안 일어난 것처럼 보인다.** (이름은 실제로 바뀌어 있었다.)
   *
   * `done` 으로 한 번만 돌게 막는다 — `blur()` 가 blur 처리기를 다시 부른다.
   */
  let done = false;
  const finish = (send: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.blur();
    paintDrawer(r);
    if (send && name !== "" && name !== bot.name) {
      post({ t: "renameBot", roomId: r.id, botId: bot.id, name });
    }
  };

  input.addEventListener("keydown", (e) => {
    // `isComposing` — 한글은 조합 중에도 Enter 가 온다. 그때 끝내면 글자가 깨진다
    if (e.key === "Enter" && !e.isComposing) finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  host.replaceChildren(input);
  input.focus();
  input.select();
}

/*
 * 🔴 **«서랍에서 누르면 멘션 삽입»은 뺐다** (v2.1 · 2026-09-22).
 *
 * *"v2.1의 «봇별 1:1 뷰»가 들어오기 전까지의 자리"* 라고 적어둔 임시 동작이었고,
 * 그 화면이 생겼으므로 **이름을 누르면 그 봇의 뷰로 간다.**
 *
 * 아쉽지 않은 이유: **뷰 안에서 친 말은 자동으로 그 봇에게 간다**(§5). 칩을
 * 꽂을 이유 자체가 사라진다. 방 전체에서 지목하려면 입력창에서 `@` 를 친다.
 */

/**
 * ★ **에이전트를 바꾸면 무엇을 잃나** — 고른 자리 바로 아래에 편다 (§4.2.1).
 *
 * 🔴 이건 «설정 바꾸기»가 아니라 **세션을 버리는 일**이다. 세션은 그 CLI의
 * 것이라 이어받을 수 없고, 되돌릴 수 없는 것이 여럿 사라진다 —
 * **누르고 나서 알게 되면 늦는다.**
 *
 * 🔴 그리고 **폴백이라는 것을 미리 말한다.** 바꾸고 나면 F7 배너가 «대화
 * 넘겨서 시작»을 권하는데, 그건 **글자만** 옮긴다 — 계획과 읽은 파일 기억은
 * 안 따라온다. 분기 폴백과 같은 길이고 같은 한계다. **알고 고르는 것과
 * 모르고 겪는 것은 다르다.**
 *
 * 목록은 `setAgent` 가 실제로 하는 그대로다 — 지어내면 안 되는 자리다.
 */
function swapWarning(r: Room, bot: BotInstance, nextId: string): Kids {
  const at = botStatus[bot.id] ?? "idle";
  const busy = at !== "idle" && at !== "error";
  const next = agentById.get(nextId)?.label ?? nextId;

  /*
   * ★ **«대화를 넘길지»를 여기서 같이 정한다** (F7과 같은 세 갈래).
   *
   * 🔴 처음에는 «바꾸기» 하나였다. 그러면 바꾼 **뒤에** 배너가 떠서 한 번 더
   * 묻는다 — 사용자에게는 **한 번의 결정**인데(«Codex로, 대화는 넘겨서»)
   * 두 번 물어보는 꼴이었다. 게다가 **무엇을 잃는지 방금 읽은 자리**에서
   * 정하는 것이 가장 정확하다.
   *
   * 되먹임은 **글자만** 옮긴다 — 위 경고에 적어뒀다. 그래서 두 갈래다.
   */
  const mk = (label: string, title: string, refeed: boolean) => {
    const b = el("button", {
      class: refeed ? "primary" : "",
      text: label,
      title,
      onclick: () => {
        const model = swapModel.get(bot.id);
        const opt = optionsFor(nextId)?.find((o) => o.category === "model");
        swapping.delete(bot.id);
        swapModel.delete(bot.id);
        post({
          t: "setAgent", roomId: r.id, botId: bot.id, agentId: nextId, refeed,
          ...(model && opt ? { model: { configId: opt.configId, value: model } } : {}),
        });
      },
    }) as HTMLButtonElement;
    b.disabled = busy;
    return b;
  };
  const goFeed = mk("대화 넘겨서 바꾸기", "지난 대화를 다음 메시지에 함께 보냅니다. 글자만 갑니다.", true);
  const goBare = mk("기록만 두고 바꾸기", "대화는 화면에만 남고, 새 에이전트는 백지에서 시작합니다.", false);

  return [
    el("div", { class: "swap-what" },
      el("div", { class: "gone" },
        el("b", { text: "사라지는 것" }),
        el("div", { text: "이 봇의 세션 — 세운 계획과 읽은 파일 기억" }),
        el("div", { text: "모델 · 권한 모드 · 설정값 · 사용량" })),
      el("div", { class: "kept" },
        el("b", { text: "남는 것" }),
        el("div", { text: "지금까지의 대화 — 말풍선은 하나도 안 지운다" }),
        el("div", { text: "이전 세션 — 그 CLI에 그대로 있어 --resume 으로 열 수 있다" })),
    ),
    el("p", { class: "warn", text:
      `${next}은(는) 위 대화를 모릅니다. 바꾸면 «대화 넘겨서 시작»을 권하는데, ` +
      "그건 글자만 옮깁니다 — 계획과 읽은 파일 기억은 따라오지 않습니다." }),
    busy
      ? el("p", { class: "warn", text: "답하는 중에는 바꿀 수 없습니다. 끝나거나 중단한 뒤에 하세요." })
      : null,
    el("div", { class: "acts" },
      goFeed,
      goBare,
      el("button", {
        class: "ghost",
        text: "그대로 두기",
        // 고른 것을 **되돌린다** — 안 바꿨는데 칸만 바뀌어 있으면 거짓말이다
        onclick: () => (swapping.delete(bot.id), swapModel.delete(bot.id), paintDrawer(r)),
      }),
    ),
  ];
}

function drawerBot(r: Room, bot: BotInstance): HTMLElement {
  const status = botStatus[bot.id] ?? "idle";
  const busy = status !== "idle" && status !== "error";

  /*
   * ★ **갈아탈 에이전트를 고르는 중인가.**
   *
   * 고르기만 하고 아직 확인은 안 한 상태다. 이 동안 **모델 칸도 그쪽 것을
   * 보여준다** — 안 그러면 Codex를 골라둔 채로 모델 칸엔 `Opus` 가 남아
   * **없는 조합을 화면이 주장하게** 된다.
   */
  const pending = swapping.get(bot.id);
  const showAgent = pending ?? bot.agentId;
  /*
   * 갈아타는 중이면 **아직 이 방에 없는 에이전트**다 — 방 안이 아니라
   * **에이전트 기본값**을 본다. 붙은 뒤에는 그 봇의 세션 값을 본다.
   */
  const options = (pending ? optionsFor(pending) : optionsFor(bot.agentId, r.id, bot.id)) ?? [];
  const model = options.find((o) => o.category === "model");

  // ── 첫 줄: 이름 · 작업 중 · 사용량
  //
  // 🔴 색 점을 뺐다. 에이전트를 **칸으로 직접 고르게 된 뒤로** 색은 같은 것을
  // 한 번 더 말하는 것이 됐고, 이름이 작아 보이게만 했다.
  const nameCell = el("span", { class: "name" });
  /*
   * ★ **이름을 누르면 그 봇의 뷰로 간다** (v2.1 · §5).
   *
   * 🔴 v2.0 에서는 **입력창에 칩을 꽂을 뿐**이었다. 그건 «히스토리 화면이
   * 생기기 전까지»의 임시 동작이라고 적어둔 것이고, 이제 그 화면이 생겼다.
   *
   * 멘션 삽입이 없어져도 아쉽지 않다 — **뷰 안에서 친 말은 자동으로 그 봇에게
   * 가므로**(§5) 칩을 꽂을 이유 자체가 사라진다. 방 전체에서 지목하고 싶으면
   * 입력창에서 `@` 를 치면 된다.
   */
  const nameBtn = r.participants.length > 1
    ? el(
        "button",
        {
          class: "link name-go",
          title: `${bot.name}와(과) 주고받은 것만 봅니다`,
          onclick: () => openBotView(bot.id),
        },
        bot.name,
        /*
         * ★ **들어갈 수 있다는 티** (v2.1).
         *
         * 🔴 이름이 본문색에 밑줄도 없어서 **눌러지는 티가 하나도 안 났다.**
         * 칩을 꽂던 시절에는 «있으면 편한 것»이라 괜찮았는데, 지금은 **봇별
         * 뷰의 유일한 입구**다 — 안 보이면 기능이 없는 것과 같다.
         *
         * 목록 행의 `›` 와 같은 뜻으로 읽힌다: **누르면 그 안으로 들어간다.**
         */
        icon("chevron-right"),
      )
    : el("span", { text: bot.name });
  nameCell.append(nameBtn);

  const head = el(
    "div",
    { class: "who" },
    nameCell,
    el("button", {
      class: "icon tiny",
      title: "이름 바꾸기",
      onclick: () => renameBotInline(r, bot, nameCell),
    }, icon("edit")),
    busy ? el("span", { class: "typing" }, el("i"), el("i"), el("i")) : null,
    usageChip(bot),
  );

  /*
   * ── 권한을 한 줄로 (§4.2.2)
   *
   * 🔴 «모델 · 에이전트» 줄은 뺐다. 바로 아래 칸 둘이 **같은 것을 고를 수
   * 있게** 보여주므로, 읽기 전용으로 한 번 더 적는 것은 줄만 늘린다.
   */
  const perm = el("div", { class: "sub perm" }, el("span", {
    text: policyLine(r, bot),
    title: "권한 모드 · 막혔을 때 누가 답하나 · 갈림길에서 물어보나",
  }));

  const rows: Kids = [head, perm];

  /*
   * ── 에이전트 — **모델 바로 위** (§4.2.1)
   *
   * 에이전트와 모델은 «이 봇이 무엇으로 도는가»로 같은 종류다. 다만 바꾸는
   * 것 자체는 **세션을 버리는 일**이라 바로 안 바꾼다 — 고르면 **모델 칸
   * 아래에** 무엇을 잃는지 펴고 거기서 확인받는다.
   */
  if (agentById.size > 1) {
    const pick = el("select") as HTMLSelectElement;
    for (const a of agentById.values()) {
      pick.append(el("option", { value: a.id, text: a.label, selected: a.id === showAgent }));
    }
    pick.addEventListener("change", () => {
      swapModel.delete(bot.id);   // 다른 에이전트의 모델 값은 여기서 뜻이 없다
      if (pick.value === bot.agentId) swapping.delete(bot.id);
      else {
        swapping.set(bot.id, pick.value);
        // 그 에이전트의 모델 목록이 없으면 지금 물어본다 — 오면 다시 그린다
        // 방에 없는 에이전트라 **방을 빼고** 묻는다 — 기본값이면 충분하다
        if (!optionsFor(pick.value)) post({ t: "needConfig", agentId: pick.value });
      }
      paintDrawer(r);
    });
    rows.push(el("div", { class: "field" }, el("label", { text: "에이전트" }), pick));
  }

  // ── 모델 — 그 에이전트가 목록을 줄 때만
  if (model?.values?.length) {
    const select = el("select") as HTMLSelectElement;
    /*
     * 🔴 **봇이 실제로 든 값이 먼저다.** `model.current` 는 방 단위 캐시라
     * 봇이 둘이면 둘 다 같은 값을 보여주고, 설정이 늦게 오면 낡은 값이 남는다.
     *
     * 갈아타는 중이면 그 값은 **이 에이전트의 것이 아니므로** 안 쓴다.
     */
    const now = pending
      ? (swapModel.get(bot.id) ?? model.current)
      : (bot.model ?? model.current);
    for (const v of model.values) {
      select.append(el("option", { value: v.id, text: v.name, selected: v.id === now }));
    }
    /*
     * ★ **갈아타는 중에도 고를 수 있다.**
     *
     * 🔴 처음에는 잠갔다 — «버릴 세션의 모델을 고치는 건 뜻이 없다»고 봐서다.
     * 그런데 **고르는 건 버릴 세션의 모델이 아니라 새 에이전트의 모델**이다.
     * 잠가두면 갈아탄 뒤에 서랍을 다시 열어 또 골라야 했다.
     *
     * 지금 고른 값은 **확정할 때 같이 걸린다**(`setAgent` 의 `model`).
     */
    select.addEventListener("change", () => {
      if (pending) { swapModel.set(bot.id, select.value); return; }
      post({ t: "setConfig", roomId: r.id, configId: model.configId, value: select.value, botId: bot.id });
    });
    rows.push(el("div", { class: "field" }, el("label", { text: labelOf(model) }), select));
  } else if (pending) {
    rows.push(el("div", { class: "sub", text: `${agentById.get(pending)?.label ?? pending}의 모델을 불러오는 중…` }));
  }

  // ── 갈아타면 무엇을 잃나 — **모델 칸 아래**
  if (pending) rows.push(el("div", { class: "swap-ask" }, ...swapWarning(r, bot, pending)));

  /*
   * ── 이 봇에 할 수 있는 것 + 역할
   *
   * 🔴 한 줄로 합쳤다. **역할 저장이 맨 오른쪽**이고 나머지는 왼쪽에 붙는다 —
   * 역할은 «지금 쓴 것을 확정»하는 것이라 입력 바로 다음이고, 압축·내보내기는
   * 그 봇에 대한 다른 일이다.
   *
   * 🔴 «권한 설정»은 뺐다. 입력창 옆 방패 버튼이 같은 화면을 여는데, 여기서
   * 한 번 더 열면 **같은 곳으로 가는 문이 둘**이 된다. 권한이 어떤지는 위의
   * 한 줄이 이미 말한다.
   */
  const acts: Kids = [];
  if (compactableBots.includes(bot.id)) {
    acts.push(
      el("button", {
        class: "ghost",
        text: "대화 압축",
        title: "지금까지를 요약으로 바꿔 컨텍스트를 비웁니다. 이 봇만.",
        onclick: () => (closeDrawer(), post({ t: "compact", roomId: r.id, botId: bot.id })),
      }),
    );
  }
  // 마지막 한 명은 코어가 막지만, 누르고 거절당하게 두지 않는다 — 애초에 안 보인다
  if (r.participants.length > 1) {
    acts.push(
      el("button", {
        // 🔴 **되돌릴 수 없다.** 세션이 끝나므로 색으로도 말한다
        class: "ghost danger",
        text: "내보내기",
        title: "이 봇과의 세션을 끝냅니다. 지금까지의 대화는 그대로 남습니다.",
        onclick: () => {
          closeDrawer();
          post({ t: "removeBot", roomId: r.id, botId: bot.id });
        },
      }),
    );
  }

  rows.push(el("div", { class: "info-row" }, el("span", { class: "dim", text: "역할" })));
  rows.push(roleEditor(r, bot, acts));

  // 세션 id는 **그 봇의 것**이다 — 방이 아니라 여기가 제자리다
  const sess = sessionRow(bot);
  if (sess) rows.push(sess);

  return el("div", { class: "drawer-bot" }, ...rows);
}

/** 갈아탈 에이전트를 고르는 중인 봇들 — `botId` → 고른 `agentId` */
const swapping = new Map<string, string>();
/** 그때 **같이 고른 모델** — `botId` → 새 에이전트의 모델 값 */
const swapModel = new Map<string, string>();

/**
 * 컨텍스트가 몇 퍼센트 찼나 — 모르면 `-1`.
 *
 * 말풍선 캐시 서명에 들어가므로 **거친 값이어야 한다.** 토큰 하나마다
 * 바뀌는 숫자를 넣으면 스트리밍 중에 말풍선을 계속 다시 만들게 된다.
 */
function usagePct(bot: BotInstance | undefined): number {
  const u = bot?.usage;
  return u?.contextUsed && u.contextSize ? Math.round((u.contextUsed / u.contextSize) * 100) : -1;
}

/**
 * 컨텍스트가 얼마나 찼나 — **이름 바로 옆**.
 *
 * 에이전트가 안 알려주면 **자리를 비운다.** 우리가 글자 수로 짐작하지 않는다 —
 * 토크나이저가 에이전트마다 다르고, 틀린 숫자는 없는 것보다 나쁘다(§0).
 */
function usageChip(bot: BotInstance | undefined): HTMLElement | null {
  const u = bot?.usage;
  if (!u?.contextUsed || !u.contextSize) return null;
  const pct = Math.round((u.contextUsed / u.contextSize) * 100);
  const tokens = `${u.contextUsed.toLocaleString()} / ${u.contextSize.toLocaleString()} 토큰`;
  // 바는 뺀다 — 숫자가 이미 정확한데 그림은 같은 말을 더 흐릿하게 할 뿐이다
  return el("span", {
    class: pct >= 90 ? "usage full" : "usage",
    title: `컨텍스트 ${tokens}`,
    text: `${pct}%`,
  });
}

// ── 스크롤 ──────────────────────────────────────────────────────────────

let stick = true;

/**
 * 방을 열 때는 **안 읽은 지점**, 없으면 맨 아래 (F6).
 *
 * 스트리밍 중에는 사용자가 위로 올려 읽고 있으면 따라가지 않는다.
 */
/**
 * **대화 목록 안에서만** 스크롤한다.
 *
 * 🔴 `scrollIntoView()`를 쓰면 안 된다. 그건 **조상 컨테이너까지 전부** 스크롤하는데,
 * `html`·`body`·`#app`이 `overflow: hidden`이라 스크롤바가 없을 뿐 **스크립트로는
 * 밀린다.** 목록에서 방으로 들어가는 슬라이드가 도는 동안 부르면, 화면이 아직
 * 오른쪽에 있으므로 브라우저가 **`body`를 옆으로 밀어** 대상을 보이게 만든다.
 * 전환이 끝나도 그 스크롤은 남아서 **화면이 어긋난 채 멈춘 것처럼** 보인다.
 *
 * 실제로 목록의 계보 배지(«…에서 분기»)를 눌렀을 때 그렇게 깨졌다.
 *
 * 그래서 **`list.scrollTop`만 건드린다.** 위치는 두 사각형의 차이로 잡는데,
 * 전환 중이어도 **둘 다 같은 만큼 밀려 있으므로 차이는 정확하다.**
 */
function scrollInside(list: HTMLElement, node: HTMLElement, place: "center" | "end"): void {
  const a = node.getBoundingClientRect();
  const b = list.getBoundingClientRect();
  const delta =
    place === "center"
      ? a.top - b.top - (list.clientHeight - a.height) / 2
      : a.bottom - b.bottom;
  list.scrollTop += delta;
}

function scrollIntoPlace(list: HTMLElement): void {
  const line = list.querySelector<HTMLElement>(".unread-line");
  if (line) {
    scrollInside(list, line, "center");
    return;
  }
  if (stick) list.scrollTop = list.scrollHeight;
}

// 파일 탐색기에서 끌어다 놓기 (I2)
screens.chat.addEventListener("dragover", (e) => {
  e.preventDefault();
  screens.chat.classList.add("dropping");
});
screens.chat.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) screens.chat.classList.remove("dropping");
});
screens.chat.addEventListener("drop", (e) => {
  e.preventDefault();
  screens.chat.classList.remove("dropping");
  if (!room) return;

  // VSCode 탐색기에서 끌고 오면 바이트가 아니라 **경로**가 온다.
  // 그대로 셀에 넘겨야 워크스페이스 안 파일로 알아보고 경로만 보낸다 (I4).
  const uris = e.dataTransfer?.getData("text/uri-list") ?? "";
  const paths = uris
    .split(/\r?\n/)
    .filter((line) => line.startsWith("file:"))
    .map((line) => decodeURIComponent(line.replace(/^file:\/\/\/?/, "")));
  if (paths.length > 0) {
    post({ t: "attachPaths", roomId: room.id, paths });
    return;
  }

  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length > 0) void attachFiles(room.id, files);
});

screens.chat.addEventListener(
  "scroll",
  (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("messages")) return;
    stick = t.scrollHeight - t.scrollTop - t.clientHeight < 60;
  },
  true,
);

// ── 확장에서 오는 것 ────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.t) {
    case "metas":
      metas = m.rooms;
      renderList();
      break;

    case "room": {
      const switching = room?.id !== m.room.id;
      // 🔴 큐는 **방마다**다. 안 비우면 옆 방의 «대기 중»이 여기 붙는다.
      if (switching) { queued = {}; reviews = []; }
      room = m.room;
      usage = m.room.usage;
      compactable = m.compactable;
      compactableBots = m.compactableBots ?? [];
      // 구분선은 방에 **들어올 때 한 번만** 잡는다. 스트리밍마다 다시 그으면 화면이 튄다.
      if (switching) {
        firstUnreadId = m.firstUnreadId;
        stick = true;
      }
      renderChat();

      // **방을 만들었으면 바로 들어간다.**
      // 생성 응답은 방 데이터만 주므로, 화면 전환은 여기서 해야 한다 —
      // 안 하면 만들기 화면에 그대로 서 있게 된다.
      if (stack[stack.length - 1] === "new") go("chat");
      if (jumpToMessageId) {
        const target = nodeCache.get(jumpToMessageId)?.node;
        jumpToMessageId = undefined;
        if (target) {
          if (chat?.list) scrollInside(chat.list, target, "center");
          target.classList.add("jumped");
          setTimeout(() => target.classList.remove("jumped"), 1600);
        }
      }
      break;
    }

    case "msg":
      // 다른 방의 응답이면 목록이 `metas`로 따로 갱신된다. 여기서는 무시.
      if (room?.id === m.roomId) {
        if (m.usage) usage = m.usage;
        applyDelta(m.message);
      }
      break;

    case "queued":
      if (room?.id === m.roomId) {
        queued = m.bots;
        renderChat();
      }
      break;

    case "reviews":
      if (room?.id === m.roomId) {
        reviews = m.list;
        renderChat();
      }
      break;

    case "clashes":
      if (room?.id === m.roomId) {
        clashes = m.list;
        // 띠만 다시 그린다 — 대화를 통째로 다시 그릴 이유가 없다
        if (chat) paintClashes(room);
      }
      break;

    case "status":
      statuses.set(m.roomId, m.status);
      if (room?.id === m.roomId) botStatus = m.bots ?? {};
      if (room?.id === m.roomId) renderChat();
      renderList();
      break;

    case "roomError":
    case "notice":
      if (room?.id === m.roomId) {
        const list = screens.chat.querySelector(".messages");
        if (list) {
          list.append(
            el(
              "div",
              { class: "msg system" },
              el("div", { class: `bubble${m.t === "roomError" ? " error" : ""}`, text: m.message }),
            ),
          );
          if (stick) list.scrollTop = list.scrollHeight;
        }
      }
      break;

    case "config": {
      const key = configKey(m.agentId, m.roomId, m.botId);
      configs.set(key, m.options);
      if (m.error) configErrors.set(key, m.error);
      else configErrors.delete(key);
      // 만들기 화면은 방이 없으므로 에이전트 몫만 받는다
      if (!m.roomId && stack[stack.length - 1] === "new") renderNew(m.error);
      // 서랍도 마찬가지다 — 열어둔 뒤에 온 설정이 갈 곳이 없으면
      // 모델 칸이 영영 비어 있거나 낡은 값을 보여준다
      if (room && m.roomId === room.id && screens.chat.querySelector(".drawer")) {
        paintDrawer(room);
      }
      // 열려 있는 권한 시트는 **늦게 온 설정을 받아 다시 그린다**
      if (room && m.roomId === room.id && screens.chat.querySelector(".sheet")) {
        paintPermissionSheet(room);
      }
      break;
    }

    case "ask":
      cards.push(m.card);
      if (room) renderChat();
      break;

    // 우리가 답하지 않았는데 끝난 경우 — 패널이 닫혔거나 에이전트가 물러섰다
    case "askResolved":
      if (dropCard(m.id) && room) renderChat();
      break;

    case "nav":
      if (m.screen === "new") openNewRoom();
      else go("list");
      break;

    case "attached":
      if (room?.id === m.roomId) {
        pending = [...pending, ...m.attachments];
        paintChips();
        if (m.rejected?.length) noticeInChat(m.rejected.join("\n"));
      }
      break;

    case "blobData": {
      blobCache.set(m.sha256, m.dataUri);
      const waiting = blobWaiters.get(m.sha256);
      blobWaiters.delete(m.sha256);
      for (const resolve of waiting ?? []) resolve(m.dataUri);
      break;
    }

    case "searchResults":
      // 타이핑이 앞서가 있으면 늦게 도착한 결과는 버린다
      if (m.query === filterText) {
        hits = m.hits;
        renderList();
      }
      break;

    case "caps":
      capsBy.set(m.agentId, {
        image: m.image, audio: m.audio, embeddedContext: m.embeddedContext, fork: m.fork,
      });
      break;

    case "cwdPicked": {
      draftCwd = m.path;
      const input = screens.new.querySelector<HTMLInputElement>("#new-cwd");
      if (input) {
        input.value = m.path;
        // 값만 넣으면 `input` 이벤트가 안 난다 — 폴더를 골랐는데도 «만들기»가
        // 잠긴 채로 남는다
        input.dispatchEvent(new Event("input"));
      }
      break;
    }

    case "createFailed":
      renderNew(m.message);
      break;
  }
});

// ── 키보드 ──────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    if (stack[stack.length - 1] === "chat") openFind();
    else screens.list.querySelector<HTMLInputElement>(".filter input")?.focus();
    return;
  }
  // 목록에서 F2로 바로 이름 바꾸기 (B4)
  if (e.key === "F2" && stack[stack.length - 1] === "list") {
    const first = filteredMetas()[0];
    if (first) {
      e.preventDefault();
      renameInList(first);
    }
    return;
  }

  if (e.key !== "Escape") return;
  if (screens.chat.querySelector(".find")) {
    closeFind();
    return;
  }
  const menu = screens.chat.querySelector(".menu") ?? roomsEl.querySelector(".menu");
  if (menu) {
    menu.remove();
    return;
  }

  // **도는 중이면 Esc는 먼저 그걸 멈춘다** (C6).
  // 응답을 받는 중에 방을 나가는 건 대개 의도가 아니다.
  if (stack[stack.length - 1] === "chat" && room) {
    const busy = statuses.get(room.id) ?? "idle";
    if (busy === "streaming" || busy === "tool" || busy === "waiting") {
      post({ t: "cancel", roomId: room.id });
      return;
    }
    leaveChat();
    return;
  }
  if (stack.length > 1) back();
});

// ── 자잘한 것 ───────────────────────────────────────────────────────────

function autoGrow(box: HTMLTextAreaElement): void {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
}

function statusText(s: RoomStatus): string {
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

function shortenPath(p: string): string {
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
function whoText(m: RoomMeta): string {
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
function whoTitle(m: RoomMeta): string {
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
function kindIcon(kind: RoomMeta["kind"]): string {
  return kind === "group" ? "organization" : kind === "shared" ? "sync" : "comment";
}

function when(ts: number): string {
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

// 첫 페인트는 HTML이 그렸다. 여기서 다시 그리는 건 이벤트를 붙이기 위해서다 —
// 같은 구조로 그리므로 화면은 바뀌지 않는다 (F8).
renderList();

// «새 대화방»으로 열렸으면 바로 만들기 화면으로. 패널이 꺼져 있던 상태에서는 `nav`가
// 이 스크립트보다 먼저 도착해 사라지므로, 부트 상태에서 받는다.
if (boot.screen === "new") openNewRoom();
