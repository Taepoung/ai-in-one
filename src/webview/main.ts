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
  WaitItem,
  ToolActivity,
  Clash,
  AgentQuota,
  QuotaLine,
} from "../core/types.js";
import { EVERYONE, parseCompose, type ComposeToken } from "../core/mentions.js";
import type { McpState } from "../core/mcpServer.js";
// 🔴 **규칙을 베끼지 않는다.** 화면이 «이렇게 됩니다»라고 약속한 이름과
//    실제로 붙는 이름이 다르면, 그 약속은 없느니만 못하다.
import {
  uniqueBotName,
  inBotView,
  botLabel,
  botColor,
  BOT_COLORS,
  USER_CHIP,
  type JoinFail,
  type JoinStep,
} from "../core/types.js";
import type {
  AgentBrief,
  AskCard,
  AuthRow,
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

/**
 * **줄 서 있는 심사들** (§4.2.2) — 지금 보는 방의 것만.
 *
 * 심사 봇의 세션은 하나라 직렬이다(B1). 기다리는 동안 **요청한 봇의 턴은
 * 얼어 있으므로**, 안 보이면 «아무 일도 안 일어난다»가 된다.
 */
let reviews: ReviewWait[] = [];
/**
 * ★ **봇마다 들고 있는 대기** (§5-M) — 지금 보는 방의 것만.
 *
 * 🔴 `reviews` 와 겹쳐 보이지만 다른 물건이다. 저쪽은 «**얼어 있는 봇**이
 * 누구를 기다리나»라 채팅에 띠로 서고, 이쪽은 «**이 봇 앞에** 무엇이
 * 서 있나»라 봇마다 모인다 — 봇이 건 말은 아무도 안 얼리므로 저쪽에는
 * 아예 안 뜬다.
 */
let waiting: WaitItem[] = [];
/** 대기 화면이 **누구 것인가** — 그 봇이 방을 떠나면 자리가 사라진다 */
let waitBotId: string | null = null;
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

/**
 * ★ **봇끼리 부르는 길이 어느 칸인가** (v3.0 2-F).
 *
 * 방마다가 아니라 **창마다**다 — 서버가 창에 하나이기 때문이다.
 */
let mcpAt: McpState = { at: "off" };

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

/**
 * 🔴 **한 번 실패하면 영영 안 물었다** (2026-10-07).
 *
 * 사용자: *"안티그래비티 아직도 방 만들때, 모델 목록 안나옴"*. 재보니 제품
 * 코드로는 11개가 멀쩡히 온다 — **19.5초 걸려서** 그렇지.
 *
 * 범인은 조르는 조건이었다. 설정은 패널을 만들 때 **한 번** 밀어주는 게
 * 전부고(`warmConfigs`), 화면은 `configs.has()` 가 거짓일 때만 다시 졸랐다.
 * 그런데 **실패도 빈 배열로 들어간다** — 그러면 `has()` 가 참이라 다시는 안
 * 묻는다. 로그인 전에 그 한 번이 지나가면 **패널을 닫았다 열기 전까지** 비어
 * 있고, 화면은 *"이 에이전트는 고를 수 있는 모델을 알려주지 않습니다"* 라는
 * **틀린 말**을 한다 — 못 물어본 것이지 저쪽이 안 알려준 게 아니다.
 *
 * 그래서 «없으면» 이 아니라 **«없거나 틀어졌으면»** 조른다. 조르면서 들고 있던
 * 것을 지워 «불러오는 중…» 으로 되돌린다.
 */
function askConfig(agentId: string): void {
  const key = configKey(agentId);
  if (configs.has(key) && !configErrors.has(key)) return;
  configs.delete(key);
  configErrors.delete(key);
  post({ t: "needConfig", agentId });
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

/**
 * ★ **지금 쓸 수 있는 에이전트** (2026-10-01) — `docs/core/install.md`.
 *
 * 안 받은 것은 방 만들기 목록에 안 뜨고, 이미 쓰던 방은 막힌다.
 * `boot` 으로 시작해서 설정 화면이 줄 `agents` 로 갱신된다 — 받자마자
 * 목록에 뜨게 하려는 것이다.
 */
const agentAvail = new Set(
  boot.agents.filter((a) => a.available !== false).map((a) => a.id),
);

/** 그 봇이 지금 돌 수 없는 상태인가 */
function agentGone(b: BotInstance): boolean {
  return !agentAvail.has(b.agentId);
}

// ── 화면 전환 (F8) ──────────────────────────────────────────────────────

type ScreenName =
  | "list" | "new" | "chat" | "fix" | "perm" | "bots" | "invite" | "agents"
  /** 그 봇 앞에 서 있는 것들 — 참여자 서랍 «위에» 얹는다 (§5-M) */
  | "wait"
  /** 창이 뜨자마자 로그인을 확인하는 자리 (2026-10-13) */
  | "auth"
  /** 방에 붙는 동안 서는 자리 (2026-10-13) */
  | "joining";

/**
 * 화면 칸을 찾는다. **없으면 만든다.**
 *
 * 🔴 `getElementById(...)!` 로만 두었더니 **화면을 하나 더할 때마다 열여섯 곳이
 * 깨졌다** — 호스트 HTML(`chatPanel.ts`)과 검사마다 들고 있는 셸이 전부 그
 * 목록을 따로 적고 있었기 때문이다. 하나만 빠져도 `null.classList` 로 터진다.
 *
 * **화면 목록은 웹뷰 안 사정이다.** 껍데기가 그걸 미리 알아야 할 이유가 없다.
 */
function screenEl(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const made = document.createElement("section");
  made.className = "screen";
  made.id = id;
  (document.getElementById("app") ?? document.body).append(made);
  return made;
}

const screens: Record<ScreenName, HTMLElement> = {
  list: screenEl("screen-list"),
  /** 에이전트를 받고·지우고·로그인하는 자리 (`docs/core/install.md`) */
  agents: screenEl("screen-agents"),
  new: screenEl("screen-new"),
  chat: screenEl("screen-chat"),
  /**
   * ★ **고른 모델이 없어졌을 때 막아서서 고르게 하는 자리** (2026-09-30).
   *
   * 띄로 띄우다가 전체화면으로 옮겼다. 띄는 **지나치기 쉬운데**, 이건
   * 지나치면 안 되는 일이다 — 대체된 모델은 **계열째 다를 수 있고**
   * (luna→terra, sonnet→opus 실측), 모르고 쓰면 답이 왜 달라졌는지를
   * 끝내 모른다.
   */
  fix: screenEl("screen-fix"),
  /**
   * ★ **권한·참여자를 시트·서랍에서 화면으로 뺀다** (2026-09-30).
   *
   * 둘 다 **덮개를 깔고 띄우는** 물건이었다. 그런데 안에 들어 있는 것이
   * «잠깐만 보고 닫는 것» 이 아니다 — 봇마다 권한 모드·승인 주체·모델·
   * 역할·색까지 들어 있어서 **세로로 길고**, 좌우로도 좀다.
   *
   * 화면으로 빼면 넓게 쓰고, 뒤로가기 하나로 나간다.
   */
  perm: screenEl("screen-perm"),
  bots: screenEl("screen-bots"),
  /**
   * ★ **대기는 서랍에서 펼치지 않고 화면으로 뺀다** (§5-M, 2026-10-14).
   *
   * 사용자: *"엄청 쌓이면서는 봇별로 엄청 많아지면 정보보기도 어렵고
   * 지저분해서 좀 힘들듯"*. 🔴 서랍 한 줄은 **봇 하나**인데, 한 봇의 대기가
   * 열 줄이면 **다른 봇이 화면 밖으로 밀린다** — 훑는 자리가 훑을 수 없게
   * 된다. 서랍에 두는 것은 **수 하나**고, 그게 곧 «여기 눌러볼 것이 있다»다.
   */
  wait: screenEl("screen-wait"),
  /**
   * ★ **봇 부르기도 화면** (2026-09-30).
   *
   * 대화 목록 안에 카드로 붙어 있었다. 🔴 **스크롤에 밀린다** — 에이전트·이름·
   * 색·모델·역할을 고르는 동안 새 말이 오면 카드가 위로 떠내려간다.
   *
   * **참여자 화면 «위에» 얹는다.** 부르고 나면 뒤로가기 하나로 참여자로
   * 돌아오고, 거기 새 봇이 늘어 있다 — 온 길과 돌아가는 길이 같다.
   */
  invite: screenEl("screen-invite"),
  /**
   * ★ **로그인 확인 — 창이 뜨는 첫 화면** (2026-10-13).
   *
   * 🔴 우리 짐작은 «자격 파일이 있나» 뿐이라 **만료 · 다른 데서 로그아웃 ·
   * 철회**를 하나도 못 본다. 그걸 모른 채 들어가면 긴 글을 다 쓰고 **보낼
   * 때** 막히고, 그때 뜨는 것은 CLI 원문이다.
   */
  auth: screenEl("screen-auth"),
  /**
   * ★ **방에 붙는 동안** (2026-10-13).
   *
   * 🔴 여태 채팅이 **바로** 열리고 뒤에서 붙었다. 그래서 셋이 어긋났다:
   *
   * ```
   * 쓸 수 있는 것처럼 보인다   아직 세션이 없는데 입력창이 열려 있다
   * 실패가 기록에 박힌다       「세션을 열지 못했습니다」 가 말풍선이 된다
   * 보다가 끌려간다            modelGone 이 붙으면 fix 로 넘어간다
   * ```
   *
   * 붙는 동안을 **따로 세우면** 셋이 한꺼번에 사라진다. 지난 대화를 읽으려고
   * 들어온 사람에게는 **다른 길**이 있다 — 목록에서 우클릭 「기록만 읽기」.
   */
  joining: screenEl("screen-joining"),
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

/**
 * ★ **위에 얹는다 — 뒤로 가면 아래가 나온다** (2026-09-30).
 *
 * `go` 는 늘 `["list", 이름]` 으로 **갈아끼운다.** 화면이 셋뿐일 때는 그걸로
 * 됐다 — 목록에서 방으로, 방에서 목록으로.
 *
 * 🔴 **권한·참여자를 화면으로 빼면서 어긋났다.** 채팅에서 권한을 열고 닫으면
 * 채팅으로 돌아와야 하는데, `go("perm")` 은 스택에서 채팅을 **지워버린다** —
 * 뒤로가기가 목록으로 가고, 돌아올 때도 «앞으로 가는» 것처럼 미끄러진다.
 *
 * 얹으면 `["list", "chat", "perm"]` 이 되고, `back()` 하나로 채팅이 제자리에
 * 돌아온다(`.behind` 였다가 `.active` 로). 애니메이션도 뒤로 가는 모양이 된다.
 */
function push(name: ScreenName): void {
  if (stack[stack.length - 1] === name) return;
  // 같은 화면이 스택에 둘이면 «뒤로» 가 어디로 갈지 모호해진다
  stack = [...stack.filter((s) => s !== name), name];
  paintScreens();
}

function back(): void {
  if (stack.length <= 1) return;
  stack = stack.slice(0, -1);
  paintScreens();
}

function paintScreens(): void {
  /*
   * ★ **확인 화면은 돌아갈 자리가 아니다** (2026-10-14).
   *
   * 창이 뜰 때 `stack = ["auth"]` 로 시작한다. 그 위에 로봇 화면을 얹으면
   * `["auth","agents"]` 가 되는데, 🔴 **뒤로가기가 끝난 로딩 화면으로**
   * 돌아간다 — 거기엔 나갈 길이 없다. 그리고 확인 화면이 `behind`(-24%)로
   * 남아 **왼쪽으로 다 안 빠진 것처럼** 보인다(사용자가 짚은 그것).
   *
   * 떠나는 순간 **목록을 바닥으로** 깔아준다. 한 자리에서만 하므로 새 길이
   * 생겨도 빠뜨릴 데가 없다.
   */
  if (stack.length > 1 && stack.includes("auth")) {
    stack = ["list", ...stack.filter((s) => s !== "auth" && s !== "list")];
  }
  const top = stack[stack.length - 1]!;
  for (const [name, el] of Object.entries(screens) as Array<[ScreenName, HTMLElement]>) {
    el.classList.toggle("active", name === top);
    el.classList.toggle("behind", name !== top && stack.includes(name));
  }
  // 첫 페인트에 심어둔 표시를 걷어낸다 — 이제 클래스가 위치를 정한다.
  // 🔴 **둘 다 걷는다** — 확인 화면으로 열릴 때는 그쪽에 붙어 있다
  screens.list.removeAttribute("data-active");
  screens.auth.removeAttribute("data-active");
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
    else if (k === "style") setStyle(node, v as Record<string, string>);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) {
    if (kid === false || kid == null) continue;
    node.append(kid);
  }
  return node;
}

/**
 * ★ **커스텀 속성(`--이름`)은 `setProperty` 로만 들어간다** (2026-09-28).
 *
 * 🔴 `Object.assign(node.style, …)` 를 쓰고 있었다. 평범한 속성에는 통하지만
 * **`--bot` 같은 커스텀 속성은 조용히 버려진다** — `style` 객체에 그런 키가
 * 없기 때문이다. 오류도 안 나고 값만 사라진다.
 *
 * 봇 색을 실으려다 걸렸다. 말풍선이 그냥 평소 색이었고 `style` 은 `null` 이었다.
 */
function setStyle(node: HTMLElement, style: Record<string, string>): void {
  for (const [k, v] of Object.entries(style)) {
    if (k.startsWith("--")) node.style.setProperty(k, v);
    else (node.style as unknown as Record<string, string>)[k] = v;
  }
}

const icon = (name: string) => el("i", { class: `codicon codicon-${name}` });

/**
 * ★ **봇 색 고르기** — 이름 **옆**에 (2026-09-28).
 *
 * 🔴 C9 는 «색은 보조 신호로만»이라고 정했고 그 이유 중 제일 센 것이 «같은
 * 에이전트의 두 봇은 색이 같다» 였다. **봇마다 색을 주면 그 이유가 사라진다.**
 * 나머지 둘(라이트 테마 대비 · 색각 이상)은 남으므로 **이름은 그대로 둔다** —
 * 색은 더해지는 것이지 대신하는 것이 아니다.
 *
 * 자리를 이름 옆으로 둔 이유: 설정 칸이 하나 더 늘면 만들기 화면이 길어진다.
 * 이름을 정하는 그 순간이 «이 봇을 무엇으로 부를까»를 정하는 때이고, 색도
 * 같은 질문이다.
 *
 * 프리셋 값이 **테마 변수**인 것이 핵심이다(`BOT_COLORS`) — 우리가 팔레트를
 * 하드코딩하면 §2.2 G(«자체 테마를 만들지 않는다»)를 바로 어긴다.
 */
/**
 * 🔴 **폴백이 «에이전트 색»이었다** (2026-09-29에 고침).
 *
 * 아무것도 안 골랐을 때 고르개의 점이 브랜드색(`#d97757`)을 보여줬다. 그런데
 * 말풍선은 **테마 기본**이다 — 고르개는 «파랑 골라져 있네»라고 하는데 화면은
 * 회색이다. 사용자가 바로 알아챘다.
 *
 * 고르개는 **실제로 그려질 것**을 보여야 한다. 안 골랐으면 «테마가 주는 평소
 * 말풍선»이므로 그 색을 그대로 보여준다 — 그게 참이다.
 */
const NO_COLOR = "var(--bubble-bot-bg)";

function colorPick(
  now: string | undefined,
  ink: "black" | "white" | undefined,
  pick: (css: string, ink: "black" | "white" | undefined) => void,
): HTMLElement {
  const fallback = NO_COLOR;
  const dot = el("span", { class: "dot", style: { background: now ?? fallback } });
  const box = el("details", { class: "swatch" });
  const close = () => box.removeAttribute("open");

  /*
   * ★ **판을 나가는 문은 «적용» 하나다** (2026-09-29).
   *
   * 🔴 예전에는 **누르는 족족 들어갔다.** 프리셋도, 글자칸도 한 번 누르면
   * 그대로 적용되고 판이 닫혔다. 그래서 «색 고르고 글자색까지 정하기» 가
   * 아예 불가능했다 — 색을 누르는 순간 판이 닫혀서 글자색을 볼 기회가
   * 없었고, 다시 열어서 또 한 번 눌러야 했다. 두 번 적용되는 셈이다.
   *
   * 이제 판 안의 모든 누름은 **고르는 것**이고, 들어가는 것은 «적용» 뿐이다.
   * 딴 데를 누르면 고르던 것은 버려진다 — 되돌리기를 따로 둘 필요가 없다.
   *
   * 글자색은 **안 건드려도 된다.** 안 건드리면 쓰던 것이 그대로 따라간다.
   */
  let draft = now ?? fallback;
  let draftInk = ink;
  const inks: HTMLElement[] = [];
  const presets: Array<{ css: string; node: HTMLElement }> = [];

  /** 고르던 것을 화면에 비춘다 — 무엇이 «적용» 될지가 보여야 한다 */
  const repaint = (): void => {
    for (const b of inks) {
      b.style.background = draft;
      b.classList.toggle("on", draftInk === (b.dataset["ink"] as "black" | "white"));
    }
    for (const p of presets) p.node.classList.toggle("on", p.css === draft);
  };

  const preset = (css: string, label: string) => {
    const node = el("button", {
      class: "sw", title: label, type: "button",
      style: { background: css },
      // **고르기만 한다.** 판은 열린 채 — 이어서 글자색을 볼 수 있어야 한다
      onclick: () => { draft = css; repaint(); },
    });
    presets.push({ css, node });
    return node;
  };

  /*
   * ★ **글자는 검정이나 하양, 둘뿐이다** (2026-09-28).
   *
   * 배경을 **섞지 않고 그대로** 칠하므로 대비를 우리가 못 잡는다. 그렇다고
   * 계산해서 고를 수도 없다 — 프리셋 값이 `var(--vscode-charts-blue)` 라
   * **테마마다 실제 색이 다르고**, 어느 테마에서 어두울지 우리는 모른다.
   *
   * 그래서 **보고 고르게 한다.** 두 칸을 **지금 배경 위에** 그려두면 어느 쪽이
   * 읽히는지 눈으로 바로 갈린다 — 설명이 필요 없다.
   *
   * ★ 그 «지금 배경» 이 이제 **고르는 중인 색**이다 (2026-09-29). 그리고
   * 누르면 **색과 글자색이 같이** 들어간다 — 색을 고른 뒤 「가」 하나만 더
   * 누르면 끝이라, «적용» 을 따로 찾을 일이 없다.
   */
  const inkBtn = (v: "black" | "white") => {
    const b = el("button", {
      class: `ink${draftInk === v ? " on" : ""}`,
      type: "button",
      "data-ink": v,
      title: v === "black" ? "이 색에 검정 글자" : "이 색에 하양 글자",
      style: { background: draft, color: v === "black" ? "#000" : "#fff" },
      text: "가",
      // 여기도 **고르기만** 한다 — 안 눌러도 되고, 누르면 «적용» 때 같이 간다
      onclick: () => { draftInk = v; repaint(); },
    });
    inks.push(b);
    return b;
  };

  /*
   * 커스텀은 **에디터가 주는 색 고르개**를 쓴다. 우리가 그리면 테마를 또
   * 흉내 내야 하고, 그러면 §2.2 G 를 우회하는 셈이 된다.
   */
  /*
   * ★ **커스텀은 «확정»을 눌러야 들어간다** (2026-09-28).
   *
   * 🔴 `oninput` 으로 바로 넣었더니 **고르는 동안 계속 적용됐다.** 색 고르개를
   * 끌고 다니는 사이에 말풍선이 수십 번 바뀌고, 손을 떼면 **지나가던 색이
   * 남는다.** 프리셋은 «한 번 누르면 그 색»이라 괜찮지만 커스텀은 다르다.
   *
   * 그래서 고르개는 **미리보기**만 하고, 넣는 것은 단추가 한다.
   *
   * ★ **그 미리보기가 이제 글자칸까지 간다** (2026-09-29).
   *
   * 「스포이드 창 안에 «적용» 을 넣을 수 없나」 하는 물음에서 나왔다. OS 가
   * 그리는 창이라 거기엔 못 넣는다 — 대신 **그 창을 닫고 나온 자리**에서
   * 색과 글자색을 한눈에 고르게 한다. 고른 색이 글자칸 두 개의 배경으로
   * 즉시 깔리므로, 「가」를 누르는 것이 곧 «이 색 + 이 글자색» 이 된다.
   */
  const custom = el("input", {
    type: "color",
    class: "sw custom",
    title: "직접 고르기",
    // `var(--vscode-…)` 는 hex 가 아니라 여기 못 넣는다 — 무난한 값에서 시작한다
    value: /^#[0-9a-f]{6}$/i.test(now ?? "") ? now! : "#888888",
    // 스포이드는 **끌면 바로 반영된다** — 고르는 중이니 확인 단계가 하나 더
    // 있으면 거추장스럽다. 들어가는 것은 여전히 «적용» 뿐이다.
    oninput: () => { draft = custom.value; repaint(); },
  });

  /*
   * ★ **«적용»은 강조 단추다** (2026-09-28).
   *
   * 커스텀 칸은 **누르기 전에는 아무 일도 안 일어난다.** 그러면 «다 골랐는데
   * 왜 안 바뀌지»가 되기 쉬우므로, 다음에 할 일이 **눈에 띄어야** 한다.
   * 알약(`link`)은 «행 안의 잔 동작» 자리라 여기서는 약하다(§2.2 G5).
   */
  const apply = el("button", {
    class: "primary apply", type: "button", text: "적용",
    title: "고른 색과 글자색을 적용합니다",
    // **판을 나가는 유일한 문.** 색과 글자색이 한 쌍으로 간다
    onclick: () => { pick(draft, draftInk); close(); },
  });

  const panel = el(
    "div",
    { class: "swatches" },
    ...BOT_COLORS.map((c) => preset(c.css, c.label)),
    /*
     * ★ **스포이드는 프리셋 «오른쪽» 기둥에** (2026-09-29).
     *
     * 🔴 아래에 뒀더니 **저를 누르면 뜨는 창이 판을 덮었다.** `<input
     * type="color">` 의 창은 **에디터가 그리고 에디터가 자리를 정한다** —
     * 우리가 못 옮긴다. 우리가 옮길 수 있는 것은 **창이 매달리는 칸** 뿐이다.
     *
     * 아래에 있으면 창이 그 밑으로 열리면서 글자칸과 단추 줄을 가린다.
     * 하필 이제 글자칸이 **고른 색을 비추는 자리**라, 색을 끌어 고르는
     * 동안 정작 봐야 할 것이 가려져 있었다.
     *
     * 그래서 오른쪽 기둥으로 보낸다 — 프리셋 두 줄 옆에 세로로 선다.
     * 창이 그 옆에서 열리므로 판의 아래쪽이 살아 있다.
     *
     * ⚠️ 그래도 **완전히 우리 손 안은 아니다.** 판이 화면 오른쪽 끝에
     * 붙어 있으면 에디터가 창을 왼쪽으로 접어 열 수 있다. 그때까지 가려면
     * 고르개를 우리가 그려야 하는데, 그건 테마를 통째로 흉내 내는 일이다.
     */
    custom,
    el("div", { class: "inks" }, inkBtn("black"), inkBtn("white")),
    el(
      "div",
      { class: "pick-acts" },
      el("button", { class: "ghost", type: "button", text: "기본값으로",
                     title: "테마가 주는 평소 말풍선으로 되돌립니다",
                     onclick: () => { pick("", undefined); close(); } }),
      apply,
    ),
  );

  /*
   * ★ **창을 넘지 않게 «고정 좌표»로 띄운다** (2026-09-28).
   *
   * 🔴 `position: absolute` 로 두었더니 **서랍 밖으로 밀려났다.** 서랍은
   * `overflow-y: auto` 라 그 안의 절대 배치는 잘리거나 스크롤 밖으로 나간다.
   * 부모가 무엇이든 상관없으려면 `fixed` 여야 한다.
   *
   * 그러면 좌표는 우리가 잡아야 하는데, **화면 안으로 접어 넣는다** — 오른쪽
   * 끝에서 열면 왼쪽으로, 아래가 모자라면 위로. 열 때 한 번만 재고 스크롤하면
   * 닫는다(따라다니게 만들면 그때부터 어긋날 자리가 는다).
   */
  const place = (): void => {
    const at = box.getBoundingClientRect();
    const w = panel.offsetWidth || 200;
    const h = panel.offsetHeight || 60;
    panel.style.left = `${Math.max(8, Math.min(at.right - w, window.innerWidth - w - 8))}px`;
    const below = at.bottom + 6;
    panel.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, at.top - h - 6) : below}px`;
  };
  box.addEventListener("toggle", () => {
    if (!box.open) {
      // 닫혔으면 **고르던 것은 버린다** — 다음에 열 때 지금 쓰는 색에서 시작한다
      draft = now ?? fallback;
      draftInk = ink;
      repaint();
      return;
    }
    place();
    const shut = () => box.removeAttribute("open");
    window.addEventListener("scroll", shut, { once: true, capture: true });
    window.addEventListener("resize", shut, { once: true });
    /*
     * ★ **딴 데를 누르면 닫힌다** (2026-09-29).
     *
     * 🔴 `<details>` 는 저 혼자 안 닫힌다. 예전에는 무엇을 누르든 바로 적용되고
     * 닫혔으니 문제가 안 됐는데, 이제 판이 **고르는 동안 계속 열려 있다.**
     * 나가는 길이 «적용» 뿐이면 «그만둘래» 가 막힌다 — 요약 점을 다시 찾아
     * 눌러야 한다.
     *
     * 딴 데 누르기가 곧 «그만두기» 다. 위에서 고르던 것을 버리므로 되돌리기를
     * 따로 둘 필요가 없다.
     */
    const away = (e: Event) => {
      if (box.contains(e.target as Node)) return;
      box.removeAttribute("open");
      document.removeEventListener("pointerdown", away, true);
    };
    document.addEventListener("pointerdown", away, true);
  });

  box.append(el("summary", { title: "말풍선 색" }, dot), panel);
  return box;
}

function replace(host: HTMLElement, ...kids: Kids): void {
  host.replaceChildren(...(kids.filter((k) => k != null && k !== false) as Node[]));
}

// ── 목록 ────────────────────────────────────────────────────────────────

const roomsEl = document.getElementById("rooms")!;
document.getElementById("btn-new")!.addEventListener("click", () => openNewRoom());
document.getElementById("btn-agents")!.addEventListener("click", () => {
  post({ t: "agentsAsk" });
  /*
   * **답이 오기 전에 한 번 그린다.** 설정을 읽고 자리 크기를 세는 데
   * 잠시 걸리는데, 그동안 **헤더도 없는 빈 화면**이면 뒤로 갈 길조차
   * 안 보인다. 머리말을 먼저 세우고 칸은 답이 오면 채운다.
   */
  renderAgents();
  push("agents");
});

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

// ── 검색 (H) ────────────────────────────────────────────────────────────

/** 목록 화면의 필터어. 메타는 이미 메모리에 있어 사실상 공짜다 (H1) */
let filterText = "";
/** 전문 검색 결과 (H2). 비어 있지 않으면 목록 대신 결과를 그린다 */
let hits: SearchHit[] | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** 방을 열 때 점프할 메시지 (H3) */
let jumpToMessageId: string | undefined;

/**
 * ★ **한 번에 그리는 말풍선 수 — 쉰 개** (사용자, 2026-10-15).
 *
 * 🔴 여태 **전부** 그렸다 — 기록을 통째로 읽어서 통째로 DOM 에 올렸다.
 * 돌아가는 중에는 `nodeCache` 가 받쳐주지만 **껐다 켜면 그 캐시가 없으므로**
 * 방을 열 때마다 평생치를 처음부터 짓는다. 그리고 오늘 모양을 바꾸면서
 * 한 턴이 상자 여럿이 됐다 — 노드 수는 더 는다.
 *
 * 사용자: *"기록은 남아있지만 보여주는건 다른거지"*. **기록은 안 자른다**
 * (§0) — 파일도 그대로고, 넘겨 보낸 것도 그대로다. 자르는 것은 **그리는
 * 것**뿐이고, 위에 「이전 대화 더 보기」가 서서 언제든 되찾을 수 있다.
 */
const PAGE = 50;

/** 지금 방에서 **몇 개까지 그리나** — 방을 바꾸면 처음으로 돌아간다 */
let shownCount = PAGE;
/**
 * ★ **찾아가기 전에 읽던 자리** (2026-09-23).
 *
 * 위로 뛰면 **자동 따라가기가 풀린다** — 아래에서 턴이 도는데 옛날 것을 보고
 * 있게 된다. 돌아올 자리를 적어두고 띠로 내어준다.
 *
 * 화면이 **실제로 움직였을 때만** 적는다. 안 움직였으면 돌아갈 데가 없다.
 */
let backTo: number | undefined;

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
  /** 말풍선 색. 비우면 테마가 주는 평소 말풍선 (2026-09-28) */
  color: string;
  /** 그 위의 글자색 — 검정/하양 택1 */
  ink?: "black" | "white";
}
let draftBots: DraftBot[] = [newDraftBot()];

/**
 * ★ **안 고르면 파랑** (2026-09-30).
 *
 * 🔴 여태 기본이 «테마가 주는 평소 말풍선»(`--bubble-bot-bg`)이었다. 그 값은
 * 편집기 배경을 글자색 쪽으로 8% 민 것이라 **거의 회색**이고, 말풍선이 배경에
 * 겨우 떠 있는 정도다. 색을 고를 수 있게 만들어 놓고 **아무도 안 고르면 아무
 * 방에도 색이 없는** 상태가 기본이었다.
 *
 * 파랑을 기본으로 둔다. 고르개에 «파랑이 골라져 있는» 것으로 보이므로,
 * 마음에 안 들면 그 자리에서 바꾸면 된다 — 숨은 기본값이 아니다.
 *
 * **봇을 더하면 다음 색으로 간다.** 둘 다 파랑이면 색을 준 보람이 없다 —
 * v2.2 가 겨냥한 «같은 에이전트로 봇 여럿» 이 정확히 그 경우다.
 */
/**
 * 안 고르면 이 색이다 — **내 말풍선과 같은 파랑**이다.
 *
 * ⏪ 한때 **이미 쓴 색을 피해 다음 색**으로 넘겼다 — 봇 둘이 같은 파랑이면
 * 색을 준 보람이 없다고 봐서다. 사용자가 «봇끼리 색 겹쳐도 됨» 으로 정리했고,
 * 그 편이 맞다: 겹치는 것이 싫으면 **고르면 된다.** 안 겹치게 해주려다
 * «내가 파랑을 골랐는데 왜 자홍이지» 가 생기는 쪽이 더 나쁘다.
 *
 * 그리고 피하기를 걷으면서 딸려 있던 것들이 같이 없어졌다 — `draftBots` 를
 * 읽던 TDZ 방어, 새로 열 때 먼저 비우던 줄.
 */
function defaultBotColor(): string {
  return (BOT_COLORS.find((c) => c.id === "default") ?? BOT_COLORS[0]!).css;
}

function newDraftBot(): DraftBot {
  return {
    /*
     * 🔴 **받아둔 것 중에서 고른다** (2026-10-02).
     *
     * 예전엔 무조건 `boot.agents[0]` 였다. 그러면 첫째를 안 받은 사람은
     * **고르개에 없는 값이 박힌 채** 방을 만들게 된다 — 고르개는 받은
     * 것만 보여주는데 속값은 Claude 에 고정돼 있어서, 눈에 보이는 것과
     * 실제로 붙는 것이 어긋난다.
     */
    agentId: (boot.agents.find((a) => agentAvail.has(a.id)) ?? boot.agents[0])?.id ?? "",
    picks: new Map(), role: "", name: "",
    color: defaultBotColor(),
  };
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
  /*
   * ⏪ **여기서 무조건 졸랐다** (2026-10-07).
   *
   * 써놓고 보면 괜찮아 보인다 — 코어가 캤시를 들고 있으니 답은 바로
   * 온다. 그런데 답을 주면서 **뒤로 새로 재기도 한다**(`refreshConfigOptions`).
   * 그게 Antigravity 에선 **세션을 하나 더 만드는 일**이고 19.5초가 걸린다 —
   * 방 만들기를 여루 번 열면 그만큼 쌓인다.
   *
   * `renderNew` 가 이미 `askConfig` 로 «없거나 틀어졌으면» 조른다.
   */
  setTimeout(() => screens.new.querySelector<HTMLInputElement>("#new-title")?.focus(), 240);
}

function renderNew(error?: string): void {
  // 화면을 다시 만들므로 «이렇게 됩니다» 줄도 새로 모은다 — 옛 노드를 들고
  // 있으면 화면에 없는 것을 계속 고치게 된다
  draftBent.length = 0;

  /*
   * 🔴 **하나도 안 받았으면 만들기 형식을 안 보여준다** (2026-10-02).
   *
   * 고르개가 **텀 빈 채** 형식을 띄우면 사용자는 이름까지 정하고 «만들기» 를
   * 누른 뒤에야 «안 받았다» 를 알게 된다. 막히는 데가 늦을수록 나쁘다.
   */
  if (boot.agents.length > 0 && agentAvail.size === 0) {
    replace(
      screens.new,
      el(
        "header",
        { class: "bar" },
        el("button", { class: "icon", title: "뒤로", onclick: () => back() }, icon("arrow-left")),
        el("h1", { text: "새 대화방" }),
      ),
      el("div", { class: "empty" },
        el("p", { text: "아직 받아둔 에이전트가 없습니다." }),
        el("p", { class: "dim" }, "목록 화면 위의 ", icon("robot"), " 에서 하나 받으면 바로 만들 수 있습니다."),
        el("button", {
          class: "primary", type: "button", text: "에이전트 받으러 가기",
          onclick: () => { post({ t: "agentsAsk" }); renderAgents(); push("agents"); },
        }),
      ),
    );
    return;
  }

  /* 화면에 들어올 때도 한 번 확인한다 — 미리 밀어준 것이 틀어졌을 수 있다 */
  for (const b of draftBots) askConfig(b.agentId);

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
    /*
     * ★ **누르는 순간 붙는 화면으로** (사용자, 2026-10-15):
     * *"새 대화방 만들기 -> 열기 누를 때 로딩창으로 이동 -> 방으로
     * 들어가짐 이 흐름으로 / 1대1 만들때는 만드는 창에서 좀 대기하는"*.
     *
     * 🔴 방이 **돌아와야** 화면이 움직였다 — 그사이 만들기 창에 그대로
     * 서 있으니 **누른 것이 먹혔나** 싶어진다. 기다리는 것은 같아도
     * «어디서 기다리나» 는 다르다 — 붙는 화면은 그 기다림이 **제 일**이다.
     */
    renderOpening(title.value.trim());
    go("joining");
    post({
      t: "createRoom",
      agentId: draftBots[0]?.agentId ?? "",
      title: title.value.trim(),
      ...(cwdInput.value.trim() ? { cwd: cwdInput.value.trim() } : {}),
      bots: draftBots.map((b) => ({
        agentId: b.agentId,
        ...(b.name.trim() ? { name: b.name.trim() } : {}),
        ...(b.color.trim() ? { color: b.color.trim() } : {}),
        ...(b.ink ? { ink: b.ink } : {}),
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
        /*
         * ⏪ **«혼자 쓰면 1:1 방입니다» 를 뺐다** (2026-09-30).
         *
         * 봇이 하나인 것은 **화면에 이미 보인다** — 봇 칸이 하나뿐이다. 보이는
         * 것을 글로 한 번 더 말하면 «내가 뭘 잘못했나» 하고 읽게 된다.
         * 여럿일 때만 적는다 — 그건 **처음 만들기 화면에서 안 보이던 것**
         * (단체방이 된다는 결과)이라 말해줄 값이 있다.
         */
        draftBots.length > 1
          ? el("span", { class: "dim", text: `봇 ${draftBots.length}개 — 단체방으로 만들어집니다` })
          : null,
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
              // 고유 이름 — 이 화면에는 «흐린 글씨»가 여럿이라 그것만으론 못 고른다
              class: "dim cwd-why",
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
  const name = el("input", {
    type: "text",
    value: b.name,
    /*
     * ★ **빈 칸에 «실제로 붙을 이름»을 보여준다** (2026-09-30).
     *
     * 🔴 에이전트 이름(`Claude`)만 보여주고, 겹치면 아래에 ««Claude»은(는)
     * 이미 있어서 «Claude 2»이(가) 됩니다» 라는 줄을 따로 띄웠다. 그런데
     * **빈 칸에 이미 답이 들어갈 자리가 있었다** — 거기에 `Claude 2` 를
     * 적으면 설명할 것이 없어진다. 글로 알려주는 대신 **그대로 보여준다.**
     */
    placeholder: draftNames()[n] ?? "",
  }) as HTMLInputElement;
  name.addEventListener("input", () => {
    b.name = name.value;
    // 앞 봇의 이름이 바뀌면 **뒤 봇에 붙을 이름도 바뀐다** — 전부 다시 본다
    syncDraftNames();
  });
  draftBent.push({ b, hint: name });

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
      ? el(
          "button",
          {
            /*
             * ★ **빨강으로** (2026-09-30). 되돌릴 수 없는 것은 색으로도 말한다 —
             * 서랍의 «내보내기»와 같은 규칙이다(`.ghost.danger`).
             */
            class: "link danger bot-drop",
            onclick: () => {
              draftBots.splice(n, 1);
              draftAt = Math.min(draftAt, draftBots.length - 1);
              renderNew();
            },
          },
          // 큐의 «빼기»와 **같은 말**이다 — 모양도 같아야 한다
          icon("close"),
          "빼기",
        )
      : null,
    /*
     * ★ **이름이 먼저, 그다음 에이전트** (2026-09-30).
     *
     * 🔴 에이전트를 먼저 물었다. 기본 이름이 에이전트 이름이라 «고른 다음에야
     * 이름이 정해진다» 고 봤기 때문이다. 그런데 **빈 칸에 붙을 이름을 그대로
     * 보여주게 되면서** 그 이유가 없어졌다 — 에이전트를 바꾸면 빈 칸의 글자도
     * 따라 바뀐다.
     *
     * 사람이 정하는 순서는 «이 봇을 뭐라고 부를까 → 무엇으로 돌릴까» 다.
     * 이름이 이 칸의 주인공이므로 맨 위가 맞다.
     *
     * ★ **색은 이름 «옆»에** (2026-09-28). 칸을 따로 만들면 화면이 길어지는데,
     * 이름을 정하는 그 순간이 «이 봇을 무엇으로 부를까»를 정하는 때이고 색도
     * 같은 질문이다.
     */
    el("div", { class: "field" },
      el("label", { text: "이름 (선택)" }),
      el("div", { class: "named" },
        name,
        colorPick(b.color || undefined, b.ink,
          (css, pickedInk) => {
            b.color = css;
            b.ink = pickedInk;
            renderNew();
          }))),
    el(
      "div",
      { class: "field" },
      el("label", { text: "에이전트" }),
      agentSelect(b, () => { draftAt = n; renderNew(); }),
    ),
    /*
     * 에이전트를 고른 뒤에 채워진다. 미리 받아두어 기다림이 없다 (B15).
     *
     * ⚠️ **못 물어본 것과 저쪽이 안 알려준 것은 다르다.** 틀어졌으면
     * 까닭을 보여주고, 빈 목록으로 둔갑시키지 않는다.
     */
    ...(configErrors.has(configKey(b.agentId))
      ? [el("p", { class: "error", text: configErrors.get(configKey(b.agentId))! })]
      : configFields(configs.get(b.agentId), b.picks)),
    el("div", { class: "field" }, el("label", { text: "역할 (선택)" }), role),
  );
}

/** 빈 칸 글씨를 다시 맞출 이름 입력칸들 — 앞 봇이 바뀌면 뒤 봇도 바뀐다 */
const draftBent: Array<{ b: DraftBot; hint: HTMLElement }> = [];

/**
 * ⏪ **«이미 있어서 …이(가) 됩니다» 를 뺐다** (2026-09-30).
 *
 * 🔴 겹치는 이름에 «이렇게 바뀝니다» 를 글로 알려줬다. 그런데 **빈 칸에 이미
 * 그 답이 들어갈 자리가 있었다** — 거기에 `Claude 2` 를 적으면 설명할 것이
 * 없어진다. 글로 알려주는 대신 **그대로 보여준다.**
 *
 * 그래서 이 함수가 하는 일은 이제 «빈 칸 글씨를 다시 맞추는 것» 하나다 —
 * 앞 봇의 이름이 바뀌면 뒤 봇에 붙을 이름도 바뀌기 때문이다.
 */
function syncDraftNames(): void {
  const names = draftNames();
  for (const [n, { hint }] of draftBent.entries()) {
    (hint as HTMLInputElement).placeholder = names[n] ?? "";
  }
}

/**
 * ★ **에이전트는 드롭다운으로** (2026-09-30).
 *
 * 🔴 카드 단추를 줄줄이 세웠다. 둘일 때는 «골라 보세요» 가 잘 읽혔는데,
 * 사용자가 `aiInOne.agents` 로 더할 수 있으므로 **몇 개가 될지 우리가 모른다.**
 * 게다가 이 화면에는 이미 같은 일을 하는 칸이 여럿이다 — 모델·강도·권한 모드.
 * **방 안에서 에이전트를 갈아탈 때도 드롭다운**을 쓴다(서랍). 만들 때와 바꿀
 * 때가 다른 모양이면 «다른 일인가» 로 읽힌다.
 *
 * 설명(`a.description`)은 고른 것 아래 한 줄로 남긴다 — 드롭다운 안에서는
 * 안 보이고, 그렇다고 버리면 «Codex 가 뭐지» 에 답할 데가 없어진다.
 */
function agentSelect(
  b: { agentId: string; picks: Map<string, string | boolean> },
  after: () => void,
): HTMLElement {
  const pick = el("select", { class: "agent-pick" }) as HTMLSelectElement;
  /* 받지 않은 것은 안 띄운다 — 고르게 해두고 나중에 막으면 더 나쁘다 */
  for (const a of boot.agents.filter((x) => agentAvail.has(x.id))) {
    pick.append(el("option", { value: a.id, text: a.label, selected: a.id === b.agentId }));
  }
  pick.addEventListener("change", () => {
    if (pick.value === b.agentId) return;
    b.agentId = pick.value;
    // 모델은 에이전트마다 다르다 — 골랐던 것을 그대로 두면 없는 id 를 보낸다
    b.picks.clear();
    askConfig(pick.value);
    after();
  });

  const who = boot.agents.find((a) => a.id === b.agentId);
  return el(
    "div",
    { class: "agent-row" },
    pick,
    who?.description ? el("span", { class: "dim agent-desc", text: who.description }) : null,
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

/**
 * ★ **지금 보는 방이 «기록만 읽기» 인가** (사용자, 2026-10-15).
 *
 * 🔴 세션을 안 붙이고 연 방에서 **입력창과 단추들이 평소처럼 서 있었다** —
 * 눌러도 될 것처럼 보이는데 보낼 곳이 없다. 사용자: *"기록만 읽기 방에서
 * 입력창 제거. 참여자 서랍 버튼, 분기버튼, ...버튼 제거, 뒤로가기랑 방
 * 정보만 보이게"*.
 *
 * 방 id 로 들고 있는다 — 옆 방으로 가면 저절로 풀린다. 「들어가기」로 다시
 * 열면 `openRoom` 이 지운다.
 */
let peeking: string | null = null;

/**
 * ★ **마지막에 받아둔 구독 잔량** (사용자, 2026-10-19).
 *
 * 🔴 **들고 있는다.** 한 번 받는 데 최대 20초(Antigravity)라, 팝업을 열
 * 때마다 빈 화면부터 보여주면 «눌러도 아무 일이 없다» 가 된다. 지난 것을
 * 먼저 세우고 **언제 받은 것인지**를 같이 적는다 — 낡은 수를 새 수인 척
 * 보여주지만 않으면 된다.
 */
let quota: AgentQuota[] | null = null;
let quotaBusy = false;

function openRoom(roomId: string): void {
  // 뷰는 **그 방 안의 상태**다 — 다른 방에 들고 가면 엉뚱한 봇을 가리킨다
  viewBotId = null;
  /*
   * ★ **들어올 때마다 백 개부터** (사용자, 2026-10-15) — *"방을 나갔다가
   * 들어오면 다시 최근 100개만 로딩하고"*.
   *
   * 🔴 방을 **바꿀 때**만 되돌리면, 나갔다 **같은 방**으로 돌아올 때는 아까
   * 펴둔 만큼이 그대로 다시 그려진다 — 가장 비싼 순간(캐시가 식은 뒤)에
   * 제일 많이 짓는 셈이다.
   */
  shownCount = PAGE;
  joinFails = new Map();
  joinSteps = new Map();
  // 제대로 들어가는 길이다 — 「기록만」 표시는 여기서 풀린다
  peeking = null;
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
function peekRoom(roomId: string): void {
  viewBotId = null;
  joinFails = new Map();
  shownCount = PAGE;
  peeking = roomId;
  post({ t: "peek", roomId });
  go("chat");
}

function leaveChat(): void {
  viewBotId = null;
  flushDraft();
  post({ t: "back" });
  room = null;
  chat = null;
  /*
   * ★ **딸린 화면들을 비운다** (2026-09-30).
   *
   * 권한·참여자·모델고르기는 **그 방의 것**이다. 화면으로 빼면서 내용이
   * 스택 밖에 남게 됐는데, 안 비우면 다음 방에서 열었을 때 **앞 방의 봇
   * 이름이 한 순간 스친다** — 다시 그리기 전까지.
   */
  for (const s of [screens.perm, screens.bots, screens.fix, screens.invite]) s.replaceChildren();
  stack = ["list"];
  paintScreens();
}

/* ── 모델이 없어졌다 — 고르기 전에는 못 쓴다 ─────────────────────────── */

/** 이 방을 지금 못 쓰게 만드는 봇들. 비어 있으면 평소 방이다 */
function needsModel(r: Room): BotInstance[] {
  /*
   * ★ **네 가지를 같은 문으로 받는다** (2026-10-01 둘, 2026-10-13 둘).
   *
   * «고른 모델이 없어졌다» 와 «그 에이전트를 안 받았다» 는 사용자
   * 입장에서 같다 — **이 방은 지금 못 쓴다.** 고치는 길도 같다:
   * 다른 걸 고르거나 봇을 내보낸다. 그래서 한 화면에서 처리한다.
   *
   * ★ **붙다가 걸린 것도 여기로 온다** (2026-10-13). 로그인이 풀렸거나
   * 아예 못 열렸거나 — 사용자 입장에서 **똑같이 이 방을 못 쓴다.** 단추를
   * 붙는 화면에도 달면 **단추가 두 화면에 흩어진다.** 붙는 화면은
   * **기다리는 자리**, 여기가 **결정하는 자리**로 나눈다.
   */
  return r.participants.filter((b) => b.modelGone || agentGone(b) || joinFails.has(b.id));
}

/**
 * **붙다가만** 걸린 봇 — 고르개가 아니라 다른 줄이 필요하다.
 *
 * 모델·에이전트가 같이 비어 있으면 그쪽이 먼저다. 고르개가 곧 답이고,
 * 고르고 나면 붙는 것도 다시 하게 된다 — 「다시 시도」를 따로 누를 일이 없다.
 */
function joinStuck(b: BotInstance): { kind: JoinFail; why: string } | undefined {
  if (b.modelGone || agentGone(b)) return undefined;
  return joinFails.get(b.id);
}

/**
 * ★ **전체화면으로 막고 고르게 한다** (2026-09-30).
 *
 * 처음엔 방 위에 띠로 띄웠다. 🔴 **띠는 지나치기 쉽다** — 대화가 보이므로 그냥
 * 쓰게 되고, 그러면 **고르지도 않은 모델로 대화가 쌓인다.** 대체는 계열째
 * 다를 수 있어서(luna→terra, sonnet→opus 실측) 나중에 «왜 답이 달라졌지» 의
 * 답을 영영 못 찾는다.
 *
 * **고른 모델이 없어진 봇만** 여기 나온다. 멀쩡한 봇까지 세워두면 «내 방이
 * 통째로 고장났나» 가 된다 — 실제로는 한 봇의 설정 하나가 빈 것뿐이다.
 */
/** 마지막으로 받은 에이전트 목록 — 화면을 다시 그릴 때 쓴다 */
let agentRows: Extract<ToWebview, { t: "agents" }>["list"] = [];

/** 바이트를 사람 글로 */
function mb(n: number): string {
  if (n <= 0) return "";
  const m = n / 1048576;
  return m >= 1024 ? (m / 1024).toFixed(1) + "GB" : m.toFixed(0) + "MB";
}

/**
 * ★ **에이전트 설정 화면** (2026-10-01) — `docs/core/install.md`.
 *
 * 단추는 **전부 `state` 가 정한다.** 여기서 다시 판단하지 않는다 —
 * 계산은 `agentInstaller.stateOf` 한 자리에만 둔다:
 *
 * ```
 * none       설치하기
 * stale      업데이트          + 제거
 * needLogin  로그인            + 제거
 * ready      로그아웃 · 사용량  + 제거
 * ```
 *
 * 🔴 **제거는 로그인을 안 지운다.** 자격은 `~/.codex`·`~/.claude` 에 있고
 * 거긴 우리 자리가 아니다. 그래서 둘이 **다른 단추**여야 한다 — 하나로
 * 묶으면 «앱을 지웠더니 로그인도 날아갔다» 가 된다.
 */
/** 붙다가 못 붙은 봇 — 방을 나가면 비운다 */
let joinFails = new Map<string, { kind: JoinFail; why: string }>();
/** 그 봇이 **어느 칸**에 있나 — 없으면 아직 시작도 안 했거나 이미 붙어 있다 */
let joinSteps = new Map<string, JoinStep>();
/**
 * 카드에서 로그인을 **띄워준** 에이전트들.
 *
 * 호스트는 로그인에 `busy` 를 안 단다 — 일이 **우리 밖**(터미널·브라우저)에서
 * 일어나서 언제 끝나는지 모르기 때문이다. 그래서 「띄웠다」만 우리가 적어두고,
 * 목록이 «이제 로그인됨» 으로 바뀌면 지운다.
 */
const loginAsked = new Set<string>();
/** 붙는 화면을 지나왔나 — 한 번 들어간 방은 다시 안 세운다 */
const joined = new Set<string>();

/** 지금 그리고 있는 확인 줄 — 호스트가 보낼 때마다 갈린다 */
let authList: AuthRow[] = boot.auth ?? [];
let authStuck = false;

/**
 * ★ **로그인 확인 화면** (2026-10-13).
 *
 * ```
 * 확인 중…        CLI 에게 물어보는 중
 * 로그인됨 / 안 됨  답을 받았다
 * 파일로만 확인     물어볼 길이 없어 자격 파일만 봤다 (Antigravity)
 * 못 물어봤습니다   기한을 넘겼다
 * ```
 *
 * 🔴 **기한을 넘기면 사람에게 묻는다.** 조용히 넘어가면 «로그인했는데 왜
 * 안 되지» 가 나중에 터지고, 그때는 왜인지 알 길이 없다.
 */
function renderAuth(): void {
  const host = screens.auth;
  host.replaceChildren();
  host.append(el("header", { class: "bar" }, el("h1", { text: "AI in One" })));

  const box = el("div", { class: "auth-box" });
  const asking = authList.some((r) => r.at === "asking");
  box.append(
    el("p", {
      class: "auth-head",
      text: asking ? "로그인을 확인하는 중입니다…" : "로그인 확인",
    }),
  );

  for (const row of authList) {
    const say = row.at === "asking"
      ? "확인 중…"
      : row.at === "failed"
        ? "못 물어봤습니다"
        : row.guessed
          ? (row.at === "yes" ? "로그인됨 (파일로만 확인)" : "로그인 안 됨 (파일로만 확인)")
          : (row.at === "yes" ? "로그인됨" : "로그인 안 됨");
    box.append(
      el(
        "div",
        { class: `auth-row ${row.at}` },
        el("span", {
          class: "auth-mark",
          text: row.at === "asking" ? "…" : row.at === "yes" ? "✓" : row.at === "no" ? "·" : "!",
        }),
        el("span", { class: "auth-name", text: row.label }),
        el("span", {
          class: row.at === "failed" ? "auth-say bad" : "auth-say dim",
          text: say,
        }),
      ),
    );
  }

  if (authStuck) {
    const stuck = authList.filter((r) => r.at === "asking" || r.at === "failed");
    box.append(
      el("p", {
        class: "auth-stuck bad",
        text: `${stuck.map((r) => r.label).join("·")}에서 답이 없습니다.`,
      }),
      el(
        "div",
        { class: "auth-acts" },
        el("button", {
          class: "agent-go", text: "다시 시도", onclick: () => post({ t: "authRetry" }),
        }),
        el("button", {
          class: "agent-btn", text: "그냥 들어가기", onclick: () => post({ t: "authSkip" }),
        }),
      ),
    );
  }

  host.append(box);
}

/**
 * ★ **방에 붙는 화면** (2026-10-13).
 *
 * 봇마다 한 칸이고 **서로 독립**이다 — 코어도 그렇게 다룬다(«한 봇이 안
 * 열려도 나머지는 산다»). 끝난 봇은 **사라지지 않고 체크로 줄어든다**:
 * 사라지면 «몇 명이었더라» 가 된다.
 *
 * ★ **여기는 기다리는 자리다** (2026-10-13). 걸린 줄에 다는 단추는
 * **[다시 시도] 하나**뿐이다 — 그 자리에서 바로 다시 해보는 것.
 *
 * 🔴 한때 까닭마다 단추가 달랐다([로그인]·[고치기]). 그러면 **단추가 두
 * 화면에 흩어진다** — 아직 붙는 중인 봇 옆에서 결정을 내리게 되고, 돌아와
 * 보면 그 사이에 다른 봇도 걸려 있다. 다 끝난 뒤에 `fix` 에서 한 번에
 * 정한다(`joinDone`).
 */
/**
 * ★ **방이 아직 없을 때의 붙는 화면** (사용자, 2026-10-15).
 *
 * 만들기를 누른 순간에는 **방이 없다** — 그런데도 화면은 옮겨야 한다.
 * 제목만 들고 같은 자리에 선다 — 방이 오면 `renderJoining` 이 그 위에 다시
 * 그린다(봇 줄까지). 두 화면이 아니라 **한 화면의 이른 모습**이다.
 */
function renderOpening(title: string): void {
  const host = screens.joining;
  host.replaceChildren(
    el("header", { class: "bar" },
      el("button", { class: "icon", title: "뒤로", onclick: () => { go("list"); } }, icon("arrow-left")),
      el("h1", { text: title || "새 대화방" }),
    ),
    el("div", { class: "auth-box" },
      el("p", { class: "auth-head", text: "방을 여는 중입니다…" }),
    ),
  );
}

function renderJoining(r: Room): void {
  const host = screens.joining;
  host.replaceChildren();
  host.append(
    el("header", { class: "bar" },
      el("button", { class: "icon", title: "뒤로", onclick: () => { go("list"); } }, icon("arrow-left")),
      el("h1", { text: r.title }),
    ),
  );

  const box = el("div", { class: "auth-box" });
  const bots = botStatus;
  const left = r.participants.filter(
    (b) => !joinFails.has(b.id) && (bots[b.id] ?? "connecting") === "connecting",
  );
  box.append(el("p", { class: "auth-head",
    text: left.length > 0 ? "방을 여는 중입니다…" : "방을 열지 못한 봇이 있습니다" }));

  /* ★ 끝난 것은 **한 줄로 줄여서** 같이 보여준다 — 사라지면 셈이 안 맞는다 */
  const done = r.participants.filter(
    (b) => !joinFails.has(b.id) && (bots[b.id] ?? "connecting") !== "connecting",
  );
  if (done.length > 0) {
    box.append(el("div", { class: "join-done" },
      ...done.map((b) => el("span", { class: "join-chip" },
        el("span", { class: "auth-mark", text: "✓" }),
        el("span", { text: b.name }),
      )),
    ));
  }

  for (const bot of r.participants) {
    if (done.includes(bot)) continue;
    const bad = joinFails.get(bot.id);
    const row = el("div", { class: `auth-row ${bad ? "failed" : "asking"}` },
      el("span", { class: "auth-mark", text: bad ? "!" : "…" }),
      el("span", { class: "auth-name", text: bot.name }),
      el("span", { class: bad ? "auth-say bad" : "auth-say dim",
        /*
         * ★ **어느 칸인지 말한다** (2026-10-13). 「여는 중…」 한 줄이면
         * Antigravity 의 17.5초가 **통째로 한 덩어리**로 보인다 — 12.5초는
         * 띄우는 데 쓰고 5초는 세션에 쓰는데, 그걸 모르면 멈춘 것 같다.
         */
        text: bad
          ? bad.why
          : joinSteps.get(bot.id) === "start"
            ? `${agentById.get(bot.agentId)?.label ?? bot.agentId} 를 띄우는 중…`
            : "세션을 여는 중…" }),
    );
    if (bad) {
      row.append(el("div", { class: "auth-acts" },
        el("button", {
          class: "agent-go", text: "다시 시도",
          onclick: () => {
            joinFails.delete(bot.id);
            post({ t: "retryJoin", roomId: r.id, botId: bot.id });
            renderJoining(r);
          },
        }),
      ));
    }
    box.append(row);
  }

  /*
   * 🔴 **「그냥 들어가기」를 안 둔다** (2026-10-13).
   *
   * 반쯤 깨진 봇을 달고 들어가면 **상태가 헷갈린다** — 멘션은 되는데 답이
   * 안 오고, 그 까닭이 어디에도 안 적혀 있다. 답은 둘뿐이다: **고치거나,
   * 내보내거나.** 둘 다 `fix` 화면에 있다(거기 「내보내기」가 이미 있다).
   */
  host.append(box);
}

function renderAgents(): void {
  const host = screens.agents;
  host.replaceChildren();
  host.append(
    el(
      "header",
      { class: "bar" },
      el("button", {
        class: "icon", title: "뒤로",
        onclick: () => back(),
      }, icon("arrow-left")),
      el("h1", { text: "에이전트" }),
    ),
  );

  for (const a of agentRows) {
    const act = (what: "install" | "remove" | "login" | "logout") =>
      post({ t: "agentDo", agentId: a.id, what });

    const head = el("div", { class: "agent-head" },
      el("span", { class: "agent-name", text: a.label }),
    );

    /* 오른쪽 끝에 판과 자리 — 받은 뒤에만 보여줄 것이 있다 */
    const facts: string[] = [];
    if (a.state === "stale") facts.push(`${a.version} → ${a.wanted}`);
    else if (a.version) facts.push(a.version);
    if (a.size > 0) facts.push(mb(a.size));
    if (facts.length) head.append(el("span", { class: "agent-facts dim", text: facts.join(" · ") }));

    const row = el("div", { class: "agent-card" }, head);

    if (!a.managed) {
      /* 사용자가 `aiInOne.agents` 로 적은 것 — 우리가 받는 게 아니다 */
      row.append(el("p", { class: "dim", text: "설정에 직접 적은 에이전트입니다." }));
      host.append(row);
      continue;
    }

    if (a.busy !== undefined) {
      row.append(el("p", { class: "agent-busy dim", text: a.busy }));
      host.append(row);
      continue;
    }

    const bar = el("div", { class: "agent-acts" });
    if (a.state === "none") {
      bar.append(el("button", { class: "agent-go", text: "설치하기", onclick: () => act("install") }));
    } else {
      if (a.state === "stale") {
        bar.append(el("button", { class: "agent-go", text: "업데이트", onclick: () => act("install") }));
      }
      if (a.loggedIn) {
        /* 길이 없으면 단추도 안 달고, 아래에 왜인지 한 줄 적는다 */
        if (a.canLogout) {
          bar.append(el("button", { class: "agent-btn", text: "로그아웃", onclick: () => act("logout") }));
        }
      } else {
        bar.append(el("button", { class: "agent-go", text: "로그인", onclick: () => act("login") }));
      }
      /* 제거는 늘 오른쪽 끝에, 빨간색으로 */
      bar.append(el("button", {
        class: "agent-btn danger", text: "제거", onclick: () => act("remove"),
      }));
    }
    row.append(bar);

    /*
     * 로그아웃할 길이 없으면 **그 사실을 말해준다.** 단추만 지우고 아무
     * 말도 안 하면 «왜 없지» 가 된다 — 안 먹는 단추와 같은 자리다.
     */
    if (a.state === "ready" && !a.canLogout) {
      row.append(el("p", { class: "dim",
        text: `「${a.label}」 의 CLI 에는 로그아웃 명령이 없습니다. `
          + `계정을 바꾸려면 그 CLI 에서 직접 해주세요.`,
      }));
    }

    /* 로그인 안 됐으면 왜 필요한지 한 줄 — 안 적으면 그냥 막힌 것처럼 보인다 */
    if (a.state === "needLogin") {
      row.append(el("p", { class: "dim",
        text: a.viaAcp
          ? "브라우저가 열립니다. 로그인을 마치면 이 화면이 알아서 바뀝니다."
          : "터미널이 열립니다. 로그인을 마치면 이 화면이 알아서 바뀝니다.",
      }));
    }
    host.append(row);
  }
}

/**
 * ★ **막음 화면에서 고르는 것들 — 누르기 전까지는 안 간다** (2026-10-01).
 *
 * 사용자: *"선택하자마자 없어지는게 아니라, 내보내기 옆에 적용 버튼이
 * 있어야지"*.
 *
 * 예전엔 고르개를 건드리는 순간 `setAgent` 가 날아갔다. 🔴 **되돌릴 수 없는
 * 일을 고르개 한 번으로 치른 것**이다 — 세션이 버려지고 맥락이 끊긴다.
 * 게다가 에이전트와 모델을 **따로** 보내게 되어 순서도 안 지켜졌다.
 *
 * 그래서 고른 것을 여기 모아두고 «적용» 에서 **한 번에** 보낸다.
 */
const fixPick = new Map<string, { agentId?: string; model?: string; carry: "log" | "summary" | "none" }>();


/** 「이전 것」 → [고르개] 한 줄 */
function swapRow(was: string, pick: HTMLElement): HTMLElement {
  return el("div", { class: "fix-swap" },
    el("span", { class: "gone", text: was }),
    el("span", { class: "dim", text: "→" }),
    pick,
  );
}

/**
 * ★ **방 화면 셋 중 어디인지를 한 자리에서 정한다** (2026-10-13).
 *
 * 채팅·붙는 중·고치기는 **같은 자리의 세 얼굴**이다. 셋을 `go`·`push` 로
 * 따로 밀면 스택이 엉킨다 — 비워둔 `fix` 가 아래 깔려 있다가 **빈 화면**으로
 * 돌아오거나, 보던 채팅이 스택에서 **지워진다**(`go` 는 늘 갈아끼운다).
 *
 * 두 가지를 지킨다:
 *
 * ```
 * 보던 채팅은 아래에 남긴다   뒤로 누르면 거기로 돌아간다
 * 위에 얹힌 것은 그대로 둔다   🔴 로봇 화면에서 **끌어내지 않는다** —
 *                             로그인·받기는 거기서 하는 일이라 갈아끼우면
 *                             하던 일이 날아간다. 뒤로 가면 맞는 화면이 있다
 * ```
 */
function roomGo(to: "chat" | "joining" | "fix"): void {
  const faces = new Set<ScreenName>(["chat", "joining", "fix"]);
  const next: ScreenName[] = ["list"];
  if (to !== "chat" && stack.includes("chat")) next.push("chat");
  next.push(to);
  // 위에 얹혀 있던 것들(로봇·권한·참여자…)은 순서대로 그대로
  for (const s of stack) if (s !== "list" && !faces.has(s)) next.push(s);
  stack = next;
  paintScreens();
}

/** 막을 것이 생겼나 없어졌나에 맞춰 화면을 돌린다 — 한 자리에서 가른다 */
function repaintBlock(r: Room): void {
  const top = stack[stack.length - 1];
  /* 아직 붙는 중이면 그 화면을 지킨다 — 끝나면 `joinDone` 이 가른다 */
  const waiting = top === "joining" && !joined.has(r.id);
  if (waiting) return;
  if (needsModel(r).length > 0) {
    renderFix(r);
    roomGo("fix");
  } else {
    /*
     * 막을 것이 없으면 **비워둔다.** 화면이 안 보인다고 남겨두면, 다음에
     * 다른 방이 걸렸을 때 **앞 방의 봇 이름이 한 순간 스친다** — 설정이
     * 늦게 와서 다시 그리기 전까지.
     */
    screens.fix.replaceChildren();
    if (stack.includes("fix") || stack.includes("joining")) roomGo("chat");
  }
}

/**
 * ★ **로그인을 마치면 저절로 다시 붙는다** (4.5-U, 2026-10-13).
 *
 * 새 메시지가 필요 없다. 로그인이 끝나면 호스트가 **에이전트 목록을 다시
 * 내려보내고**(터미널이 닫히면 즉시, 안 닫으면 20초 뒤 한 번 더), 거기에
 * 「이제 로그인됨」(`state: "ready"`) 이 실려 온다. 그걸 보고 움직인다.
 *
 * **그 에이전트로 막힌 봇 전부**를 다시 붙인다 — 한 에이전트에 봇이 여럿일 수
 * 있고, 로그인은 그 봇들에게 한꺼번에 통한다. 다른 까닭(`other`)으로 막힌
 * 봇은 안 건드린다. 로그인과 무관하다.
 *
 * ★ [다시 확인] 은 그래도 남긴다 — 저쪽이 늦게 끝나거나 우리가 못 알아챘을
 * 때의 보험이다. 하나는 알아서, 하나는 손으로.
 */
function retryAfterLogin(r: Room): boolean {
  let any = false;
  for (const [botId, bad] of [...joinFails]) {
    if (bad.kind !== "auth") continue;
    const bot = r.participants.find((b) => b.id === botId);
    if (!bot || agentRows.find((a) => a.id === bot.agentId)?.state !== "ready") continue;
    fireRetry(r, botId);
    any = true;
  }
  return any;
}

/** 다시 붙여달라고만 한다 — 화면은 부르는 쪽이 정한다 */
function fireRetry(r: Room, botId: string): void {
  const bot = r.participants.find((b) => b.id === botId);
  if (bot) loginAsked.delete(bot.agentId);
  joinFails.delete(botId);
  post({ t: "retryJoin", roomId: r.id, botId });
}

/**
 * 다시 붙여본다 — **기다리는 자리로 데려가면서.**
 *
 * 🔴 그 자리에 세워두면 **아무 일도 안 일어난 것처럼 보인다.** 다시 붙는 데는
 * 길면 수십 초가 걸리는데(Antigravity 12.5초 + 5초), 칸이 어디까지 갔는지
 * 보여주는 화면은 붙는 화면뿐이다. 끝나면 거기서 알아서 갈린다 —
 * 되면 채팅, 또 걸리면 여기로 돌아온다(`room` 이 올 때 한 군데서 가른다).
 */
function retryJoin(r: Room, botId: string): void {
  fireRetry(r, botId);
  renderJoining(r);
  roomGo("joining");
}

/**
 * ★ **붙다가 걸린 봇의 카드** (2026-10-13) — `fix` 화면.
 *
 * 줄이 **까닭마다 갈린다**:
 *
 * ```
 * auth   [로그인] [다시 확인]   로그인이 풀렸다
 * other  [다시 시도]            망·시간 초과. 대개 이걸로 풀린다
 * gone   ─                      여기 안 온다 (고르개 카드가 받는다)
 * ```
 *
 * 어느 쪽이든 **[내보내기]가 같이 있다** — 사용자: *"그냥 들어가기는 없어,
 * 봇 제거는 있어도"*. 반쯤 깨진 봇을 달고 들어가면 멘션은 되는데 답이 안 오고
 * 그 까닭이 어디에도 없다. 답은 둘뿐이다: **고치거나, 내보내거나.**
 *
 * ★ **[로그인] 은 그 자리에서 쏜다** (2026-10-13).
 *
 * 🔴 처음엔 로봇 화면으로 **보냈다.** 그러면 거기서 같은 단추를 **한 번 더**
 * 눌러야 했는데, 그 사이에 로봇 화면이 보여주는 것이 없다 — 진짜 로그인은
 * 어차피 **우리 창 밖**(터미널·브라우저)에서 일어나고 포커스도 그리로 간다.
 * 사용자: *"그자리에서 로그인 되면서 에이전트 화면에도 업데이트 되면 좋겠는데"*.
 * 로봇 화면은 `agents` 가 올 때마다 **안 보여도 다시 그려지므로**(`renderAgents`)
 * 거기 가 보면 이미 맞춰져 있다.
 */
function stuckCard(r: Room, bot: BotInstance, bad: { kind: JoinFail; why: string }): HTMLElement {
  const who = agentById.get(bot.agentId);
  const row = agentRows.find((a) => a.id === bot.agentId);
  /** 호스트가 무언가 하는 중이면(받기·지우기) 로그인을 겹쳐 쏘지 않는다 */
  const busy = row?.busy;
  const asked = loginAsked.has(bot.agentId);
  const acts = el("div", { class: "fix-acts" });

  if (bad.kind === "auth") {
    const open = el("button", {
      class: "agent-go", type: "button", text: "로그인",
      title: `${who?.label ?? bot.agentId} 로그인을 띄웁니다`,
      onclick: () => {
        loginAsked.add(bot.agentId);
        post({ t: "agentDo", agentId: bot.agentId, what: "login" });
        renderFix(r);
      },
    }) as HTMLButtonElement;
    open.disabled = asked || busy !== undefined;
    acts.append(open);
  }
  acts.append(el("button", {
    /* 로그인 쪽은 **[로그인]이 먼저**다 — 두 개를 다 강조하면 어느 쪽이 답인지 흐려진다 */
    class: bad.kind === "auth" ? "agent-btn" : "agent-go", type: "button",
    text: bad.kind === "auth" ? "다시 확인" : "다시 시도",
    onclick: () => { retryJoin(r, bot.id); },
  }));
  acts.append(el("button", {
    class: "ghost danger", type: "button", text: "내보내기",
    onclick: () => { fixPick.delete(bot.id); post({ t: "removeBot", roomId: r.id, botId: bot.id }); },
  }));

  /*
   * **띄운 뒤엔 무슨 일이 일어나는지 적는다.** 터미널이 뜨면서 포커스가
   * 그리로 가므로, 돌아왔을 때 이 카드가 아무 말도 안 하면 «눌린 건가» 가
   * 된다. 끝나면 저절로 다시 붙는다는 것도 여기서만 말할 수 있다.
   */
  const say = busy ?? (asked
    ? "로그인 창을 띄웠습니다. 마치면 저절로 다시 붙습니다."
    : undefined);

  return el("div", { class: "fix-bot" },
    el("div", { class: "fix-name" },
      el("span", { class: "dot", style: { background: botColor(bot) } }),
      el("strong", { text: bot.name }),
      el("span", { class: "dim", text: who?.label ?? bot.agentId }),
    ),
    el("p", { class: "fix-stuck", text: bad.why }),
    say !== undefined && el("p", { class: "agent-busy dim", text: say }),
    acts,
  );
}

function renderFix(r: Room): void {
  const hit = needsModel(r);
  /** 한 봇이라도 «에이전트가 없다» 면 글이 달라진다 — 모델 이야기만 하면 틀린 말이 된다 */
  const anyAgent = hit.some((b) => agentGone(b));
  const host = screens.fix;
  host.replaceChildren();
  if (hit.length === 0) return;

  /*
   * **왜 막는지**를 적는다. 안 적으면 «그냥 쓰면 되지 왜 막아» 가 된다.
   *
   * ★ **까닭마다 한 줄씩 쌓는다** (2026-10-13). 예전엔 «에이전트가 없다»
   * 아니면 «모델이 없다» 둘 중 하나만 골라 적었는데, 이제 한 방에 **네 가지가
   * 섞여 올 수 있다.** 하나만 적으면 **나머지 봇의 까닭이 어디에도 없다.**
   */
  const says: string[] = [];
  if (anyAgent) {
    says.push("받지 않은 에이전트는 부를 수 없습니다. 로봇 아이콘에서 받아두거나, " +
      "여기서 다른 에이전트로 바꾸거나 봇을 내보내면 됩니다.");
  }
  if (hit.some((b) => b.modelGone)) {
    // 핵심은 «비슷한 걸로 바꿔놨다» 가 아니라 **성격이 다를 수 있다** 이다
    says.push("대신 들어간 모델은 성격이 다를 수 있습니다 — 빠른 모델이 균형 모델로 " +
      "바꿔도 합니다. 모르고 쓰면 답이 왜 달라졌는지 나중에 알 수 없습니다.");
  }
  const anyStuck = hit.some((b) => joinStuck(b));
  if (anyStuck) {
    says.push("붙지 못한 봇은 불러도 답이 오지 않습니다. 다시 해보거나, 봇을 내보내면 됩니다.");
  }

  host.append(
    el(
      "header",
      { class: "bar" },
      el("button", {
        class: "icon", title: "목록으로",
        // **가둬두지 않는다.** 이 방을 지금 안 쓰겠다는 것도 답이다
        onclick: () => { room = null; chat = null; go("list"); },
      }, icon("arrow-left")),
      el("h1", { text: anyAgent || anyStuck ? "이 방을 쓰려면 정리가 필요합니다" : "모델을 다시 골라 주세요" }),
    ),
    el("div", { class: "fix-why" },
      el("p", {
        text:
          `${r.title}의 ${hit.length > 1 ? `봇 ${hit.length}개` : hit[0]!.name}가 ` +
          `지금 돌 수 없어 이 방을 쓸 수 없습니다. 하나씩 정리하면 돌아갑니다.`,
      }),
      ...says.map((text) => el("p", { class: "dim", text })),
    ),
  );

  for (const bot of hit) {
    /*
     * ★ **붙다가 걸린 봇은 다른 카드다** (2026-10-13). 고르개를 띄우면
     * «모델을 바꾸라는 건가» 가 된다 — 모델은 멀쩡하다. 여기서 할 일은
     * **다시 해보거나 내보내거나** 뿐이다.
     */
    const stuck = joinStuck(bot);
    if (stuck) { host.append(stuckCard(r, bot, stuck)); continue; }

    const who = agentById.get(bot.agentId);
    const gone = agentGone(bot);
    const got = fixPick.get(bot.id) ?? { carry: "log" as const };
    if (!fixPick.has(bot.id)) fixPick.set(bot.id, got);

    /**
     * 바꾼 뒤에 돌 에이전트.
     *
     * 안 고른 상태의 기본값이 다르다 — **없어진 에이전트는 기본값이 없다.**
     * 멀쩡하면 지금 것이 기본이라 «그대로 두고 모델만» 이 자연스럽게 된다.
     */
    const nextAgent = got.agentId ?? (gone ? "" : bot.agentId);
    const swapping = Boolean(nextAgent) && nextAgent !== bot.agentId;
    const mine = nextAgent === bot.agentId;
    const modelOpt = nextAgent
      ? optionsFor(nextAgent, mine ? r.id : undefined, mine ? bot.id : undefined)
          ?.find((o) => o.category === "model")
      : undefined;

    const card = el("div", { class: "fix-bot" },
      el("div", { class: "fix-name" },
        el("span", { class: "dot", style: { background: botColor(bot) } }),
        el("strong", { text: bot.name }),
        el("span", { class: "dim", text: who?.label ?? bot.agentId }),
      ),
    );

    /*
     * ── 에이전트 줄 ────────────────────────────────────────────
     *
     * ★ **모델만 없어졌을 때도 띄운다** (2026-10-02).
     *
     * 사용자: *"에이전트 줄도 선택하게 하자"*. 판이 올라가며 모델이 바뀐 김에
     * **아예 다른 에이전트로 가겠다**는 것도 답이다. 그 길이 서랍에만 있으면
     * 막혀 있는 사람은 거기까지 갈 수가 없다 — 방이 잠겨 있으니까.
     */
    const others = boot.agents.filter((x) => agentAvail.has(x.id));
    if (gone && others.length === 0) {
      card.append(el("p", { class: "dim",
        text: `「${who?.label ?? bot.agentId}」 을(를) 아직 받지 않았고, 바꿔 달 다른 에이전트도 없습니다. ` +
          "위의 로봇 아이콘에서 먼저 받아주세요.",
      }));
    } else {
      const swap = el("select", { class: "regone" }) as HTMLSelectElement;
      if (gone) swap.append(el("option", { value: "", text: "고르세요…", selected: !got.agentId }));
      for (const x of others) {
        swap.append(el("option", { value: x.id, text: x.label, selected: nextAgent === x.id }));
      }
      swap.addEventListener("change", () => {
        got.agentId = swap.value || undefined;
        /* 에이전트가 바뀌면 모델도 다시 골라야 한다 — 남겨두면 없는 id 를 보낸다 */
        got.model = undefined;
        if (swap.value && !configs.has(swap.value)) post({ t: "needConfig", agentId: swap.value });
        renderFix(r);
      });
      card.append(swapRow(who?.label ?? bot.agentId, swap));
    }

    /*
     * ── 모델 줄 ──────────────────────────────────────────────
     *
     * ★ **에이전트를 안 골랐어도 줄은 있다** (2026-10-02).
     *
     * 사용자: *"이전 에이전트, 모델 나와있고 에이전트 골랐을때 모델 선택이
     * 활성화되는걸로"*.
     *
     * 🔴 예전엔 에이전트를 고르기 전까지 이 줄이 **아예 없었다.** 그러면
     * 화면이 **고르는 동안 자라나서** 무엇을 더 정해야 하는지 미리 알 수
     * 없었고, 「이전 모델」 이 무엇이었는지도 그때까진 안 보였다.
     * 처음부터 둘 다 보여주고 **꺼둔 채로** 기다리는 쪽이 맞다.
     */
    {
      const was = bot.modelGone?.label ?? bot.modelLabel ?? bot.model ?? "모델";
      const pick = el("select", { class: "regone" }) as HTMLSelectElement;
      if (!nextAgent) {
        pick.append(el("option", { value: "", text: "에이전트를 먼저 고르세요", selected: true }));
        pick.disabled = true;
      } else if (modelOpt?.values?.length) {
        pick.append(el("option", { value: "", text: "고르세요…", selected: !got.model }));
        for (const v of modelOpt.values) {
          pick.append(el("option", { value: v.id, text: v.name, selected: got.model === v.id }));
        }
        pick.addEventListener("change", () => {
          got.model = pick.value || undefined;
          renderFix(r);
        });
      } else {
        /*
         * 🔴 **기다리는 동안에도 「여기서」 는 보여준다** — 한 번 줄을 통째로
         * 뺐다가 **없어진 모델 이름이 같이 사라졌다.** 설정은 방에 들어온 뒤에
         * 오므로 처음 몇 순간은 늘 이 꼴인데, 하필 그때 제일 알고 싶은 것이다.
         */
        pick.append(el("option", { value: "", text: "불러오는 중…", selected: true }));
        pick.disabled = true;
      }
      card.append(swapRow(was, pick));
    }

    /* ── 단추 줄 ──────────────────────────────────────────────── */
    const ready = Boolean(nextAgent && got.model);
    const acts = el("div", { class: "fix-acts" });

    const drop = () => el("button", {
      class: "ghost danger", type: "button", text: "내보내기",
      onclick: () => { fixPick.delete(bot.id); post({ t: "removeBot", roomId: r.id, botId: bot.id }); },
    });

    if (swapping) {
      /*
       * ★ **에이전트가 바뀌면 «무엇을 넘길까» 가 곧 «적용» 이다** (2026-10-02).
       *
       * 사용자: *"에이전트가 다를 경우는 [기록 넘기기] [요약 넘기기]
       * [안 넘기기] [내보내기]"*.
       *
       * 🔴 갈아타기는 **세션을 버리는 일**이라 맥락이 끊긴다. 그래서 «적용»
       * 하나로 두면 **무엇을 잃는지 모르고 누르게** 된다. 단추가 곧 답이면
       * 고르는 순간이 곧 아는 순간이다 — 서랍의 갈아타기도 같은 꼴이다.
       *
       * 🔴 **요약은 있을 때만.** 요약은 우리가 만든 게 아니라 에이전트가
       * 압축하며 준 것이라, 압축한 적 없는 방엔 하나도 없다. 띄워두면
       * **빈 것을 보내고 나서** 알게 된다.
       */
      const go = (carry: "log" | "summary" | "none", label: string, title: string) => {
        const b = el("button", {
          class: carry === "log" ? "agent-go" : "agent-btn", type: "button", text: label, title,
          onclick: () => {
            if (!got.agentId) return;
            post({
              t: "setAgent", roomId: r.id, botId: bot.id, agentId: got.agentId,
              refeed: carry !== "none",
              ...(carry !== "none" ? { refeedKind: carry } : {}),
              ...(got.model && modelOpt ? { model: { configId: modelOpt.configId, value: got.model } } : {}),
            });
            fixPick.delete(bot.id);
          },
        }) as HTMLButtonElement;
        b.disabled = !ready;
        acts.append(b);
      };
      go("log", "대화 넘겨서 바꾸기", "지난 대화를 통째로 실어 보냅니다. 세운 계획과 읽은 파일 기억은 안 갑니다.");
      go("summary", "요약만 넘겨서 바꾸기",
         "압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다.");
      go("none", "기록만 두고 바꾸기", "새 에이전트가 백지에서 시작합니다. 대화는 화면에만 남습니다.");
    } else {
      const apply = el("button", {
        class: "agent-go", type: "button", text: "적용",
        onclick: () => {
          if (!got.model || !modelOpt) return;
          post({ t: "setConfig", roomId: r.id, configId: modelOpt.configId, value: got.model, botId: bot.id });
          fixPick.delete(bot.id);
        },
      }) as HTMLButtonElement;
      apply.disabled = !ready;
      acts.append(apply);
    }

    acts.append(drop());
    card.append(acts);
    host.append(card);
  }
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

/**
 * ★ **치워둔 글** — 깊이 1 스택 (v3.0 1-E).
 *
 * 「수정」을 누르면 예약 글이 입력창으로 내려오는데, 그때 **쓰던 글이 있으면**
 * 덮어쓰게 된다. 묻지도 않고 안 잃으려면 어딘가 둬야 한다.
 *
 * 🔴 **이건 «예약»이 아니다.** 예약 칸은 턴이 끝나면 **나가고**, 치워둔 칸은
 * **안 나간다** — 그냥 보관이다. 그래서 «예약은 명시적 행동»이 안 깨진다.
 *
 * 깊이는 **1 이면 충분하다** — 예약이 하나니 밀어둘 것도 하나뿐이다. 그리고
 * **보여준다.** 숨긴 스택이 문제지, 한 줄로 보이면 그냥 «잠깐 치워둔 것»이다.
 */
let stash: { roomId: string; tokens: ComposeToken[] } | null = null;

/** 이 글이 갈 봇들 중 **도는 중인** 이름들 */
function busyAmong(r: Room, botIds: string[]): string[] {
  return botIds
    .filter((id) => {
      const at = botStatus[id];
      return at !== undefined && at !== "idle" && at !== "error";
    })
    .map((id) => r.participants.find((b) => b.id === id)?.name ?? id);
}

/** 토큰을 입력창에 되돌린다 — 칩은 칩으로, 글자는 글자로 */
function putTokens(r: Room, tokens: ComposeToken[]): void {
  // `chat.box` 는 1:1 이면 textarea, 단체방이면 contenteditable 이다
  const box: HTMLElement | undefined = chat?.box;
  if (!box) return;
  if (box instanceof HTMLTextAreaElement) {
    box.value = tokens.map((t) => (t.kind === "text" ? t.text : "")).join("").trim();
    autoGrow(box);
    box.focus();
    return;
  }
  /*
   * 🔴 **글자로 눌러 담지 않는다.** «@구현» 을 글자로 되돌리면 그게 지목인지
   * 글자인지 우리가 다시 해석해야 하고, 사용자가 쓴 것과 달라질 수 있다.
   * 칩은 칩 그대로 돌려놓는다.
   */
  box.replaceChildren(
    ...tokens.map((t) =>
      t.kind === "mention"
        ? mentionChip(t.botId, r.participants.find((b) => b.id === t.botId)?.name ?? "?")
        : box.ownerDocument.createTextNode(t.text),
    ),
  );
  box.focus();
  box.dispatchEvent(new Event("input"));
}

/** 지금 입력창에 든 것 — 둘 중 어느 모양이든 토큰으로 */
function takeTokens(): ComposeToken[] {
  const box: HTMLElement | undefined = chat?.box;
  if (!box) return [];
  if (box instanceof HTMLTextAreaElement) {
    const text = box.value.trim();
    box.value = "";
    autoGrow(box);
    return text ? [{ kind: "text", text }] : [];
  }
  const out = readTokens(box);
  box.replaceChildren();
  return out.some((t) => t.kind === "mention" || t.text.trim()) ? out : [];
}

/**
 * ★ **입력창 위 한 줄** — 예약 칸, 또는 치워둔 칸 (v3.0 1-E).
 *
 * **둘이 동시에 안 뜬다.** 「수정」을 누르는 순간 예약이 풀리므로 언제나 한 줄이다.
 *
 * ```
 * 예약만 있을 때   ⏳ 끝나면 보냅니다 — "그거 말고 이거"   [수정] [내리기]
 * 수정 누른 뒤     ↩ 치워둔 글 — "아까 쓰던 거"           [되돌리기]
 * ```
 *
 * 🔴 **접거나 작게 하지 않는다.** 올려두고 잊으면 10분 뒤 뜬금없이 나가서
 * «이게 왜 나가?»가 된다. 입력창 위에 계속 보이는 것이 그 값이다.
 */
function paintStaged(r: Room): void {
  const host = chat?.staged;
  if (!host) return;
  host.replaceChildren();

  if (r.staged) {
    const glance = quoteish(textOf(r, r.staged.tokens));
    host.hidden = false;
    host.append(
      el("span", { class: "what", text: `⏳ 끝나면 보냅니다 — ${glance}` }),
      el(
        "button",
        {
          class: "link",
          title: "예약을 풀고 글을 입력창으로 가져옵니다. 쓰던 글은 잠깐 치워둡니다.",
          onclick: () => {
            // **쓰던 글을 먼저 치운다** — 묻지도 않고 안 잃는다
            const now = takeTokens();
            stash = now.length > 0 ? { roomId: r.id, tokens: now } : null;
            post({ t: "editStaged", roomId: r.id });
          },
        },
        icon("edit"),
        "수정",
      ),
      el(
        "button",
        {
          class: "link",
          // 아무도 못 봤으므로 지울 수 있고, 지우면 자국이 없다 (§0)
          title: "올려둔 글을 버립니다.",
          onclick: () => post({ t: "unstage", roomId: r.id }),
        },
        icon("close"),
        "내리기",
      ),
    );
    return;
  }

  if (stash?.roomId === r.id) {
    const kept = stash.tokens;
    host.hidden = false;
    host.append(
      el("span", { class: "what", text: `↩ 치워둔 글 — ${quoteish(textOf(r, kept))}` }),
      el(
        "button",
        {
          class: "link",
          title: "치워둔 글을 입력창으로 되돌립니다.",
          onclick: () => {
            stash = null;
            putTokens(r, kept);
            paintStaged(r);
          },
        },
        icon("discard"),
        "되돌리기",
      ),
    );
    return;
  }

  host.hidden = true;
}

/** 토큰을 사람이 읽을 한 줄로 */
function textOf(r: Room, tokens: ComposeToken[]): string {
  return tokens
    .map((t) =>
      t.kind === "mention"
        ? `@${r.participants.find((b) => b.id === t.botId)?.name ?? "?"}`
        : t.text,
    )
    .join("");
}

/** 한 줄에 들어갈 만큼만 — 전체는 입력창이나 예약 칸이 들고 있다 */
function quoteish(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `"${one.length > 40 ? `${one.slice(0, 40)}…` : one}"`;
}

/**
 * ★ **바쁘면 단추가 «끝나면 보내기»라고 말한다** (v3.0 1-E).
 *
 * 🔴 누르기 전에 **무슨 일이 일어날지**를 말해야 한다. 같은 아이콘이 어떤
 * 때는 바로 보내고 어떤 때는 올려두면, 올려둔 글이 10분 뒤에 나갈 때
 * «이게 왜 나가?»가 된다 — 올린 기억이 없으니까.
 *
 * 예약이 이미 하나 있으면 **못 올린다**(칸이 하나다). 그것도 미리 말한다 —
 * 눌러보고 나서 알려주면 이미 한 번 헛손질한 뒤다.
 */
function paintSendButton(r: Room): void {
  const btn = chat?.box.parentElement?.querySelector<HTMLButtonElement>("button.send");
  if (!btn) return;
  const targets = viewBotId ? [viewBotId] : r.participants.map((b) => b.id);
  const held = busyAmong(r, targets);
  const full = r.staged !== undefined;

  /*
   * 🔴 **올려둔 것이 있으면 아무것도 안 나간다** — 받는 이가 누구든.
   *
   * ⏪ 한때 «바쁜 봇에게만» 막았다. 그러면 올려둔 글이 베타를 기다리는 동안
   * **알파에게 친 말이 먼저 나간다** — 입력창 위에는 «끝나면 보냅니다» 가
   * 떠 있는데 나중에 친 말이 먼저 가는 꼴이라, **그 줄이 거짓이 된다.**
   *
   * 예약 칸을 하나로 둔 근거가 «하나뿐이라 순서가 없다» 였는데, 그러면
   * 사실상 «예약 1 + 즉시 전송» 이라 **순서가 둘**이 된다.
   *
   * ★ **끄는 것이 거절보다 낫다.** 거절하려면 일단 보내야 하고, 보내려면
   * 입력창을 비워야 한다 — 그 사이에 **글을 잃는다**(실제로 그랬다).
   * 꺼두면 누를 수가 없으니 비울 일도 없다.
   */
  btn.disabled = full;
  btn.classList.toggle("later", !full && held.length > 0);
  btn.title = full
    ? "올려둔 글이 먼저 나가야 합니다 — 위에서 보내거나 내릴 수 있습니다."
    : held.length > 0
      ? `${held.join("·")}이(가) 답하는 중입니다 — 끝나면 보냅니다.`
      : "보내기";
  btn.replaceChildren(icon(held.length > 0 && !full ? "history" : "send"));
}

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
    let mark: Node = text;
    for (const id of row.ids) {
      const name = id === EVERYONE ? "everyone" : (r.participants.find((b) => b.id === id)?.name ?? id);
      const chip = mentionChip(id, name);
      mark.parentNode?.insertBefore(chip, mark.nextSibling);
      const gap = box.ownerDocument.createTextNode(" ");
      chip.parentNode?.insertBefore(gap, chip.nextSibling);
      mark = gap;
    }
    /*
     * 🔴 **빈 글자 노드를 남기지 않는다** (사용자, 2026-10-15). 뒤에 남은
     * 글이 없는데도 빈 노드를 끼워 넣으면 커서가 **빈 노드 앞**에 서고,
     * 거기서 한글 조합이 첫 글자를 두 번 친다. 앞쪽도 마찬가지라 `@` 앞이
     * 비었으면 그 노드도 걷는다.
     */
    if (rest) {
      mark.parentNode?.insertBefore(box.ownerDocument.createTextNode(rest), mark.nextSibling);
    }
    if (text !== mark && text.data === "") text.remove();
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

/**
 * 커서를 이 노드 뒤로.
 *
 * 🔴 **글자 노드면 «그 안의 끝»에 둔다** (사용자, 2026-10-15): *"칩 작성후
 * 쓰는 첫 글자가 두번써짐"*.
 *
 * 노드와 노드 **사이**에 커서를 두면 한글 조합(IME)이 그 자리에서 **첫 글자를
 * 두 번** 친다 — 조합을 시작할 때 브라우저가 글자 노드를 새로 만들고, 조합이
 * 확정될 때 그 노드와 원래 자리 둘 다에 넣는다. 글자 노드 **안의 자리**(노드 +
 * 오프셋)를 주면 조합이 처음부터 그 노드에서 일어나 겹치지 않는다.
 */
function caretAfter(box: HTMLElement, node: Node): void {
  const doc = box.ownerDocument;
  const range = doc.createRange();
  if (node.nodeType === 3) range.setStart(node, (node as Text).data.length);
  else range.setStartAfter(node);
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
  const group = r.participants.length > 1 && viewBotId === null;
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
      if (parsed.blocks.length === 0 && pending.length === 0) return;
      // 다음번 «직전 그룹»은 지금 보낸 첫 블록이다
      lastGroup = parsed.blocks[0]?.botIds ?? [];
      const attachments = pending;
      pending = [];
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
      const held = busyAmong(live(), [viewBotId]);
      post({
        t: held.length > 0 ? "stage" : "sendCompose",
        roomId: r.id,
        tokens: [{ kind: "mention", botId: viewBotId }, { kind: "text", text: ` ${text}` }],
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
      { class: "composer", hidden: peeking === r.id },
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

  chat = {
    roomId: r.id, head, queue, clash, list, back, down, status, chips, box, perm,
    compose, staged, stop,
  };
  // 방을 갈아타면 돌아갈 자리도 사라진다 — 남의 방 스크롤 값이다
  backTo = undefined;
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
  paintStaged(r);
  // 🔴 다시 붙이는 길에서도 칠한다 — 안 하면 **방을 옮겼을 때만** 단추가 산다
  paintSendButton(r);
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

  /*
   * ★ **나에게 한 말에도 칩을 단다** — 단체방에서만 (2026-09-29).
   *
   * 🔴 여태 «칩이 없으면 나에게 한 말»이었다. **없는 것으로 구별하면 약하다** —
   * 긴 대화를 훑을 때 «빠뜨린 것»과 구별이 안 된다. 봇끼리 말하기(§7)가
   * 들어오면 그 차이가 매 줄 필요해진다.
   *
   * ★ **1:1 에서는 안 단다.** 받을 사람이 나뿐이라 아무것도 안 말해주는
   * 군더더기다 — 이름을 1:1 에서 생략하는 것과 같은 이유다(C9).
   */
  const alsoMe = m.role === "agent" && m.toUser === true && manyBots();
  if (to.length === 0 && !alsoMe) return null;

  const lost = new Set(m.notSentTo ?? (m.sendFailed ? m.deliveredTo : []));
  // ⏪ «줄 서 있음»은 없어졌다 (v3.0 1-E) — 말풍선이 있으면 **이미 간 것**이다
  const wait = new Set<string>();

  /*
   * ★ **못 간 곳은 칩에서 뺀다** (2026-09-23).
   *
   * 🔴 예전에는 그어서 남겼다 — «지우지 않는다»는 §0 뺄셈 규칙 때문이었다.
   * 그런데 **뺄셈 규칙은 «사라지면 안 된다»지 «여기 있어야 한다»가 아니다.**
   * 안 갔다는 사실은 말풍선 아래에 **글과 «다시 보내기»로** 더 분명히 남는다.
   *
   * 빼고 나니 칩 줄의 뜻이 **하나로 좁아진다**:
   *
   * ```
   * 예전   «받는 이»   — 간 것도 안 간 것도 섞여 있어 매번 표시를 읽어야 했다
   * 지금   «받은 사람» — 여기 있으면 갔다
   * ```
   *
   * 다 못 갔으면 칩이 **한 장도 안 남는다.** 그게 맞다 — 아무도 못 받았다.
   */
  const gotIt = to.filter((id) => !lost.has(id));
  if (gotIt.length === 0 && !alsoMe) return null;

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
  for (const id of gotIt) {
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
    // 못 간 것은 이미 걸러졌다 — 여기 남는 것은 «갔다»와 «줄에 서 있다»뿐이다
    const state = wait.has(id) ? " held" : "";
    /*
     * ★ **어디까지 갔나를 한 글자로** (2026-10-14).
     *
     * 🔴 여태 칩이 아는 것은 「큐에 넣었다」 하나였다. 그래서 **「봤는데 답을
     * 안 한 것」과 「아예 못 본 것」이 똑같이 보였다** — 봇끼리 말이 오가는
     * 방에서 그 둘은 전혀 다른 이야기다.
     *
     * ```
     * @베타     넣었다 — 아직 저쪽 턴이 안 왔다
     * @베타 ✓   건네졌다 — check_queue 가 꺼내줬다 (저쪽 맥락에 들어갔다)
     * @베타 ↩   반응했다 — say 로 돌아왔다
     * ```
     *
     * 🔴 **「읽었다」가 아니라 「건네줬다」다.** 글자가 저쪽에 들어간 것은
     * 확실하지만 모델이 읽었는지는 모른다 — 아는 것만 적는다.
     */
    /*
     * ⏪ **칩에는 «어디까지 갔나» 를 안 단다** (2026-10-14).
     *
     * 한 번 달아봤다 — `@베타 ✓`(건네졌다) · `@베타 ↩`(반응했다), 그리고 ↩ 는
     * 눌러서 그 답으로 뛰게. 사용자: *"칩에는 안해도돼"*.
     *
     * 칩은 **문장 맨 앞에 꽂혀 글과 한 줄로 흐르는 것**이라(여기 바로 위의
     * 주석) 글자가 하나만 더 붙어도 읽는 흐름을 끊는다. 「무엇에 반응했나」는
     * **말풍선 아래 인용**이 이미 말하고, 그쪽은 자리를 안 뺏는다.
     */
    row.append(
      el("span", {
        class: `chip to${state}${seen && !seen.gone ? "" : " gone"}`,
        text: seen ? (seen.gone ? `@${seen.name} (나감)` : `@${seen.name}`) : "@나간 봇",
        title: wait.has(id)
          ? "아직 줄에 서 있습니다"
          : seen?.gone
            ? `${seen.name}에게 전달되었습니다 — 그 뒤 방에서 나갔습니다`
            : seen
              ? `${seen.name}에게 전달되었습니다`
              : "이 봇은 방에서 나갔습니다",
      }),
    );
  }

  /*
   * ★ **«@사용자» 는 맨 뒤에** (2026-09-29).
   *
   * 봇 이름들 다음에 붙는다 — 대화의 흐름이 «봇들끼리 → 나에게» 인 경우가
   * 많고, 읽는 순서가 그 순서와 같은 편이 낫다.
   *
   * ★ **3인칭이다.** 칩은 **보내는 쪽 말풍선 안**에 들어가므로, «@나» 라고
   * 쓰면 그 «나»가 **말하는 봇**으로 읽힌다. «@사용자» 는 누가 읽어도 같은
   * 사람을 가리킨다 — 대화를 내보내거나 남에게 보여줄 때도 안 흔들린다.
   */
  if (alsoMe) {
    row.append(
      el("span", {
        class: "chip to me",
        /*
         * ★ **`@` 를 붙인다** (2026-09-29).
         *
         * 🔴 괄호만 두르고 `@` 를 빼먹었다. 바로 옆 봇 칩은 `@이름` 인데
         * 혼자 `(사용자)` 라서, **같은 줄에서 같은 일을 하는 칩 둘이 다른
         * 말투**였다. 멘션처럼 안 읽히니 «받는 이» 가 아니라 무슨 꼬리표처럼
         * 보인다.
         *
         * `@` 는 봇 칩과 같은 자리에서 붙이고, 괄호는 `USER_CHIP` 이 들고
         * 있는다 — 그게 **봇이 못 가지는 모양**이라 이름과 안 겹친다
         * (`cleanBotName` 이 괄호를 걷어낸다).
         */
        text: `@${USER_CHIP}`,
        title: "나에게 한 말입니다",
      }),
    );
  }
  return row;
}

/*
 * ⏪ **«⏳ 대기 중» 띠를 물린다** (v3.0 1-E).
 *
 * 말풍선 아래에 «이 말이 아직 줄에 서 있다»를 적던 자리다. 줄 자체를
 * 없앴으니 적을 것이 없다 — 보낸 말은 **언제나 이미 간 것**이고, 아직
 * 안 간 글은 애초에 말풍선이 아니라 **입력창 위 예약 칸**에 있다.
 *
 * 받는 이는 원래부터 여기가 아니라 말풍선 **안**이다(`deliveryChips`) —
 * 10px 회색 글씨가 말풍선 밖에 붙으니 안 읽혔고, §4.1.1 의 유일한 위험을
 * 막으려고 넣은 표시가 안 읽히면 아무 값이 없다.
 */

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
  /*
   * ★ **혼잣말에는 언제나 적는다** (2026-09-28).
   *
   * 짝이 되는 질문이 **없는** 말이다. «자명한가»를 따질 것이 아니라, 짝이
   * 없다는 사실 자체가 적어야 할 이유다 — 안 적으면 앞 답의 뒷부분으로 읽힌다.
   */
  if (isSpur(m)) return true;

  const answers = m.replyToIds ?? [];
  if (answers.length === 0) return false;
  if (answers.length > 1) return true;   // 묶여서 답한 것은 언제나 적는다

  /*
   * ★ **봇에게 건 말에는 언제나 적는다** (사용자, 2026-10-15).
   *
   * 그 말풍선은 **제 상자로 갈려** 나가므로(받는 이마다 하나), 아래의
   * «바로 위가 그 질문이면 자명하다» 가 더는 안 맞는다 — 사이에 사용자에게
   * 한 말이 끼고, 한 턴이 상자 여럿으로 흩어진다.
   *
   * 그리고 그 꼬리표가 **반응인지 답장인지**를 가른다(4.5-AF): 사용자가
   * 물은 것엔 「답합니다」, 봇의 말을 보고 쓴 것엔 「반응했습니다」.
   */
  if (botToBot(m)) return true;

  /*
   * ★ **`say(to: null)` 로 사용자에게 한 말에도 언제나 적는다**
   * (사용자, 2026-10-15).
   *
   * 그 말풍선은 **턴의 산문과 같은 턴, 다른 상자**다. 둘 다 `@(사용자)` 를
   * 달고 서므로, 갈라 읽히게 하는 것은 **이 꼬리표뿐**이다 — 사용자:
   * *"얘는 산문이랑 구별되게 별도의 말풍선으로 나오고 (반응을 달고)"*.
   *
   * 가르는 법: 턴의 산문은 **제가 묶음의 머리**다(`composeGroupId === id`).
   * `say` 가 만든 상자는 그 머리를 가리키므로 둘이 다르다. 새 칸을 안 만들고
   * **이미 있는 사실**로 가른다.
   */
  if (saidToUser(m)) return true;

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
      /*
       * ★ **사용량 — 참여자 바로 왼쪽** (사용자, 2026-10-19).
       *
       * 🔴 **봇에 관한 것들 옆에 둔다.** 잔량은 계정에 붙는 값이지만, 사람이
       * «얼마 남았지» 를 떠올리는 순간은 **이 방에서 일을 시키다가**다 —
       * 에이전트 설정 화면까지 가야 보이면 그때 길이 끊긴다.
       *
       * ⚠️ 수를 **달고 있지 않는다.** 머리에 늘 띄우는 것은 한 번 걷어낸
       * 길이다(ROADMAP B14: «노이즈다»). 누를 때만 보여준다.
       */
      el(
        "button",
        { class: "icon", title: "사용량", onclick: () => openQuota(r) },
        icon("pulse"),
      ),
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
          /*
           * ★ **«기록만» 이라고 적는다** (2026-10-15). 입력창과 단추를 걷어낸
           * 자리에 아무 말도 없으면 **고장 난 것처럼** 보인다 — 왜 없는지
           * 한 마디가 방 정보 줄에 붙는다.
           */
          text: `${agent?.label ?? "?"} · ${shortenPath(r.cwd)}`
            + (peeking === r.id ? " · 기록만" : ""),
        }),
      ),
      /*
       * ★ **기록만 읽는 방에는 여기까지다** (사용자, 2026-10-15) —
       * 뒤로가기와 방 정보만.
       *
       * 🔴 참여자·분기·⋮ 는 전부 **방에 붙어 있어야** 뜻이 있는 것들이다.
       * 세션을 안 붙이고 연 방에서 눌리면 «왜 아무 일도 안 일어나지»가 되고,
       * 어떤 것은 **붙이는 일을 몰래 시작**한다 — 17초를 피하려고 들어온
       * 자리에서 그러면 들어온 까닭이 사라진다.
       */
      // 참여자 서랍 — 봇에 관한 것이 모이는 자리 (§4.2.1)
      // 사용량 — 참여자 바로 왼쪽. 「기록만」 방에는 안 세운다(물을 세션이 없다)
      peeking === r.id ? null : el(
        "button",
        { class: "icon", title: "사용량", onclick: () => openQuota(r) },
        icon("pulse"),
      ),
      peeking === r.id ? null : el(
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
      peeking === r.id ? null : forkHeadButton(r),
      peeking === r.id ? null : el(
        "button",
        { class: "icon", title: "메뉴", onclick: (e: Event) => toggleMenu(e, r) },
        icon("kebab-vertical"),
      ),
    );
  }
  // 서랍이 열려 있으면 **같이 갱신된다** — 사용량과 작업 중 표시가
  // 멈춰 있으면 서랍을 보는 동안에는 아무 일도 안 일어나는 것처럼 보인다.
  if (screens.bots.firstElementChild) paintDrawer(r);
  /*
   * ★ **권한 시트도 같이 갱신된다.**
   *
   * 서랍에서 봇을 불렀는데 시트를 열면 **아까 그 봇이 없었다** — 열던
   * 순간의 참여자로 그려둔 채로 멈춰 있었기 때문이다. 내보낸 봇이 남아
   * 있는 것도 같은 이유다. 시트는 «지금 방에 누가 있나»를 보여주는 곳이므로
   * 방이 바뀌면 따라가야 한다.
   */
  if (screens.perm.firstElementChild) paintPermissionSheet(r);

  const atBottom = stick;
  const nodes: Node[] = [];
  /*
   * ★ **뷰에서는 그 봇이 본 것만 남긴다** (§5).
   *
   * 규칙은 코어와 **같은 함수**(`inBotView`)를 쓴다. v2.0 이 «멘션된 것만
   * 전달»하므로 이 뷰가 곧 **«그 봇이 실제로 본 전부»** 인데, 규칙이 어긋나면
   * 그 약속이 바로 거짓말이 된다.
   */
  const inView = viewBotId
    ? r.messages.filter((m) => inBotView(m, viewBotId!))
    : r.messages;

  /*
   * ★ **아직 안 간 말은 맨 아래로** (v2.x).
   *
   * 🔴 쓴 순서대로 늘어놓으면 **아직 안 간 것이 이미 일어난 일들 위에** 묻힌다 —
   * 줄에 선 사이에 옆 봇이 답하거나 시스템 줄 하나만 생겨도 그렇게 된다.
   * 바닥으로 내려가 «지금 어떻게 됐나»를 보려는데 정작 **안 끝난 것이 위에**
   * 있는 셈이다.
   *
   * 그래서 **«간 시각»으로 늘어놓는다**(`sentAt`). 아직 안 간 것은 그 값이
   * 없으므로 맨 뒤다.
   *
   * 🔴 **«대기 중이면 맨 아래»만으로는 부족했다.** 그러면 보내는 순간 조건이
   * 풀려 말풍선이 **위로 튄다** — 이미 본 것이 두 번 움직인다. `sentAt` 이
   * 박히면 내려간 자리에 그대로 머문다.
   *
   * 정렬은 **안정적**이라(JS `sort`) 같은 시각끼리는 원래 순서를 지킨다.
   */
  const orderAt = (m: Message): number => {
    /*
     * 🔴 **«대기 중이면 바닥»만 보면 안 된다.** 단체방에서는 한 말이 **한 봇에게는
     * 가고 한 봇은 기다리는** 일이 흔하다. 그때도 바닥으로 내리면 **답이 질문
     * 위에** 놓인다 — 실제로 그렇게 나왔다:
     *
     * ```
     * 구현의 답
     * 둘 다 봐줘   ⏳ Codex 대기 중     ← 질문이 답 아래로 내려갔다
     * ```
     *
     * 자리를 정하는 것은 «**대화에 들어온 시각**»이다. 한 명이라도 받았으면
     * 그 말은 이미 들어온 것이고(`sentAt` 이 그때 박힌다), 아무도 못 받았을
     * 때만 «아직 안 들어온 것»이라 바닥이다.
     *
     * 누가 받고 누가 기다리는지는 **한 줄에 이미 다 있다** — 받은 이는 칩으로,
     * 기다리는 이는 «⏳ … 대기 중»으로. 말풍선을 둘로 쪼갤 이유가 없다.
     */
    return m.placedAt ?? m.createdAt;
  };
  const sorted = [...inView].sort((x, y) => orderAt(x) - orderAt(y));

  /*
   * ★ **꼬리부터 백 개** — 그 위는 접는다.
   *
   * 🔴 **못 보면 안 되는 것은 창을 넓힌다.** 안 읽음 줄·찾아가 앉을 자리·
   * 분기 선이 창 밖이면 **그 줄이 통째로 사라진다** — 방을 열자마자 「여기서
   * 부터 안 읽음」이 없는 채로 바닥에 앉게 된다. 자르는 것이 **보이는 것을
   * 바꾸면** 안 된다.
   */
  const spot = (id?: string): number => (id ? sorted.findIndex((m) => m.id === id) : -1);
  let from = Math.max(0, sorted.length - shownCount);
  for (const must of [spot(firstUnreadId), spot(jumpToMessageId), spot(r.forkedAtMessageId)]) {
    if (must >= 0 && must < from) from = must;
  }
  const hidden = from;
  const shownMsgs = sorted.slice(from);
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
    const built = reuseOrBuild(
      m, agentOf(m, r), !broken && followsSame(above, m), needsAnswerNote(m, r.messages),
    );
    /*
     * ⏪ **앞 말풍선 안으로 밀어 넣어봤다** (2026-10-14) — `say` 도 그 턴에
     * 그 봇이 한 일이므로. 🔴 그러면 **사용자에게 한 말과 봇에게 한 말이 한
     * 상자에** 섞인다: *"> @봇1 이게 별개의 말풍선이 되어야함"*. 상자는
     * 갈리고, 이어 말하는 표시(이름 안 쓰기)가 둘을 묶어준다.
     */
    nodes.push(built);
    above = m;
    // 물려받은 대화가 끝나는 자리에 선 하나 (D2)
    if (r.forkedAtMessageId && m.id === r.forkedAtMessageId) {
      nodes.push(forkLine(r));
      // 선이 끼어들었으므로 다음 말은 이어지는 게 아니다 — 이름을 다시 쓴다
      above = undefined;
    }
  }
  /*
   * ★ **접어둔 것이 있으면 맨 위에 길을 낸다** (사용자, 2026-10-15).
   *
   * 🔴 **수를 적는다.** 「더 보기」만 있으면 **얼마나 묻혀 있는지**를 모르고,
   * 그걸 모르면 누를지 말지를 못 고른다.
   *
   * ⚠️ **누른 뒤에도 보던 자리에 머문다** — 위로 백 개가 끼어들면 읽던 줄이
   * 화면 밖으로 밀려난다. 바닥에서 잰 거리(`scrollHeight - scrollTop`)를
   * 그대로 되돌려 놓는다.
   */
  if (hidden > 0) {
    nodes.unshift(
      el(
        "div",
        { class: "back-jump more-up" },
        el(
          "button",
          {
            class: "link",
            onclick: () => {
              const c2 = chat;
              const keep = c2 ? c2.list.scrollHeight - c2.list.scrollTop : 0;
              shownCount += PAGE;
              paintChat(r);
              const now = chat;
              if (now) now.list.scrollTop = now.list.scrollHeight - keep;
            },
          },
          icon("arrow-up"),
          `이전 대화 ${hidden}개 더 보기`,
        ),
      ),
    );
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
          onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "log" }),
        }),
        /*
         * ★ **여기에도 «요약만» 이 있어야 한다** (2026-10-02).
         *
         * 사용자: *"세션 끕겼을때도 … 4개 있어야되지 않아?"*.
         * 갈아타기와 **같은 일**이다 — 세션이 없어졌으니 무엇을 실어
         * 다시 시작할지를 정하는 것. 문이 다르다고 고를 수 있는 것이 다르면
         * 사용자는 «어디서 들어왔느냐» 에 따라 다른 선택을 하게 된다.
         */
        el("button", {
          class: "link",
          text: "요약만 넘겨서 시작",
          title: "압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다.",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "summary" }),
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
            onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "log" }),
          }),
          el("button", {
            class: "link",
            text: "요약만 넘겨서 시작",
            title: "압축 요약과 최근 대화만 보냅니다.",
            onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "summary" }),
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
   * 군다 — 그 봇의 상태를 말한다.
   *
   * ⏪ **중단만은 다르다** (v3.0 1-D). 중지는 이제 하나뿐이라 **방이 통째로**
   * 멈춘다. 그러면 뷰의 약속과 어긋나는데, 둘 중 **거짓말을 안 하는 쪽**을
   * 고른다 — 봇이 둘 이상인 방에서는 글자를 «전부 중단»으로 적는다.
   * 「중단」이라고만 두면 **이 봇만 멈추는 줄 알고 누른다.**
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

  bar.replaceChildren(
    el("span", { class: "typing" }, el("i"), el("i"), el("i")),
    el("span", { text }),
  );

  /*
   * ★ **중단은 대화 위에 떠 있는 한 자리** (2026-10-13).
   *
   * 여기(상태 줄)와 말풍선 아래, **둘**에 있었다. 같은 일을 하는 단추가 둘이면
   * 어느 쪽이 무엇을 멈추는지부터 헷갈린다 — 실제로 한쪽은 «이 봇만» 이던
   * 시절의 자국이었다. 이제 한 자리다.
   *
   * 턴이 도는 동안에만 뜬다 — 멈출 것이 없을 때 서 있으면 누를 수 있는 줄 안다.
   * 뷰에서는 **그 봇의** 상태를 본다(`at`), 멈추기는 방 전체다(v3.0 1-D) —
   * 그래서 봇이 여럿이면 말이 «전부»로 바뀐다. 「중단」이라고만 두면 **이 봇만
   * 멈추는 줄 알고 누른다.**
   */
  if (!chat || chat.roomId !== r.id) return;
  const live = at === "streaming" || at === "tool" || at === "waiting";
  chat.stop.hidden = !live;
  const all = many || r.participants.length > 1;
  const say = chat.stop.querySelector(".stop-say");
  if (say) say.textContent = all ? "전부 중단" : "중단";
  chat.stop.title = all
    ? "이 방에서 도는 것을 전부 멈춥니다. 줄 서 있던 말도 안 갑니다."
    : "지금 답하는 것을 끊습니다";
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
    // 혼잣말 표시 — 늦게 붙을 수 있다 (2026-09-28)
    (m.afterIds ?? []).join(","),
    m.afterToolId ?? "",
    // 봇 색 — 바꾸면 말풍선을 다시 칠해야 한다 (2026-09-28)
    (m.authorBotId ? room?.participants.find((b) => b.id === m.authorBotId)?.color : "") ?? "",
    (m.authorBotId ? room?.participants.find((b) => b.id === m.authorBotId)?.ink : "") ?? "",
    // 나에게 한 말인가 — 칩이 붙고 떨어진다 (2026-09-29)
    m.toUser ? "me" : "",
    // 버리면서 남긴 말은 접혀서 선다 (2026-10-15)
    m.aside ? "a" : "",
    // 자리를 잡으면 **순서가 바뀐다** — 다시 그려야 한다 (대기 정렬)
    m.placedAt ?? "",
    (m.notSentTo ?? []).join(","),
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

  /*
   * ★ **사용자가 고른 색만 싣는다** (2026-09-28).
   *
   * 값은 CSS 변수로만 넘기고 **섞는 일은 스타일시트가 한다** —
   * `color-mix(… , var(--bubble-bot-bg))` 로 **테마가 준 배경**과 섞으므로
   * 다크·라이트가 저절로 따라온다.
   *
   * 🔴 처음에는 에이전트 색으로 **떨어지게** 해놓고 «안 고른 방은 오늘과
   * 똑같이 보인다»고 적었는데 **거짓이었다.** 그러면 모든 봇 말풍선이 처음부터
   * 브랜드색으로 물든다 — 아무도 안 골랐는데 화면이 바뀌는 것이다.
   *
   * 게다가 그 «에이전트 색»(`#d97757`·`#10a37f`)은 **우리가 박아넣은 값**이지
   * 테마가 준 것이 아니다. 작은 점에 쓰는 것은 C9 가 허락한 예외인데, 말풍선
   * 배경까지 그걸로 칠하면 예외가 규칙을 먹는다.
   *
   * **기본은 테마 그대로다.** 고른 적이 있을 때만 칠한다.
   */
  const mineBot = m.role === "agent"
    ? (m.authorBotId ? room?.participants.find((b) => b.id === m.authorBotId) : room?.participants[0])
    : undefined;
  const chosen = mineBot?.color;

  const node = el("div", {
    class: `msg ${m.role}${m.sendFailed ? " failed" : ""}${grouped ? " grouped" : ""}`,
    ...(chosen
      ? { style: { "--bot": chosen, "--ink": mineBot?.ink === "black" ? "#000" : "#fff" } }
      : {}),
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
    /*
     * ★ **이름과 사용량을 알약 하나로** (사용자, 2026-10-14).
     *
     * 🔴 *"봇 이름이 잘 안보여서"*. 흐린 글자 한 줄이라 **대화가 길어지면
     * 누가 말하는지가 묻힌다** — 봇이 여럿이면 그게 제일 먼저 알아야 할
     * 것인데.
     *
     * **테마를 뒤집어 칠한다** — 어두운 테마면 흰 알약, 밝은 테마면 검은
     * 알약. 글자색과 배경색을 **서로 바꿔 쓰면** 테마가 무엇이든 대비가
     * 제일 센 짝이 나온다(색을 우리가 고르지 않는다 — §C9).
     *
     * 사용량도 그 안에 넣는다. 둘 다 «이 봇이 지금 어떤가»라 **한 덩어리**고,
     * 떨어져 있으면 알약 옆에 흐린 숫자가 따로 떠서 더 시끄럽다.
     */
    node.append(
      el(
        "div",
        { class: "who" },
        el("span", { class: "dot", style: { background: botColor(who) } }),
        /*
         * 🔴 **봇 이름이지 에이전트 이름이 아니다.**
         *
         * 에이전트 라벨을 쓰고 있었는데, 그러면 같은 에이전트로 봇을 둘 두면
         * «알파»와 «알파 2»가 **둘 다 «알파»로** 보인다 — 누가 말했는지를
         * 구별할 수 없게 된다. 이름은 봇에 붙고(B1) 멘션도 그 이름으로 간다.
         */
        el(
          "span",
          { class: "name-pill" },
          who?.name ?? (goneName ? `${goneName.name} (나감)` : undefined)
            ?? agent?.label ?? "에이전트",
          usageChip(who),
        ),
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
  /*
   * ★ **말풍선 하나가 전체를 감싼다** (사용자, 2026-10-14).
   *
   * ⏪ 조각마다 말풍선이었다 — 글·활동·글이면 상자가 셋. 🔴 그러면 **고른
   * 색이 조각마다 끊긴다**: *"그 색을 고른 말풍선이 전체를 감싸야함"*.
   * 한 턴은 **한 덩어리**고, 그 안에서 순서를 지키는 것은 그대로다(C3).
   */
  const wrap = el("div", { class: "bubble" });

  /*
   * ★ **토큰은 제 줄에** (사용자, 2026-10-14) — *"메시지는 항상 토큰에서
   * 줄 바꿈 이후 나옴 (토큰과 같은 라인에는 토큰만 존재)"*.
   *
   * ⏪ 첫 문단 **안**에 꽂았다 — 메신저의 멘션처럼 글과 한 줄로 흐르게.
   * 🔴 그런데 받는 이가 둘셋이면 **첫 문장이 칩에 밀려** 어디서 시작하는지
   * 가 흐려진다. 토큰은 «누구에게»를 말하는 머리고, 글은 그 다음이다.
   */
  /*
   * 🔴 **접히는 말은 여기서 토큰 줄을 안 만든다** (2026-10-14 · 2026-10-15).
   *
   * 그 칩은 **접는 머리로** 올라간다(`relayFold`) — 거기 이미 «누구에게»가
   * 있는데 안에서 또 적으면 **같은 칩이 두 번** 보인다.
   *
   * 🔴 버린 말(`aside`)에서 실제로 그렇게 떴다 (사용자, 2026-10-15):
   *
   * ```
   * >@(사용자)      ← 접는 머리
   * @(사용자)       ← 말풍선 안 토큰 줄 (중복)
   * 봇2 자기소개 수신 완료
   * ```
   *
   * 봇끼리 말은 `toUser` 가 아니라 안 걸렸고, 버린 말은 **`toUser` 라** 걸렸다 —
   * 가르는 것은 «봇에게인가»가 아니라 **«접히는가»** 였다.
   */
  const folded = botToBot(m) || (m.aside === true && m.toUser === true);
  if (room && !folded) {
    const to = deliveryChips(m, room);
    if (to) wrap.append(el("div", { class: "to-line" }, to));
  }

  let lastSay: HTMLElement | undefined;
  for (const part of weave(m)) {
    if (part.kind === "tools") {
      wrap.append(toolPills(part.tools));
      continue;
    }
    const say = el("div", { class: "say" });
    renderMarkdown(say, part.text);
    wrap.append(say);
    lastSay = say;
  }

  /*
   * 점은 **«턴을 쥐고 있나»** 다 — 글자가 오나가 아니라(2026-10-13).
   * 승인 대기도 쥐고 있는 것이고(저쪽 턴은 열린 채 살아 있다), 조각이
   * 아니라 **감싼 것 하나**에 붙는다.
   */
  const at = m.authorBotId !== undefined ? botStatus[m.authorBotId] : undefined;
  const holding = at === "waiting" || at === "streaming" || at === "tool"
    || at === "permission";
  if (m.streaming && holding) {
    (lastSay ?? wrap).append(el("span", { class: "typing" }, el("i"), el("i"), el("i")));
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
   * ⏪ **«이 봇만 중단»이었다** (v3.0 1-D). 이제는 봇이 여럿이어도 같은 일을
   * 한다 — **방이 통째로** 멈춘다. 중지가 넷이면 각각이 MCP 큐·권한 대기·
   * 심사 줄과 어떤 관계인지 따로 정의해야 해서 하나로 모았다.
   *
   * 그래서 **자리는 그대로 두고 말만 바꾼다.** 멈추고 싶은 순간 보고 있는
   * 자리가 여기라는 사실은 안 변했고, 하는 일이 달라졌으니 **글자가 그걸
   * 말해야** 한다 — 「이 봇만」이 남아 있으면 거짓말이 된다.
   *
   * 말풍선은 스크롤하면 사라지므로 **위의 «중단»을 없애지 않는다** — 그건
   * 언제나 닿을 수 있는 자리다.
   */
  /*
   * ⏪ **말풍선 아래에서 걷었다** (2026-10-13).
   *
   * 사용자: *"전부 중단 버튼이 말풍선 아래있는게 맘에 안듬, 전송버튼 왼쪽에
   * 있게 하자"*.
   *
   * 말풍선마다 달리면 **답이 길어질수록 아래로 밀려 내려가고**, 스크롤하면
   * 사라진다. 그래서 위 상태 줄에도 같은 단추를 두고 있었는데 — 같은 일을
   * 하는 단추가 둘이었다. 이제 **입력줄 왼쪽 한 자리**다: 거긴 안 움직이고,
   * 멈추고 다시 쓰는 손이 이미 가 있는 자리다.
   */

  // 생각은 기본 접힘 — 읽고 싶을 때만 편다 (C2)
  if (m.thought) {
    wrap.append(
      el(
        "details",
        { class: "tool thought" },
        el("summary", {}, icon("lightbulb"), " 생각"),
        el("pre", { class: "thought-body" }, el("code", { text: m.thought })),
      ),
    );
  }

  /*
   * 뭐에 대한 답인지 — **자명하지 않을 때만** 보여준다 (C4).
   *
   * 🔴 **말풍선 «아래»다** (사용자, 2026-10-14). 한 번 안에 넣어봤는데
   * (「전체를 감싼다」를 넓게 읽어서) 그건 **글이 아니라 꼬리표**다 —
   * 안에 들어가면 봇이 한 말처럼 읽히고, 인용이 글 흐름을 끊는다.
   */
  const note = noteAnswer ? answerNote(m) : null;

  // 누구에게 갔고 누가 아직 줄에 서 있나 (§4.1.1)
  if (room) {
    const sent = null;
    if (sent) node.append(sent);
  }

  // 계획은 **결과가 아니라 약속**이다 — 접지 않고 말풍선 아래 그대로 보여준다
  if (m.plan) wrap.append(planNode(m.plan, m.id));
  if (m.attachments?.length) wrap.append(attachmentsNode(m));
  /*
   * 🔴 **파일 변경은 말풍선 «아래»다** (사용자, 2026-10-14).
   *
   * 활동 알약과 같은 모양이지만 자리가 다르다 — 활동은 **글 사이에** 끼는
   * 그 순간의 일이고, 이것은 **턴이 끝나고 난 뒤의 결과**다(그 턴에 무엇이
   * 바뀌었나). 안에 넣으면 마지막 문장 뒤에 붙어 **말의 일부처럼** 읽힌다.
   */
  const changed = m.files?.length ? filesNode(m) : null;

  /*
   * ★ **같은 말을 두 번 하지 않는다** (2026-10-13).
   *
   * 🔴 사용자가 받은 것: 「응답이 중단되었습니다.」 가 **두 줄.**
   *
   * 끊긴 답이 **빈 답**이면 `healAfterCrash` 가 둘을 같이 세운다 —
   * `truncated` 와 `error = "응답이 중단되었습니다."`. 말풍선이 통째로 비면
   * 아무 말도 없는 것보다는 낫기 때문인데, 그 둘이 **글자까지 똑같아서**
   * 나란히 두 번 떴다.
   *
   * 「잘렸다」 는 **자를 글이 있을 때** 하는 말이다. 글이 없으면 자를 것도
   * 없고, 그 자리는 `error` 한 줄이 맡는다.
   */
  if (m.truncated && m.text) {
    wrap.append(el("div", { class: "meta", text: "응답이 중단되었습니다." }));
  }
  if (m.error) wrap.append(el("div", { class: "meta error", text: m.error }));

  if (m.sendFailed) {
    wrap.append(
      el("div", { class: "meta error", text: m.sendFailed }),
      el("button", {
        class: "retry",
        text: "다시 보내기",
        onclick: () => room && post({ t: "retry", roomId: room.id, messageId: m.id }),
      }),
    );
  }

  /*
   * ★ **봇끼리 주고받은 말은 접는다** (사용자, 2026-10-14).
   *
   * 🔴 사용자: *"자기들끼리 주고 받는 메세지는 … 약간 주고받을때 정신없이
   * 엄청 길어져"*. 봇 둘이 세 번만 오가도 **내가 한 말이 화면 밖으로** 나간다 —
   * 그런데 그 말들은 **나에게 한 말이 아니다.**
   *
   * 🔴 **안 지운다**(§0). 접을 뿐이다 — 누가 누구에게 보냈는지는 **칩으로
   * 그 줄에 남고**, 펴면 글도 활동도 그대로 있다.
   */
  /*
   * ★ **봇끼리 보낸 말은 말풍선 «안»의 묶음 칩이다** (사용자, 2026-10-14).
   *
   * ⏪ 말풍선을 통째로 접었다 — 그러면 **말풍선 밖에 줄이 하나 더** 생긴다.
   * 사용자: *"전체 말풍선 안에 들어가있어야지, 이것도 봇1이 하는 메시지
   * 활동이잖아"*. 맞는 말이다 — `say` 는 그 턴에 그 봇이 **한 일**이고,
   * 활동 알약이 말풍선 안에 서는 것과 같은 자리다.
   *
   * 왼쪽 `>` 가 «숨겨진 것이 있다»는 표고, 누르면 **칩은 그대로 있고**
   * 글이 아래로 난다(`details` 가 원래 그렇게 생겼다).
   */
  /*
   * ★ **봇에게 보낸 말은 제 말풍선이다 — 받는 이마다 하나씩** (사용자,
   * 2026-10-14~15).
   *
   * ⏪ 두 번 돌았다. ① 말풍선을 통째로 접었다(밖에 줄이 하나 더 생겼다).
   * ② 앞 말풍선 **안에** 묶음 칩으로 넣었다 — 그러면 사용자에게 한 말과
   * 봇에게 한 말이 **한 상자에 섞인다**: *"> @봇1 이게 별개의 말풍선이
   * 되어야함"*.
   *
   * 지금은 **상자가 갈린다.** 사용자가 `@봇1 @봇2` 로 쓰면 코어가 받는
   * 이별로 쪼개 보내는 것과 같은 규칙이다(`mentions.ts`) — 받는 쪽에서는
   * 각각 한 통이므로 화면도 한 통씩이어야 읽기가 같다.
   */
  /*
   * ★ **버리면서 남긴 말도 접는다** (사용자, 2026-10-15):
   * *"그거는 사용자에게만 가지만, 확장형 말풍선(다른 봇에 보내는 것과
   * 같이)로 분리하게 / to user로 명시하면 그냥 말풍선"*.
   *
   * 🔴 가르는 것은 **적어 보냈나**다. `to: ["user"]` 는 사용자에게 한
   * 말이니 그냥 선다. `to: null` 은 **버린 것**이고, 사용자가 읽으라고
   * 쓴 글이 아니라 **장부에 남는 글**이라 펼쳐두면 대화가 그것으로 덮인다.
   */
  if (m.aside === true && m.toUser === true) {
    node.append(
      el(
        "div",
        { class: "row" },
        el("div", { class: "bubble" }, relayFold(m, room, USER_FOLD, [...wrap.childNodes])),
        !m.streaming ? el("span", { class: "time", text: hhmm(m.createdAt) }) : null,
      ),
    );
    if (changed) node.append(changed);
    if (note) node.append(note);
    return node;
  }

  if (botToBot(m)) {
    const ids = m.deliveredTo.filter((id) => id !== m.authorBotId);
    const inner = [...wrap.childNodes];
    ids.forEach((id, n) => {
      const kids = n === 0 ? inner : inner.map((k) => k.cloneNode(true) as ChildNode);
      node.append(
        el(
          "div",
          { class: "row" },
          el("div", { class: "bubble" }, relayFold(m, room, id, kids)),
          !m.streaming && n === ids.length - 1
            ? el("span", { class: "time", text: hhmm(m.createdAt) })
            : null,
        ),
      );
    });
  } else {
    node.append(
      el(
        "div",
        { class: "row" },
        wrap,
        !m.streaming ? el("span", { class: "time", text: hhmm(m.createdAt) }) : null,
      ),
    );
  }
  if (changed) node.append(changed);
  if (note) node.append(note);
  return node;
}

/** 펼쳐 둔 봇끼리 말풍선 — 글자가 올 때마다 다시 그리므로 **기억해 둬야 산다** */
const relayOpen = new Set<string>();

/**
 * **봇이 봇에게만 한 말인가.**
 *
 * 🔴 `toUser` 를 본다 — 「칩이 없으면 나에게 한 말」로 가르던 시절의 약점을
 * 메우려고 둔 칸이다(`Message.toUser`). 사용자에게도 한 말이면 **접지
 * 않는다**: 나한테 한 말을 감추는 것은 다른 이야기다.
 */
function botToBot(m: Message): boolean {
  if (m.role !== "agent" || m.toUser === true) return false;
  return m.deliveredTo.some((id) => id !== m.authorBotId);
}

/**
 * **`say(to: null)` 로 사용자에게 보낸 말인가** (사용자, 2026-10-15).
 *
 * 턴의 산문도 사용자에게 가지만 그것은 **묶음의 머리**다 — `composeGroupId`
 * 가 제 `id` 와 같다. `say` 가 만든 상자는 그 머리를 가리키므로 둘이 다르다.
 */
const saidToUser = (m: Message): boolean =>
  m.role === "agent"
  && m.toUser === true
  && m.composeGroupId !== undefined
  && m.composeGroupId !== m.id;

/**
 * **묶음 칩 하나** — 누르면 그 아래로 숨겨둔 것이 난다.
 *
 * ⚠️ **글은 안 건드린다.** 받은 자식들을 그대로 안에 넣을 뿐이라, 펴면
 * 평소와 똑같다(마크다운·활동·계획·답장 인용까지).
 */
/** 접힌 말풍선의 받는 이 자리에 쓰는 «사용자» 표 — 봇 id 와 안 섮인다 */
const USER_FOLD = "(사용자)";

function relayFold(m: Message, r: Room | null, to: string, kids: ChildNode[]): HTMLElement {
  const nameOfBot = (id: string): string => {
    if (id === USER_FOLD) return `@${USER_CHIP}`;
    const seen = r ? botLabel(r, id) : undefined;
    return seen ? `@${seen.name}` : "@나간 봇";
  };

  const key = `${m.id}:${to}`;
  const box = el("details", { class: "relay-fold", open: relayOpen.has(key) });
  box.append(
    el(
      "summary",
      {
        class: "relay-head",
        /*
         * 🔴 **`toggle` 로 적으면 놓친다** — 그 사건은 다음 차례에 오는데,
         * 같은 차례에 글자 조각이 또 오면 다시 그리는 쪽이 먼저다(계획을
         * 접을 때 겪은 그것). 누르는 순간 적는다.
         */
        onclick: () => {
          if (box.open) relayOpen.delete(key);
          else relayOpen.add(key);
        },
      },
      /*
       * ★ **접히면 «누가 누구에게» 하나뿐** (사용자, 2026-10-14) —
       * *"(@봇2->@봇1) 이렇게만 있는 메시지를 클릭하면 전체 메시지가 나오는
       * 느낌이 나을듯"*.
       *
       * ⏪ 한 줄 미리보기를 달아봤다. 🔴 그런데 **미리보기는 반쯤 읽히는
       * 글**이다 — 줄 끝이 «…» 로 잘리면 눈이 거기 머물고, 접은 보람이
       * 그만큼 준다. 봇끼리의 말은 **나에게 한 말이 아니므로** 평소엔
       * «오갔다»만 알면 되고, 궁금하면 누른다.
       */
      /*
       * ★ **받는 이 칩 하나** (사용자, 2026-10-14) — *"말풍선 안에 있으니까
       * @봇2 → @봇1 대신에 그냥 @봇1 칩이 나오고 누르면 메시지가 아래"*.
       *
       * ⏪ 한 알에 «보낸 이 → 받는 이» 를 다 넣었다. 🔴 그건 **말풍선 밖에
       * 혼자 섰을 때** 쓰던 모양이다 — 안으로 들어오면 **보낸 이는 말풍선이
       * 이미 말한다**(이름 알약). 같은 것을 두 번 적는 셈이다.
       *
       * 그래서 `@사용자` 와 **같은 취급**이다: 같은 `.chip.to`, 같은 자리.
       * 다른 것은 왼쪽의 `>` 하나뿐이고, 그게 «여기 숨은 글이 있다»를 말한다.
       */
      el("span", { class: "relay-mark", text: ">" }),
      el("span", { class: "chip to relay-token", text: nameOfBot(to) }),
    ),
  );
  for (const k of kids) box.append(k);
  return box;
}

/** 발췌 길이 — 한 줄에 여럿이 설 수 있어야 하므로 짧게 */
const EXCERPT = 20;

/**
 * ★ **무엇에 대한 답인지 — 질문마다 하나씩, 눌러서 갈 수 있게** (C4 · 2026-09-23).
 *
 * 🔴 여태 **둘 이상이면 발췌가 아예 없었다**: «질문 2개에 한 번에 답합니다».
 * 그런데 그게 **가장 헷갈리는 경우**다 — 줄에 서 있던 봇이 턴 끝에 묶어서
 * 받은 것이라, 묶인 질문들 사이에 **남의 말이 끼어 있다.** 하나일 때보다
 * 되레 안 보였다.
 *
 * 그래서 **개수 대신 발췌를 늘어놓는다.** 그러면 «누를 대상»이 곧 «발췌»가
 * 되어, 되돌아가기가 따로 붙는 기능이 아니라 **같은 것의 두 쓰임**이 된다.
 *
 * 🔴 **못 찾는 질문은 그냥 뺀다.** 압축(C11)으로 사라졌을 수 있는데, 그때
 * 눌러도 아무 일이 없는 단추를 두면 «고장»으로 읽힌다. 하나도 못 찾으면
 * 옛 문구로 떨어진다 — 그래도 «몇 개에 답했다»는 남겨야 한다.
 */
/**
 * **봇이 먼저 보낸 말인가** (2026-09-28).
 *
 * 턴 응답에는 «무슨 질문에 답하는지»가 **언제나** 붙는다(`replyToIds`).
 * 혼잣말에는 없다 — 가리킬 질문이 애초에 없기 때문이다. 그래서 그 빈칸이
 * 곧 «봇이 먼저 말했다»는 표시다.
 */
const isSpur = (m: Message): boolean =>
  m.role === "agent" && (m.replyToIds?.length ?? 0) === 0;

function answerNote(m: Message): HTMLElement | null {
  /*
   * ★ **«답합니다»와 «끝나서»를 가른다** (2026-09-28).
   *
   * 물어봐서 온 답이 아니라 **봇이 먼저 보낸 말**일 때가 있다. «답합니다»라고
   * 쓰면 거짓말이 된다 — 사용자는 그 질문을 한 적이 없다.
   *
   * 🔴 처음에는 «어느 대화에서 이어졌는지»만 적었는데, 그 판정이 **«마지막으로
   * 답한 턴»** 이라 **도중에 딴 말을 하면 그쪽으로 걸렸다.** 지금은 **깨운
   * 활동**을 짚고(`afterToolId`), 그 활동이 든 답변의 **원래 요청**으로 간다 —
   * 대화 순서가 아니라 **일**을 따라가므로 안 흔들린다.
   */
  /*
   * ★ **혼잣말은 «한 줄»로 끝낸다** (결정 2026-09-28).
   *
   * 한때 깨운 활동을 짚어 ««빌드 돌려놔줘»의 «npm run build»가 끝났습니다» 까지
   * 보여줬다. 실제로 짚였다. 그런데 **그 실이 우연에 가깝다** — 에이전트가
   * 결과를 말하려고 출력 파일을 «읽어주기 때문»이지 프로토콜이 이어준 것이
   * 아니다. 언젠가 그냥 *"끝났어"* 라고만 하면 끊긴다.
   *
   * 그러면 **같은 종류의 말풍선이 어떤 날은 가리키고 어떤 날은 안 가리킨다.**
   * 사용자는 그 차이가 무슨 뜻인지 알 수 없고, 있을 때는 믿게 된다. 그래서
   * **늘 같은 한 줄**로 둔다.
   *
   * ★ **«백그라운드 작업»이라고 단정하지 않는다.** 여태 본 혼잣말은 전부
   * 백그라운드 때문이었지만, 그것만이라고 확인한 적은 없다. 늘 참인 것만 쓴다.
   *
   * ⚠️ 표시는 안 해도 **기록은 남긴다**(`afterToolId`·`afterIds`). 마음이
   * 바뀌었을 때 지난 대화까지 되살릴 수 있어야 한다 — 우리는 기록자다(§0).
   */
  const spur = isSpur(m);
  if (spur) return el("div", { class: "meta", text: "↩ 봇이 먼저 보냈습니다" });

  const ids = m.replyToIds ?? [];
  if (ids.length === 0) return null;

  const asked = ids
    .map((id) => room?.messages.find((x) => x.id === id))
    .filter((x): x is Message => x !== undefined);

  if (asked.length === 0) {
    // «질문 1개에 한 번에» 는 말이 안 된다 — 하나면 그냥 «앞선 질문»이다
    return el("div", {
      class: "meta",
      text: ids.length === 1 ? "↩ 앞선 질문에 답합니다"
                             : `↩ 질문 ${ids.length}개에 한 번에 답합니다`,
    });
  }

  const note = el("div", { class: "meta answer-note" });
  note.append("↩ ");
  asked.forEach((q, i) => {
    // 띄어쓰기는 **글자로** 넣는다 — flex gap 으로 주면 뒤의 «에 답합니다»까지 떨어진다
    if (i > 0) note.append(" ");
    const one = q.text.replace(/\s+/g, " ").trim();
    note.append(
      el(
        "button",
        {
          class: "link jump",
          // 잘린 뒤를 보려면 여기 — 발췌는 짧아야 여럿이 한 줄에 선다
          title: one.slice(0, 200),
          onclick: () => jumpTo(q.id, true),
        },
        `«${one.length > EXCERPT ? `${one.slice(0, EXCERPT)}…` : one}»`,
      ),
    );
  });
  /*
   * ★ **«답합니다» 와 «반응했습니다» 를 가른다** (2026-10-14).
   *
   * 사용자가 물은 것에는 **답한다.** 그런데 봇이 봇의 말을 보고 쓴 글은
   * 물음에 대한 답이 아니다 — 받아서 **반응한** 것이다. 같은 말로 적으면
   * «내가 언제 그걸 물었지» 가 된다.
   *
   * 잇는 길과 찾아가기는 **똑같다** — 사용자: *"우리 말에 답장하는 메세지에
   * 연결된 것 처럼"*.
   */
  const toBot = asked.every((q) => q.role === "agent");
  note.append(
    asked.length > 1
      ? (toBot ? "에 한 번에 반응했습니다" : "에 한 번에 답합니다")
      : (toBot ? "에 반응했습니다" : "에 답합니다"),
  );
  return note;
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

/**
 * ★ **활동 하나 = 알약 하나** (사용자, 2026-10-14).
 *
 * ⏪ 여기는 **접는 묶음**이었다 — `▸ 활동 2개` 를 눌러 펴고, 그 안의 줄을
 * 또 펴서 명령과 결과를 봤다. 🔴 두 번 눌러야 보이는 것은 **안 보는 것**과
 * 비슷하고, 묶음이 접혀 있으면 «무엇을 했나»가 숫자 하나로 뭉개진다.
 * 사용자: *"활동 드랍테이블 삭제 및 각 활동을 알약으로"*.
 *
 * ★ **가로로 늘어놓는다 — 넘치면 줄을 바꾼다** (사용자). 말풍선 밖으로는
 * 안 나간다: 알약이 글보다 넓어지면 **말풍선이 활동 때문에 늘어난다.**
 *
 * 글자는 **도구 이름**이다(`title`) — `Bash`·`Read` 처럼 짧은 것이 와야
 * 한 줄에 여럿이 선다. 무엇을 했는지 자세히는 눌러서 본다.
 *
 * 누르면 상세가 **팝업**으로 뜬다 — 말풍선 안에서 펴면 글이 멀어진다.
 */
function toolPills(list: ToolActivity[]): HTMLElement {
  const box = el("div", { class: "acts" });
  for (const t of list) {
    box.append(
      el(
        "button",
        {
          class: `act-pill ${t.status}`,
          // 제목만으로는 `rm -rf` 와 `ls` 가 같다 — 손대기 전에 툴팁으로 한 번 (D1)
          title: t.command ?? t.paths?.join("\n") ?? t.title,
          onclick: () => showActivity(t),
        },
        icon(permIcon(t.kind)),
        el("span", { class: "what", text: t.title }),
        /* 승인 결과는 **그 활동에 붙는다**(D3) — 알약에는 표만, 까닭은 팝업에 */
        t.decision
          ? el("span", {
              class: `seal ${t.decision.mark === "✓" ? "ok" : t.decision.mark === "✕" ? "no" : ""}`,
              text: t.decision.mark,
            })
          : null,
      ),
    );
  }
  return box;
}

/**
 * 활동 하나의 **상세** — 무엇을 했고 무엇이 나왔나 (C3).
 *
 * 🔴 **그대로 보여준다.** 요약하면 판단 근거가 사라진다 — `Bash` 라고만
 * 적힌 줄로는 `ls` 인지 `rm -rf` 인지 알 수 없다(D1).
 */
function showActivity(t: ToolActivity): void {
  const why = t.decision
    ? `${t.decision.mark} ${t.decision.label}`
      + (t.decision.by ? ` · ${t.decision.by}` : "")
      + (t.decision.why ? ` · ${t.decision.why}` : "")
    : "";
  showModal(
    el(
      "div",
      { class: "card act-pop" },
      el(
        "div",
        { class: "card-title" },
        icon(permIcon(t.kind)),
        el("span", { class: "what", text: t.title }),
        t.at ? el("span", { class: "at", text: hhmm(t.at) }) : null,
      ),
      why
        ? el("div", {
            class: `seal ${t.decision?.mark === "✓" ? "ok" : t.decision?.mark === "✕" ? "no" : ""}`,
            text: why,
          })
        : null,
      t.command ? el("pre", { class: "act-in" }, el("code", { text: t.command })) : null,
      t.output ? el("pre", { class: "act-out" }, el("code", { text: t.output })) : null,
      ...(t.paths ?? []).map((p) =>
        el("button", {
          class: "file", text: shortenPath(p), title: "에디터에서 열기",
          onclick: () => post({ t: "openFile", path: p }),
        })),
      el(
        "div",
        { class: "card-actions" },
        el("button", { text: "닫기", onclick: () => closeModal() }),
      ),
    ),
  );
}

/**
 * ★ **펼쳐 둔 계획** (§5-N) — 말풍선 id 로.
 *
 * 🔴 **기억 안 하면 못 펼친다.** 이 화면은 글자가 올 때마다 다시 그려지는데,
 * `<details>` 는 새로 만들어지면 **닫힌 채**다 — 펼쳐놓고 보는 사이에 다음
 * 조각이 오면 눈앞에서 접힌다. 체크해 둔 승인(`ticked`)과 같은 자리다.
 */
const planOpen = new Set<string>();

/**
 * 에이전트가 세운 계획 (계획 모드).
 *
 * 🔴 여태 **받아서 버리고 있었다** — 계획을 세우라고 시켜놓고 화면에는
 * 아무것도 안 나왔다. 항목형이면 체크리스트로, 마크다운이면 그대로 그린다.
 *
 * ★ **접는다 — 머리 한 줄이 약속을 계속 말해주므로** (§5-N, 2026-10-14).
 *
 * ```
 * 접힘   ▸ 계획 — ▶ 테스트 돌려보기 (2/3)
 * 펼침   ☑ auth.ts 읽기 · ▶ 토큰 만료 처리 고치기 · ☐ 테스트 돌려보기
 * ```
 *
 * ⏪ 여기 *"계획은 결과가 아니라 **약속**이라 접지 않는다"* 고 적혀 있었다.
 * 그 근거가 **머리줄로 옮겨간다** — 지금 하는 칸이 머리에 떠 있으면 약속은
 * 안 깨진다. 🔴 반대로 **다 펴두면 긴 계획이 대화를 밀어낸다**: 열두 칸짜리
 * 계획이 말풍선마다 붙으면 **정작 봇이 한 말이 화면 밖**으로 나간다.
 */
function planNode(plan: NonNullable<Message["plan"]>, msgId: string): HTMLElement {
  const entries = plan.entries ?? [];
  const done = entries.filter((e) => e.status === "completed").length;
  /*
   * **지금 하는 칸.** 없으면 아직 시작 안 한 첫 칸 — 그것도 없으면 다 끝났다.
   * 🔴 «맨 앞»을 적으면 안 된다. 끝난 칸이 머리에 떠 있으면 **멈춘 것처럼**
   * 보인다.
   */
  const now = entries.find((e) => e.status === "in_progress")
    ?? entries.find((e) => e.status !== "completed");

  const box = el("details", { class: "plan", open: planOpen.has(msgId) });
  box.append(
    el(
      "summary",
      {
        class: "plan-head",
        /*
         * 🔴 **`toggle` 로 적으면 놓친다.** 그 사건은 **다음 차례**에 오는데,
         * 같은 차례에 글자 조각이 한 번 더 오면 다시 그려지는 쪽이 **먼저**다 —
         * 방금 편 것이 눈앞에서 접힌다(검사가 실제로 그걸 잡았다).
         *
         * 누르는 순간 적는다. 이때 `open` 은 **아직 바뀌기 전 값**이라 뒤집어
         * 읽는다.
         */
        onclick: () => {
          if (box.open) planOpen.delete(msgId);
          else planOpen.add(msgId);
        },
      },
      icon("chevron-right"),
      icon("checklist"),
      " 계획",
      now ? el("span", { class: "plan-now" }, " — ", icon(planIcon(now.status)), ` ${now.text}`) : null,
      entries.length > 0
        ? el("span", { class: "plan-count", text: ` (${done}/${entries.length})` })
        : null,
    ),
  );

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
      ...entries.map((e) =>
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

  /*
   * ★ **파일 변경도 활동이다** (사용자, 2026-10-14) — *"봇2 파일 1개 변경 →
   * 활동인데 안잡힘"*.
   *
   * ⏪ 여기만 **접는 상자**로 남아 있었다. 활동을 알약으로 바꾸면서 놓친
   * 자리다 — 「무엇을 했나」 중 하나인데 혼자 다른 모양이면 **눈이 두 규칙을
   * 외운다.** 같은 알약, 같은 손놀림(누르면 팝업).
   */
  const body = el(
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
    );

  return el(
    "div",
    { class: "acts" },
    el(
      "button",
      {
        class: "act-pill",
        title: files.map((f) => f.path).join("\n"),
        onclick: () =>
          showModal(
            el(
              "div",
              { class: "card act-pop" },
              el("div", { class: "card-title" }, icon("files"), ` ${label}`),
              body,
              el(
                "div",
                { class: "card-actions" },
                el("button", { text: "닫기", onclick: () => closeModal() }),
              ),
            ),
          ),
      },
      icon("files"),
      who ? el("span", { class: "by", text: who }) : null,
      el("span", { class: "what", text: label }),
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
 * 심사는 그 봇의 **큐에 들어간다** — 바빠도 바로 들어가고, 봇은 제 턴에
 * 꺼내 본다(v3.0 3-I). 그래서 기다리는 데 끝이 정해져 있지 않다.
 *
 * 🔴 그동안 **요청한 봇의 턴은 얼어 있다.** 안 보이면 «왜 아무 일도 안
 * 일어나지»가 되고, 그때 할 수 있는 일도 없다. 보여주고, **빠져나올 길**을 준다.
 *
 * ⏪ 한때 «줄 서는 중» 과 «물어보는 중» 을 갈라 그렸다. 묻는 것이 봇이 제
 * 턴에 꺼내 보는 일이 되면서 **우리가 그 순간을 모르게 됐다** — 한 모양이다.
 */
function reviewNode(w: ReviewWait, r: Room): HTMLElement {
  const name = (id: string) => r.participants.find((b) => b.id === id)?.name ?? "봇";
  return el(
    "div",
    { class: "card review-wait" },
    el(
      "div",
      { class: "card-title" },
      icon("watch"),
      ` ${name(w.askerBotId)}의 «${w.title}»`,
    ),
    el("div", {
      class: "dim",
      text: `${name(w.judgeBotId)}의 판단을 기다립니다.`,
    }),
    el(
      "div",
      { class: "card-actions" },
      el("button", {
        /*
         * ★ **같은 일이면 같은 이름** (2026-10-14) — 대기 화면의 단추와 한 글자도
         * 다르지 않다. 둘 다 `takeOverReview` 고, 둘 다 **그 하나를 내 큐로**
         * 옮긴다. 이름이 갈리면 «다른 일인가»가 생긴다.
         */
        text: "유저 승인으로",
        title: "이 요청 하나만 내가 답합니다 — 유저 승인 큐로 옮깁니다",
        onclick: () =>
          room && post({ t: "takeOverReview", roomId: room.id, reviewId: w.id }),
      }),
    ),
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

/** 내가 답할 것들 — 체크해 둔 것 중 사라진 것도 여기서 턴다 */
function asksIn(r: Room): AskCard[] {
  const mine = cards.filter((c) => c.roomId === r.id || c.roomId === "");
  for (const id of [...ticked]) if (!mine.some((c) => c.id === id)) ticked.delete(id);
  return mine;
}

/**
 * ★ **채팅에는 «왔다»만** (§5-M, 2026-10-14) — 답하는 자리는 유저 승인 화면이다.
 *
 * ⏪ 여기에 **카드가 통째로** 쌓였다(최대 44vh). 한 장일 때는 그게 제일 빨랐지만,
 * 🔴 쌓이면 **대화를 덮는다** — 그리고 봇의 큐를 화면으로 빼고 나니 같은 물건이
 * 두 모양이 됐다. 사용자가 고른 쪽: *"알림만 — 답하는 것은 전부 큰 화면에서"*.
 *
 * 🔴 **띠다, 메시지가 아니다.** 대화에 한 번 적고 마는 것은 **스크롤에 밀려**
 * «지금 몇 개가 기다리는지»를 못 말한다 — 부딪힘 띠가 배운 것과 같은 줄(§4.3).
 * 자리도 그대로 둔다: **머리 바로 아래**, 대화와 같이 안 흐른다.
 */
/**
 * ★ **승인은 입력창 바로 위에 쌓인다** (§5-M, 2026-10-14).
 *
 * ⏪ **두 번 옮겼다.** 처음에는 **머리 바로 아래**였다 — 대화가 바닥으로
 * 흐르므로 아래에 두면 밀린다는 것이 근거였다. 그 다음에는 **따로 한 화면**
 * 으로 뺐다 — 쌓이면 대화를 덮으므로. 둘 다 사용자가 물렸다:
 *
 * ```
 * 머리 아래   "승인 대기 알림이 위에 뜨니까 잘 안보임"
 * 따로 한 창  "창을 따로 만드니까 조금 불편한데"
 * ```
 *
 * 🔴 **눈은 입력창에 있다.** 답할 것이 거기 있어야 보이고, 답하고 나서
 * 이어서 칠 자리도 바로 아래다. 대화와 같이 안 흐르는 것은 그대로다 —
 * 스크롤 밖이라 밀려 올라가지 않는다.
 *
 * ★ **서넛까지만 보이고 그 다음은 스크롤** (사용자). 쌓이는 자리라 높이를
 * 안 묶으면 **대화를 덮는다** — 그게 화면으로 뺐던 까닭이었다.
 */
function paintApprovals(r: Room): void {
  const host = chat?.queue;
  if (!host) return;
  const mine = asksIn(r);
  if (mine.length === 0) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  const keep = host.scrollTop;

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

  const rows = mine.map((card) => {
    const tick = el("input", { type: "checkbox" }) as HTMLInputElement;
    tick.checked = ticked.has(card.id);
    tick.addEventListener("change", () => {
      if (tick.checked) ticked.add(card.id);
      else ticked.delete(card.id);
      paintApprovals(r);
    });
    return approvalCard(r, card, (c, optionId) => (answer(c, optionId), renderChat()), tick);
  });

  const picked = mine.filter((c) => ticked.has(c.id));
  const head = el(
      "div",
      { class: "approvals-head" },
      el("span", { class: "count", text: `승인 대기 ${mine.length}` }),
      picked.length > 0
        ? el("button", {
            class: "ok",
            // 개수는 **바로 위 «승인 대기 N»** 과 체크 표시가 이미 말한다.
            // 단추에까지 넣으면 길어지기만 하고, 길이가 계속 바뀌어 자리가 흔들린다.
            text: "선택 허용",
            title: `고른 ${picked.length}개를 «이번만» 허용합니다`,
            onclick: () => sweep(picked, true),
          })
        : null,
      picked.length > 0
        ? el("button", {
            class: "no",
            text: "선택 거절",
            title: `고른 ${picked.length}개를 «이번만» 거절합니다`,
            onclick: () => sweep(picked, false),
          })
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
            class: "ok",
            text: "전부 허용",
            title: `${mine.length}개를 «이번만» 허용합니다. «항상»은 하나씩 펴서 고르세요.`,
            onclick: () => sweep(mine, true),
          })
        : null,
      mine.length > 1
        ? el("button", {
            class: "no",
            text: "전부 거절",
            title: `${mine.length}개를 «이번만» 거절합니다.`,
            onclick: () => sweep(mine, false),
          })
        : null,
    );

  host.replaceChildren(head, ...rows);
  host.scrollTop = keep;
}

/**
 * ★ **승인 하나를 그린다 — 그리는 곳은 둘, 모양은 하나** (§5-M, 2026-10-14).
 *
 * 채팅의 승인 줄과 **대기 화면 위의 팝업**이 이 함수를 같이 쓴다.
 *
 * 🔴 **복사해 두면 갈린다.** 여기 있는 것은 전부 «무엇을 승인하는지»를 지키는
 * 장치다 — 보낼 말은 코드 상자에 안 넣고, 바꾸는 파일은 눌러서 열 수 있고,
 * «항상»은 펴야 나온다. 한쪽에만 고치면 **다른 쪽이 더 적게 보여주는 자리**가
 * 되고, 적게 보고 누르는 것이 곧 도장 찍기다(D1).
 *
 * 밖에서 받는 둘:
 *
 * ```
 * answer  답하고 **다시 그리는 것까지** — 채팅은 renderChat, 팝업은 닫기
 * tick    여럿 고르기 체크 상자. **팝업에는 없다**(한 장뿐이라 고를 것이 없다)
 * ```
 */
function approvalCard(
  r: Room,
  card: AskCard,
  answer: (card: AskCard, optionId?: string) => void,
  tick: HTMLElement | null,
): HTMLElement {
  const req = card.req;
  const from = req.askerBotId
    ? r.participants.find((b) => b.id === req.askerBotId)
    : undefined;
  const asker = r.participants.length > 1 ? from?.name : undefined;

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
  const quick = el(
    "span",
    { class: "quick" },
    /*
     * ★ **허용은 초록, 거절은 빨강** (2026-09-23).
     *
     * 🔴 «거절»이 흰 단추라 **글자를 읽어야만** 어느 쪽인지 알 수 있었다.
     * 승인 큐는 **여럿이 쌓이는 자리**라 하나씩 읽게 하면 안 된다 — 색이
     * 먼저 말하고 글자가 확인해 준다.
     *
     * 파괴적인 쪽(거절)을 **눈에 띄게** 둔다. 거절은 되돌릴 수 있지만
     * «잘못 허용»은 파일을 고치고 나서야 안다.
     */
    el("button", {
      class: "ok",
      text: "허용",
      title: "이번만 허용합니다. «항상»은 펴서 고르세요.",
      onclick: () => answer(card, onceOption(req, true)),
    }),
    el("button", {
      class: "no",
      text: "거절",
      onclick: () => answer(card, onceOption(req, false)),
    }),
  );

  // 펴면 **무엇을 승인하는지** 전부 (D1) — 제목만으로는 rm -rf 와 ls 가 같다
  const body = el("div", { class: "card-body" });
  /*
   * ★ **보낼 말을 그대로 보여준다** (v3.0 4-J).
   *
   * 봇이 봇을 부르는 승인이면 **무엇을 보내는가**가 판단의 전부다. 코드
   * 상자(`perm-cmd`)에 넣지 않는 이유는 그게 **명령처럼 보이기** 때문이다 —
   * 이건 사람 말이라 사람 말처럼 보여야 한다.
   */
  if (req.text) body.append(el("blockquote", { class: "perm-text", text: req.text }));
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
          onclick: () => answer(card, o.optionId),
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
          // 같은 이유로 제 상자에 담는다 — `toolsNode` 의 설명 참조
          el("span", { class: "what", text: req.title }),
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
  if (stack[stack.length - 1] === "perm") { back(); return; }
  paintPermissionSheet(r);
  push("perm");
}

/** 화면이므로 **돌아가기만** 하면 된다 — 그린 것은 남겨둔다(다시 열 때 깜빡임 없게) */
function closeSheet(): void {
  if (stack[stack.length - 1] === "perm") back();
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

  /*
   * ★ **화면이라 제자리에 갈아끼운다** (2026-09-30).
   *
   * 🔴 시트일 때는 «덮개를 깔고 올리기» 와 «갈아끼우기» 를 갈라야 했다 —
   * 갱신마다 다시 올라오면 보는 중에 화면이 계속 새로 나타났기 때문이다.
   * 화면이 되면서 그 갈래가 통째로 없어졌다. 뜨고 지는 것은 스택이 한다.
   *
   * **스크롤은 지킨다.** 설정이 늦게 와서 다시 그릴 때마다 맨 위로 튀면
   * 읽던 자리를 잃는다 — 시트 시절에 겪은 그대로다.
   */
  const host = screens.perm;
  const keep = host.scrollTop;
  host.replaceChildren(
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "돌아가기", onclick: () => closeSheet() }, icon("arrow-left")),
      el("h1", {}, icon("shield"), " 권한 설정"),
    ),
    relayRow(r),
    ...r.participants.map((bot) => botPolicyBlock(r, bot)),
    // `replaceChildren` 는 `el()` 과 달리 `null` 을 안 걸러준다
    ...[sharedMemoryRow(r)].filter((n): n is HTMLElement => n !== null),
  );
  host.scrollTop = keep;
}

/**
 * ★ **봇끼리 부르기 — 권한 설정 맨 위** (v3.0 2-F).
 *
 * 🔴 **그것도 권한이다.** 봇이 다른 봇을 부르는 것은 «누가 무엇을 할 수
 * 있나»의 한 줄이고, 봇별 권한보다 **위에** 있는 결정이다 — 이게 꺼져
 * 있으면 아래 줄들이 다 무의미하다.
 *
 * 지금은 **길이 서 있나**만 말한다. 켜고 끄는 것과 상한은 §4 에서 이 줄에
 * 붙는다.
 *
 * 🔴 **왜 안 되는지를 같이 적는다.** 루프백이 막힌 기계가 있는데, 조용히
 * 안 되면 «왜 안 부르지»를 영영 못 푼다. 그리고 **자동으로 다시 안 한다** —
 * 「몇 초마다」라는 숫자가 하나 생기고 그 숫자는 아무도 고를 수 없다.
 */
function relayRow(r: Room): HTMLElement {
  // 아래 봇 칸들과 **같은 상자**를 쓴다 — 같은 화면의 같은 종류의 결정이다
  const box = el("div", { class: "sheet-bot relay" });
  box.append(el("div", { class: "who" }, el("span", { class: "name", text: "봇끼리 부르기" })));

  if (mcpAt.at === "ready") {
    box.append(relayPick(r), capRow(r));
    return box;
  }

  box.append(
    el(
      "div",
      { class: "policy" },
      el("span", {
        class: "bad",
        text: mcpAt.at === "failed"
          ? `쓸 수 없습니다 — ${mcpAt.why}`
          : "아직 서지 않았습니다.",
      }),
      el(
        "button",
        {
          class: "link",
          title: "봇끼리 부르는 길을 다시 세워봅니다.",
          onclick: () => post({ t: "retryMcp" }),
        },
        icon("refresh"),
        "다시 시도",
      ),
    ),
  );
  return box;
}

/**
 * ★ **세 칸** (v3.0 4-L).
 *
 * ```
 * 끔         say 가 와도 «이 방은 안 됩니다» 로 돌려보낸다
 * 물어봄      호출마다 승인 카드          ← 기본
 * 무조건 허용  안 묻는다. 상한만 건다
 * ```
 *
 * 🔴 **켜둔 걸 잊으면 안 되는 종류**라 입력창 옆이다. «무조건 허용»은
 * **사람이 스스로에게 주는 권한**이라 §4.2.2 의 «`*_always` 는 봇에게 안
 * 준다»와 어긋나지 않는다.
 */
function relayPick(r: Room): HTMLElement {
  const now = r.relay ?? "ask";
  const pick = (mode: "off" | "ask" | "always", text: string, why: string) =>
    el("button", {
      class: now === mode ? "pill on" : "pill",
      text,
      title: why,
      onclick: () => {
        if (now === mode) return;
        post({ t: "setRelay", roomId: r.id, relay: mode });
      },
    });
  return el(
    "div",
    { class: "policy relay-pick" },
    pick("off", "끔", "say 가 와도 돌려보냅니다."),
    pick("ask", "물어봄", "봇이 다른 봇을 부를 때마다 승인 카드가 뜹니다."),
    pick("always", "무조건 허용", "안 묻습니다. 아래 상한만 겁니다."),
  );
}

/**
 * ★ **깊이 상한 — «사용자에게서 몇 다리까지»** (v3.0 4-L).
 *
 * ```
 * 0  사용자 메시지
 * 1  거기 반응해서 봇이 거는 말
 * 2  그 말에 반응해서 거는 말 — **답도 반응이다**
 * ```
 *
 * 🔴 **«무조건 허용» 일 때만 걸린다.** 「물어봄」은 **답까지 전부** 사람이
 * 누르므로 상한이 할 일이 없다. 그래서 다른 칸일 때는 **흐리게** 둔다 —
 * 숨기면 «언제 쓰이는 값이지»가 되고, 그냥 두면 «지금도 걸리나»가 된다.
 */
function capRow(r: Room): HTMLElement {
  const live = (r.relay ?? "ask") === "always";
  const box = el("input", {
    type: "number",
    class: "cap",
    min: "0",
    max: "999",
    value: String(r.depthCap ?? 12),
    title:
      "사용자 말이 깊이 0 입니다. 거기 반응해 거는 말이 1, 그 말에 반응해 거는 " +
      "말이 2 — **답도 반응이라 한 칸 늘어납니다.** 이만큼을 넘으면 say 가 " +
      "거절됩니다. 0 이면 제한 없음.",
  }) as HTMLInputElement;
  if (!live) box.disabled = true;
  const commit = () => {
    const n = Number(box.value);
    if (!Number.isFinite(n)) { box.value = String(r.depthCap ?? 12); return; }
    post({ t: "setRelayDepth", roomId: r.id, depth: n });
  };
  box.addEventListener("change", commit);
  return el(
    "div",
    { class: live ? "policy cap-row" : "policy cap-row off" },
    /*
     * ⏪ «사용자에게서 N 다리까지» 였다. **「다리」는 우리끼리 쓰던 말**이고
     * 화면 어디에도 풀어둔 데가 없었다 — 숫자를 고치는 사람이 **무엇을 고치는지
     * 모른다.** 설계가 내내 부르던 이름(«깊이»)을 그대로 쓴다.
     */
    el("span", { class: "dim", text: "봇끼리 이어지는 깊이" }),
    box,
    el("span", {
      class: "dim",
      // **0 이 무슨 뜻인지 그 자리에 적는다** — 숫자만 두면 «0 = 아예 못 한다» 로 읽는다
      text: !live
        ? "까지 — «무조건 허용» 에서만 걸립니다."
        : (r.depthCap ?? 12) === 0
          ? "— 제한 없음."
          : "까지. 넘으면 그 호출이 거절됩니다.",
    }),
  );
}

/** 봇 하나의 설정 — 권한 모드 · 승인 주체 · 질문 */
function botPolicyBlock(r: Room, bot: BotInstance): HTMLElement {
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
   * ★ **방에 있는 다른 봇이 그대로 선택지가 된다** (v3.0 3-P).
   *
   * ⏪ 여기는 오래 «사용자» 한 칸이었고 *"다른 봇에게 맡기는 것은 v3.0에서"*
   * 라고 적혀 있었다. **지금이 v3.0이다.** 심사(§4.2.2)는 큐·`verdict`·
   * 가로채기·기록까지 다 서 있고 검사도 붙어 있었다 — **켤 길만 없었다.**
   * 코어가 다 돌아가는데 화면이 안 닿는 것은 «아직»이 아니라 **구멍**이다.
   *
   * 🔴 **목록을 손으로 관리하지 않는다.** 방의 참여자가 곧 목록이라 봇을
   * 부르면 그 자리에서 선택지가 되고 내보내면 사라진다. 따로 적어두면
   * 「추가」 버튼이 하나 생기고, 그 목록은 **방과 어긋나기 시작한다.**
   *
   * 🔴 **자기 자신은 뺀다.** 같은 맥락에 있는 쪽이 «해도 된다»고 답하는 것은
   * 심사가 아니라 메아리다 — 코어도 같은 이유로 막는다(`askBotApprover`).
   *
   * 🔴 **길이 안 서면 새로 고르지 못하게 한다.** 심사는 심사 봇의 **큐**로
   * 가고 큐를 읽는 길은 MCP 서버다. 서버가 없으면 고를 수는 있는데 매 요청이
   * 조용히 사용자에게 되돌아온다 — **고른 적 없는 설정이 켜진 것처럼** 보인다.
   *
   * 🔴 **그런데 「봇끼리 부르기」가 꺼진 것과는 다르다.** 「끔」은 `say` 만
   * 막는다 — `relay` 를 보는 곳은 `relaySay` 하나뿐이고, `check_queue` 도
   * `verdict` 도 깨우기도 그대로 돈다. **말을 걸 수 있느냐와 권한을 누가
   * 보느냐는 다른 축**이고, 둘이 같이 묶이는 것은 **MCP 서버 하나**다.
   * 그래서 여기서 보는 것도 `mcpAt` 이지 `r.relay` 가 아니다 — 문구도
   * 저 토글의 이름(«봇끼리 부르기»)을 빌려 쓰면 안 된다.
   */
  const mates = r.participants.filter((b) => b.id !== bot.id);
  const mcpUp = mcpAt.at === "ready";
  const picked = bot.approver?.kind === "bot" ? bot.approver.botId : "user";

  const who = el("select") as HTMLSelectElement;
  who.append(el("option", { value: "user", text: "사용자", selected: picked === "user" }));
  for (const mate of mates) {
    who.append(
      el("option", {
        value: mate.id,
        text: mate.name,
        selected: picked === mate.id,
        // **이미 골라둔 것은 안 막는다** — 막으면 화면이 «사용자»라고 거짓말한다
        disabled: !mcpUp && picked !== mate.id,
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

  /** 고른 것에 따라 **무슨 일이 벌어지는지**를 적는다 — 규칙이 아니라 결과를 */
  const judge = mates.find((b) => b.id === picked);
  const whyWho = mates.length === 0
    ? "물어봐야 할 때 누가 답하나. 이 방엔 다른 봇이 없습니다."
    : !mcpUp
      ? "봇이 큐를 읽을 길이 아직 안 서서, 지금은 사용자에게만 물어볼 수 있습니다."
      : judge
        ? `${judge.name}의 큐로 갑니다. 넘기는 것은 «이번만»뿐이고 «항상»은 사용자 몫입니다.`
        : "물어봐야 할 때 누가 답하나. 봇에게 맡기면 그 봇의 큐로 갑니다.";
  rows.push(
    el(
      "div",
      { class: "field" },
      el("label", { text: "승인 주체" }),
      who,
      el("span", {
        class: !mcpUp && mates.length > 0 ? "bad" : "dim",
        text: whyWho,
        // 🔴 툴팁은 **보이는 글을 품어야** 한다 — 한 줄로 잘리기 때문이다
        title: whyWho,
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
    /*
     * ⏪ **칸 가장자리에 색을 긋던 것을 뺐다** (2026-09-30).
     *
     * 점이 작아 안 잡힌다고 왼쪽 테두리를 그 색으로 굵게 그었다. 🔴 그런데
     * 바로 앞에서 **칸을 상자로 묶어둔 참**이었다 — 상자가 이미 «여기서
     * 저기까지가 이 봇» 을 말하고 있으므로, 색줄은 **같은 말을 두 번** 하는
     * 것이 됐다. 구분은 상자가, 누구인지는 점이 맡는다.
     */
    { class: "sheet-bot" },
    el(
      "div",
      { class: "who" },
      // 이름은 이 칸의 주인공이다 — 참여자 화면과 같은 크기로 (`.who .name`)
      el("span", { class: "name", text: bot.name }),
      /*
       * ★ **점은 이름 «오른쪽»에** (2026-09-30).
       *
       * 🔴 왼쪽에 뒀더니 **이름이 뒤로 밀렸다.** 칸마다 첫 글자가 안 맞아
       * 이름을 훑기가 어렵다 — 이 화면에서 제일 먼저 찾는 것이 이름인데.
       * 오른쪽에 두면 이름들이 **같은 자리에서 시작**하고, 색은 그 옆에서
       * 따라온다.
       *
       * 🔴 그리고 색은 **에이전트 것이 아니라 봇 것**이어야 한다. 에이전트
       * 색을 쓰면 같은 에이전트로 봇을 둘 두었을 때 점이 똑같아진다 — 정작
       * 봇을 가려야 하는 화면에서 구별을 못 해준다.
       */
      el("span", { class: "dot", style: { background: botColor(bot) } }),
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
      el("button", { text: "닫기", onclick: () => closeModal() }),
      // 봇에 대한 것을 찾아 여기까지 온 사람을 **되돌려 보내지 않는다**
      el("button", { text: "참여자 보기", onclick: () => (closeModal(), paintDrawer(r), push("bots")) }),
    ),
  );

  /*
   * ★ **방 정보는 팔업이다** — 대화에 붙이지 않는다.
   *
   * 대화 아래에 붙는 카드들(승인·분기 다이얼로그)는 **답할 때까지 눈에
   * 보여야 하는 것**이라 거기 있는다. 방 정보는 반대다 — 보고 닫는 것이고,
   * 대화에 끼어들면 스크롤에 밀려 사라지고 기록처럼 보이기까지 한다.
   */
  showModal(card);
}

/**
 * 팝업을 **그 화면 위에** 띄운다 (기본은 채팅).
 *
 * 🔴 화면마다 따로 띄우는 이유: `.modal` 은 `position: absolute` 라 **가장
 * 가까운 자리 잡힌 조상**을 기준으로 선다. `.screen` 이 그것이다 — 다른 데
 * 붙이면 화면이 미끄러질 때 팝업만 제자리에 남는다.
 */
function showModal(node: HTMLElement, where: HTMLElement = screens.chat): void {
  closeModal();
  where.append(
    el("div", { class: "modal-veil", onclick: () => closeModal() }),
    el("div", { class: "modal" }, node),
  );
}

/**
 * ★ **구독 잔량 팝업** (사용자, 2026-10-19).
 *
 * 🔴 **대화를 안 건드린다.** 잔량은 어댑터의 슬래시 명령으로만 알 수 있는데
 * (`docs/SLASH.md`), 그걸 방으로 보내면 읽던 대화에 말풍선이 둘 남는다.
 * 저쪽은 조회용 세션을 따로 열고 닫는다 — 모델도 그 턴을 기억하지 않는다.
 *
 * ⚠️ **열자마자 안 묻는다.** 들고 있는 것이 있으면 그걸 먼저 보여주고,
 * 새로 받는 것은 **새로고침을 눌렀을 때**다. 열 때마다 물으면 팝업을 두 번
 * 여는 것만으로 세션이 둘 뜬다.
 */
function openQuota(r: Room): void {
  showModal(quotaCard(r));
  if (quota === null) askQuota(r);
}

function askQuota(r: Room): void {
  quotaBusy = true;
  post({ t: "quotaAsk", roomId: r.id });
  paintQuota();
}

/** 떠 있는 팝업만 갈아끼운다 — 열려 있지 않으면 아무 일도 안 한다 */
function paintQuota(): void {
  const old = document.querySelector(".quota-card");
  if (!old || !room) return;
  old.replaceWith(quotaCard(room));
}

/**
 * 호스트가 뜯어 보낸 한도를 **막대 줄**로 세운다. 빈 배열이면 **아무것도 안
 * 세운다** — 그 자리는 아래 «받은 글» 이 받아준다.
 *
 * ★ **화면은 뜯지 않는다** (리팩토링 ③, 2026-10-20). «쓴 양이냐 남은 양이냐» 는
 * 에이전트마다 반대인데, 그걸 아는 것은 애드온이다 — 화면은 에이전트를 몰라야
 * 한다(`docs/REFACTOR.md` §2). 그래서 `line.left` 는 **이미 «남은 양»** 이다.
 */
function quotaBars(lines: readonly QuotaLine[]): HTMLElement[] {
  return lines.map((line) => {
    const left = line.left;
    return el(
      "div",
      { class: "quota-bar" },
      el(
        "div",
        { class: "quota-bar-head" },
        el("span", { class: "quota-bar-name", text: line.label }),
        el("span", { class: "quota-bar-num", text: `${Math.round(left)}% 남음` }),
      ),
      el(
        "div",
        { class: "quota-track" },
        /*
         * ⚠️ **적게 남았을 때 눈에 띄어야 한다.** 20% 아래를 가른다 —
         * 색만으로 말하지 않으려고 수를 **늘 옆에 적어둔다**(C9).
         */
        el("div", {
          class: `quota-fill${left <= 20 ? " low" : ""}`,
          style: { width: `${left}%` },
        }),
      ),
      ...(line.resets
        ? [el("div", { class: "quota-at", text: `${line.resets} 에 다시 찹니다` })]
        : []),
    );
  });
}

function quotaCard(r: Room): HTMLElement {
  /** 이 방이 쓰는 에이전트만 — 잔량은 계정에 붙지 방에 붙지 않는다 */
  const mine = [...new Set(r.participants.map((b) => b.agentId))];
  const rows = mine.map((id) => {
    const got = quota?.find((q) => q.agentId === id);
    const label = agentRows.find((a) => a.id === id)?.label ?? id;
    if (quotaBusy && !got) {
      return el("div", { class: "quota-row" },
        el("div", { class: "quota-name" }, label),
        el("div", { class: "quota-why" }, "받는 중…"));
    }
    if (!got) {
      return el("div", { class: "quota-row" },
        el("div", { class: "quota-name" }, label),
        el("div", { class: "quota-why" }, "아직 안 받았습니다"));
    }
    return el("div", { class: "quota-row" },
      el("div", { class: "quota-name" }, label,
        el("span", { class: "sub", text: got.cmd ? ` /${got.cmd}` : "" })),
      /*
       * ★ **뜯은 것은 더하기만 한다** (사용자, 2026-10-19).
       *
       * 🔴 모양은 저쪽 판이 바뀌면 같이 바뀌므로 `parseQuota` 는 **언젠가
       * 반드시 틀린다.** 그래서 받은 글을 **버리지 않고 접어서** 들고
       * 있는다 — 막대가 안 서면 한 번 더 눌러 진짜 글을 본다. 잃는 것이
       * «막대» 뿐이면 틀려도 괜찮은 기능이 된다.
       */
      ...quotaBars(got.lines ?? []),
      got.text
        ? el(
            "details",
            { class: "quota-raw" },
            el("summary", { text: "받은 글" }),
            el("pre", { class: "quota-text", text: got.text }),
          )
        : el("div", { class: "quota-why" }, got.why ?? "빈손으로 왔습니다"),
      el("div", { class: "quota-at", text: `${new Date(got.at).toLocaleTimeString()} 기준` }));
  });

  return el(
    "div",
    { class: "card quota-card" },
    el("div", { class: "card-title" }, icon("pulse"), " 사용량"),
    el("div", { class: "card-body" }, ...rows),
    el(
      "div",
      { class: "card-actions" },
      el("button", { text: "닫기", onclick: () => closeModal() }),
      /* 강조는 **권하는 쪽**이 맨 오른쪽 — 여기서는 다시 받아오는 것이다 */
      el("button", {
        class: "primary",
        text: quotaBusy ? "받는 중…" : "새로고침",
        disabled: quotaBusy,
        onclick: () => askQuota(r),
      }),
    ),
  );
}

/** 팝업과 덮개를 함께 걷는다 — **어느 화면에 떠 있든** */
function closeModal(): void {
  for (const n of document.querySelectorAll(".modal-veil, .modal")) n.remove();
}

/**
 * ★ **한 줄 소개 — «하는 일»** (v3.0 4-K).
 *
 * 다른 봇들이 받는 명단 표의 한 칸이다. 비면 **칸이 빈다** — «(설명 없음)»
 * 같은 글자를 안 쓴다. 표에서는 빈 칸이 «없다»를 이미 말해준다.
 *
 * 🔴 **이름만으로는 «누구에게 넘길까»를 못 고른다.** 「리뷰어」는 우연히 역할을
 * 말해주지만 「알파·베타」로 지었으면 아무것도 안 알려준다.
 *
 * 저장은 **포커스를 뗄 때**다. 한 줄짜리라 단추를 하나 더 두면 그 단추가 글보다
 * 크다 — 역할이 단추를 갖는 것은 **여러 줄이고 길게 고치는 것**이기 때문이다.
 */
function blurbRow(r: Room, bot: BotInstance): HTMLElement {
  const box = el("input", {
    type: "text",
    class: "blurb",
    value: bot.blurb ?? "",
    placeholder: "예: 코드를 쓰고 고친다 — 다른 봇에게 이렇게 보입니다",
    title: "이 방의 다른 봇들이 받는 명단에 그대로 적힙니다.",
  }) as HTMLInputElement;
  const commit = () => {
    if ((bot.blurb ?? "") === box.value.trim()) return;
    post({ t: "setBlurb", roomId: r.id, blurb: box.value.trim(), botId: bot.id });
  };
  box.addEventListener("blur", commit);
  box.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") box.blur();
  });
  return el(
    "div",
    { class: "info-row blurb-row" },
    el("span", { class: "dim", text: "하는 일" }),
    box,
  );
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
      el("button", { text: "취소", onclick: () => renderChat() }),
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
      el("button", { text: "취소", onclick: () => renderChat() }),
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
            // 둘 다 «진행»이라 왼쪽이 약한 쪽, 오른쪽이 권하는 쪽이다
            el("button", {
              text: "기록만 두고 분기",
              title: "화면에는 남지만 에이전트는 위 대화를 모릅니다",
              onclick: () => go("fresh"),
            }),
            el("button", {
              class: "primary",
              text: "대화 넘겨서 분기",
              title: "지금까지의 대화를 글로 옮겨 보냅니다 — 토큰이 듭니다",
              onclick: () => go("refeed"),
            }),
          ]
        : [el("button", { class: "primary", text: "분기하기", onclick: () => go() })]),
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
  if (stack[stack.length - 1] === "bots") { back(); return; }
  paintDrawer(r);
  push("bots");
}

/** 권한 화면과 같다 — 돌아가기만 한다 */
function closeDrawer(): void {
  if (stack[stack.length - 1] === "bots") back();
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

  // 화면이 된 뒤로 «떠 있나» 가 아니라 «이미 그려 뒀나» 를 본다
  const was = screens.bots.firstElementChild ? screens.bots : null;

  /*
   * 🔴 **글을 쓰는 중이면 건드리지 않는다.**
   *
   * 이 함수는 상태·메시지가 올 때마다 도는데(`paintChat`), 갈아끼우면
   * **역할 입력과 이름 고치기가 통째로 날아간다.** 방 제목을 고치는 중에
   * 헤더를 안 건드리는 것과 같은 이유다.
   */
  /*
   * 🔴 **색 고르개는 예외다** (2026-09-28).
   *
   * 이 규칙은 «치던 글자가 날아간다»를 막으려는 것인데, `input[type=color]` 에는
   * **칠 글자가 없다.** 그런데 색을 고르고 나면 포커스가 거기 남아, 갱신이
   * 막혀서 **방금 고른 색이 서랍에 안 나타났다** — 말풍선만 바뀌고 고르개는
   * 그대로라 «안 먹었나» 싶어진다. 이름 바꾸기가 겪었던 그 문제와 같다.
   */
  const focus = document.activeElement;
  const typing = focus instanceof HTMLElement
    && /^(INPUT|TEXTAREA)$/.test(focus.tagName)
    && (focus as HTMLInputElement).type !== "color";
  if (was && focus && was.contains(focus) && typing) return;

  /*
   * ★ **화면이라 «열 때만 밀려 들어온다» 가 없어졌다** (2026-09-30).
   *
   * 🔴 서랍일 때는 `animation` 이 `.drawer` 에 붙어 있어서, 갱신마다 새
   * 엘리먼트로 갈아끼우느라 **상태가 한 번 바뀔 때마다 오른쪽에서 다시
   * 슬라이드됐다.** 보고 있는 중에 화면이 계속 새로 나타나는 꼴이었다.
   * `.opening` 을 붙였다 뗐다 하며 피해 다녔는데, 화면이 되면서 **그 문제
   * 자체가 없어졌다** — 뜨고 지는 것은 스택이 한다.
   *
   * 스크롤은 여전히 지킨다. 설정이 늦게 와서 다시 그릴 때마다 맨 위로
   * 튀면 보던 자리를 잃는다.
   */
  const keep = screens.bots.scrollTop;
  screens.bots.replaceChildren(
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "돌아가기", onclick: () => closeDrawer() }, icon("arrow-left")),
      el("h1", {}, icon("organization"), ` 참여자 ${r.participants.length}`),
    ),
    ...r.participants.map((bot) => drawerBot(r, bot)),
    ...[sharedMemoryRow(r), inviteRow(r)].filter((n): n is HTMLElement => n !== null),
  );
  screens.bots.scrollTop = keep;
}

/**
 * ★ **«대기 N ›» — 서랍 줄 오른쪽 끝** (§5-M, 2026-10-14).
 *
 * 🔴 **0 이면 아예 없다.** «대기 0» 을 띄우면 **아무 일도 없다는 것을 말하려고
 * 모든 줄에 자리를 하나씩 내주게** 된다 — 단체방이면 그 빈 단추가 참여자 수만큼
 * 선다. 있는 것만 보이면 **단추가 곧 알림**이다.
 */
function waitGo(r: Room, bot: BotInstance): HTMLElement | null {
  const mine = waiting.filter((w) => w.botId === bot.id);
  if (mine.length === 0) return null;
  const perms = mine.filter((w) => w.kind === "permission").length;
  return el(
    "button",
    {
      class: "ghost wait-go",
      title: perms > 0
        ? `${bot.name} 앞에 ${mine.length} 개 — 그중 ${perms} 개는 승인 요청입니다`
        : `${bot.name} 앞에 ${mine.length} 개가 서 있습니다`,
      onclick: () => openWaiting(r, bot.id),
    },
    icon("inbox"),
    ` 대기 ${mine.length} `,
    icon("chevron-right"),
  );
}

/** 서랍 «위에» 얹는다 — 뒤로가기 하나로 서랍으로 돌아온다 */
function openWaiting(r: Room, botId: string): void {
  waitBotId = botId;
  paintWaiting(r, botId);
  push("wait");
}

/**
 * ★ **그 봇 앞에 서 있는 것들** (§5-M).
 *
 * 두 종류가 한 줄 간격으로 선다. 🔴 **할 수 있는 일이 서로 다르다:**
 *
 * ```
 * 권한    낸 봇이 **얼어 있다**  → 「유저 승인으로」 — 내 큐로 옮기고 따라간다
 * 메시지  아무도 안 기다린다     → 「버리기」 — 그 봇은 영영 안 본다
 * ```
 *
 * 권한에 「버리기」를 안 주는 이유가 그것이다 — 버리면 **낸 봇이 영영
 * 기다린다.** 둘을 같은 단추로 묶으면 그 차이가 지워진다.
 */
function paintWaiting(r: Room, botId: string): void {
  const bot = r.participants.find((b) => b.id === botId);
  const mine = waiting.filter((w) => w.botId === botId);
  const keep = screens.wait.scrollTop;
  screens.wait.replaceChildren(
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "돌아가기", onclick: () => back() }, icon("arrow-left")),
      el("h1", {}, icon("inbox"), ` ${bot?.name ?? "봇"} — 대기 ${mine.length}`),
    ),
    /*
     * 🔴 **비면 화면을 닫지 않는다.** 마지막 하나를 처리한 순간 화면이 사라지면
     * «내가 뭘 한 거지» 가 된다 — 돌아가는 것은 사용자가 한다.
     */
    ...(mine.length === 0
      ? [el("div", { class: "empty", text: "대기가 없습니다." })]
      : mine.map((w) => waitRow(r, w))),
  );
  screens.wait.scrollTop = keep;
}

/** 대기 한 줄 — 누가 · 무엇을 · 내가 할 수 있는 것 */
/** 펼쳐 둔 대기 줄 — 큐가 바뀔 때마다 다시 그리므로 **기억해 둬야 산다** */
const waitOpen = new Set<string>();

function waitRow(r: Room, w: WaitItem): HTMLElement {
  const perm = w.kind === "permission";
  const box = el("details", { class: "card wait-item", open: waitOpen.has(w.id) });
  /* `append` 는 `null` 을 안 받는다 — `el` 과 달리 여기서 걸러낸다 */
  const kids: Kids = [
    el(
      "summary",
      {
        class: "card-title",
        onclick: () => {
          if (box.open) waitOpen.delete(w.id);
          else waitOpen.add(w.id);
        },
      },
      icon("chevron-right"),
      icon(perm ? "shield" : "comment"),
      ` ${w.from}의 ${perm ? "승인 요청" : "말"}`,
      el("span", { class: "wait-head", text: w.text }),
    ),
    el("div", { class: "wait-text", text: w.text }),
    // **무엇을 하려는지 그대로** — 제목만 보면 `rm -rf /` 와 `ls` 가 같다 (D1)
    w.command ? el("pre", { class: "wait-cmd" }, el("code", { text: w.command })) : null,
    ...(w.paths ?? []).map((p) =>
      el("button", {
        class: "file", text: shortenPath(p), title: "에디터에서 열기",
        onclick: () => post({ t: "openFile", path: p }),
      })),
    w.diff ? el("pre", { class: "preview" }, el("code", { text: w.diff.newText })) : null,
    el(
      "div",
      { class: "card-actions" },
      perm
        ? el("button", {
            class: "ok",
            text: "허용",
            title: "이번 한 번만 허용합니다 — 이 봇을 기다리지 않고 내가 답합니다",
            /*
             * ★ **그 자리에서 답한다** (사용자, 2026-10-14).
             *
             * ⏪ 여기 있던 것은 「유저 승인으로」 **하나**였다 — 가져오기만
             * 하고 답은 다른 자리에서. 사용자: *"펼쳐볼 수 있고 바로 승인,
             * 거절 할 수 있는게 더나을듯"*. 가져오는 것은 **우리 사정**이지
             * 사용자가 원하는 일이 아니었다.
             *
             * 🔴 **그래서 줄을 펼칠 수 있게 했다.** 안 보고 누르면 심사가
             * 아니라 도장 찍기다(D1) — 펼치면 명령·바뀌는 파일·미리보기가
             * 카드와 **같은 것**으로 나온다.
             *
             * ⚠️ 「항상 허용」은 여기 없다. 여럿을 한 번에 넘기는 자리에
             * «앞으로 전부»를 두지 않는 것과 같은 줄이다(§4.2.2).
             */
            /*
             * ★ **이 하나를 내 큐로 옮긴다** (사용자, 2026-10-14).
             *
             * 🔴 **답하는 것이 아니라 옮기는 것**이다 — 심사가 봇의 큐에서
             * 빠지고 **유저 승인 큐**에 선다. 그래서 이름이 「유저 승인으로」고,
             * 누르면 **그 큐로 따라간다**(카드가 돌아서 오므로 도착할 때).
             *
             * ⚠️ **이 요청 하나만이다.** 봇의 승인 설정은 안 바뀐다 — 다음
             * 요청은 그대로 그 봇에게 간다. 그 말이 단추에 안 들어가므로
             * **툴팁에 적는다.**
             *
             * ⏪ 두 번 돌았다: 채팅으로 내려보냈다가(줄을 비우러 온 화면에서
             * 내려갔다 올라오기를 반복하게 된다), 그 자리에 팝업으로 띄웠다가
             * (같은 물건이 두 모양이 된다). 큐에는 **큐의 자리**가 맞다.
             *
             * 🔴 [승인][거절] 두 단추로 쪼개지 않는 이유는 그대로다 — 이 줄에는
             * 제목과 명령뿐이고 **diff·바뀌는 파일·「항상 허용」은 카드에만**
             * 있다. 안 보고 누르면 심사가 아니라 도장 찍기다(D1).
             */
            onclick: () =>
              post({ t: "answerWaiting", roomId: r.id, botId: w.botId, id: w.id, allow: true }),
          })
        : el("button", {
            class: "ghost danger",
            text: "버리기",
            title: "이 봇은 이 말을 끝내 안 봅니다. 보낸 쪽 기록에는 그대로 남습니다.",
            onclick: () => post({ t: "dropWaiting", roomId: r.id, botId: w.botId, id: w.id }),
          }),
      perm
        ? el("button", {
            class: "no",
            text: "거절",
            title: "이번 한 번만 거절합니다",
            onclick: () =>
              post({ t: "answerWaiting", roomId: r.id, botId: w.botId, id: w.id, allow: false }),
          })
        : null,
    ),
  ];
  for (const k of kids) if (k) box.append(k);
  return box;
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
      onclick: () => askInvite(r),
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
          /*
           * ⏪ **여기만 단추 줄이었다** (2026-10-07).
           *
           * 바로 위 `agentSelect` 에 *"에이전트는 드롭다운으로"* 라고
           * 적어두고도 **부르기 화면은 빠뜨렸다.** 색 고르기를 빠뜨렸던
           * 것과 같은 자리다(바로 아래 주석).
           *
           * 🔴 **가리는 것도 틀렸다.** `boot.agents` 를 그대로 줄 세워
           * **안 받은 에이전트까지 고를 수 있었다** — 고르게 해두고
           * 부른 뒤에 막는 꼴이다. 드롭다운은 `agentAvail` 로 거른다.
           */
          agentSelect(draft, paint),
        ),
        /*
         * ★ **부를 때도 색을 정한다** (2026-09-29).
         *
         * 🔴 방 만들기에는 넣고 **여기는 빠뜨렸다.** 그런데 색이 제일 필요한
         * 순간이 바로 여기다 — 같은 에이전트를 하나 더 부를 때. 이름과 같은
         * 자리에 둔다.
         */
        el("div", { class: "field" },
          el("label", { text: "이름 (선택)" }),
          el("div", { class: "named" },
            name,
            colorPick(draft.color || undefined, draft.ink, (css, pickedInk) => {
              draft.color = css;
              draft.ink = pickedInk;
              paint();
            })),
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
        el("button", { text: "취소", onclick: () => back() }),
        el("button", {
          class: "primary",
          text: "부르기",
          onclick: () => {
            post({
              t: "addBot",
              roomId: r.id,
              agentId: draft.agentId,
              ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
              ...(draft.color?.trim() ? { color: draft.color.trim() } : {}),
              ...(draft.ink ? { ink: draft.ink } : {}),
              ...(draft.role.trim() ? { rolePrompt: draft.role.trim() } : {}),
              ...(draft.picks.size > 0 ? { configValues: Object.fromEntries(draft.picks) } : {}),
            });
            // 참여자 화면으로 돌아간다 — 거기 방금 부른 봇이 늘어 있다
            back();
          },
        }),
      ),
    );

    /*
     * 화면이라 **통째로 갈아끼운다.** 에이전트를 바꾸면 아래 칸들이 다 바뀌므로
     * 어차피 다시 그리는 자리다 — 카드 시절에도 `replaceWith` 였다.
     */
    screens.invite.replaceChildren(
      el(
        "header",
        { class: "bar" },
        el("button", { class: "icon", title: "돌아가기", onclick: () => back() }, icon("arrow-left")),
        el("h1", {}, icon("organization"), " 봇 부르기"),
      ),
      card,
    );
  };
  paint();
  push("invite");
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
  const mk = (label: string, title: string, carry: "log" | "summary" | "none") => {
    const refeed = carry !== "none";
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
          ...(refeed ? { refeedKind: carry } : {}),
          ...(model && opt ? { model: { configId: opt.configId, value: model } } : {}),
        });
      },
    }) as HTMLButtonElement;
    b.disabled = busy;
    return b;
  };
  /*
   * ★ **세 갈래 — 막음 화면과 같은 것** (2026-10-02).
   *
   * 사용자: *"에이전트가 없어져서 다른 에이전트로 바�때도 똑같이
   * 해줄래? (통일성)"*. 두 자리가 **같은 일**을 하는데 골라지는 것이
   * 다르면, 사용자는 어느 문으로 들어왔느냐에 따라 다른 선택을 하게 된다.
   */
  const goFeed = mk("대화 넘겨서 바꾸기", "지난 대화를 다음 메시지에 함께 보냅니다. 글자만 갑니다.", "log");
  const goSum = mk("요약만 넘겨서 바꾸기", "압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다.", "summary");
  const goBare = mk("기록만 두고 바꾸기", "대화는 화면에만 남고, 새 에이전트는 백지에서 시작합니다.", "none");

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
      goSum,
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
  /*
   * ⏪ **이름을 단추로 쓰던 것을 물렀다** (2026-09-30).
   *
   * v2.1 에서 봇별 뷰를 만들면서 **이름 자체를 입구**로 삼았다. 눌러지는 티가
   * 안 난다고 밑줄을 긋고 `›` 를 붙이며 애썼는데, 🔴 **이름은 읽는 것이지
   * 누르는 것이 아니다** — 무엇을 꾸며도 «이름인가 단추인가» 가 남는다.
   *
   * 입구를 아래 «1:1로 보기» 단추로 옮겼다. 압축·내보내기와 나란히 서면
   * «이 봇에 할 수 있는 일» 중 하나로 곧장 읽힌다.
   */
  const nameCell = el("span", { class: "name" }, el("span", { text: bot.name }));

  const head = el(
    "div",
    { class: "who" },
    nameCell,
    el("button", {
      class: "icon tiny",
      title: "이름 바꾸기",
      onclick: () => renameBotInline(r, bot, nameCell),
    }, icon("edit")),
    // 이름을 고치는 그 자리에서 색도 (2026-09-28)
    colorPick(bot.color, bot.ink, (css, pickedInk) =>
      post({ t: "setBotColor", roomId: r.id, botId: bot.id, color: css,
             ...(pickedInk ? { ink: pickedInk } : {}) })),
    busy ? el("span", { class: "typing" }, el("i"), el("i"), el("i")) : null,
    usageChip(bot),
    waitGo(r, bot),
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
  /*
   * 🔴 **안 받은 에이전트는 여기서도 뺀다** (2026-10-02).
   *
   * 사용자가 짚었다 — *"참여자 서랄에서 에이전트가 없는데 나오는
   * 경우도 있음"*. 방 만들기만 걸러두고 여길 놓쳐서, **고르면 그제서야
   * 막히는** 꼴이었다.
   *
   * 다만 지금 붙어 있는 것은 받지 않았어도 남긴다 — 고르개가 제 값을
   * 안 담고 있으면 **엉뙡한 것이 고른 것처럼 보인다.**
   */
  const choosable = [...agentById.values()].filter(
    (a) => agentAvail.has(a.id) || a.id === bot.agentId,
  );
  if (choosable.length > 1) {
    const pick = el("select") as HTMLSelectElement;
    for (const a of choosable) {
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
      drawerModel.set(bot.id, select.value);
      paintDrawer(r);
    });
    const staged = drawerModel.get(bot.id);
    if (!pending && staged !== undefined && staged !== String(model.current ?? "")) {
      select.value = staged;
    }
    const field = el("div", { class: "field" }, el("label", { text: labelOf(model) }), select);
    /*
     * «적용» 은 **고른 것이 지금것과 다를 때만** 나타난다. 항상 두면
     * 누를 일이 없는 단추가 줄마다 서 있게 된다.
     */
    if (!pending && staged !== undefined && staged !== String(model.current ?? "")) {
      field.append(el("button", {
        class: "primary", type: "button", text: "적용",
        onclick: () => {
          drawerModel.delete(bot.id);
          post({ t: "setConfig", roomId: r.id, configId: model.configId, value: staged, botId: bot.id });
        },
      }));
    }
    rows.push(field);
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

  /*
   * ★ **1:1 뷰로 가는 단추 — 압축과 내보내기 사이** (2026-09-30).
   *
   * 🔴 여태 **봇 이름 자체가 단추**였다(`.name-go`). 이름에 밑줄을 긋고 «들어갈
   * 수 있다는 티» 를 내려고 애썼는데, 그래도 **이름인지 단추인지 모호했다** —
   * 이름은 읽는 것이지 누르는 것이 아니다.
   *
   * 여기 있는 것들과 나란히 두면 «이 봇에 할 수 있는 일» 중 하나로 읽힌다.
   * 자리는 압축과 내보내기 사이다 — 내보내기는 **되돌릴 수 없는 것**이라 늘
   * 맨 끝에 있어야 하고, 그 앞이 평범한 동작들의 자리다.
   */
  if (r.participants.length > 1) {
    acts.push(
      el("button", {
        class: "ghost",
        text: "1:1로 보기",
        title: `${bot.name}와(과) 주고받은 것만 봅니다`,
        onclick: () => openBotView(bot.id),
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

  /*
   * ★ **«하는 일»이 역할 바로 위** (v3.0 4-K).
   *
   * 🔴 **둘은 다른 물건이고, 그 차이가 눈에 보여야 한다:**
   *
   * ```
   * 하는 일   남에게 보이는 소개  — 다른 봇의 명단 표에 그대로 적힌다
   * 역할      이 봇에게 주는 지시  — 남은 못 본다
   * ```
   *
   * 역할 글을 소개로 끌어다 쓰지 않는 이유가 여기 있다 — *"코드를 쓴 뒤 반드시
   * 리뷰어를 호출해라"* 의 첫 줄은 설명이 아니다. **우리가 넘겨짚는 것**이다.
   */
  rows.push(blurbRow(r, bot));
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
 * ★ **서랄에서 고른 모델 — «적용» 전까지** (2026-10-02).
 *
 * 사용자: *"채팅창 안에서 봇 모델 바꿀때도 적용 버튼을 추가하자.
 * 지금 선택하자마자 적용돼서 좀 그럴 수 있어"*.
 *
 * 모델을 바꾸는 것은 세션을 버리진 않지만 **다음 턴부터 다른 모델이
 * 답한다.** 고르개를 스치다 바뀜는 일이 아니다.
 */
const drawerModel = new Map<string, string>();

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

/**
 * ★ **그 말풍선으로 간다** (2026-09-23).
 *
 * 🔴 **이미 보이면 화면을 안 움직인다.** 눌렀더니 읽던 자리가 사라졌는데 정작
 * 목적지는 원래 보이던 것 — 그게 제일 나쁘다. **깜빡임이 본체고 스크롤은
 * 필요할 때만** 따라붙는다.
 *
 * `wantBack` 은 **방 안에서 뛸 때만** 참이다. 검색 결과로 방을 **열면서**
 * 뛰는 길(H3)에는 «읽던 자리»가 없다 — 막 들어온 참이라 돌아갈 데가 없다.
 */
function jumpTo(id: string, wantBack: boolean): void {
  const c = chat;
  const target = nodeCache.get(id)?.node;
  if (!c || !target?.isConnected) return;

  // 앞서 깜빡이던 것이 남아 있으면 «어느 쪽이지»가 된다 — 하나만 켠다
  c.list.querySelectorAll(".msg.jumped").forEach((old) => old.classList.remove("jumped"));

  const a = target.getBoundingClientRect();
  const b = c.list.getBoundingClientRect();
  if (a.top < b.top || a.bottom > b.bottom) {
    if (wantBack) {
      backTo = c.list.scrollTop;
      // **띠를 먼저 띄운다** — 띄우면 목록이 그만큼 짧아지므로, 자리는 그 뒤에 재야 맞다
      paintBack(true);
    }
    scrollInside(c.list, target, "center");
  }

  target.classList.add("jumped");
  setTimeout(() => target.classList.remove("jumped"), 1600);
}

/** «읽던 자리로» 띠를 켜고 끈다 */
function paintBack(on: boolean): void {
  const c = chat;
  if (!c) return;
  if (on) {
    replace(
      c.back,
      el(
        "button",
        { class: "link", onclick: () => {
          const now = chat;
          if (now && backTo !== undefined) now.list.scrollTop = backTo;
          paintBack(false);
        } },
        icon("arrow-down"),
        "읽던 자리로",
      ),
    );
  } else {
    backTo = undefined;
  }
  c.back.hidden = !on;
}

/**
 * ★ **«맨 아래로» 를 켜고 끈다** (사용자, 2026-10-15).
 *
 * 🔴 긴 대화를 위로 훑다 보면 **바닥으로 돌아갈 길이 손가락뿐**이다 — 봇이
 * 답하는 중이면 그 사이에도 내용이 자라서 끝이 멀어진다. «읽던 자리로»와
 * 같은 자리에 같은 모양으로 둔다.
 */
function paintDown(on: boolean): void {
  const c = chat;
  if (!c) return;
  /* 🔴 **«읽던 자리로»가 떠 있으면 비킨다** — 돌아갈 곳이 둘이면 안 된다 */
  const show = on && backTo === undefined;
  if (show && c.down.childElementCount === 0) {
    replace(
      c.down,
      el(
        "button",
        {
          class: "link",
          onclick: () => {
            const now = chat;
            if (!now) return;
            now.list.scrollTop = now.list.scrollHeight;
            stick = true;
            paintDown(false);
          },
        },
        icon("arrow-down"),
        "맨 아래로",
      ),
    );
  }
  c.down.hidden = !show;
}

function scrollIntoPlace(list: HTMLElement): void {
  const line = list.querySelector<HTMLElement>(".unread-line");
  if (line) {
    scrollInside(list, line, "center");
    return;
  }
  if (stick) {
    list.scrollTop = list.scrollHeight;
    paintDown(false);
  }
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
    // 손으로 바닥까지 내려왔으면 **이미 돌아온 것**이다 — 띠가 남아 있을 이유가 없다
    if (stick && backTo !== undefined) paintBack(false);
    /*
     * 🔴 **조금 올라간 것으로는 안 띄운다.** 한 줄 읽으려고 손가락을 굴린
     * 자리에 단추가 뜨면 **읽는 것을 가린다.** 한 화면쯤 올라가야 «돌아갈
     * 길»이 뜻이 생긴다.
     */
    paintDown(t.scrollHeight - t.scrollTop - t.clientHeight > t.clientHeight * 0.5);
    /*
     * ★ **위에 닿으면 저절로 백 개 더** (사용자, 2026-10-15) — *"그 100개까지
     * 다다르면 다시 100개 로딩해오는거지?"*.
     *
     * 띠는 그대로 둔다 — **눌러서도** 되는 것이 분명해야 «왜 멈췄지»가 안
     * 생기고, 저절로 이어지는 것은 그 위에 얹힌 편의다.
     *
     * ⚠️ **자리를 지킨다.** 위로 백 개가 끼어들면 읽던 줄이 화면 밖으로
     * 밀려난다 — 바닥에서 잰 거리를 그대로 되돌려 놓는다(띠를 누를 때와
     * 같은 셈법).
     */
    if (t.scrollTop < 40 && room && t.querySelector(".more-up")) {
      const keep = t.scrollHeight - t.scrollTop;
      shownCount += PAGE;
      paintChat(room);
      const now = chat;
      if (now) now.list.scrollTop = now.list.scrollHeight - keep;
    }
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
      // 🔴 심사 줄은 **방마다**다. 안 비우면 옆 방 것이 여기 붙는다.
      // 치워둔 글도 방을 갈아타면 보여줄 자리가 없다 — 그 방으로 돌아가면 다시 뜬다.
      /* 🔴 **창도 되돌린다** — 안 그러면 옆 방에서 편 만큼 여기서도 펴진다 */
      if (switching) { reviews = []; waiting = []; waitBotId = null; shownCount = PAGE; }
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

      /*
       * ★ **모델이 없어진 봇이 있으면 채팅 대신 고르기 화면으로** (2026-09-30).
       *
       * 방을 여는 순간 갈린다. `renderChat()` 은 위에서 그대로 돌려둔다 —
       * 고르고 나면 바로 그 방으로 들어가야 하므로 뒤에 준비돼 있어야 한다.
       *
       * 고르면 코어가 `modelGone` 을 지우고 방을 다시 내보낸다. 그때 이 자리가
       * **다시 돌아** 남은 봇이 없으면 채팅으로 넘긴다 — 봇이 여럿이면 하나씩
       * 지워지다가 마지막에 열린다.
       */
      /*
       * ★ **붙는 화면을 지나야 채팅이다** (2026-10-13).
       *
       * 🔴 여태 채팅이 먼저 열리고 뒤에서 붙었다. 그래서 **처음 쓰는 방에서
       * 모델이 없어졌으면 보던 채팅에서 끌려갔다** — `modelGone` 은 세션이
       * 열려야 정해지기 때문이다. 붙는 것을 앞에 세우면 판정이 **채팅을
       * 보여주기 전에** 끝난다.
       */
      if (stack[stack.length - 1] === "joining") {
        /*
         * 붙이는 일이 **이미 끝났다고** 들었으면 그대로 넘어간다.
         *
         * ★ 걸린 봇이 있어도 여기로 온다 (2026-10-13) — 아래 `needsModel` 이
         * 같이 센다. **다시 붙어보는 길이 여기로 돌아온다**: `retryJoin` 은
         * `joinDone` 을 다시 내지 않고(방은 이미 붙은 방이다) 끝에 방만
         * 내보내므로, 되면 채팅 · 또 걸리면 `fix` 를 **이 한 자리가** 가른다.
         */
        if (!joined.has(m.room.id)) { renderJoining(m.room); break; }
      }

      /* 붙는 화면에서도 여기로 빠진다 — 다 붙었고 막을 것도 없으면 채팅이다 */
      repaintBlock(m.room);

      /*
       * **방을 만들었으면 들어간다.** 생성 응답은 방 데이터만 주므로,
       * 화면 전환은 여기서 해야 한다 — 안 하면 만들기 화면에 그대로 선다.
       *
       * ★ **붙는 화면을 거친다** (사용자, 2026-10-15): *"새로운 방 만들때,
       * 방 진입시 로딩화면이 안뜨음, 같은 과정이 되어야될거 같은데"*.
       *
       * 🔴 만든 방도 **세션을 붙이는 것은 마찬가지**다(Antigravity 는 17초가
       * 걸린다). 그동안 빈 대화창에 서 있으면 «다 된 것» 으로 보여 글을 치게
       * 되고, 그 한 마디는 봇이 아직 없어서 **줄에 서 있다가 나중에 간다.**
       * 들어가는 길이 둘인데 모양이 다른 것도 그 자체로 헷갈림이다.
       */
      if (stack[stack.length - 1] === "new") {
        if (joined.has(m.room.id)) go("chat");
        else { renderJoining(m.room); go("joining"); }
      }
      if (jumpToMessageId) {
        // 막 들어온 참이라 «읽던 자리»가 없다 — 띠를 안 띄운다
        jumpTo(jumpToMessageId, false);
        jumpToMessageId = undefined;
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

    /*
     * ★ **예약을 돌려받았다** — 「수정」의 뒷반쪽 (v3.0 1-E).
     *
     * 쓰던 글은 누를 때 이미 치워뒀다(`stash`). 여기서는 돌려받은 것을
     * 입력창에 꽂기만 한다.
     */
    case "stagedBack":
      if (room?.id === m.roomId) {
        /*
         * 🔴 **칸이 비었다는 것을 여기서 바로 반영한다.** 코어도 방을 다시
         * 내보내지만 그건 따로 오는 소식이라, 기다리면 **«예약»과 «치워둔 글»이
         * 한 순간 같이** 보인다 — 둘이 동시에 안 뜬다는 것이 이 줄의 약속이다.
         */
        delete room.staged;
        putTokens(room, m.tokens);
        paintStaged(room);
        paintSendButton(room);
      }
      break;

    case "mcp":
      mcpAt = m.state;
      // 권한 화면을 보고 있는 중이면 그 자리에서 바뀐다 — [다시 시도] 의 답이다
      if (room && stack[stack.length - 1] === "perm") paintPermissionSheet(room);
      break;

    case "reviews":
      if (room?.id === m.roomId) {
        reviews = m.list;
        renderChat();
      }
      break;

    /*
     * ★ **대기는 두 자리에 떠 있다** (§5-M) — 서랍의 수와, 열어둔 대기 화면.
     *
     * 🔴 **둘 다 다시 그린다.** 서랍만 고치면 화면을 열어둔 채 항목이 닫혔을
     * 때 **이미 답한 것이 그대로 서 있고**, 거기서 「버리기」를 누르면 코어가
     * «그런 건 없다» 로 답한다 — 사용자 눈에는 단추가 먹지 않는 것이 된다.
     */
    case "waiting":
      if (room?.id === m.roomId) {
        waiting = m.list;
        if (stack.includes("bots")) paintDrawer(room);
        if (stack[stack.length - 1] === "wait" && waitBotId) paintWaiting(room, waitBotId);
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
      // 붙는 화면은 **봇별 상태로** 그려진다 — 바뀔 때마다 다시 그린다
      if (room?.id === m.roomId && stack[stack.length - 1] === "joining") {
        renderJoining(room);
      }
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

    /*
     * ★ **구독 잔량** (사용자, 2026-10-19).
     *
     * 팝업이 떠 있을 때만 다시 그린다 — 닫고 나서 늦게 온 답이 화면을
     * 흔들 이유가 없다. 다음에 열면 **마지막에 받은 것**이 먼저 서고,
     * 언제 받은 것인지는 줄마다 적힌다.
     */
    case "quota": {
      quota = m.list;
      quotaBusy = false;
      if (document.querySelector(".quota-card")) paintQuota();
      break;
    }

    case "agents": {
      agentRows = m.list;
      /*
       * 받거나 지우면 방 만들기 목록과 막음이 **같이** 바뀜다.
       * 설정 화면만 고치고 나면 받아놓고도 목록에 안 뜨는 꼴이 된다.
       */
      agentAvail.clear();
      for (const a of m.list) if (a.available) agentAvail.add(a.id);
      /* 로그인이 끝난 에이전트는 **띄웠다는 표시**를 지운다 — 단추가 다시 산다 */
      for (const a of m.list) if (a.state === "ready") loginAsked.delete(a.id);
      renderAgents();
      if (stack[stack.length - 1] === "new") renderNew();
      if (room) {
        /* ★ 로그인이 풀렸던 봇은 **저절로** 다시 붙는다 (4.5-U) */
        if (retryAfterLogin(room)) {
          renderJoining(room);
          /* 로봇 화면 위에서 눌렀으면 거기 그대로 — 뒤로 누르면 이 화면이다 */
          roomGo("joining");
          break;
        }
        repaintBlock(room);
      }
      break;
    }

    case "config": {
      const key = configKey(m.agentId, m.roomId, m.botId);
      configs.set(key, m.options);
      if (m.error) configErrors.set(key, m.error);
      else configErrors.delete(key);
      // 만들기 화면은 방이 없으므로 에이전트 몫만 받는다
      if (!m.roomId && stack[stack.length - 1] === "new") renderNew(m.error);
      // 서랍도 마찬가지다 — 열어둔 뒤에 온 설정이 갈 곳이 없으면
      // 모델 칸이 영영 비어 있거나 낡은 값을 보여준다
      if (room && m.roomId === room.id && screens.bots.firstElementChild) {
        paintDrawer(room);
      }
      // 열려 있는 권한 시트는 **늦게 온 설정을 받아 다시 그린다**
      if (room && m.roomId === room.id && screens.perm.firstElementChild) {
        paintPermissionSheet(room);
      }
      /*
       * ★ **«모델 다시 고르기» 띠도 늦게 온 설정을 기다린다** (2026-09-30).
       *
       * 🔴 설정은 방에 **들어올 때** 요청하고 답은 나중에 온다. 그런데 여기서
       * 다시 그리는 것은 서랍과 권한 시트뿐이었다 — 본문은 안 그린다. 그래서
       * 띠 안의 고르개가 **«목록을 불러오는 중…» 에서 영영 멈춘다.** 고르라고
       * 띄워놓고 고를 수가 없다.
       *
       * **그 띠가 떠 있을 때만** 다시 그린다. 설정 메시지마다 본문을 그리면
       * 스크롤 자리가 흔들린다.
       */
      /*
       * ★ **방 몴이 아닌 설정도 받는다** (2026-10-01).
       *
       * 갈아타기를 고르면 **아직 방에 없는 에이전트**의 모델을 골라야
       * 하는데, 그 설정은 `roomId` 없이 온다(«미리보기» 길). 방 것만
       * 받으면 에이전트를 골라도 **모델 줄이 영영 안 나타난다.**
       */
      if (room && needsModel(room).length > 0 && (!m.roomId || m.roomId === room.id)) {
        renderFix(room);
      }
      break;
    }

    case "ask": {
cards.push(m.card);
      if (room) renderChat();
      break;
    }

    // 우리가 답하지 않았는데 끝난 경우 — 패널이 닫혔거나 에이전트가 물러섰다
    case "askResolved":
      if (dropCard(m.id) && room) renderChat();
      break;

    case "auth":
      authList = m.list;
      authStuck = m.stuck;
      renderAuth();
      break;

    case "joinDone": {
      /*
       * 🔴 **방보다 먼저 와도 된다** (2026-10-13).
       *
       * 호스트는 방을 내보내는 것과 붙이는 것을 **따로** 한다 — 어느 쪽이
       * 먼저 닿을지 우리가 못 정한다. 먼저 오면 **적어뒀다가**, 방이 올 때
       * 그걸 보고 넘어간다. 순서에 기대면 그 기대가 틀리는 날 **붙는 화면에
       * 갇힌다** — `ready` 악수에서 이미 한 번 밟은 자리다.
       */
      joined.add(m.roomId);
      if (room?.id !== m.roomId) break;
      if (stack[stack.length - 1] === "joining") {
        /*
         * ★ **못 붙은 봇이 있으면 `fix` 로 간다** (2026-10-13).
         *
         * 🔴 여태 붙는 화면에 **남았다.** 그래서 결정하는 단추가 거기 달려야
         * 했고, 화면 둘이 같은 일을 반씩 했다. 붙는 일이 **다 끝난 뒤**에
         * 한 번만 넘어가면 — 걸린 봇이 한꺼번에 카드로 서고, 그 화면은
         * 기다리기만 하면 된다. `needsModel` 이 이제 걸린 봇도 센다.
         */
        repaintBlock(room);
      }
      break;
    }

    case "joinStep": {
      if (room?.id !== m.roomId) break;
      joinSteps.set(m.botId, m.step);
      if (stack[stack.length - 1] === "joining") renderJoining(room);
      break;
    }

    case "joinFail": {
      if (room?.id !== m.roomId) break;
      joinFails.set(m.botId, { kind: m.kind, why: m.why });
      const top = stack[stack.length - 1];
      if (top === "joining") renderJoining(room);
      // 카드가 서 있는 동안 **다른 봇이 또 걸릴 수 있다** — 그 자리에 더 그린다
      else if (top === "fix") renderFix(room);
      else if (top === "chat") {
        /*
         * ★ **채팅을 보던 중에 끊겨도 보인다** (4.5-V, 2026-10-13).
         *
         * 🔴 한 번 들어간 방은 다시 들어갈 때 **붙는 화면을 안 지난다**
         * (`joined`) — 바로 채팅이다. 그런데 호스트는 그동안 세션을 다시
         * 붙이고 있고, **그게 실패하면 아무 데도 안 보였다.** 잘 되면 상태
         * 줄로 지나가지만 실패는 지나갈 자리가 없다.
         *
         * **얹는다**(push) — 뒤로 누르면 보던 채팅이 그대로 있다.
         */
        renderJoining(room);
        roomGo("joining");
      }
      break;
    }

    case "nav":
      if (m.screen === "new") openNewRoom();
      else if (m.screen === "agents") {
        // 로봇 화면은 **목록 위에 얹는다** — 뒤로 하나면 목록으로 돌아간다
        post({ t: "agentsAsk" });
        renderAgents();
        push("agents");
      } else go("list");
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
      post({ t: "stopAll", roomId: room.id });
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
/*
 * 🔴 **확인 화면은 HTML 이 이미 띄워뒀다** — 여기서는 스택만 맞춰준다.
 * 안 맞추면 `paintScreens` 가 목록을 켜면서 **확인 화면을 덮는다.**
 */
if (boot.screen === "auth") { stack = ["auth"]; paintScreens(); renderAuth(); }

/*
 * ★ **다 떴다고 알린다 — 맨 마지막 줄이어야 한다** (2026-10-13).
 *
 * 🔴 이 앞에 보낸 것은 호스트가 **우리가 뜨기 전에** 보냈을 수 있고, 그건
 * 그냥 사라진다. 여기서 한 번 알리면 호스트가 **들고 있던 것을 다시** 준다.
 */
post({ t: "ready" });
