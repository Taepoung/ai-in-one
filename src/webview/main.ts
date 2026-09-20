import type {
  Attachment,
  BotInstance,
  ElicitationField,
  SearchHit,
  Message,
  Room,
  RoomMeta,
  RoomStatus,
  RoomUsage,
  ToolActivity,
} from "../core/types.js";
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
function configKey(agentId: string, roomId?: string): string {
  return roomId ? `room:${roomId}` : agentId;
}

function optionsFor(agentId: string, roomId?: string): ConfigOptionBrief[] | undefined {
  return configs.get(configKey(agentId, roomId));
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

let draftAgentId = boot.agents[0]?.id ?? "";
let draftCwd = "";

function openNewRoom(): void {
  draftCwd = "";
  renderNew();
  go("new");
  if (draftAgentId) post({ t: "needConfig", agentId: draftAgentId });
  setTimeout(() => screens.new.querySelector<HTMLInputElement>("#new-title")?.focus(), 240);
}

function renderNew(error?: string): void {
  const options = configs.get(draftAgentId);
  const picks = new Map<string, string | boolean>();

  const title = el("input", { type: "text", id: "new-title", placeholder: "비우면 «새 대화»" });
  const role = el("textarea", {
    id: "new-role",
    placeholder: "예) 너는 코드 리뷰어다. 구현하지 말고 지적만 해라.",
  });
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

  create.addEventListener("click", () => {
    if (needsFolder()) return;
    create.disabled = true;
    create.textContent = "여는 중…";
    post({
      t: "createRoom",
      agentId: draftAgentId,
      title: title.value.trim(),
      ...(cwdInput.value.trim() ? { cwd: cwdInput.value.trim() } : {}),
      ...(role.value.trim() ? { rolePrompt: role.value.trim() } : {}),
      ...(picks.size > 0 ? { configValues: Object.fromEntries(picks) } : {}),
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
      el(
        "fieldset",
        { class: "bot" },
        el("legend", { text: "봇" }),
        el(
          "div",
          { class: "field" },
          el("label", { text: "에이전트" }),
          el(
            "div",
            { class: "agents" },
            ...boot.agents.map((a) => agentButton(a)),
          ),
        ),
        // 에이전트를 고른 뒤에 채워진다. 미리 받아둬서 기다림이 없다 (B15)
        ...configFields(options, picks),
        el("div", { class: "field" }, el("label", { text: "역할 (선택)" }), role),
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

function agentButton(a: AgentBrief): HTMLElement {
  return el(
    "button",
    {
      class: "agent",
      "aria-pressed": a.id === draftAgentId,
      onclick: () => {
        if (a.id === draftAgentId) return;
        draftAgentId = a.id;
        renderNew();
        // 이 에이전트의 모델 목록이 아직 없으면 지금 받아온다
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
  post({ t: "open", roomId });
  go("chat");
}

function leaveChat(): void {
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
  list: HTMLElement;
  status: HTMLElement;
  chips: HTMLElement;
  box: HTMLTextAreaElement;
  perm: HTMLElement;
}
let chat: ChatEls | null = null;

function renderChat(): void {
  const r = room;
  if (!r) return;
  if (chat?.roomId !== r.id) mountChat(r);
  paintChat(r);
}

function mountChat(r: Room): void {
  // 방이 바뀌면 이전 방의 말풍선을 들고 있을 이유가 없다
  nodeCache.clear();

  const head = el("header", { class: "bar" });
  const list = el("div", { class: "messages" });
  const status = el("div", { class: "status" });
  const box = el("textarea", { rows: 1, placeholder: "메시지 입력…" }) as HTMLTextAreaElement;
  const perm = el("button", { class: "icon perm" }, icon("shield"));
  const chips = el("div", { class: "chips", hidden: true });

  box.value = r.draft ?? "";
  autoGrow(box);

  const send = () => {
    const text = box.value.trim();
    // 첨부만 보내는 것도 메신저에서는 자연스럽다
    if (!text && pending.length === 0) return;
    const attachments = pending;
    pending = [];
    paintChips();
    box.value = "";
    autoGrow(box);
    post({
      t: "send",
      roomId: r.id,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
  };

  box.addEventListener("input", () => {
    autoGrow(box);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => post({ t: "draft", roomId: r.id, text: box.value }), 400);
  });
  box.addEventListener("keydown", (e) => {
    // **한글 입력 중의 Enter는 조합 확정이다.** 여기서 보내면 글자가 잘린다.
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    send();
  });

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
  perm.addEventListener("click", () => togglePermissionSheet(r));

  replace(
    screens.chat,
    head,
    list,
    status,
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

  chat = { roomId: r.id, head, list, status, chips, box, perm };
  pending = [];
  paintChips();
  post({ t: "needCaps", agentId: r.participants[0]?.agentId ?? "" });
  // 권한 시트가 봇마다 모드를 보여주므로 **참여자 전부** 필요하다 (캐시가 있으면 즉시 온다)
  for (const agentId of new Set(r.participants.map((b) => b.agentId))) {
    post({ t: "needConfig", agentId, roomId: r.id });
  }
  // 방에 **들어올 때 한 번만** 자리를 잡는다. 갱신마다 하면 화면이 계속 끌려간다.
  paintChat(r);
  scrollIntoPlace(list);
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

  // 이름을 고치는 중이면 헤더를 건드리지 않는다 — 입력이 날아간다
  if (!c.head.querySelector("input")) {
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
        { class: "icon", title: `참여자 ${r.participants.length}`, onclick: () => toggleDrawer(r) },
        icon("organization"),
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

  const atBottom = stick;
  const nodes: Node[] = [];
  let day = "";
  /** 바로 위에 붙어 있는 메시지. 선이 끼어들면 끊긴다 */
  let above: Message | undefined;

  for (const m of r.messages) {
    const key = dayKey(m.createdAt);
    let broken = false;
    if (key !== day) {
      nodes.push(dayLine(m.createdAt));
      day = key;
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
  // 카드는 대화 아래에 붙는다 — 답할 때까지 눈에 보여야 한다
  for (const card of cards.filter((x) => x.roomId === r.id || x.roomId === "")) {
    nodes.push(cardNode(card));
  }
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
            `이전 세션이 끊겨 에이전트는 위 대화를 모릅니다. ` +
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
  const many = r.participants.length > 1;
  const busy = r.participants.filter((b) => {
    const s = botStatus[b.id];
    return s !== undefined && s !== "idle" && s !== "error";
  });

  const text =
    many && busy.length > 0
      ? busy
          .map((b) => `${agentById.get(b.agentId)?.label ?? b.name} ${statusText(botStatus[b.id]!)}`)
          .join(" · ")
      : statusText(status);

  const kids: Node[] = [
    el("span", { class: "typing" }, el("i"), el("i"), el("i")),
    el("span", { text }),
  ];
  // 중단은 턴이 도는 동안에만 의미가 있다
  if (status === "streaming" || status === "tool" || status === "waiting") {
    kids.push(
      el("button", {
        class: "stop",
        text: "중단",
        onclick: () => post({ t: "cancel", roomId: r.id }),
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
    // 봇 수가 바뀌면 «이 봇만 중단»이 생기거나 사라진다
    manyBots() ? "m" : "",
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
    return el("div", { class: "msg system" }, el("div", { class: "bubble", text: m.text }));
  }

  const node = el("div", {
    class: `msg ${m.role}${m.sendFailed ? " failed" : ""}${grouped ? " grouped" : ""}`,
  });

  // 우클릭으로 그 지점에서 분기한다 (D2)
  node.addEventListener("contextmenu", (e) => openMessageMenu(e, m));

  // 이어지는 말에는 이름을 다시 쓰지 않는다 — 같은 사람이 계속 말하는 중이다
  if (m.role === "agent" && !grouped) {
    node.append(
      el(
        "div",
        { class: "who" },
        el("span", { class: "dot", style: { background: agent?.color ?? "#888" } }),
        agent?.label ?? "에이전트",
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
    // 타이핑 표시와 시각은 **마지막 조각에만** — 중간에 붙으면 말이 끝난 것처럼 보인다
    if (m.streaming && part.last) {
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
    const head: Kids = [
      icon(permIcon(t.kind)),
      ` ${t.title}`,
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

  return el(
    "details",
    { class: "tool" },
    el("summary", {}, icon("chevron-right"), ` ${label}`),
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
let caps: { image: boolean; audio: boolean; embeddedContext: boolean; fork: "yes" | "no" | "unknown" } =
  { image: true, audio: true, embeddedContext: true, fork: "unknown" };

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
    if ((isImage && !caps.image) || (isAudio && !caps.audio)) {
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

function cardNode(card: AskCard): HTMLElement {
  const node = el("div", { class: "card" });

  /**
   * 답하면 **카드를 치운다.**
   *
   * 🔴 예전에는 «답함» 표시만 붙이고 목록에 남겨뒀는데, 그러면 승인할 때마다
   * 대화 아래에 카드가 **한 장씩 쌓인다.** 카드는 «지금 답해야 할 것»이고
   * 답하고 나면 그건 지나간 일이다.
   *
   * **기록이 사라지는 게 아니다** — 무엇을 허용·거부했는지는 D3가 대화에
   * 시스템 메시지로 남긴다. 카드는 그 기록의 자리가 아니다.
   */
  const answer = (send: () => void) => {
    if (!dropCard(card.id)) return;
    send();
    renderChat();
  };

  if (card.kind === "permission") {
    const r = card.req;
    const body = el("div", { class: "card-body" });

    // **무엇을 승인하는지 보여준다** (D1). 제목만으로는 `rm -rf`와 `ls`가 같아 보인다.
    if (r.command) {
      body.append(el("pre", { class: "perm-cmd" }, el("code", { text: r.command })));
    }
    for (const p of r.paths ?? []) {
      body.append(
        el(
          "button",
          {
            class: "file",
            text: `${shortenPath(p)}`,
            title: "에디터에서 열기",
            onclick: () => post({ t: "openFile", path: p }),
          },
        ),
      );
    }
    if (r.diff) {
      body.append(
        el(
          "details",
          { class: "tool" },
          el("summary", {}, icon("diff"), " 바뀔 내용 보기"),
          el("pre", { class: "preview" }, el("code", { text: r.diff.newText })),
        ),
      );
    }

    node.append(
      el("div", { class: "card-title" }, icon(permIcon(r.kind)), ` ${r.title}`),
      body,
      el(
        "div",
        { class: "card-actions" },
        ...r.options.map((o) =>
          el("button", {
            class: o.kind === "allow_always" || o.kind === "allow_once" ? "primary" : "",
            text: o.name,
            onclick: () =>
              answer(() =>
                post({ t: "answer", id: card.id, answer: { kind: "permission", optionId: o.optionId } }),
              ),
          }),
        ),
      ),
    );
    return node;
  }

  // 질문 — URL 모드는 링크 버튼 하나면 된다
  if (card.req.url) {
    node.append(
      el("div", { class: "card-title" }, icon("link-external"), " 에이전트가 링크 열기를 요청합니다"),
      el("div", { class: "dim", text: card.req.url }),
      el(
        "div",
        { class: "card-actions" },
        el("button", {
          class: "primary",
          text: "열기",
          onclick: () =>
            answer(() =>
              post({
                t: "answer",
                id: card.id,
                answer: { kind: "elicitation", outcome: "accepted", values: {} },
              }),
            ),
        }),
        el("button", {
          text: "거절",
          onclick: () =>
            answer(() =>
              post({ t: "answer", id: card.id, answer: { kind: "elicitation", outcome: "declined" } }),
            ),
        }),
      ),
    );
    return node;
  }

  const inputs = new Map<string, () => unknown>();
  const body = el("div", { class: "card-body" });
  for (const f of card.req.fields) {
    const row = fieldRow(f, inputs, false);
    if (row) body.append(row);
  }

  node.append(
    el("div", { class: "card-title" }, icon("question"), " 에이전트가 묻습니다"),
    body,
    el(
      "div",
      { class: "card-actions" },
      el("button", {
        class: "primary",
        text: "확인",
        onclick: () =>
          answer(() => {
            const values: Record<string, unknown> = {};
            for (const [name, read] of inputs) values[name] = read();
            post({
              t: "answer",
              id: card.id,
              answer: { kind: "elicitation", outcome: "accepted", values },
            });
          }),
      }),
      el("button", {
        text: "건너뛰기",
        onclick: () =>
          answer(() =>
            post({ t: "answer", id: card.id, answer: { kind: "elicitation", outcome: "declined" } }),
          ),
      }),
    ),
  );
  return node;
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
  const open = screens.chat.querySelector(".sheet");
  if (open) {
    open.remove();
    return;
  }
  paintPermissionSheet(r);
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
  for (const agentId of new Set(r.participants.map((b) => b.agentId))) {
    if (!optionsFor(agentId, r.id)) post({ t: "needConfig", agentId, roomId: r.id });
  }

  const sheet = el(
    "div",
    { class: "sheet" },
    el(
      "div",
      { class: "sheet-bar" },
      el("span", {}, icon("shield"), " 권한 설정"),
      el(
        "button",
        { class: "icon", title: "닫기", onclick: () => sheet.remove() },
        icon("close"),
      ),
    ),
    ...r.participants.map((bot) => botPolicyBlock(r, bot)),
    sharedMemoryRow(r),
  );
  screens.chat.querySelector(".sheet")?.replaceWith(sheet);
  if (!sheet.isConnected) screens.chat.append(sheet);
}

/** 봇 하나의 설정 — 권한 모드 · 승인 주체 · 질문 */
function botPolicyBlock(r: Room, bot: BotInstance): HTMLElement {
  const agent = agentById.get(bot.agentId);
  const options = optionsFor(bot.agentId, r.id) ?? [];
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
      hint.hidden = hint.textContent === "";
    };
    select.addEventListener("change", () => {
      paint();
      post({ t: "setConfig", roomId: r.id, configId: mode.configId, value: select.value });
    });
    paint();
    rows.push(el("div", { class: "field" }, el("label", { text: "권한 모드" }), select, hint));
  } else {
    const err = configErrors.get(configKey(bot.agentId, r.id));
    rows.push(
      el("p", {
        class: err ? "warn" : "dim",
        text: err
          ? err
          : optionsFor(bot.agentId, r.id) !== undefined
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
            configs.delete(configKey(bot.agentId, r.id));
            configErrors.delete(configKey(bot.agentId, r.id));
            // 다시 그리면서 «불러오는 중»으로 바뀌고, 그 김에 요청도 나간다
            paintPermissionSheet(r);
          },
        }),
      );
    }
  }

  // ── 승인 주체 — 물어봐야 할 때 누구에게
  const others = r.participants.filter((b) => b.id !== bot.id);
  const who = el("select") as HTMLSelectElement;
  who.append(el("option", { value: "user", text: "사용자", selected: bot.approver.kind === "user" }));
  for (const o of others) {
    who.append(
      el("option", {
        value: o.id,
        text: o.name,
        selected: bot.approver.kind === "bot" && bot.approver.botId === o.id,
      }),
    );
  }
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
      others.length === 0
        ? el("span", { class: "dim", text: "방에 다른 봇이 있으면 그 봇에게 맡길 수 있습니다." })
        : null,
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
      el("span", { class: "dim", text: "에이전트가 갈림길에서 물어볼 때." }),
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
    ...rows,
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

function fieldRow(
  f: ElicitationField,
  inputs: Map<string, () => unknown>,
  disabled: boolean,
): HTMLElement | null {
  // 스펙이 확장 가능하다. 모르는 타입이 오면 건너뛰지 말고 사실을 보여준다 (D4)
  if (f.type === "unsupported") {
    return el("div", { class: "dim", text: `${f.label}: 지원하지 않는 입력입니다` });
  }

  const label = el("label", { text: f.label + (f.required ? " *" : "") });

  if (f.type === "boolean") {
    const box = el("input", { type: "checkbox", disabled }) as HTMLInputElement;
    inputs.set(f.name, () => box.checked);
    return el("div", { class: "field" }, el("label", {}, box, ` ${f.label}`));
  }

  if (f.type === "select" || f.type === "multiselect") {
    const sel = el("select", { disabled, multiple: f.type === "multiselect" }) as HTMLSelectElement;
    for (const o of f.options ?? []) sel.append(el("option", { value: o.value, text: o.label }));
    inputs.set(f.name, () =>
      f.type === "multiselect"
        ? [...sel.selectedOptions].map((o) => o.value)
        : sel.value,
    );
    return el("div", { class: "field" }, label, sel);
  }

  const input = el("input", {
    type: f.type === "string" ? "text" : "number",
    disabled,
  }) as HTMLInputElement;
  inputs.set(f.name, () => (f.type === "string" ? input.value : Number(input.value)));
  return el(
    "div",
    { class: "field" },
    label,
    input,
    f.description ? el("span", { class: "dim", text: f.description }) : null,
  );
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
      el("button", { text: "참여자 보기", onclick: () => (renderChat(), paintDrawer(r)) }),
      el("button", { text: "닫기", onclick: () => renderChat() }),
    ),
  );

  chat?.list.append(card);
  if (chat?.list) scrollInside(chat.list, card, "end");
}

/**
 * 역할 편집기 — **봇마다**.
 *
 * 역할은 첫 프롬프트 앞에 붙는 프리픽스라(B3) 세션에 갇힌다 — 즉 **봇의
 * 것이다.** 실측해보니 같은 폴더의 다른 세션으로 새지 않았다(§13.2).
 * 기억과 달리 역할은 봇마다 나눠 줄 수 있다 — 그래서 여기 놓는다.
 */
function roleEditor(r: Room, bot: BotInstance): HTMLElement {
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
  return el("div", { class: "role-edit" }, box, el("div", { class: "card-actions" }, save));
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
function forkHeadButton(r: Room): HTMLElement {
  const busy = isBusyHere(r);
  const empty = !r.messages.some((m) => m.role !== "system");
  const why = busy
    ? "응답이 끝난 뒤에 분기할 수 있습니다"
    : empty
      ? "아직 나눌 대화가 없습니다"
      : "여기서 분기";
  return el("button", {
    class: "icon",
    title: why,
    disabled: busy || empty,
    onclick: () => askFork(r),
  }, icon("git-branch"));
}

/**
 * 분기 물어보기 (D1).
 *
 * ⚠️ **파일은 갈라지지 않는다.** 여기가 그걸 말할 유일한 자리다 — 분기 방은
 * «평범한 새 방»이라 상단 배너를 두지 않기로 했으므로(D2), 고르는 순간에
 * 말하지 않으면 영영 말하지 않는 셈이 된다. (방 정보에도 남긴다.)
 */
function askFork(r: Room, atMessageId?: string): void {
  const at = atMessageId ? r.messages.findIndex((m) => m.id === atMessageId) : r.messages.length - 1;
  const inherited = r.messages.slice(0, at + 1).filter((m) => m.role !== "system").length;

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
  const cannot = caps.fork === "no";
  const lossy = past || cannot;
  const title = el("input", {
    type: "text",
    placeholder: `비우면 «${r.title.replace(/\s*\(\d+\)\s*$/, "")} (2)»`,
  }) as HTMLInputElement;

  const go = (fallback?: "refeed" | "fresh") => {
    post({
      t: "fork",
      roomId: r.id,
      ...(atMessageId ? { atMessageId } : {}),
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
      ...(fallback ? { fallback } : {}),
    });
    renderChat();
  };

  const node = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title" }, icon("git-branch"), " 여기서 분기"),
    el("div", {
      class: "dim",
      text:
        `지금까지의 대화 ${inherited}개를 물려받아 새 방을 만듭니다. ` +
        `이 방은 그대로 남습니다.`,
    }),
    el("div", { class: "card-body" }, title),
    // ★ 잎는 것을 **누르기 전에** — 위 주석 참조
    lossy
      ? el(
          "div",
          { class: "warn-row" },
          icon("warning"),
          ` 계획과 파일 기억은 물려받지 못합니다 — 대화만 글로 옮깁니다. ` +
            (past
              ? "과거 지점은 세션을 복제할 수 없습니다."
              : `${agentById.get(r.participants[0]?.agentId ?? "")?.label ?? "이 에이전트"}는 세션 분기를 지원하지 않습니다."`) +
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

  // ── 분기 — 헤더 버튼이 못 하는 것: **이 지점에서**
  if (kids.length > 0) kids.push(el("hr"));
  kids.push(
    el("button", {
      text: "이 메시지에서 분기",
      title: "여기까지를 물려받은 새 방을 만듭니다",
      onclick: () => {
        close();
        askFork(r, m.id);
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
  for (const agentId of new Set(r.participants.map((b) => b.agentId))) {
    if (!optionsFor(agentId, r.id)) post({ t: "needConfig", agentId, roomId: r.id });
  }

  const veil = el("div", { class: "drawer-veil", onclick: () => closeDrawer() });
  const drawer = el(
    "div",
    { class: "drawer" },
    el(
      "div",
      { class: "sheet-bar" },
      el("span", {}, icon("organization"), ` 참여자 ${r.participants.length}`),
      el("button", { class: "icon", title: "닫기", onclick: () => closeDrawer() }, icon("close")),
    ),
    ...r.participants.map((bot) => drawerBot(r, bot)),
    sharedMemoryRow(r),
  );

  const was = screens.chat.querySelector(".drawer");
  if (was) {
    was.replaceWith(drawer);
  } else {
    screens.chat.append(veil, drawer);
  }
}

/**
 * 봇 한 줄.
 *
 * **이름 옆이 사용량 자리다.** 컨텍스트는 세션마다 차고 세션은 봇 단위라(B1),
 * 방에 하나로 걸어두면 봇이 둘일 때 누구 숫자인지 알 수 없다 — 실제로 나중에
 * 온 봇이 앞 봇의 숫자를 덮어쓰고 있었다.
 */
function drawerBot(r: Room, bot: BotInstance): HTMLElement {
  const agent = agentById.get(bot.agentId);
  const options = optionsFor(bot.agentId, r.id) ?? [];
  const model = options.find((o) => o.category === "model");
  const status = botStatus[bot.id] ?? "idle";
  const busy = status !== "idle" && status !== "error";

  // ── 첫 줄: 색 점 · 이름 · 작업 중 · 사용량
  const head = el(
    "div",
    { class: "who" },
    el("span", { class: "dot", style: { background: agent?.color ?? "#888" } }),
    el("span", { class: "name", text: bot.name }),
    busy ? el("span", { class: "typing" }, el("i"), el("i"), el("i")) : null,
    usageChip(bot),
  );

  // ── 둘째 줄: 모델(주) · 에이전트(부) — 모델이 앞에 온다 (§4.2.1)
  const sub = el("div", { class: "sub" }, el("span", {
    text: bot.modelLabel ? `${bot.modelLabel} · ${agent?.label ?? "?"}` : (agent?.label ?? "?"),
  }));

  const rows: Kids = [head, sub];

  // ── 모델 바꾸기 — 에이전트가 목록을 줄 때만
  if (model?.values?.length) {
    const select = el("select") as HTMLSelectElement;
    for (const v of model.values) {
      select.append(el("option", { value: v.id, text: v.name, selected: v.id === model.current }));
    }
    select.addEventListener("change", () =>
      post({ t: "setConfig", roomId: r.id, configId: model.configId, value: select.value }),
    );
    rows.push(el("div", { class: "field" }, el("label", { text: labelOf(model) }), select));
  }

  // ── 이 봇에 할 수 있는 것
  const acts: Kids = [
    el("button", {
      class: "ghost",
      text: "권한 설정",
      title: "입력창 옆 방패 버튼과 같은 화면입니다",
      onclick: () => (closeDrawer(), paintPermissionSheet(r)),
    }),
  ];
  // 압축 — **이 봇이** 명령을 광고할 때만 (에이전트가 섞인 방에서는 한 쪽만 안다)
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
  // 🔴 **중단은 여기 안 둔다.** 흔드는 말풍선 아래에 이미 «…만 중단»이 있고,
  // 그것이 본래 자리다 — 멈추려는 순간 보는 것은 그 말풍선이지 서랍이 아니다.
  // 서랍을 열고 봇을 찾는 사이에 답이 끝나면 버튼만 헛돌게 된다.
  rows.push(el("div", { class: "acts" }, ...acts));
  // 세션 id는 **그 봇의 것**이다 — 방이 아니라 여기가 제자리다
  const sess = sessionRow(bot);
  if (sess) rows.push(sess);
  rows.push(el("div", { class: "info-row" }, el("span", { class: "dim", text: "역할" })));
  rows.push(roleEditor(r, bot));

  return el("div", { class: "drawer-bot" }, ...rows);
}

/**
 * 컨텍스트가 얼마나 찼나 — **이름 바로 옆**.
 *
 * 에이전트가 안 알려주면 **자리를 비운다.** 우리가 글자 수로 짐작하지 않는다 —
 * 토크나이저가 에이전트마다 다르고, 틀린 숫자는 없는 것보다 나쁘다(§0).
 */
function usageChip(bot: BotInstance): HTMLElement | null {
  const u = bot.usage;
  if (!u?.contextUsed || !u.contextSize) return null;
  const pct = Math.round((u.contextUsed / u.contextSize) * 100);
  const tokens = `${u.contextUsed.toLocaleString()} / ${u.contextSize.toLocaleString()} 토큰`;
  return el(
    "span",
    { class: pct >= 90 ? "usage full" : "usage", title: `컨텍스트 ${tokens}` },
    el("span", { class: "bar" }, el("i", { style: { width: `${Math.min(pct, 100)}%` } })),
    el("span", { text: `${pct}%` }),
  );
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
      const key = configKey(m.agentId, m.roomId);
      configs.set(key, m.options);
      if (m.error) configErrors.set(key, m.error);
      else configErrors.delete(key);
      // 만들기 화면은 방이 없으므로 에이전트 몫만 받는다
      if (!m.roomId && stack[stack.length - 1] === "new") renderNew(m.error);
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
      if (room?.participants[0]?.agentId === m.agentId) {
        caps = { image: m.image, audio: m.audio, embeddedContext: m.embeddedContext, fork: m.fork };
      }
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
function whoText(m: RoomMeta): string {
  return m.agentIds
    .map((id, i) => {
      const label = agentById.get(id)?.label ?? id;
      const model = m.models?.[i];
      return model ? `${label} · ${model}` : label;
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
