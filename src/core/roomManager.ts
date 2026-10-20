import { EventEmitter } from "node:events";
import type * as acp from "@agentclientprotocol/sdk";

import {
  type DecisionNote,
  describe,
} from "./acpConnection.js";
import type { McpResult, McpServer, McpState, McpTool } from "./mcpServer.js";
import type { RoomLocks } from "./roomLock.js";
import { BotQueue } from "./mcp/botQueue.js";
import { McpCalls, type McpPort } from "./mcp/calls.js";
import { Review, type ReviewPort } from "./review/review.js";
import { Rooms, rollUpLost, whose, type RoomsPort } from "./room/rooms.js";
import { Runtimes, type RuntimesPort } from "./room/runtimes.js";
import { AgentPool, type PoolPort } from "./session/pool.js";
import { SessionConfig, type ConfigPort } from "./session/config.js";
import { Sessions, type SessionsPort } from "./session/sessions.js";
import { Activity, type ActivityPort } from "./turn/activity.js";
import { Prompts, type PromptPort } from "./turn/prompt.js";
import { Forks, type ForkOptions, type ForkPort } from "./room/fork.js";
import { Turns, type TurnPort } from "./turn/turns.js";
import { withTimeout } from "./time.js";
import { messageId } from "./ids.js";
import {
  parseCompose,
  type ComposeParse,
  type ComposeToken,
} from "./mentions.js";
import type { RoomStore } from "./store.js";
import {
  createBotInstance,
  type AgentDef,
  type AnswerPolicy,
  type ReviewWait,
  type WaitItem,
  type Approver,
  type JoinFail,
  type JoinStep,
  ASK_USER,
  type BotInstance,
  type Attachment,
  type Message,
  type Room,
  type RoomMeta,
  type PermissionDecision,
  type PermissionRequest,
  isBusy,
  type RoomStatus,
  type RoomUsage,
  type Clash,
  uniqueBotName,
  cleanBotName,
  type SearchHit,
  type Staged,
  type RelayMode,
  DEFAULT_RELAY,
  DEFAULT_DEPTH_CAP,
  type AgentQuota,
  hasManyBots,
} from "./types.js";
import type { WorkspaceHost } from "./workspaceHost.js";

export interface RoomManagerOptions {
  host: WorkspaceHost;
  store: RoomStore;
  /** 받기·지우기로 바뀔다 — `setAgents` 를 통한다 */
  agents: AgentDef[];
  /** 설정 조회를 포기하는 시간. 테스트에서만 줄인다 */
  configProbeMs?: number;
  /**
   * 에이전트를 받아둔 자리 (`<globalStorage>`).
   *
   * 모델 목록을 **그 에이전트 폴더 옆에** 적어두려고 받는다(`keepOptions`).
   * 없으면 적지도 꺼내지도 않는다 — 검사처럼 받아둔 것이 없는 자리에서는
   * 쓸 일이 없다.
   */
  agentRoot?: string;
  /**
   * ★ **방 자리 — 같은 방은 한 창에서만** (v3.0 2-G).
   *
   * 없으면 안 막는다. 검사처럼 창이 하나뿐인 자리에서는 둘 이유가 없다.
   */
  locks?: RoomLocks;
  /**
   * ★ **봇끼리 말을 걸게 해주는 MCP 서버** (v3.0 2-F).
   *
   * 🔴 **주소만 받지 않고 서버를 받는다.** 세션마다 **다른 비밀**을 발급해야
   * 하는데(그래야 «누가 부르나»를 가른다), 그건 서버만 할 수 있는 일이다.
   *
   * 없으면 그냥 안 싣는다 — 그 창은 봇끼리 못 부르고, 나머지는 멀쩡하다.
   */
  mcp?: McpServer;
}

/**
 * 단체방의 봇 하나 (v2.0).
 *
 * v1.0의 «에이전트 하나 = 방 하나»를 그대로 여러 개로 늘린 것이다 — 모델·역할·
 * 권한이 전부 **봇에 붙는 값**이라(D2·B3) 봇마다 따로 받아야 한다.
 */
export interface BotSpec {
  agentId: string;
  rolePrompt?: string;
  /** 남에게 보이는 한 줄 소개 (v3.0 4-K) */
  blurb?: string;
  agentMode?: string;
  answerPolicy?: AnswerPolicy;
  /** 그 봇의 세션에 적용할 설정 — 모델·추론 강도 (B15) */
  configValues?: Record<string, string | boolean>;
  /**
   * ★ **부를 이름** (v2.2 앞당김). 비우면 에이전트 이름을 쓴다.
   *
   * 같은 에이전트로 봇을 둘 넣으면 `Claude`·`Claude 2` 가 되는데, 그러면
   * **@로 지목할 때 누가 누군지 알 수가 없다.** 만들 때 정할 수 있어야
   * 나중에 하나씩 고치지 않는다.
   */
  name?: string;
  /**
   * ★ **말풍선 색** (2026-09-28). 비우면 에이전트 색을 쓴다.
   *
   * 이름과 **같은 자리에서** 고르게 하려고 만들 때부터 받는다 — 방을 만든
   * 뒤에 하나씩 다시 고르게 하면 고르는 자리가 또 하나 생긴다.
   */
  color?: string;
  /** 그 위의 글자색 — 검정/하양 택1 (2026-09-28) */
  ink?: "black" | "white";
}

export interface CreateRoomOptions {
  /**
   * 1:1 방의 에이전트. **`bots`를 주면 무시된다.**
   *
   * v1.0 경로를 그대로 두려고 남긴다 — 부르는 쪽을 전부 고치지 않아도 되게.
   */
  agentId?: string;
  /** 단체방 (v2.0). 봇마다 에이전트·모델·역할을 따로 고른다 */
  bots?: BotSpec[];
  title?: string;
  cwd?: string;
  /** 봇 역할 (B3). 첫 프롬프트 앞에 프리픽스로 붙는다 */
  rolePrompt?: string;
  /**
   * 방 만들기 화면에서 고른 세션 설정 — 모델·추론 강도 등 (B15).
   *
   * `configId → 값`. 세션을 연 **직후, 첫 프롬프트 전에** 적용하므로 비용이 없다.
   */
  configValues?: Record<string, string | boolean>;
  /**
   * 봇의 권한 정책 (D2).
   *
   * **전역 설정이 없으므로 여기서 정해진다.** 비워두면 `DEFAULT_AUTO_APPROVE`.
   */
  agentMode?: string;
  answerPolicy?: AnswerPolicy;
}

/** 세션을 새로 열고 한 턴을 묻는 길이라 설정 조회보다 넉넉히 둔다 */
const USAGE_PROBE_MS = 120_000;

/*
 * ⏪ **`REVIEW_TIMEOUT_MS` 와 `REVIEW_WAIT_MS` 가 여기 있었다** (v3.0 3-I).
 *
 * 둘 다 **턴 하나를 쓰기 때문에** 생긴 숫자였다 — 심사 봇의 턴을 가로채
 * 물어봤으므로, 앞 일이 끝나기를 90초 기다리고(`WAIT`) 물어본 뒤 15초
 * 기다렸다(`TIMEOUT`).
 *
 * 큐는 턴을 안 쓴다. 봇이 **제 턴에** 꺼내 보고 답하므로 줄 설 이유도,
 * 답을 재촉할 이유도 없다. 기다리는 동안 요청한 봇이 얼어 있는 것은 그대로라
 * **보이게 하고 가로챌 수 있게** 하는데, 그건 숫자가 아니라 사람이 정한다.
 */

/*
 * ⏪ **`reviewPrompt` 와 `readVerdict` 가 여기 있었다** (v3.0 3-I).
 *
 * 심사를 **프롬프트로 물어보고 첫 줄을 읽어** 판단으로 삼았다. 첫 줄만 본
 * 이유는 뒤에 붙는 이유 글에서 `ALLOW` 를 주우면 *"ALLOW 할 수 없습니다"* 를
 * 허용으로 읽기 때문이었고, 그건 **인젝션이 통하는 자리**이기도 했다.
 *
 * 이제 답이 **도구**(`verdict`)로 온다 — `allow` 가 불리언이라 읽을 것이
 * 없다. 산문은 그냥 산문이고, 판정이 아니다.
 *
 * ★ **데이터 울타리는 안 없어졌다.** 자리만 옮겼다 — `check_queue` 의 도구
 * 설명과 항목의 `text`·`command`·`diff` 에 그대로 있다(2-H).
 */

/**
 * 방 안에서 **겹치지 않는 봇 이름**을 만든다.
 *
 * 이름이 곧 멘션 이름이라(B1) 둘이 같으면 `@Claude`가 누구를 가리키는지
 * 우리가 정할 수 없다. 겹치면 뒤에 수를 붙인다 — `Claude`, `Claude 2`, ...
 */
function uniqueName(wanted: string, others: BotInstance[]): string {
  return uniqueBotName(wanted, new Set(others.map((b) => b.name)));
}

/**
 * 오류 한 줄에서 **고치는 길**을 읽어낸다 (2026-10-13).
 *
 * ⚠️ **글자로 가른다.** ACP 는 오류에 종류를 안 싣는다 — `newSession` 이
 * auth 를 이미 우리 말로 바꿔두고(«…에 로그인이 필요합니다»), 안 받은
 * 에이전트는 `withInstalled` 가 «아직 받지 않았습니다» 로 바꿔둔다. 그
 * 두 자리가 **우리가 쓴 글**이라 여기서 알아볼 수 있다.
 *
 * 🔴 모르면 `other` 다 — 그쪽이 **[다시 시도]** 를 다는 쪽이라, 잘못 맞혀도
 * 사용자가 할 수 있는 일이 남는다. 거꾸로 `auth` 로 잘못 몰면 **로그인하라고
 * 보내놓고 아무것도 안 고쳐진다.**
 */
function whyJoin(say: string): JoinFail {
  if (say.includes("받지 않았습니다") || say.includes("알 수 없는 에이전트")) return "gone";
  if (say.includes("로그인")) return "auth";
  return "other";
}

type Events = {
  /** 목록 화면 갱신 */
  metas: [RoomMeta[]];
  /**
   * 방 전체 갱신. **구조가 바뀜 때만** 쓴다 (정책·제목·불러오기).
   *
   * 스트리밍에는 쓰지 않는다 — 그쪽은 `message`다.
   */
  room: [Room];
  /**
   * 메시지 하나만 바뀌었다 (roomId, 그 메시지).
   *
   * **스트리밍의 기본 경로다.** 방 전체를 내보내면 셀이 60ms마다
   * 대화 전체를 직렬화하게 되어 **비용이 대화 길이에 비례한다.**
   * 디스크를 JSONL append로 푸다 것과 같은 문제를 한 겹 위에서 푸는 것이다.
   */
  message: [string, Message];
  /**
   * ★ **그 봇이 방에 못 붙었다** — (roomId, botId, 까닭, 한 줄) (2026-10-13).
   *
   * 🔴 여태 이것을 **말풍선으로** 남겼다(`noteRoom`). 그러면 «세션을 열지
   * 못했습니다» 가 **대화 기록의 일부**가 된다 — 다음에 열면 그대로 있고,
   * 되먹임에도 실려 간다. 세션이 붙고 말고는 **우리 사정**이지 대화가 아니다.
   *
   * 그리고 `bindSession` 은 봇 전부를 `Promise.all` 로 묶어 **하나의 catch** 로
   * 받고 있었다 — 봇 셋 중 누가 못 붙었는지가 거기서 사라진다.
   */
  joinFail: [string, string, JoinFail, string];
  /** 그 봇이 **어느 칸**에 있나 — (roomId, botId, 칸) */
  joinStep: [string, string, JoinStep];
  /**
   * ★ **붙이는 일이 끝났다** — (roomId) (2026-10-13).
   *
   * 🔴 **「다 붙었다」를 화면이 추론하게 두면 안 된다.** 봇별 상태만 보고
   * 재면 **아직 한 줄도 안 온 때**와 **다 끝난 때**가 똑같아 보인다 —
   * 그러면 붙는 화면이 영영 서 있거나, 반대로 한 프레임 만에 지나간다.
   * 끝나는 때를 아는 것은 여기뿐이므로 여기서 말한다.
   */
  joinDone: [string];
  /**
   * 응답 대기 표시 (C10) — (roomId, 합친 상태, 봇별 상태).
   *
   * 봇별이 필요한 이유는 단체방이다 — «Claude는 답하는 중, Codex는 끝»을
   * 합친 값 하나로는 말할 수 없다.
   */
  status: [string, RoomStatus, Record<string, RoomStatus>];
  /**
   * **봇끼리 부르는 길이 어느 칸인가** (v3.0 2-F).
   *
   * 방마다가 아니라 **창마다**다 — 서버가 창에 하나이기 때문이다.
   */
  mcp: [McpState];
  /**
   * **줄 서 있는 심사들** (roomId, 목록) — §4.2.2.
   *
   * 심사 봇의 세션은 하나라 직렬이다(B1). 그래서 승인 요청이 여럿이면
   * **기다려야 한다.** 기다리는 것 자체는 옳다 — 남의 턴을 끊으면 그 일은
   * **자동으로 다시 이어지지 않기** 때문이다.
   *
   * 다만 기다리는 동안 **요청한 봇의 턴은 얼어 있다.** 그래서 보이게 한다:
   * 무엇이 누구를 기다리는지 보이면 사람이 **가로챌** 수 있다.
   */
  reviews: [string, ReviewWait[]];
  /**
   * **그 방의 봇들이 들고 있는 큐** (roomId, 목록) — §5-M.
   *
   * 🔴 `reviews` 와 겹치지 않는다. 저쪽은 «**얼어 있는 봇**이 누구를 기다리나»
   * 라 채팅에 띠로 뜨고, 이쪽은 «**이 봇 앞에** 무엇이 서 있나» 라 봇마다
   * 모인다 — 메시지는 아무도 안 얼리므로 저쪽에는 아예 안 뜬다.
   */
  waiting: [string, WaitItem[]];
  /**
   * **지금 부딪히는 파일들** (roomId, 목록) — §4.3.
   *
   * 🔴 **메시지로만 적으면 «지금»을 못 본다.** 시스템 메시지는 대화가 흐르면
   * 위로 밀려 올라가서, 사용자는 **부딪히는 중인지 이미 끝났는지 알 수 없다.**
   * 띠는 **지금 상태**고 메시지는 **그때 일어난 일**이다 — 둘 다 있어야 한다.
   */
  clashes: [string, Clash[]];
  /**
   * 방에서 일어난 오류 (roomId, 메시지).
   *
   * **이름이 `error`가 아닌 이유**: Node의 `EventEmitter`는 `'error'`를 특별 취급해
   * **리스너가 없으면 던진다.** 셸이 깜빡하면 에이전트 실패 하나가 확장 호스트를 죽인다.
   */
  roomError: [string, string];
  /** 오래 걸리는 중이라는 안내. 오류가 아니므로 따로 둔다 */
  notice: [string, string];
};

/**
 * 방의 수명과 대화를 관리한다.
 *
 * **에이전트당 프로세스 하나, 방마다 세션 하나**(A4·B1). 여러 방이 같은
 * CLI 프로세스를 공유하되 대화는 세션으로 격리된다.
 */
export class RoomManager extends EventEmitter<Events> {
  /**
   * ★ **연결 풀** — `core/session/pool.ts` (리팩토링 ⑧ L1, 2026-10-20).
   * 에이전트마다 CLI 하나. 방 쪽 일은 갈고리로 꽂는다(`poolPort`).
   */
  private readonly pool = new AgentPool(this.poolPort());
  /**
   * ★ **봇 상태** — `core/room/runtimes.ts` (리팩토링 ⑧ L1, 2026-10-20).
   * 저장(L0) 바로 위층이다.
   */
  private readonly runtimes = new Runtimes(this.runtimesPort());
  /**
   * ★ **열린 방 · 저장** — `core/room/rooms.ts` (리팩토링 ⑧ L0, 2026-10-20).
   *
   * 맨 아래층이다 — 다른 층이 다 쓰고, 이건 아무 층도 안 빌린다.
   */
  private readonly rooms = new Rooms(this.roomsPort());
  /**
   * ★ **세션 설정** — `core/session/config.ts` (리팩토링 ⑧ L2, 2026-10-20).
   * 에이전트별 선택지와 봇별 지금 값.
   */
  private readonly config = new SessionConfig(this.configPort());
  /**
   * ★ **세션** — `core/session/sessions.ts` (리팩토링 ⑧ L3, 2026-10-20).
   * 붙이기 · 되살리기 · 이어가기. 분기는 이걸 쓰는 손님이다.
   */
  private readonly sessions = new Sessions(this.sessionsPort());
  /** ★ **분기** — `core/room/fork.ts` (리팩토링 ⑨, 2026-10-20). 세션층의 손님이다 */
  private readonly forks = new Forks(this.forkPort());
  /** ★ **턴** — `core/turn/turns.ts` (리팩토링 ⑨, 2026-10-20). 아래층이 다 여기 모인다 */
  private readonly turns = new Turns(this.turnPort());
  /** 세션을 붙이는 중인 방들. 방을 빠르게 오가도 CLI를 두 번 부르지 않는다 */
  private readonly sessionFlight = new Map<string, Promise<void>>();
  /**
   * 사용자가 지금 보고 있는 방.
   *
   * **미읽음(B8)의 기준이다.** 이게 없으면 어느 방의 응답을 "안 읽었다"고 할지
   * 알 수 없다 — 방이 메모리에 로드되어 있다는 것과 사용자가 보고 있다는 건 다르다.
   */
  private activeRoomId: string | null = null;
  /** 초안 저장 디바운스. 타이핑마다 디스크를 때리지 않는다 */
  private draftTimer?: ReturnType<typeof setTimeout>;
  /** 그 초안이 **어느 방 것인지**. 활성 방과 다를 수 있다 */
  private draftRoomId?: string;
  /**
   * **줄 서 있는 심사들.** 열쇠는 `ReviewWait.id`.
   *
   * 사람이 가로채면 여기서 `takenOver` 를 세우고, 기다리던 쪽이 그걸 보고
   * 물러난다 — 중간에 프라미스를 깨우는 것보다 **상태 하나를 보는 편**이
   * 취소·타임아웃과 한 군데서 다뤄진다.
   */
  /**
   * 지금 예약을 내보내는 중인 방들.
   *
   * 🔴 턴이 끝나는 자리가 여러 군데라 **같은 예약을 두 번 보낼 수 있다** —
   * 단체방에서 둘이 거의 동시에 끝나면 양쪽 끝에서 한 번씩 부른다. 칸을
   * 먼저 비우긴 하지만, 비우는 것과 보내는 것 사이에 `await` 가 있어서
   * 그것만으로는 안 된다 — **먼저 찜하고 그다음 await** 다.
   */
  private readonly firing = new Set<string>();

  /**
   * ★ **봇에게 갈 것들** (v3.0 2-H) — 권한과 메시지가 한 큐에 있다.
   *
   * 디스크에 안 남긴다. 껐다 켜면 그 권한 요청 자체가 사라지고(세션이
   * 끊기므로), 간 적 없는 말은 **아무도 못 본 것**이다 — `ReviewWait` 와
   * 같은 선택이다(§4.2.2).
   */
  /**
   * 큐가 바뀌면 **그 방 화면에 알린다** (§5-M) — 알림을 거는 자리는 여기 하나다.
   */
  private readonly queue = new BotQueue((owner) => this.review.waitingChanged(owner));
  /**
   * ★ **활동 · 부딪힘** — `core/turn/activity.ts` (리팩토링 ⑨, 2026-10-20).
   * 도구·파일 변경을 대화에 적고, 같은 파일을 동시에 만지면 띠를 세운다.
   */
  private readonly activity = new Activity(this.activityPort());
  /** ★ **프롬프트 짓기** — `core/turn/prompt.ts` (리팩토링 ⑨, 2026-10-20) */
  private readonly prompts = new Prompts(this.promptPort());

  /**
   * ★ **MCP 도구층** — `core/mcp/calls.ts` (리팩토링 ②, 2026-10-20).
   *
   * 빌려 주는 것은 `McpPort` 에 적힌 것이 전부다. 값이 아니라 **읽는 길**을
   * 넘긴다(getter·화살표) — 필드가 어떤 차례로 채워지든 부를 때의 값을 본다.
   */
  private readonly mcp = new McpCalls(this.mcpPort());

  /**
   * ★ **권한·심사 층** — `core/review/review.ts` (리팩토링 ⑦-3, 2026-10-20).
   * 빌려 주는 것은 `ReviewPort` 에 적힌 것이 전부다.
   */
  private readonly review = new Review(this.reviewPort());

  private roomsPort(): RoomsPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get disk() { return self.opts.store; },
      get locks() { return self.opts.locks; },
      emitMessage: (roomId, message) => { this.emit("message", roomId, message); },
      emitMetas: (metas) => { this.emit("metas", metas); },
    };
  }

  private runtimesPort(): RuntimesPort {
    return {
      roomById: (roomId) => this.rooms.open.get(roomId),
      openRooms: () => this.rooms.open.values(),
      emitStatus: (roomId, status, bots) => { this.emit("status", roomId, status, bots); },
      emitClashes: (roomId) => { this.emit("clashes", roomId, this.activity.clashesIn(roomId)); },
    };
  }

  private poolPort(): PoolPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get host() { return self.opts.host; },
      get disk() { return self.opts.store; },
      agent: (agentId) => this.agentOrThrow(agentId),
      isDown: () => this.down,
      onCrash: (agentId, reason) => this.onAgentCrash(agentId, reason),
      recordDecision: (sessionId, note) => this.recordDecision(sessionId, note),
      askApprover: (sessionId, req) => this.askApprover(sessionId, req),
      emitNotice: (roomId, text) => { this.emit("notice", roomId, text); },
    };
  }

  private configPort(): ConfigPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get host() { return self.opts.host; },
      get disk() { return self.opts.store; },
      get agentRoot() { return self.opts.agentRoot; },
      get probeMs() { return self.opts.configProbeMs; },
      get pool() { return self.pool; },
      get rooms() { return self.rooms; },
      agents: () => this.opts.agents,
      agent: (agentId) => this.agentOrThrow(agentId),
    };
  }

  private sessionsPort(): SessionsPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get host() { return self.opts.host; },
      get mcp() { return self.opts.mcp; },
      get rooms() { return self.rooms; },
      get runtimes() { return self.runtimes; },
      get pool() { return self.pool; },
      get config() { return self.config; },
      agent: (agentId) => this.agentOrThrow(agentId),
      soleBot: (room) => this.soleBot(room),
      watch: (room, bot, sessionId) => this.turns.watchIdle(room, bot, sessionId),
      emitNotice: (roomId, text) => { this.emit("notice", roomId, text); },
      emitRoom: (room) => { this.emit("room", room); },
    };
  }

  private activityPort(): ActivityPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get host() { return self.opts.host; },
      get disk() { return self.opts.store; },
      get rooms() { return self.rooms; },
      get runtimes() { return self.runtimes; },
      emitClashes: (roomId, list) => { this.emit("clashes", roomId, list); },
    };
  }

  private promptPort(): PromptPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get disk() { return self.opts.store; },
      get rooms() { return self.rooms; },
      get pool() { return self.pool; },
      get queue() { return self.queue; },
    };
  }

  private forkPort(): ForkPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get disk() { return self.opts.store; },
      get rooms() { return self.rooms; },
      get runtimes() { return self.runtimes; },
      get pool() { return self.pool; },
      get sessions() { return self.sessions; },
      agent: (agentId) => this.agentOrThrow(agentId),
      watch: (room, bot, sessionId) => this.turns.watchIdle(room, bot, sessionId),
      emitRoom: (room) => { this.emit("room", room); },
      emitNotice: (roomId, text) => { this.emit("notice", roomId, text); },
    };
  }

  private turnPort(): TurnPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get host() { return self.opts.host; },
      get disk() { return self.opts.store; },
      get rooms() { return self.rooms; },
      get runtimes() { return self.runtimes; },
      get pool() { return self.pool; },
      get queue() { return self.queue; },
      get prompts() { return self.prompts; },
      get sessions() { return self.sessions; },
      get activity() { return self.activity; },
      get config() { return self.config; },
      activeRoomId: () => this.activeRoomId,
      isDown: () => this.down,
      soleBot: (room) => this.soleBot(room),
      turnDone: (room) => this.maybeFireStaged(room),
      releaseIfUnseen: (roomId) => this.maybeReleaseRoom(roomId),
      emitMessage: (roomId, message) => { this.emit("message", roomId, message); },
      emitRoom: (room) => { this.emit("room", room); },
      emitRoomError: (roomId, text) => { this.emit("roomError", roomId, text); },
    };
  }

  private reviewPort(): ReviewPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get queue() { return self.queue; },
      get host() { return self.opts.host; },
      mcpReady: () => this.opts.mcp?.current().at === "ready",
      mcpHttp: (agentId) => this.pool.connection(agentId).mcpHttp,
      roomById: (roomId) => this.rooms.open.get(roomId),
      openRooms: () => this.rooms.open.values(),
      botRuntime: (roomId, botId) => this.runtimes.bot(roomId, botId),
      botForSession: (sessionId) => this.runtimes.botForSession(sessionId),
      statusOf: (roomId, botId) => this.runtimes.statusOf(roomId, botId),
      setStatus: (roomId, status, botId) => this.runtimes.setStatus(roomId, status, botId),
      noteRoom: (room, text, kind, about) => this.rooms.noteRoom(room, text, kind, about),
      maybeWake: (room, botId) => this.turns.maybeWake(room, botId),
      emitNotice: (roomId, text) => { this.emit("notice", roomId, text); },
      emitReviews: (roomId, list) => { this.emit("reviews", roomId, list); },
      emitWaiting: (roomId, list) => { this.emit("waiting", roomId, list); },
    };
  }

  private mcpPort(): McpPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get queue() { return self.queue; },
      get host() { return self.opts.host; },
      roomById: (roomId) => this.rooms.open.get(roomId),
      botRuntime: (roomId, botId) => this.runtimes.bot(roomId, botId),
      append: (room, message) => this.rooms.append(room, message),
      saveMessage: (room, patch) => this.rooms.saveMessage(room, patch),
      saveNewMessage: (room, message) => this.rooms.saveNewMessage(room, message),
      maybeWake: (room, botId) => this.turns.maybeWake(room, botId),
      giveVerdict: (botId, id, allow, reason) => this.review.giveVerdict(botId, id, allow, reason),
      emitMessage: (roomId, message) => { this.emit("message", roomId, message); },
    };
  }

  /** 내린 뒤인가 — 그러면 예약을 더 안 내보낸다 (`dispose`) */
  private down = false;

  /**
   * ★ **목록을 갈아끼운다** (2026-10-01).
   *
   * 사용자가 에이전트를 받거나 지우면 `command`·`args` 가 바뀐다
   * (`agentInstaller.withInstalled`). 그런데 여기는 만들 때 받은 배열을
   * 그대로 쥐고 있어서, **받아놓고도 예전 길로 띄우는** 일이 생긴다.
   *
   * ⚠️ **이미 떠 있는 연결은 안 건드린다.** 대화 중에 CLI 를 갈아끼우면
   * 세션이 끊긴다 — 다음에 여는 방부터 새 것을 쓴다.
   */
  setAgents(list: AgentDef[]): void {
    this.opts.agents = list;
    /*
     * 🔴 **쌓아둔 연결도 같이 갈아끼운다** (2026-10-07).
     *
     * 여기서 목록만 바꾸고 말았다. 그런데 `connection()` 은 에이전트당
     * 객체를 한 번만 만들어 쌓아두고, 그 객체는 **만들 때의 정의를
     * 그대로 쥐고 있다.** 그래서 이렇게 됐다:
     *
     * ```
     * 방을 열었다   → 안 받은 상태라 «아직 받지 않았습니다» 를 쥐고 생긴다
     * 로봇에서 받았다 → 목록은 고쳐졌는데 그 객체는 그대로다
     * 다시 방으로   → **받아놓고도 «아직 받지 않았습니다»**
     * ```
     *
     * 사용자가 그대로 봉착했다. VSCode 를 다시 띄우기 전엔 풀리지 않았다.
     *
     * ⚠️ **떠 있는 것은 그대로 둔다** — `retarget` 이 거절한다. 대화 중에
     * 갈아끼우면 세션이 끊긴다.
     */
    this.pool.retarget(list);
  }

  constructor(private readonly opts: RoomManagerOptions) {
    super();
  }

  // ── 목록 ──────────────────────────────────────────────────────────────

  /** 열린 워크스페이스 루트. 셀이 방을 구분할 때 쓴다 (B5) */
  defaultCwd(): string {
    return this.opts.host.defaultCwd();
  }

  /** 폴더가 실제로 열려 있는가 (B9). `defaultCwd`는 없어도 홈을 준다 */
  hasWorkspace(): boolean {
    return this.opts.host.hasWorkspace();
  }

  listMetas(): RoomMeta[] {
    return this.rooms.listMetas();
  }

  /** 방의 상태, 또는 **그 봇의** 상태 (v2.0 준비) */
  statusOf(roomId: string, botId?: string): RoomStatus {
    return this.runtimes.statusOf(roomId, botId);
  }

  /** 상태 표시줄 배지용 (F1) */
  totalUnread(): number {
    return this.rooms.listMetas().reduce((sum, m) => sum + m.unread, 0);
  }

  // ── 방 ────────────────────────────────────────────────────────────────

  async createRoom(opts: CreateRoomOptions): Promise<Room> {
    /*
     * **봇 목록으로 통일해서 만든다** (v2.0).
     *
     * 1:1은 «봇이 하나인 단체방»이지 다른 물건이 아니다. 갈래를 둘로 두면
     * 나중에 고칠 때마다 한쪽을 빠뜨린다 — v1.1에서 `participants[0]`을
     * 여기저기 박아뒀다가 겪은 일이다.
     */
    const specs: BotSpec[] =
      opts.bots && opts.bots.length > 0
        ? opts.bots
        : [{
            agentId: opts.agentId ?? "",
            ...(opts.rolePrompt ? { rolePrompt: opts.rolePrompt } : {}),
            ...(opts.agentMode ? { agentMode: opts.agentMode } : {}),
            ...(opts.answerPolicy ? { answerPolicy: opts.answerPolicy } : {}),
            ...(opts.configValues ? { configValues: opts.configValues } : {}),
          }];

    // **이름은 방 안에서 유일해야 한다** — 이름이 곧 멘션 이름이라(§4.1.2)
    // 같은 에이전트를 둘 고르면 `Claude`, `Claude 2`로 갈라진다.
    const taken = new Set<string>();
    const participants = specs.map((spec) => {
      const bot = createBotInstance(this.agentOrThrow(spec.agentId), {
        taken,
        ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
        ...(spec.color?.trim() ? { color: spec.color.trim() } : {}),
        ...(spec.ink ? { ink: spec.ink } : {}),
        ...(spec.rolePrompt ? { rolePrompt: spec.rolePrompt } : {}),
        ...(spec.blurb ? { blurb: spec.blurb } : {}),
        ...(spec.agentMode ? { agentMode: spec.agentMode } : {}),
        ...(spec.answerPolicy ? { answerPolicy: spec.answerPolicy } : {}),
      });
      taken.add(bot.name);
      return bot;
    });

    const now = Date.now();
    const room: Room = {
      id: `room-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: opts.title?.trim() || this.rooms.nextDefaultTitle(),
      participants,
      cwd: opts.cwd ?? this.opts.host.defaultCwd(),
      messages: [],
      unread: 0,
      createdAt: now,
      lastActivityAt: now,
    };
    await this.opts.store.createRoom(room);
    this.rooms.open.set(room.id, room);
    this.rooms.emitMetas();

    // **역할을 방 상단에 보여준다** (B3). 안 보이면 봇이 왜 이렇게
    // 답하는지 모른 채로 대화하게 된다.
    for (const bot of room.participants) {
      if (!bot.rolePrompt?.trim()) continue;
      const note: Message = {
        id: messageId(),
        role: "system",
        // 봇이 여럿이면 **누구의 역할인지** 써준다 — 안 그러면 줄만 늘고 뜻이 없다
        text:
          hasManyBots(room)
            ? `${bot.name}의 역할: ${bot.rolePrompt.trim()}`
            : `역할: ${bot.rolePrompt.trim()}`,
        deliveredTo: [],
        createdAt: now,
      };
      this.rooms.append(room, note);
      await this.rooms.saveNewMessage(room, note);
    }

    // **방을 만들면 세션도 연다** (B1: 방 1개 = 세션 1개).
    //
    // 첫 메시지까지 미루면 (1) 고른 모델을 적용할 수 없고 — `setConfigOption`은
    // 세션이 있어야 부른다 — (2) 로그인 문제를 첫 메시지에서야 알게 되고
    // (3) 방은 있는데 세션은 없는 상태가 생긴다.
    // 봇마다 하나씩 — **병렬로**. 세션은 서로 무관하고, 순차로 열면
    // 봇이 셋일 때 방 만드는 데만 몇 초가 걸린다.
    await Promise.all(
      room.participants.map(async (bot, at) => {
        try {
          await this.sessions.open(room, bot, specs[at]?.configValues);
        } catch (err) {
          // 방은 남긴다 — 제목·역할을 다시 입력하게 만들지 않는다.
          // 첫 메시지를 보낼 때 다시 시도한다.
          //
          // ★ **한 봇이 안 열려도 나머지는 산다** — Codex 로그인이 풀렸다고
          // Claude와의 대화까지 못 하게 만들 이유가 없다.
          this.runtimes.setStatus(room.id, "error", bot.id);
          this.rooms.noteRoom(room, `${bot.name} 세션을 열지 못했습니다 — ${describe(err)}`,
                        "error", [bot.id]);
        }
      }),
    );
    return room;
  }

  /** 방을 메모리에 올린다 — `Rooms.openRoom` (읽음 처리는 안 한다) */
  async openRoom(roomId: string): Promise<Room> {
    return this.rooms.openRoom(roomId);
  }

  /**
   * ★ **봇끼리 부르기 — 끔 · 물어봄 · 무조건 허용** (v3.0 4-L).
   *
   * **방 단위**다. 봇별 권한(D2)보다 **층이 하나 위**라 — 이게 꺼져 있으면
   * 아래 줄들이 다 무의미하다 — 권한 시트 맨 위에 있다.
   *
   * 🔴 **도구를 빼서 막지 않는다.** 한때 *"off 면 도구를 아예 안 줘서 봇이
   * 시도조차 못 한다"* 고 적었는데 전제가 둘 다 죽었다 — 셋이 한 서버에 묶여
   * 있어 하나만 뺄 수 없고, `tools/list_changed` 를 보내도 **모델까지는 안
   * 닿는다**(`mcplist.cjs` 실측). 막는 자리는 **호출**이다.
   */
  async setRelay(roomId: string, relay: RelayMode): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    if ((room.relay ?? DEFAULT_RELAY) === relay) return;
    room.relay = relay;
    await this.rooms.saveProps(room, { relay });
    this.emit("room", room);
  }

  /**
   * ★ **깊이 상한을 고친다** (v3.0 4-L). `always` 에서만 쓰인다.
   *
   * ```
   * 0      **제한 없음**
   * 1..999 사용자에게서 그만큼 멀어지면 그 `say` 가 거절된다
   * ```
   *
   * 🔴 **0 이 «한 번도 못 건다»가 아니다.** 그건 «끔»이 할 일이고, 숫자로도
   * 같은 말을 하게 두면 **같은 뜻을 두 군데**에서 말하게 된다.
   *
   * ⚠️ 음수는 0 으로 접는다 — 저쪽이 무슨 뜻으로 보냈든 **안 막는 쪽**이
   * 그나마 짐작이 덜 섞인다.
   */
  async setRelayDepth(roomId: string, depth: number): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const next = Math.max(0, Math.min(999, Math.floor(depth)));
    if ((room.depthCap ?? DEFAULT_DEPTH_CAP) === next) return;
    room.depthCap = next;
    await this.rooms.saveProps(room, { depthCap: next });
    this.emit("room", room);
  }

  /**
   * ★ **한 줄 소개를 고친다** (v3.0 4-K).
   *
   * 🔴 **역할과 다른 물건이다.** 역할은 그 봇에게 주는 지시라 **그 봇의 세션
   * 에만** 다시 넣으면 되는데, 소개는 **표에 적히는 것**이라 그 방 **전원**의
   * 명단이 바뀐다. 한 봇만 거두면 나머지는 **낡은 표**를 들고 있다.
   *
   * 거두는 코드는 따로 없다 — 명단은 **지은 글을 비교**해서 나가므로
   * (`rosterSent`) 다음 턴에 저절로 달라진다. 여기서는 값만 고친다.
   */
  async setBlurb(roomId: string, blurb: string, botId?: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;

    const next = blurb.trim();
    if ((bot.blurb ?? "") === next) return;
    if (next) bot.blurb = next;
    else delete bot.blurb;

    await this.rooms.saveProps(room, { participants: room.participants });
    this.emit("room", room);
  }

  /**
   * 봇의 역할을 고친다 (B3·B12).
   *
   * 이미 대화 중이면 이번 세션에 **다시 주입해야** 반영된다 —
   * 역할은 프롬프트 프리픽스라 한 번 보낸 뒤에는 다시 보내지 않는다.
   */
  async setRole(roomId: string, rolePrompt: string, botId?: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;

    bot.rolePrompt = rolePrompt || undefined;
    // 역할은 프롬프트 프리픽스라 **그 봇의** 세션에 다시 넣어야 한다
    this.runtimes.bot(roomId, bot.id).roleInjected = false;

    await this.rooms.saveProps(room, { participants: room.participants });
    this.emit("room", room);
  }

  /**
   * **봇을 방에 초대한다** (v2.0). 1:1 방을 단체방으로 올리는 것도 이 길이다.
   *
   * 🔴 **새 봇은 위 대화를 모른다** (§4.1.1). 화면에는 지난 대화가 그대로
   * 보이는데 초대된 봇의 세션은 백지라, 말해주지 않으면 사용자는 *"보이니까
   * 알겠지"* 라고 믿은 채로 말을 건다. 그 착각이 이 설계의 유일한 위험이므로
   * **초대하는 자리에서 바로 적는다.**
   *
   * 기억은 또 다른 이야기다 — 같은 폴더를 보므로 **기억은 오히려 공유된다**
   * (§4.2.3 실측). «대화는 모르는데 기억은 안다»가 헷갈릴 수 있어서, 봇이 둘이
   * 되는 순간 그것도 함께 말한다.
   */
  async addBot(roomId: string, spec: BotSpec): Promise<BotInstance> {
    const room = await this.rooms.openRoom(roomId);
    const agent = this.agentOrThrow(spec.agentId);

    const taken = new Set(room.participants.map((b) => b.name));
    const bot = createBotInstance(agent, {
      taken,
      ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
      ...(spec.color?.trim() ? { color: spec.color.trim() } : {}),
      ...(spec.ink ? { ink: spec.ink } : {}),
      ...(spec.rolePrompt ? { rolePrompt: spec.rolePrompt } : {}),
      ...(spec.blurb ? { blurb: spec.blurb } : {}),
      ...(spec.agentMode ? { agentMode: spec.agentMode } : {}),
      ...(spec.answerPolicy ? { answerPolicy: spec.answerPolicy } : {}),
    });
    room.participants.push(bot);

    const first = room.participants.length === 2;
    const said = room.messages.some((m) => m.role !== "system");
    this.rooms.noteRoom(
      room,
      said
        ? `${bot.name}을(를) 초대했습니다. ${bot.name}은(는) 위 대화를 모릅니다 — ` +
            `@${bot.name} 으로 지목해 다시 알려주세요.`
        : `${bot.name}을(를) 초대했습니다.`,
      "info",
      // 그 봇 이야기다. 방 전체 공지는 바로 아래 «기억은 안 나뉜다» 쪽이다
      [bot.id],
    );
    // 봇이 둘이 되는 **그 순간**에 한 번만 (§4.2.3)
    if (first) {
      this.rooms.noteRoom(
        room,
        "이제 봇이 여럿입니다. 대화는 봇마다 갈라지지만 **에이전트의 기억은 나뉘지 않습니다** — " +
          "같은 폴더를 보므로 한 봇에게 시킨 «기억해»를 다른 봇도 읽습니다.",
        "info",
      );
    }

    // 세션은 **지금** 연다 — 첫 멘션까지 미루면 로그인 문제를 그때 알게 된다(B1)
    try {
      await this.sessions.open(room, bot, spec.configValues);
    } catch (err) {
      this.runtimes.setStatus(room.id, "error", bot.id);
      this.rooms.noteRoom(room, `${bot.name} 세션을 열지 못했습니다 — ${describe(err)}`,
                    "error", [bot.id]);
    }

    await this.rooms.saveProps(room, { participants: room.participants });
    this.emit("room", room);
    this.rooms.emitMetas();
    return bot;
  }

  /**
   * **봇을 내보낸다** (v2.0).
   *
   * 그 봇의 세션은 **지운다.** 방을 나갈 때와 같은 이유다 — 내보내는 것은
   * «이 봇과의 대화를 끝낸다»는 뜻이므로 에이전트 쪽에 기록을 남겨둘 이유가 없다.
   *
   * 🔴 **말풍선은 지우지 않는다.** 세션은 그쪽 것이고 기록은 우리 것이다(§0).
   * 나간 봇이 한 말까지 지우면 *"아까 그 얘기 어디 갔지"* 가 되고, 무엇보다
   * 사용자가 읽은 것을 우리가 되물릴 수는 없다.
   *
   * 마지막 한 명은 내보낼 수 없다 — 봇이 없는 방은 말을 걸 수가 없다.
   */
  async removeBot(roomId: string, botId: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const at = room.participants.findIndex((b) => b.id === botId);
    if (at < 0) return;
    if (room.participants.length === 1) {
      throw new Error("마지막 봇은 내보낼 수 없습니다. 방을 나가시려면 «방 나가기»를 쓰세요.");
    }

    const bot = room.participants[at]!;
    const rt = this.runtimes.get(roomId);
    const bt = rt?.bots.get(botId);
    const sessionId = bt?.sessionId ?? bot.sessionId ?? undefined;

    if (sessionId) {
      const conn = this.pool.get(bot.agentId);
      await conn?.cancel(sessionId).catch(() => undefined);
      // 말을 건 적 있는 세션만 디스크에 있다 — 없는 걸 지우려 들면 실패한다(§13.1)
      await conn?.deleteSession(sessionId, bot.sessionPrompted === true).catch(() => undefined);
    }

    /*
     * ★ **임자가 사라졌으면 열쇠를 거둔다** (2026-10-15).
     *
     * 🔴 새로 발급할 때 거두던 것을 물리면서(살아 있는 붙임을 끊었다)
     * **거두는 자리가 한 군데도 안 남았다.** 내보낸 봇의 열쇠가 창이
     * 닫힐 때까지 먹으면, 그 봇으로서 말하고 심사할 길이 열려 있다.
     */
    this.opts.mcp?.revoke(`${roomId}:${botId}`);

    room.participants.splice(at, 1);
    /*
     * ★ **이름은 남긴다** (2026-09-23).
     *
     * 세션도 설정도 따라가지 않지만 **이름은 기록의 일부**다. 지난 말풍선과
     * 멘션 칩이 «@나간 봇»이라는 익명이 되면 *"누구한테 시킨 거였지"* 에 답할
     * 수 없다 — 기록은 우리 것이고(§0), 떠났다고 그 사람 말이 익명이 되지는 않는다.
     */
    (room.left ??= []).push({ id: bot.id, name: bot.name, at: Date.now() });
    rt?.bots.delete(botId);

    /*
     * ★ **그 봇을 심사자로 두고 있던 봇을 풀어준다** (v3.0 3-P).
     *
     * 🔴 안 풀어도 **안전하기는 하다** — `askBotApprover` 가 «심사를 맡긴
     * 봇이 방에 없어» 로 사용자에게 되돌린다. 그런데 **설정 화면은 여전히
     * 나간 봇을 가리키고**, 매 요청마다 같은 알림이 한 줄씩 쌓인다.
     * 고칠 데를 아는 쪽이 고친다 — 사용자가 짐작할 일이 아니다.
     */
    const orphans = room.participants.filter(
      (b) => b.approver?.kind === "bot" && b.approver.botId === botId,
    );
    for (const o of orphans) o.approver = ASK_USER;

    this.rooms.noteRoom(room, `${bot.name}을(를) 내보냈습니다. 지금까지의 대화는 그대로 남습니다.`, "info");
    if (orphans.length > 0) {
      this.rooms.noteRoom(
        room,
        `${orphans.map((b) => b.name).join("·")}의 승인 주체를 사용자로 되돌렸습니다.`,
        "info",
      );
    }
    await this.rooms.saveProps(room, { participants: room.participants, left: room.left });
    this.emit("room", room);
    this.rooms.emitMetas();
  }

  /**
   * 봇 이름을 바꾼다 (v2.2 준비).
   *
   * **표시 이름이 곧 멘션 이름이다**(`BotInstance.name`). 그래서 방 안에서
   * 유일해야 하고, 겹치면 `Claude 2`처럼 뒤에 수를 붙인다 — 단체방에서
   * `@Claude`가 둘을 가리키면 어느 쪽에 보낼지 우리가 정할 수 없게 된다.
   *
   * 세션은 건드리지 않는다. 이름은 **우리 쪽 이름표**일 뿐이고 에이전트는
   * 모르는 값이다.
   */
  /**
   * ★ **봇 색을 바꾼다** (2026-09-28).
   *
   * 이름 바꾸기와 달리 **공지하지 않는다.** 이름은 멘션에 쓰이므로 «누구를
   * 부르는지»가 바뀌지만, 색은 보이기만 한다 — 대화에 줄을 하나 더 얹을 일이
   * 아니다.
   *
   * 빈 값이면 지운다 → `botColor` 가 에이전트 색으로 떨어진다.
   */
  async setBotColor(
    roomId: string,
    botId: string,
    color: string,
    ink?: "black" | "white",
  ): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;
    const next = color.trim();
    if (next) bot.color = next;
    else delete bot.color;
    /*
     * 색을 지우면 글자색도 같이 지운다 — 배경이 테마로 돌아가는데 글자만
     * 검정으로 박혀 있으면 **다크 테마에서 안 읽힌다.** 둘은 한 쌍이다.
     */
    if (!next) delete bot.ink;
    else if (ink) bot.ink = ink;
    await this.rooms.saveProps(room, { participants: room.participants });
    this.emit("room", room);
    // 목록의 색 점도 따라가야 한다
    this.rooms.emitMetas();
  }

  async renameBot(roomId: string, botId: string, name: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;

    // 표시용 글자는 걷어낸다 — 우리 표시(`(사용자)` 등)를 흉내 낼 수 없어야 한다
    const wanted = cleanBotName(name);
    if (!wanted || wanted === bot.name) return;

    const before = bot.name;
    bot.name = uniqueName(wanted, room.participants.filter((b) => b.id !== botId));
    await this.rooms.saveProps(room, { participants: room.participants });

    /*
     * ★ **바꿨다고 적는다.**
     *
     * 🔴 **멘션 칩은 `botId` 를 들고 있어서 지난 메시지도 새 이름으로 다시
     * 그려진다.** 그래서 위로 올려보면 «@구현» 이라고 보냈던 것이 «@리뷰어» 로
     * 보인다 — 공지가 없으면 **기억이 틀린 것처럼 느껴진다.**
     *
     * 🔴 그리고 **우리가 이름을 고쳤을 수 있다.** 방 안에서 유일해야 해서
     * 겹치면 뒤에 수를 붙이는데(`uniqueName`), 사용자가 친 것과 다른 값이
     * 되므로 **«달라졌다»가 어딘가에 남아야 한다**(§0 뺄셈 규칙).
     */
    const msg: Message = {
      id: messageId(),
      role: "system",
      text:
        `«${before}»의 이름을 «${bot.name}»(으)로 바꿨습니다.` +
        (bot.name !== wanted ? ` «${wanted}»은(는) 이미 있어서 뒤에 수를 붙였습니다.` : ""),
      aboutBotIds: [botId],
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.rooms.append(room, msg);
    await this.rooms.saveNewMessage(room, msg);

    this.emit("room", room);
    this.rooms.emitMetas();
  }

  /**
   * 봇의 에이전트를 바꾼다 (§8.1(b) 준비 — **구조만**).
   *
   * 🔴 **이것은 «설정 바꾸기»가 아니라 «세션을 버리는 일»이다.** 세션은 그
   * 에이전트의 CLI 것이라 Claude 세션을 Codex가 이어받을 방법이 없다. 그래서
   * 바꾸는 순간 **새 에이전트는 지금까지의 대화를 하나도 모른다.**
   *
   * 그 상태를 표현할 자리는 이미 있다 — `contextLost`(F7). 세션을 못 이어받아
   * 새로 열었을 때와 **화면에 보이는 것과 에이전트가 아는 것이 어긋난다**는
   * 점이 똑같으므로, 되먹임 제안(«대화 넘겨서 시작») 기계를 그대로 쓴다.
   *
   * **이전 세션 id는 지우지 않고 기록에 남긴다.** 우리는 기록자다(§0) — 바꾼
   * 뒤에 «전에 쓰던 세션이 뭐였지»를 물을 자리가 있어야 하고, 그 CLI에서
   * `--resume`으로 열어볼 수도 있다.
   *
   * ⚠️ **아직 화면이 없다.** 이 흐름은 «바꿨더니 다 잊었다»가 되지 않게 묻는
   * 단계가 필요한데, 그건 컨텍스트 이동(§8.1)과 함께 설계한다. 여기서는
   * 코어가 할 일만 정해둔다.
   */
  async setAgent(
    roomId: string,
    botId: string,
    agentId: string,
    /**
     * 갈아타면서 **같이 정하는 것들**.
     *
     * 🔴 셋을 따로 보내면 순서가 안 지켜진다(웹뷰의 `post` 는 기다리지 않는다).
     * 게다가 사용자에게는 **한 번의 결정**이다 — «Codex의 GPT-5로, 대화는
     * 넘겨서» 가 한 문장이지 세 번의 조작이 아니다.
     */
    opts?: {
      /** 갈아탄 뒤 곧바로 걸 모델. 새 에이전트의 `configId` 와 값 */
      model?: { configId: string; value: string };
      /**
       * 지난 대화를 다음 메시지에 실어 보낼까 (F7).
       *
       * 안 주면 «아직 못 정했다» — `contextLost` 배너가 떠서 그때 묻는다.
       */
      refeed?: boolean;
      /** 넘길 때 **원문까지인가 요약만인가.** 안 주면 원문(`"log"`) */
      refeedKind?: "log" | "summary";
    },
  ): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;
    if (bot.agentId === agentId) return;

    const next = this.agentOrThrow(agentId);
    const before = this.opts.agents.find((a) => a.id === bot.agentId)?.label ?? bot.agentId;

    // 돌고 있으면 바꾸지 않는다 — 답이 오는 중에 세션을 갈면 그 답은 갈 곳이 없다
    if (this.runtimes.statusOf(roomId, botId) !== "idle" && this.runtimes.statusOf(roomId, botId) !== "error") {
      throw new Error("답하는 중에는 에이전트를 바꿀 수 없습니다.");
    }

    const bt = this.runtimes.bot(roomId, botId);
    const old = bt.sessionId ?? bot.sessionId ?? undefined;
    /* 아래에서 `agentId` 와 `sessionPrompted` 를 갈아끼우므로 **먼저** 적어둔다 */
    const fromAgent = bot.agentId;
    const hadTalk = bot.sessionPrompted === true;

    // 붙어 있던 세션에서 손을 뗀다. **지우지는 않는다** — 그 CLI에 그대로 두고
    // 우리만 놓는다. 사용자가 되돌리고 싶어질 수도 있고, 남의 기록을 우리가
    // 치울 이유도 없다.
    if (old) await this.pool.get(bot.agentId)?.cancel(old).catch(() => undefined);
    bt.sessionId = undefined;
    bt.commands = [];
    bt.roleInjected = false;
    delete bt.rosterSent;
    delete bt.turn;

    bot.agentId = agentId;
    bot.sessionId = null;
    bot.sessionPrompted = false;
    // 모델·권한·설정값은 **그 에이전트의 것**이라 같이 버린다. 남겨두면 새
    // 에이전트에 없는 id를 들고 있다가 복구 때 엉뚱한 값을 밀어 넣는다.
    delete bot.model;
    delete bot.modelLabel;
    delete bot.agentMode;
    delete bot.configValues;
    delete bot.usage;
    // 이름을 손대지 않은 사람에게는 에이전트 이름이 곧 봇 이름이었다 — 따라 바꾼다
    if (bot.name === before) {
      bot.name = uniqueName(next.label, room.participants.filter((b) => b.id !== botId));
    }

    // **화면과 에이전트가 어긋난 상태**다 (F7과 같은 자리) — **이 봇만**
    bot.contextLost = true;
    if (old) {
      bot.lostSessionId = old;
      bot.lostAgentId = fromAgent;
      bot.lostPrompted = hadTalk;
    }
    rollUpLost(room);

    this.rooms.noteRoom(
      room,
      `${whose(room, bot)}에이전트를 ${before}에서 ${next.label}(으)로 바꿨습니다. ` +
        `${next.label}은(는) 위 대화를 모릅니다.` +
        (old ? ` 이전 세션 ${old}은(는) ${before} 쪽에 그대로 있습니다.` : ""),
      "info",
      [bot.id],
    );

    await this.rooms.saveProps(room, {
      participants: room.participants,
      contextLost: true,
      ...(old ? { lostSessionId: old } : {}),
    });

    /*
     * ★ **고를 때 같이 정한 것들을 지금 건다.**
     *
     * 되먹임부터다 — 모델을 거는 순간 세션이 열리는데, 그 전에 «대화를
     * 넘길지»가 정해져 있어야 **첫 프롬프트에 실려 간다**.
     */
    if (opts?.refeed !== undefined) await this.decideRefeed(roomId, opts.refeed);
    /*
     * ★ **무엇을 넘길지는 넘기기로 정한 뒤에 걸어야 한다** (2026-10-01).
     *
     * `decideRefeed` 가 봇마다 `refeedPending` 을 세우므로, 종류는 그 뒤에
     * 덮어쓴다. 순서가 바뀌면 방금 섬 것이 지워진다.
     */
    if (opts?.refeed && opts.refeedKind) {
      for (const b of room.participants) {
        if (b.refeedPending) b.refeedKind = opts.refeedKind;
      }
    }
    if (opts?.model) {
      try {
        await this.setConfig(roomId, opts.model.configId, opts.model.value, botId);
      } catch (err) {
        // 모델을 못 걸어도 **갈아타기 자체는 끝났다** — 되돌리지 않고 말만 한다
        this.rooms.noteRoom(room, `모델을 걸지 못했습니다 — ${describe(err)}`, "info");
      }
    }

    this.emit("room", room);
    this.rooms.emitMetas();
  }

  async renameRoom(roomId: string, title: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    room.title = title.trim() || room.title;
    await this.rooms.saveProps(room, { title: room.title });
    // 목록뿐 아니라 **열려 있는 방의 헤더도** 바뀌어야 한다.
    this.emit("room", room);
  }

  /**
   * **아무것도 안 쓰고 나간 방은 치운다** (B6).
   *
   * 메신저에서 대화창을 열었다 그냥 나오면 목록에 안 남는 것과 같다. 여기서는
   * 이유가 하나 더 있다 — 에이전트는 **첫 프롬프트를 받아야** 세션을 디스크에
   * 남기므로(§13.1), 말을 안 건 방의 세션은 다음에 열 때 **반드시 복구에
   * 실패한다.** 되살릴 것도 없는 방을 그 대가를 치르며 들고 있을 이유가 없다.
   *
   * **«쓴 게 있으면» 남긴다** — 대화든 초안이든 역할이든. 제목만으로는 안 남긴다:
   * 제목은 비워두면 우리가 지어주는 것이라 사용자가 쓴 것이라 할 수 없다.
   *
   * 지웠으면 `true`.
   */
  async discardIfUntouched(roomId: string): Promise<boolean> {
    // 초안이 디바운스 중일 수 있다 — 확정하고 나서 본다
    await this.flushDraft();

    const room = this.rooms.open.get(roomId) ?? (await this.opts.store.loadRoom(roomId));
    if (!room) return false;

    const wrote =
      room.messages.some((m) => m.role !== "system") ||
      Boolean(room.draft?.trim()) ||
      room.participants.some((b) => b.rolePrompt?.trim());
    if (wrote) return false;

    await this.leaveRoom(roomId);
    return true;
  }


  // ── 분기 ──────────────────────────────────────────────────────────────

  /** 대화를 갈라 새 방을 만든다 — `Forks.forkRoom` (v1.1) */
  async forkRoom(roomId: string, opts: ForkOptions = {}): Promise<Room> {
    return this.forks.forkRoom(roomId, opts);
  }

  /** 분기 때 못 가른 세션을 다시 갈라 본다 — `Forks.retryFork` */
  async retryFork(roomId: string): Promise<{ ok: boolean; reason?: string }> {
    return this.forks.retryFork(roomId);
  }

  /** 이 방에서 갈라진 방들 — `Forks.childrenOf` */
  childrenOf(roomId: string): RoomMeta[] {
    return this.forks.childrenOf(roomId);
  }

  /**
   * 방을 나간다 (B6). **세션과 방 파일이 함께 사라진다.**
   *
   * 진행 중인 턴이 있으면 먼저 중단하고, 그 에이전트의 마지막 방이었으면
   * CLI 프로세스까지 정리한다 — 좀비 프로세스를 남기지 않는다.
   *
   * 🔴 **봇마다 따로 해야 한다** (2026-09-23). 이 코드는 v1.0 에 썼고 그때는
   * 방에 봇이 하나뿐이라 `soleBot`(= `participants[0]`) 하나만 놓아주면 끝이었다.
   * v2.0 에서 봇이 여럿이 됐는데 **이 길을 다시 안 봤다** — 단체방을 나가면
   * **첫 봇만 지워지고 나머지는 그대로 남았다.** 실측으로 확인했다(`leaveall.mts`):
   * 둘이 있는 방을 나갔는데 `session/delete` 가 **한 번만** 나갔다.
   *
   * 남은 세션은 진짜로 남는다 — `claude --resume <id>` 로 **그 대화가 그대로
   * 열린다**(`delsess2.cjs`). 우리 앱에서 지운 방을 claude 가 기억하는 셈이다.
   *
   * ★ 대화 여부는 **봇마다** 본다(`sessionPrompted`). 방에 말이 오갔어도
   * **초대만 하고 말을 안 건 봇**의 세션은 CLI 디스크에 아예 없어서, 거기에
   * `delete`를 부르면 실패하고 **실패한 delete 가 뒤이은 close 까지 깨뜨린다**
   * (§13.1). `removeBot` 이 이미 그렇게 하고 있었다 — 같은 식으로 맞춘다.
   */
  async leaveRoom(roomId: string): Promise<void> {
    const room = this.rooms.open.get(roomId) ?? (await this.opts.store.loadRoom(roomId));
    const rt = this.runtimes.get(roomId);

    for (const bot of room?.participants ?? []) {
      const sessionId = rt?.bots.get(bot.id)?.sessionId ?? bot.sessionId ?? undefined;
      if (!sessionId) continue;
      // **그 봇의** 에이전트다 — 단체방에서는 봇마다 다를 수 있다
      const conn = this.pool.get(bot.agentId);
      await conn?.cancel(sessionId).catch(() => undefined);
      // **대화가 있으면 삭제, 없으면 해제.** 방을 나가는 건 대화를 지우는 행위이므로
      // 에이전트 쪽 기록도 남기지 않는다.
      await conn?.deleteSession(sessionId, bot.sessionPrompted === true).catch(() => undefined);
    }

    // 나간 방의 열쇠도 거둔다 — 방이 없는데 그 봇으로 먹힐 이유가 없다
    for (const bot of room?.participants ?? []) this.opts.mcp?.revoke(`${roomId}:${bot.id}`);

    // 나간 방의 자리는 들고 있을 이유가 없다 — 파일도 같이 사라진다
    this.opts.locks?.release(roomId);

    // 진행 중인 턴이 끝나면서 저장하려 들 수 있다. 되살아나지 않게 막는다.
    this.rooms.left.add(roomId);
    this.runtimes.delete(roomId);
    this.rooms.open.delete(roomId);
    await this.opts.store.deleteRoom(roomId);
    this.rooms.emitMetas();

    this.pool.disposeUnused(new Set(this.rooms.listMetas().flatMap((m) => m.agentIds)));
  }

  /**
   * 읽음 처리. 구분선 자리를 마지막 메시지로 옮긴다.
   *
   * 다음에 이 방을 열면 안 읽은 게 없으므로 맨 아래로 간다.
   */
  markRead(room: Room): void {
    const last = room.messages.at(-1);
    if (room.unread === 0 && room.lastReadMessageId === last?.id) return;
    room.unread = 0;
    room.lastReadMessageId = last?.id;
    void this.rooms.saveProps(room, { unread: 0, lastReadMessageId: last?.id });
  }

  /**
   * 방을 열 때 어디로 스크롤할지 (F6).
   *
   * 메신저와 같다 — **안 읽은 게 있으면 그 시작 지점, 없으면 맨 아래.**
   * 중간 스크롤 위치를 따로 기억하지 않는 이유는, AI 대화는 선형이라
   * 대개 최신 응답이 궁금하기 때문이다.
   */
  firstUnreadId(room: Room): string | undefined {
    if (room.unread === 0 || !room.lastReadMessageId) return undefined;
    const at = room.messages.findIndex((m) => m.id === room.lastReadMessageId);
    return at >= 0 ? room.messages[at + 1]?.id : room.messages[0]?.id;
  }

  /**
   * 사용자가 보고 있는 방을 알린다. **목록으로 뒤로 가면 `null`** (B7).
   *
   * **방 나가기(B6)와 전혀 다르다.** 여기서는 세션을 건드리지 않는다 —
   * 목록에 나가 있는 동안에도 에이전트는 계속 일하고, 끝나면 미읽음이 붙는다.
   *
   * 셸이 불러줘야 한다 — core는 어느 화면이 떠 있는지 모른다.
   */
  /**
   * ★ **방에 들어간다 — 자리를 잡고** (v3.0 2-G).
   *
   * 🔴 **남이 쓰는 중이면 막는다.** `ensureSession` 은 「세션이 사라졌다」와
   * 「남이 쓰는 중이다」를 **안 가려서**, 둘 다 «못 붙었다»로 읽고 새 세션을
   * 열어 `bot.sessionId` 를 덮는다 — **먼저 쓰던 창의 세션이 고아가 된다.**
   *
   * ★ **빠져나갈 단추를 안 둔다.** «그래도 열기» 를 주면 그 순간 그 고아
   * 세션이 생기고, 사용자는 무엇이 잘못됐는지 모른 채 두 화면이 어긋나는
   * 것만 본다. **껐다 켜면 저절로 풀리는 것**이 출구다.
   */
  async enterRoom(roomId: string): Promise<{ ok: true; room: Room } | { ok: false; why: string }> {
    const got = this.opts.locks?.take(roomId) ?? { ok: true as const };
    if (!got.ok) {
      return {
        ok: false,
        why: `이 방은 «${got.held.window}» 에서 열려 있습니다. ` +
          `같은 방을 두 곳에서 열면 세션이 어긋나므로 막습니다 — 그쪽 창을 닫고 다시 열어보세요.`,
      };
    }
    return { ok: true, room: await this.rooms.openRoom(roomId) };
  }

  /**
   * **자리를 놓는다** — 목록으로 나왔을 때.
   *
   * 🔴 **도는 중이면 안 놓는다.** 방을 나와도 봇은 계속 일하고(§4.3), 그
   * 세션은 여전히 이 창 것이다 — 여기서 놓으면 옆 창이 들어와 같은 세션을
   * 집는다. 조용해지면 `closeIdle` 쪽에서 놓는다.
   */
  releaseRoom(roomId: string): void {
    if (!this.opts.locks?.holds(roomId)) return;
    if (isBusy(this.runtimes.statusOf(roomId)) === true) return;
    this.opts.locks.release(roomId);
  }

  async setActiveRoom(roomId: string | null): Promise<void> {
    if (this.activeRoomId === roomId) return;

    // 나가는 방의 초안을 확정 저장한다 (디바운스 대기 중일 수 있다)
    await this.flushDraft();

    this.activeRoomId = roomId;
    if (roomId) {
      const room = await this.rooms.openRoom(roomId);
      this.markRead(room);
      // **방을 보고 있으면 세션도 붙어 있어야 한다** (B1)
      void this.bindSession(room);
    }
  }

  /**
   * 보고 있는 방의 세션을 붙인다 (B1).
   *
   * **«방 하나 = 세션 하나»가 계속 참이어야 한다.** 방을 만들 때는 열어 두는데
   * 창을 껐다 켜면 그 연결이 사라지고, 예전에는 **첫 전송 때까지** 안 붙었다.
   * 그 사이가 거짓말하는 구간이었다 — 목록의 모델, 시트의 권한 모드가 전부
   * «이 방의 값»이 아니라 에이전트 기본값이었고, 로그인이 풀린 것도 첫 메시지를
   * 보내고 나서야 알았다.
   *
   * **목록을 훑는 것만으로는 안 붙인다.** 보고 있는 방 하나뿐이라 세션 수는
   * 예전과 같다 — 시점만 당겼다.
   *
   * 화면을 막지 않는다. 실패는 방 오류로 알리고, 다음 전송이 다시 시도한다.
   */
  private bindSession(room: Room): Promise<void> {
    // **참여자 전부**를 붙인다 — 단체방에서는 봇마다 세션이 하나씩이다(B1).
    const need = room.participants.filter(
      (b) => !this.runtimes.bot(room.id, b.id).sessionId,
    );
    if (need.length === 0) {
      // 붙일 것이 없으면 **그 자리에서 끝난 것**이다 — 화면을 세워두지 않는다
      this.emit("joinDone", room.id);
      return Promise.resolve();
    }

    const running = this.sessionFlight.get(room.id);
    if (running) return running;

    for (const b of need) this.runtimes.setStatus(room.id, "connecting", b.id);
    /*
     * ★ **봇마다 따로 받는다** (2026-10-13).
     *
     * 🔴 여기가 `Promise.all` 하나에 `catch` 하나였다. 봇 셋 중 하나가
     * 터지면 **누가 터졌는지가 거기서 사라지고**, 나머지가 멀쩡히 붙었는지도
     * 알 수 없었다. 화면은 «세션에 붙지 못했습니다» 한 줄만 받았다.
     *
     * 그리고 그 한 줄이 **말풍선으로** 남았다 — 대화 기록에 박혀서 다음에
     * 열어도 그대로 있다. 세션이 붙고 말고는 **우리 사정**이지 대화가 아니다.
     */
    const work = Promise.all(need.map((b) => this.joinOne(room, b)))
      .then(() => {
        // 붙고 나면 화면이 들고 있는 값이 낡았다 — 이 방의 진짜 값으로 갈아준다
        this.emit("room", room);
        this.emit("joinDone", room.id);
      })
      .finally(() => this.sessionFlight.delete(room.id));

    this.sessionFlight.set(room.id, work);
    return work;
  }

  /**
   * 한 봇을 방에 붙인다 — **터져도 나머지를 안 끈다** (2026-10-13).
   *
   * 까닭을 갈라 알려주는 것이 여기서 하는 일의 절반이다. 화면이 달 단추가
   * 종류마다 다르기 때문이다(`JoinFail`).
   */
  private async joinOne(room: Room, bot: BotInstance): Promise<void> {
    const bt = this.runtimes.bot(room.id, bot.id);
    try {
      /*
       * ★ **두 칸을 따로 밟는다** (2026-10-13).
       *
       * 이미 붙어 있으면 둘 다 건너뛴다 — `ensureSession` 첫 줄이 그렇고,
       * `ensureStarted` 도 «떠 있으면 바로 돌아온다». 그래서 **두 번째 방부터는
       * ① 이 그냥 지나가고**, 화면도 그걸 그대로 보여준다.
       */
      if (!bt.sessionId) {
        this.emit("joinStep", room.id, bot.id, "start");
        await this.pool.start(room.id, bot.agentId);
        this.emit("joinStep", room.id, bot.id, "session");
      }
      await this.sessions.ensure(room, bot);
      this.runtimes.setStatus(room.id, "idle", bot.id);
    } catch (err) {
      const why = describe(err);
      this.runtimes.setStatus(room.id, "error", bot.id);
      this.emit("joinFail", room.id, bot.id, whyJoin(why), why);
    }
  }

  /**
   * ★ **못 붙은 봇을 다시 붙여본다** — 화면의 [다시 시도] (2026-10-13).
   *
   * 자동으로 되풀이하지 않는다. 「몇 초마다」 라는 숫자가 하나 생기는데 그
   * 숫자는 아무도 고를 수 없다 — MCP 쪽과 같은 규칙이다.
   */
  async retryJoin(roomId: string, botId: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;
    this.runtimes.setStatus(room.id, "connecting", bot.id);
    await this.joinOne(room, bot);
    this.emit("room", room);
  }

  /**
   * 쓰다 만 메시지를 기억한다.
   *
   * 타이핑마다 디스크를 때리지 않도록 디바운스한다. 방을 나가거나 전송할 때는
   * `flushDraft()`로 즉시 확정한다.
   */
  setDraft(roomId: string, text: string): void {
    const room = this.rooms.open.get(roomId);
    if (!room) return;
    room.draft = text || undefined;
    clearTimeout(this.draftTimer);
    // **어느 방의 초안인지 붙들어 둔다.** 아래 참조.
    this.draftRoomId = roomId;
    this.draftTimer = setTimeout(() => void this.flushDraft(), 800);
  }

  /**
   * 디바운스 중인 초안을 즉시 확정한다 (B7).
   *
   * 🔴 예전에는 **«지금 활성인 방»의 초안**을 저장했다. 대개는 같은 방이라
   * 맞아떨어졌지만, 활성 방이 없거나 이미 바뀐 뒤에 불리면 **엉뚱한 방을
   * 저장하거나 아무것도 저장하지 않았다.** 초안은 «내가 쓰던 글»이라
   * 조용히 사라지면 안 된다 — **쓴 방을 기억해 그 방에 쓴다.**
   */
  async flushDraft(): Promise<void> {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    const roomId = this.draftRoomId;
    this.draftRoomId = undefined;
    if (!roomId) return;
    const room = this.rooms.open.get(roomId);
    if (room) await this.rooms.saveProps(room, { draft: room.draft });
  }

  // ── 대화 ──────────────────────────────────────────────────────────────

  /**
   * 메시지를 보낸다.
   *
   * ⏪ **진행 중이면 쌓았다가 묶어서 보내던 것을 없앴다** (v3.0 1-E).
   * 그 큐가 엇갈림을 만들었다 — 10분짜리 일이 끝난 뒤에 «그거 말고 이거»가
   * 나가서 이미 끝난 일에 대한 정정이 날아갔다. 이제는 **예약 한 칸**
   * (`stage`)이고, 올리는 것은 사용자가 누르는 명시적 행동이다.
   *
   * 🔴 **그래도 여기서 한 번 더 막는다.** 화면은 «한가하다»를 보고 보내기를
   * 눌렀는데 그사이 바빠질 수 있다 — 그대로 밀어 넣으면 **도는 턴 한가운데에
   * 프롬프트가 하나 더** 들어간다. 그럴 땐 예약 칸으로 돌린다.
   */
  async send(
    roomId: string,
    text: string,
    attachments?: Attachment[],
    /** 보낼 봇. 안 주면 방의 유일한 봇 (v2.0에서는 멘션이 정한다) */
    botId?: string,
  ): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    // v1.0은 방에 봇이 하나다. 단체방에서는 **멘션된 봇마다** 이 아래가 돈다.
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;

    /*
     * 🔴 **올려둔 것이 있으면 아무것도 안 나간다** (2026-10-12).
     *
     * 화면이 단추를 끄지만, 규칙은 **여기서도** 지킨다 — 안 그러면 화면이
     * 늦게 알거나 다른 길로 들어왔을 때 **나중에 친 말이 먼저 나간다.**
     */
    if (room.staged) {
      this.rooms.noteRoom(room, "올려둔 글이 먼저 나가야 합니다.", "error");
      return;
    }
    if (isBusy(this.runtimes.statusOf(roomId, bot.id)) === true) {
      await this.holdBack(room, [{ kind: "text", text }], attachments, [bot.name]);
      return;
    }

    // 보냈으니 초안은 비운다
    room.draft = undefined;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;

    const sent: Message = {
      id: messageId(),
      role: "user",
      text,
      deliveredTo: botId ? [bot.id] : room.participants.map((b) => b.id),
      createdAt: Date.now(),
      ...(attachments?.length ? { attachments } : {}),
    };
    this.rooms.append(room, sent);

    // **보낸 즉시 저장한다.** 턴이 끝날 때 몰아서 저장하면, 응답을 기다리는 중에
    // VSCode를 닫았을 때 내가 보낸 메시지까지 사라진다.
    await this.rooms.saveNewMessage(room, sent);

    await this.turns.runQueue(room, [sent], bot.id);
    this.maybeFireStaged(room);
    this.maybeReleaseRoom(room.id);
  }

  /**
   * **한 번에 쓴 글을 멘션 그룹대로 쪼개 보낸다** (§4.1.2 · §4.3).
   *
   * 1:1의 `send()`는 «방의 유일한 봇에게 이 글»이었다. 단체방에서는 한 번 쓴
   * 것이 **여러 봇에게 서로 다른 지시**로 갈라지므로 입구가 따로 필요하다.
   *
   * ```
   * (@claude) (@codex)          →  블록 1 : 두 봇에게
   * 이 코드 리뷰해줘
   *
   * (@리뷰어)                  →  블록 2 : 한 봇에게
   * 문서도 업데이트해줘
   * ```
   *
   * 🔴 **저장은 대상별로 쪼갠다.** 한 말풍선에 여러 봇을 담으면 «누가 무엇을
   * 받았나»가 흐려지고, 봇별 뷰(v2.1)와 응답 짝짓기가 전부 어려워진다.
   *
   * ★ **화면도 쪼갠 그대로 그린다** (2026-09-23 확정).
   *
   * 🔴 여기 *"`composeGroupId` 로 묶어 화면이 붙여 그린다"* 고 적혀 있었는데
   * **화면은 그 값을 한 번도 읽지 않는다.** 주석만 그렇게 말하고 있었다 —
   * 실제로는 처음부터 블록마다 말풍선 하나였다.
   *
   * 그리고 **그게 맞다.** 여럿에게 섞어 보내면 붙여 놓은 말풍선에서는 «어느
   * 줄이 누구에게 갔는지»를 눈으로 되짚어야 하는데, 나눠 두면 **말풍선마다
   * 받는 이 칩이 따로 붙어** 한눈에 갈린다. 쪼갠 이유(«누가 무엇을 받았나»)가
   * 화면에서도 똑같이 값을 한다.
   *
   * `composeGroupId` 는 **저장만 해둔다** — «한 번에 쓴 것»이라는 사실 자체는
   * 잃을 이유가 없고(§0), 첨부를 어느 블록에 붙일지 같은 것이 나중에 이 값을
   * 쓴다. **붙여 그리라는 뜻은 아니다.**
   *
   * **블록끼리는 병렬**이다(§4.3). 봇이 다르면 기다릴 이유가 없고, 같은 봇이
   * 두 블록에 나오면 그 봇의 큐가 알아서 순서를 지킨다 — 직렬은 **세션 단위**의
   * 제약이지 방 단위가 아니다.
   */
  async sendCompose(
    roomId: string,
    tokens: ComposeToken[],
    attachments?: Attachment[],
  ): Promise<ComposeParse> {
    const room = await this.rooms.openRoom(roomId);
    const parsed = parseCompose(tokens, room.participants);

    // 말해줄 것이 있으면 **보내기 전에** 남긴다 — 건너뛴 그룹을 나중에 알려주면
    // 이미 «보냈다»고 믿은 뒤다.
    for (const w of parsed.warnings) this.rooms.noteRoom(room, w, "info");
    if (parsed.blocked) {
      this.rooms.noteRoom(room, parsed.blocked, "error");
      return parsed;
    }

    /*
     * 🔴 **한 명이라도 바쁘면 통째로 올려둔다** (v3.0 1-E).
     *
     * ⏪ 예전에는 **봇마다** 갈라져서, 알파에게는 지금 가고 베타에게는 줄을
     * 섰다. 예약 칸은 방에 하나뿐이라 그 갈래를 못 만든다 — 그리고 안 만드는
     * 편이 맞다: 반만 나가면 **반만 나간 것을 사용자가 알아야** 하고, 그걸
     * 말해주려면 결국 «줄 서 있음» 표시가 다시 필요해진다.
     *
     * ⚠️ 예약이 **스스로를 다시 올리는 일은 없다** — `maybeFireStaged` 는
     * 기다리던 봇이 전부 한가할 때만 부른다.
     */
    // 🔴 **올려둔 것이 먼저다** — 받는 이가 누구든 (위 `send` 주석)
    if (room.staged) {
      this.rooms.noteRoom(room, "올려둔 글이 먼저 나가야 합니다.", "error");
      return parsed;
    }
    const busy = [...new Set(parsed.blocks.flatMap((b) => b.botIds))]
      .filter((id) => isBusy(this.runtimes.statusOf(roomId, id)) === true)
      .map((id) => room.participants.find((b) => b.id === id)?.name ?? id);
    if (busy.length > 0) {
      await this.holdBack(room, tokens, attachments, busy);
      return parsed;
    }

    room.draft = undefined;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;

    const groupId = messageId();
    const at = Date.now();

    /** 블록 하나 = 메시지 하나. 먼저 **전부 적고** 나서 보낸다 */
    const sent: Array<{ message: Message; botIds: string[] }> = [];
    for (const [n, block] of parsed.blocks.entries()) {
      const message: Message = {
        id: messageId(),
        role: "user",
        text: block.text,
        deliveredTo: block.botIds,
        createdAt: at + n,   // 쓴 순서를 잃지 않는다
        composeGroupId: groupId,
        // 첨부는 **첫 블록에만** 붙인다. 블록마다 복사하면 같은 그림을 여러 번
        // 올리게 되고, 어느 블록에 붙일지는 화면이 고르게 할 일이다(v2.1).
        ...(n === 0 && attachments?.length ? { attachments } : {}),
      };
      this.rooms.append(room, message);
      await this.rooms.saveNewMessage(room, message);
      sent.push({ message, botIds: block.botIds });
    }

    // ── 보낸다. **봇마다 독립**이라 한 봇이 막혀도 나머지는 간다
    const byBot = new Map<string, Message[]>();
    for (const { message, botIds } of sent) {
      for (const id of botIds) {
        const list = byBot.get(id) ?? [];
        list.push(message);
        byBot.set(id, list);
      }
    }

    await Promise.all(
      [...byBot].map(async ([botId, batch]) => {
        const bot = room.participants.find((b) => b.id === botId);
        if (!bot) return;
        /*
         * ★ **블록마다 한 턴씩** — 합치지 않는다 (§4.1.2).
         *
         * 같은 봇을 두 번 지목했다면 *"먼저 이것, 그다음 저것"* 을 나눠 시킨
         * 것이다. 묶어 보내면 한 턴이 되어 그 순서가 «한 번에 말한 것»으로
         * 눈치까지 눈치는 수밖에 없다.
         *
         * 묶는 것은 **답하는 중에 끼어든** 메시지들이다(§4.3) — 그건 사용자가
         * 따로 보낸 것이고, 기다리는 동안 쌓인 것을 한 번에 주는 게 이득이다.
         */
        for (const one of batch) await this.turns.runQueue(room, [one], botId);
      }),
    );
    this.maybeFireStaged(room);
    this.maybeReleaseRoom(room.id);
    return parsed;
  }

  /**
   * 전달되지 못한 메시지를 다시 보낸다.
   *
   * 새 말풍선을 만들지 않고 **원래 메시지의 실패 표시만 걷어낸다** — 메신저에서
   * 재전송하면 그 말풍선이 그대로 보내지는 것과 같다.
   */
  async retry(roomId: string, messageId?: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const targets = room.messages.filter(
      (m) => m.role === "user" && m.sendFailed && (!messageId || m.id === messageId),
    );
    if (targets.length === 0) return;

    /*
     * ★ **안 간 봇에게만 다시 보낸다** (v2.0).
     *
     * 한 메시지가 여럿에게 갈 수 있고(`@알파 @베타`), 그중 한 쪽만 끊길 수
     * 있다. 전원에게 다시 보내면 **이미 받은 봇이 같은 일을 두 번 한다** —
     * 코딩 에이전트에서는 파일을 두 번 고치는 일이다.
     */
    const byBot = new Map<string, Message[]>();
    for (const m of targets) {
      const who = m.notSentTo?.length ? m.notSentTo : m.deliveredTo;
      for (const id of who) {
        if (!room.participants.some((b) => b.id === id)) continue;
        const list = byBot.get(id) ?? [];
        list.push(m);
        byBot.set(id, list);
      }
    }
    for (const m of targets) {
      delete m.sendFailed;
      delete m.notSentTo;
      await this.rooms.saveMessage(room, { id: m.id, sendFailed: undefined, notSentTo: undefined });
      this.emit("message", room.id, m);
    }
    if (byBot.size === 0) return;

    await Promise.all(
      [...byBot].map(([botId, batch]) => this.turns.runQueue(room, batch, botId)),
    );
    this.maybeFireStaged(room);
  }

  /** 다시 보낼 수 있는 메시지가 있는지 (UI의 `↻` 표시 여부) */
  hasFailedMessages(room: Room): boolean {
    return room.messages.some((m) => m.role === "user" && m.sendFailed);
  }

  /**
   * 받다 만 응답이 있는지.
   *
   * 있으면 다음에 세션을 열 때 `resume` 대신 `load`를 써서 보정할 수 있다 —
   * 끊긴 건 **마지막 에이전트 메시지 하나**뿐이라 꼬리만 바꿔치기하면 된다.
   * 평소에는 `resume`을 쓰므로 비용이 늘지 않는다.
   */
  truncatedMessage(room: Room): Message | undefined {
    const last = room.messages.at(-1);
    return last?.truncated ? last : undefined;
  }

  /**
   * ★ **전체 중지 — 중지는 이것 하나다** (v3.0 1-D · C6).
   *
   * ⏪ 한때 넷이었다: 방 전체 중단 · 봇 하나만 중단 · 끼어들기 · 줄에서 빼기.
   * 넷을 다 두면 **각각이 MCP 큐·권한 대기·심사 줄과 어떤 관계인지 따로
   * 정의해야 한다** — v3.0 에서 그게 열여섯 가지 조합이 된다. 하나면 한 번만
   * 정하면 되고, 사용자도 «무엇이 멈추는지»를 한 번만 배우면 된다.
   *
   * ```
   * 멈춘다    도는 턴 전부 · 줄 서 있던 것 전부
   * 정리한다  심사 줄 · 떠 있던 승인 카드 — **cancelled 로 답하고** 거둔다
   * 내린다    «무조건 허용» → «물어봄»
   * 남긴다    말풍선 · 내 말은 «안 갔다»+↻ · 봇 말은 받은 데까지
   * ```
   *
   * 🔴 **«내린다»가 없으면 중지가 «잠깐 멈춤»이 된다.** 자리를 비운 채
   * 알아서 하라고 해둔 상태로 되돌아가면, 멈추라고 누른 사람이 다음 말 한
   * 마디에 **다시 같은 자리로** 간다.
   */
  async stopAll(roomId: string): Promise<void> {
    const room = this.rooms.open.get(roomId);
    const rt = this.runtimes.get(roomId);
    if (!room || !rt) return;

    /*
     * ★ **답을 기다리던 것부터 푼다.**
     *
     * `session/request_permission` 은 **블로킹**이다. 턴만 끊고 이걸 그대로
     * 두면 에이전트는 영영 답을 기다리고, 화면에는 누를 수 없는 카드가 남는다.
     * 그러니 **먼저** `cancelled` 로 답해 길을 터준다.
     */
    /*
     * ★ **MCP 큐를 비우고, 기다리던 것을 푼다** (v3.0 2-H · 3-I).
     *
     * 🔴 `session/request_permission` 은 **블로킹**이다. 턴만 끊고 이걸
     * 그대로 두면 에이전트는 영영 답을 기다린다 — **먼저** `cancelled` 로
     * 답해 길을 터준다.
     *
     * 🔴 그리고 큐에 남은 말은 **중지한 뒤에 봇을 깨운다** — 멈추라고
     * 눌렀는데 하던 이야기가 이어지는 꼴이다.
     */
    for (const item of this.queue.dropAll(room.participants.map((b) => b.id))) {
      this.queue.close(item.id, "전체 중지로 거두어졌습니다");
      if (item.kind === "permission") this.review.settleQueued(item.id, { outcome: "cancelled" });
    }
    /*
     * 큐에 안 든 채 기다리는 것도 있다 — 넣기 **전에** 거른 것들(«이번만»
     * 선택지가 없어서 사람에게 넘긴 것 등)은 호스트가 들고 있다.
     */
    this.opts.host.cancelPermissions?.(roomId);

    for (const bot of room.participants) {
      const bt = rt.bots.get(bot.id);
      if (!bt?.sessionId) continue;

      /*
       * 🔴 **왜 끊겼는지는 우리가 적어야 한다.** `session/cancel` 은 «왜»를
       * 안 알려주고, 모델은 그 빈칸을 추측으로 메운다 — 한 판은 «권한이
       * 거부돼서»라고 지어냈다(실측 2026-09-23).
       */
      if (isBusy(this.runtimes.statusOf(roomId, bot.id)) === true) bt.interrupted = true;
      await this.pool.get(bot.agentId)?.cancel(bt.sessionId);
    }
    /*
     * ★ **올려둔 것도 같이 내린다** (v3.0 1-E).
     *
     * ⏪ 여기서 «줄에 있던 것을 안 갔다로 적는» 일을 했다. 줄이 없어졌으니
     * 적을 것도 없다 — 대신 **예약 칸**이 그 자리를 잇는다. 남겨두면
     * **중지한 뒤에 뜬금없이 한 마디가 나간다.**
     *
     * 자국은 안 남긴다 — 아무도 못 본 글이다(§0).
     */
    await this.unstage(roomId);

    /*
     * ★ **«무조건 허용»을 내린다** (§4.2.2).
     *
     * 자리를 비운 채 맡겨둔 상태 그대로 멈추면, 다음 말 한 마디에 **같은
     * 자리로 되돌아간다.** 멈추라고 누른 사람의 뜻은 거기까지다.
     *
     * 🔴 **조용히 바꾸지 않는다**(§0). 사용자가 켠 것을 우리가 껐으므로
     * 방에 적는다 — 안 적으면 다음에 «왜 또 묻지»가 된다.
     */
    const lowered = room.participants.filter((b) => b.answerPolicy === "auto");
    for (const b of lowered) b.answerPolicy = "ask";
    if (lowered.length > 0) {
      await this.rooms.saveProps(room, { participants: room.participants });
      this.rooms.noteRoom(
        room,
        `중지하면서 ${lowered.map((b) => b.name).join("·")}의 «무조건 허용»을 ` +
          `«물어봄»으로 내렸습니다.`,
        "info",
        lowered.map((b) => b.id),
      );
    }

  }

  // ── 예약 한 칸 (v3.0 1-E) ────────────────────────────────────────────

  /**
   * ★ **올려둔다** — 지금 바쁜 봇이 있어 못 보내는 글을 한 칸에 둔다.
   *
   * ⏪ 여기 있던 것은 **봇마다의 큐**였다. 바쁠 때 보내면 **저절로** 줄에
   * 섰고, 그게 엇갈림을 만들었다 — 10분짜리 일이 끝난 뒤에 «그거 말고 이거»가
   * 나가서 **이미 끝난 일에 대한 정정**이 날아갔다.
   *
   * 🔴 **예약은 명시적 행동이다.** 옛 큐는 기본 동작이라 모르고 쌓였다
   * («내가 언제 이걸 줄 세웠지»). 눌러서 올린 것이면 엇갈려도 납득이 된다.
   *
   * **아직 말풍선을 안 만든다.** 내리면 흔적 없이 사라져야 하므로(§0) 실제로
   * 나갈 때 비로소 메시지가 생긴다.
   *
   * @returns 올렸으면 `true`. 칸이 이미 찼으면 `false` — **덮어쓰지 않는다**
   */
  async stage(
    roomId: string,
    tokens: ComposeToken[],
    attachments?: Attachment[],
  ): Promise<boolean> {
    const room = await this.rooms.openRoom(roomId);
    // 🔴 **덮어쓰지 않는다.** 칸이 하나라는 말은 «둘째가 첫째를 밀어낸다»가
    // 아니라 «둘째를 안 받는다»여야 한다 — 밀어내면 조용히 잃는다(§0).
    if (room.staged) return false;

    const parsed = parseCompose(tokens, room.participants);
    const botIds = [...new Set(parsed.blocks.flatMap((b) => b.botIds))];
    if (botIds.length === 0) return false;

    room.staged = {
      tokens,
      ...(attachments?.length ? { attachments } : {}),
      botIds,
      at: Date.now(),
    };
    await this.rooms.saveProps(room, { staged: room.staged });
    this.emit("room", room);

    /*
     * ★ **기다릴 것이 없으면 지금이 그때다** (2026-10-12).
     *
     * 🔴 `maybeFireStaged` 는 **턴이 끝나는 자리**에서만 도는데, 끝낼 턴이
     * 없으면 영영 안 나간다 — 올려둔 글이 입력창 위에 뜬 채로 멎는다.
     * 재보고 알았다(한가할 때 올리면 1.5초 뒤에도 그대로 있었다).
     *
     * 규칙을 그대로 읽으면 이미 답이 있다 — «기다리던 봇이 **전부 한가해지면**
     * 나간다». 한가하면 그 조건이 **이미 참**이다.
     *
     * ★ 이게 없으면 둘째 구멍이 딸린다: 그 상태에서 새로 친 말을 보내면
     * **새 말이 먼저 가고 올려둔 말이 그 뒤에** 간다 — 1-E 가 없애려던
     * 엇갈림과 같은 종류다.
     */
    this.maybeFireStaged(room);
    return true;
  }

  /**
   * **늦게 알아챘을 때 예약으로 돌린다** (`send`·`sendCompose` 의 막음벽).
   *
   * 🔴 화면이 «한가하다»를 보고 보내기를 눌렀는데 그사이 바빠질 수 있다.
   * 그대로 밀어 넣으면 **도는 턴 한가운데에 프롬프트가 하나 더** 들어간다.
   *
   * 칸이 이미 찼으면 **덮어쓰지 않고 말해준다** — 덮어쓰면 조용히 잃는다(§0).
   * 글은 입력창에 그대로 남아 있으므로 사용자가 잃는 것은 없다.
   */
  private async holdBack(
    room: Room,
    tokens: ComposeToken[],
    attachments: Attachment[] | undefined,
    waitingFor: string[],
  ): Promise<void> {
    if (await this.stage(room.id, tokens, attachments)) {
      this.rooms.noteRoom(
        room,
        `${waitingFor.join("·")}이(가) 답하는 중이라 올려두었습니다 — 끝나면 보냅니다.`,
        "info",
      );
      return;
    }
    /*
     * ⚠️ **«칸이 찼다» 로는 여기 안 온다** — 부르는 쪽(`send`·`sendCompose`)이
     * 이미 막는다. 여기 남는 경우는 **받을 봇을 못 고른 것**뿐이다
     * (나간 봇만 지목했다든가).
     */
    this.rooms.noteRoom(room, "올려둘 수가 없습니다 — 받을 봇이 없습니다.", "error");
  }

  /**
   * **내린다** — 글까지 버린다.
   *
   * 🔴 흔적을 안 남긴다. 아무도 못 봤으므로 지울 수 있고, 지우면 자국이
   * 없어야 한다(§0 — «간 적 없는 것만 지울 수 있고, 지우면 흔적이 없다»).
   */
  async unstage(roomId: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    if (!room.staged) return;
    delete room.staged;
    await this.rooms.saveProps(room, { staged: undefined });
    this.emit("room", room);
  }

  /**
   * **수정한다** — 예약을 풀고 글을 돌려준다. 화면이 입력창에 꽂는다.
   *
   * 내리기와 **같은 동작이고 «글을 살리느냐»만 다르다.** 그래서 예약 칸은
   * 입력란을 따로 안 들어도 된다 — 보여주기만 한다.
   */
  async takeStaged(roomId: string): Promise<Staged | undefined> {
    const room = await this.rooms.openRoom(roomId);
    const was = room.staged;
    if (!was) return undefined;
    delete room.staged;
    await this.rooms.saveProps(room, { staged: undefined });
    this.emit("room", room);
    return was;
  }

  /**
   * **때가 되면 내보낸다** — 기다리던 봇이 전부 한가해졌을 때.
   *
   * 🔴 **한 봇만 봐서는 안 된다.** 예약은 방에 하나고 받는 이는 여럿일 수
   * 있다 — 알파가 끝났다고 베타에게 갈 말까지 지금 보내면 **베타의 턴
   * 한가운데로 밀어 넣는** 꼴이다. 전부 한가할 때까지 기다린다.
   *
   * ⚠️ **부르는 쪽을 안 기다린다**(`void`). 턴이 끝나는 자리에서 불리는데,
   * 거기서 다음 턴이 끝나기를 기다리면 턴 하나가 영영 안 닫힌다.
   */
  private maybeFireStaged(room: Room): void {
    const want = room.staged;
    if (!want || this.down || this.firing.has(room.id)) return;
    // 그사이 나간 봇은 기다릴 것이 없다 — 남은 사람만 본다
    const live = want.botIds.filter((id) => room.participants.some((b) => b.id === id));
    if (live.length === 0) {
      void this.unstage(room.id);
      return;
    }
    if (live.some((id) => isBusy(this.runtimes.statusOf(room.id, id)) === true)) return;

    this.firing.add(room.id);
    delete room.staged;
    void this.rooms.saveProps(room, { staged: undefined });
    this.emit("room", room);
    void this.sendCompose(room.id, want.tokens, want.attachments)
      .catch((err) => this.opts.host.log(`[${room.id}] 예약 보내기 실패: ${describe(err)}`))
      .finally(() => this.firing.delete(room.id));
  }

  // ── 권한·심사 — `core/review/review.ts` 로 갔다 (리팩토링 ⑦-3) ────────────
  reviewsIn(roomId: string): ReviewWait[] { return this.review.reviewsIn(roomId); }
  waitingIn(roomId: string): WaitItem[] { return this.review.waitingIn(roomId); }
  dropWaiting(roomId: string, botId: string, id: string): boolean { return this.review.dropWaiting(roomId, botId, id); }
  answerWaiting(roomId: string, botId: string, id: string, allow: boolean): boolean { return this.review.answerWaiting(roomId, botId, id, allow); }
  takeOverReview(reviewId: string): boolean { return this.review.takeOverReview(reviewId); }
  /** 연결이 권한을 물어올 때 — 심사 층으로 넘긴다 (검사들도 이 이름으로 부른다) */
  private askApprover(sessionId: string,
    req: PermissionRequest,): Promise<PermissionDecision> { return this.review.askApprover(sessionId, req); }

  /** 에이전트가 압축 명령을 제공하는지 (C11). 없으면 버튼을 숨긴다 */
  compactCommand(roomId: string, botId?: string): string | undefined {
    const room = this.rooms.open.get(roomId);
    const bot = botId
      ? room?.participants.find((b) => b.id === botId)
      : room
        ? this.soleBot(room)
        : undefined;
    const names = bot ? (this.runtimes.get(roomId)?.bots.get(bot.id)?.commands ?? []) : [];
    return names.find((n) => /^(compact|compress)$/i.test(n));
  }

  /** 압축을 시킬 수 있는 봇들 — 화면이 버튼을 어디 보일지 정하는 근거 */
  compactableBots(roomId: string): string[] {
    const room = this.rooms.open.get(roomId);
    return (room?.participants ?? [])
      .filter((b) => this.compactCommand(roomId, b.id))
      .map((b) => b.id);
  }

  /**
   * 컨텍스트를 압축한다 (C11).
   *
   * **ACP에 압축 요청 메서드가 없다.** 에이전트가 광고한 슬래시 명령을 프롬프트로
   * 보내는 게 유일한 경로다.
   */
  async compact(roomId: string, botId?: string): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;
    const cmd = this.compactCommand(roomId, bot.id);
    if (!cmd) throw new Error(`${bot.name}은(는) 압축을 지원하지 않습니다.`);
    await this.send(roomId, `/${cmd}`, undefined, bot.id);
    // 압축되면 역할이 요약에 안 남을 수 있다. 다음 턴에 다시 주입한다 (B3).
    const after = this.runtimes.bot(room.id, bot.id);
    after.roleInjected = false;
    // 명단도 요약에 안 남는다 — 같은 이유로 같이 거둔다 (4-K)
    delete after.rosterSent;
  }

  /**
   * 대화 중에 모델·추론 강도를 바꾼다 (B12·B15).
   *
   * 방 만들 때만 정할 수 있으면 "Opus로 바꿔볼까"가 불가능하다.
   */
  async setConfig(
    roomId: string,
    configId: string,
    value: string | boolean,
    /**
     * 어느 봇의 설정인가.
     *
     * 🔴 **없이 만들었다가 단체방에서 어긋났다.** 언제나 `participants[0]` 을
     * 골랐으므로, 서랍에서 **둘째 봇의 모델을 바꾸면 첫째 봇이 바뀌었다** —
     * 권한 시트의 모드도 같았다. 설정은 **세션에 거는 것**이고 세션은 봇
     * 단위다(B1). 안 주면 예전처럼 방의 첫 봇이다(1:1 경로).
     */
    botId?: string,
  ): Promise<acp.SessionConfigOption[]> {
    const room = await this.rooms.openRoom(roomId);
    const bot = (botId ? room.participants.find((b) => b.id === botId) : undefined)
      ?? room.participants[0]!;

    // 🔴 **저장된 `sessionId`를 그대로 쓰면 안 된다.** 창을 껐다 켜면 그 id는
    // 디스크에 남아 있지만 **CLI는 그 세션을 안 들고 있다** — 방을 여는 것만으로는
    // 복구하지 않기 때문이다(복구는 첫 전송에서 일어난다). 그 상태로 설정을 바꾸면
    // 없는 세션에 대고 부르게 된다. `ensureSession`이 복구까지 책임진다.
    // 턴이 도는 중에도 모드를 바꿀 수 있다 — 그 상태를 덮어쓰면 안 된다
    const before = this.runtimes.statusOf(room.id);
    if (before === "idle") this.runtimes.setStatus(room.id, "connecting", bot.id);
    let sessionId: string;
    try {
      sessionId = await this.sessions.ensure(room, bot);
    } finally {
      if (before === "idle") this.runtimes.setStatus(room.id, "idle", bot.id);
    }

    const conn = this.pool.connection(bot.agentId);
    const updated = await conn.setConfigOption(sessionId, configId, value);
    if (typeof value === "string") this.config.rememberModel(bot.agentId, configId, value);

    // **권한 모드도 모델 이름도 여기서 봇에 박힌다** (D2·B5) — 응답에 실려 온
    // 현재 값을 그대로 옮기므로, 우리가 보낸 값과 에이전트가 실제로 고른 값이
    // 다르면 에이전트 쪽이 이긴다.
    this.config.note(room, bot, updated);
    /*
     * ★ **물음에 답한 것이다 — 띠를 걷는다** (2026-09-30).
     *
     * 고른 모델이 없어져서 «다시 고르세요» 를 띄워뒀다면, 여기서 고른 것이
     * 그 답이다. **무엇을 골랐든 걷는다** — 대체된 그것을 그대로 고르는 것도
     * 답이고, 그때도 다시 물으면 걷을 길이 없어진다.
     *
     * `participants` 는 배열째 갈아 끼우므로 `delete` 로 디스크에서도 사라진다 —
     * 한 칸만 `undefined` 로 두는 것과 다르다(그쪽은 `store` 의 `erasable` 몫).
     */
    if (updated.find((o) => o.id === configId)?.category === "model") delete bot.modelGone;
    await this.rooms.saveProps(room, { participants: room.participants });
    /*
     * 🔴 **방을 다시 내보내야 한다.**
     *
     * `noteRoomConfig` 가 `bot.model`·`modelLabel` 을 고치는데, 그걸 안 알리면
     * 화면은 **낡은 방 스냅샷**을 계속 들고 있다. 서랍의 모델 칸은
     * `bot.model ?? model.current` 로 읽으므로 **낡은 쪽이 이겨서**, 모델을
     * 바꿔도 칸은 그대로였다 — 방을 다시 열기 전까지.
     */
    this.emit("room", room);

    // 왜 응답 성향이 바뀌었는지 나중에 알 수 있어야 한다
    const opt = updated.find((o) => o.id === configId);

    if (opt?.category === "model") {
      const msg: Message = {
        id: messageId(),
        role: "system",
        // id가 아니라 **보이는 이름으로** 남긴다 — 사용자가 고른 건 그쪽이다
        text:
          `${whose(room, bot)}모델이 ` +
          `${bot.modelLabel ?? String(value)}(으)로 바뀌었습니다.`,
        // 그 봇 이야기다 — 봇별 뷰에서는 그 봇 쪽에만 (v2.1)
        aboutBotIds: [bot.id],
        deliveredTo: [],
        createdAt: Date.now(),
      };
      this.rooms.append(room, msg);
      await this.rooms.saveNewMessage(room, msg);
    }
    return updated;
  }

  /**
   * 봇의 질문 정책을 바꾼다 (D5).
   *
   * **권한은 여기 없다.** 권한은 에이전트 모드가 정하고, 그건 `setConfig()`로
   * 세션에 적용한다(D2) — 우리 사다리를 따로 두지 않는다.
   *
   * 1:1 방에서는 봇이 하나뿐이라 `botId`를 생략하면 그 봇을 가리키고,
   * 단체방에서는 참여자 서랍이 `botId`를 준다.
   */
  async setPolicy(
    roomId: string,
    patch: { answerPolicy?: AnswerPolicy; approver?: Approver },
    botId?: string,
  ): Promise<void> {
    const room = await this.rooms.openRoom(roomId);

    // 1:1이면 «그 봇». 여럿인데 지목하지 않으면 누구 얘긴지 알 수 없다.
    // 손으로 다시 쓴 soleBot 이었다 — 같은 갈래라 같은 로그를 받게 그쪽으로 (리팩토링 ⑥)
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;

    if (patch.answerPolicy !== undefined) bot.answerPolicy = patch.answerPolicy;
    if (patch.approver !== undefined) bot.approver = patch.approver;
    await this.rooms.saveProps(room, { participants: room.participants });
  }


  // ── 세션 설정 ──────────────────────────────────────────────────────────

  /**
   * 모델 등 선택지를 받아온다 (B15).
   *
   * 캐시가 있으면 **즉시 돌려주고 뒤에서 갱신**한다 — 방 만들기 화면에서
   * 목록이 비어 보이지 않게 하려는 것이다.
   */
  /**
   * 에이전트가 받아주는 첨부 종류 (I5).
   *
   * **CLI를 띄우지 않는다** — 연결 전이면 전부 허용으로 답하고,
   * 실제로 보낼 때 다시 확인해 걸러낸다.
   */
  /**
   * 모든 방의 대화를 훑는다 (H2).
   *
   * 방 하나가 세션 하나라 **방이 빠르게 쌓인다.** 일주일이면
   * 수십 개가 되므로 기본 기능이다.
   */
  search(query: string, limit?: number): Promise<SearchHit[]> {
    return this.opts.store.search(query, limit);
  }

  /**
   * 방의 사용량 (B14).
   *
   * 스트리밍은 메시지 단위로만 나가므로(F9), 셀이 사용량을 같이
   * 실어 보내려면 동기적으로 집어올 수 있어야 한다.
   */
  usageOf(roomId: string): RoomUsage | undefined {
    return this.rooms.open.get(roomId)?.usage;
  }

  /**
   * 그 에이전트가 세션을 갈라줄 수 있나 (v1.1).
   *
   * 화면이 **누르기 전에** *"상태를 잃습니다"* 라고 알려주려고 내보난다.
   * `unknown`이면 경고하지 않는다 — 모르는 걸 단정하면 멀줦한 에이전트를 못 한다고 모함한다.
   */
  forkSupport(agentId: string): "yes" | "no" | "unknown" {
    return this.pool.connection(agentId).forkSupport();
  }

  promptCapabilities(agentId: string): { image: boolean; audio: boolean; embeddedContext: boolean } {
    return this.pool.connection(agentId).promptCapabilities();
  }

  /**
   * **이 방의** 설정 선택지 (D2·B15).
   *
   * 🔴 에이전트별 캐시를 쓰면 안 된다. 세션은 **방마다, 그리고 방 안에서도
   * 봇마다** 다른데(B1) 캐시가 하나라 **방 A에서 계획 모드로 바꾸면 방 B의
   * 시트에도 «계획»이 떴다.** 방을 여는 순간 세션이 붙으므로 대개 이미 있다.
   */
  async roomConfigOptions(
    roomId: string,
    botId?: string,
  ): Promise<acp.SessionConfigOption[]> {
    const room = await this.rooms.openRoom(roomId);
    // 지목이 없으면 방의 유일한 봇 (v1.0). 단체방에서는 화면이 봇을 준다.
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return [];

    const known = this.config.ofBot(room.id, bot.id);
    if (known) return known;

    await this.bindSession(room);
    const after = this.config.ofBot(room.id, bot.id);
    if (after) return after;

    // 붙는 데 실패했으면 이유가 있어야 한다 — 빈 목록으로 삼키면
    // «이 에이전트는 권한 모드가 없다»로 읽힌다
    return this.configOptions(bot.agentId);
  }

  /** 에이전트별 설정 선택지 — `SessionConfig.forAgent` (방 만들기 화면 몫) */
  async configOptions(agentId: string): Promise<acp.SessionConfigOption[]> {
    return this.config.forAgent(agentId);
  }

  /**
   * ★ **에이전트마다 구독 잔량을 물어온다** (사용자, 2026-10-19).
   *
   * 🔴 **방을 안 거친다.** `send` 로 보내면 읽던 대화에 말풍선이 둘 남는데,
   * 잔량 조회는 «대화의 사건» 이 아니다. `AcpConnection.probeUsage` 가
   * 조회용 세션을 따로 열고 닫는다.
   *
   * ★ **묶음은 에이전트다.** 잔량은 계정에 붙는 값이라 방마다 다르지 않고,
   * 한 방에 Claude 봇이 둘 있어도 **물어볼 것은 한 번**이다.
   *
   * 🔴 **하나가 터져도 나머지는 돌려준다.** 셋 중 하나가 로그인이 풀렸다고
   * 전부 빈손이 되면, 멀쩡한 둘을 보려고 그걸 먼저 고쳐야 한다.
   */
  async quotaOf(agentIds: readonly string[]): Promise<AgentQuota[]> {
    const seen = [...new Set(agentIds)];
    return await Promise.all(seen.map(async (agentId): Promise<AgentQuota> => {
      const def = this.opts.agents.find((a) => a.id === agentId);
      const label = def?.label ?? agentId;
      try {
        /*
         * ★ **무엇을 물을지도 애드온이 정한다** — 코어는 명령 이름을 모른다.
         * 목록을 세울 때 standard 가 끼워지므로 보통 비지 않는다.
         */
        const q = def?.quota;
        if (!q) {
          return { agentId, label, at: Date.now(), why: "잔량을 묻는 길을 모르는 에이전트입니다." };
        }
        const got = await withTimeout(
          this.pool.connection(agentId).probeUsage(this.opts.host.defaultCwd(), q.commands),
          USAGE_PROBE_MS,
          `${label}이(가) ${Math.round(USAGE_PROBE_MS / 1000)}초 안에 응답하지 않았습니다.`,
        );
        /*
         * ★ **뜯는 것은 애드온이다** — 코어는 그 꼴(`QuotaLine[]`)만 받는다.
         *
         * 🔴 **애드온이 터져도 팝업은 산다.** 남의 글 모양에 기대는 코드라 언젠가
         * 반드시 틀리는데, 그게 예외로 올라오면 다른 에이전트 줄까지 같이 사라진다.
         * 막대만 잃고 받은 글은 그대로 보인다.
         */
        let lines: AgentQuota["lines"] = [];
        try { lines = q.parse(got.text); } catch (e) {
          this.opts.host.log(`[${agentId}] 잔량 글을 못 뜯었습니다: ${(e as Error).message}`);
        }
        return { agentId, label, at: Date.now(), ...got, lines };
      } catch (e) {
        return { agentId, label, at: Date.now(), why: (e as Error).message };
      }
    }));
  }

  // ── 내부 ──────────────────────────────────────────────────────────────


  /**
   * 턴을 놓는다 — **응답이 온 순간이 아니라 조금 뒤에** (A11 경계).
   *
   * 🔴 `session/prompt`의 응답과 그 턴의 `session/update`는 **도착 순서가 보장되지
   * 않는다.** 가짜 에이전트로 재보니 8턴 중 2턴에서 응답이 먼저 왔다 — 파이프는
   * 순서를 지키지만 SDK가 그 순서대로 넘겨주지는 않는다.
   *
   * 그래서 응답을 받자마자 턴을 닫으면 **그 턴의 마지막 말이 턴 밖 발화로 오인된다.**
   * 화면에는 «빈 말풍선 + 엉뚱한 자리에 붙은 말»이 되고, 30초 안에 여러 턴이 돌면
   * 그것들이 한 말풍선에 뭉친다.
   *
   * 유예를 두면 그 창이 닫힌다. **길게 잡을 필요는 없다** — 늦어야 수십 ms고,
   * 진짜 턴 밖 발화는 한참 뒤에 온다. 그 사이의 것을 이 턴의 꼬리로 보는 편이
   * 새 말풍선을 만드는 것보다 언제나 맞다.
   */

  /**
   * **나와 있는 사이 조용해졌으면 자리를 놓는다** (v3.0 2-G).
   *
   * 🔴 방을 나와도 봇은 계속 일한다(§4.3). 나오는 그 순간에 놓으면 **옆 창이
   * 들어와 도는 세션을 집는다.** 그래서 나올 때 못 놓은 자리는 **조용해지는
   * 그때** 놓는다 — 턴이 끝나는 자리가 그 전이를 잡아준다.
   */
  private maybeReleaseRoom(roomId: string): void {
    // 보고 있는 방이면 안 놓는다 — 자리는 «보고 있다» 는 뜻이다
    if (this.activeRoomId === roomId) return;
    this.releaseRoom(roomId);
  }

  /** 그 방에서 살아 있는 부딪힘 — `Activity.clashesIn` */
  clashesIn(roomId: string): Clash[] {
    return this.activity.clashesIn(roomId);
  }

  /** 끊긴 맥락을 어떻게 할지 정한다 — `Sessions.decideRefeed` (F7) */
  async decideRefeed(roomId: string, accept: boolean, kind?: "log" | "summary"): Promise<void> {
    return this.sessions.decideRefeed(roomId, accept, kind);
  }

  /** 못 이어받은 세션에 다시 붙어본다 — `Sessions.retryResume` (F7) */
  async retryResume(roomId: string): Promise<boolean> {
    return this.sessions.retryResume(roomId);
  }

  /**
   * 에이전트 프로세스가 죽었다 (A5).
   *
   * **보관 중인 sessionId를 버리는 게 핵심이다.** 그대로 두면 다음 전송이
   * 이미 없는 세션으로 나가 조용히 실패한다. 비워두면 다음 턴에
   * `ensureSession`이 **저장된 세션으로 재접속**한다 (F7) — 대화는 이어진다.
   *
   * 미리 다시 띄우지는 않는다. 쓸 일이 없는데 CLI를 살려두면 메모리만 쓴다.
   */
  /**
   * 권한 요청과 질문을 방에 남긴다 (D3·D5).
   *
   * 자동 승인이나 자동 취소로 조용히 지나가면 나중에
   * *"이걸 물었었구나"* 를 볼 수 없다.
   */

  /**
   * ★ **승인 결과는 그 «활동»에 접어 넣는다** (D3).
   *
   * 🔴 예전에는 승인할 때마다 시스템 메시지를 한 줄씩 붙였다. 한두 번이면
   * 괜찮은데 에이전트가 스무 번 물으면 **대화가 시스템 줄로 덮이고**
   * 정작 읽을 내 대화가 그 사이에 묻힌다.
   *
   * 승인은 **활동의 일종**이다. 그 도구 옆에 붙어 있을 때 «무엇을 승인했나»가
   * 한 자리에서 읽히고, 활동 목록은 원래 접혀 있다(C3).
   *
   * 못 붙이는 경우(그 활동이 아직 안 왔거나 `toolCallId` 가 없을 때)에는
   * **예전처럼 한 줄로 남긴다** — 어느 쪽이든 §0대로 버리지는 않는다.
   */
  private recordDecision(sessionId: string, note: DecisionNote): void {
    const found = this.runtimes.botForSession(sessionId);
    if (!found) return;
    const { room, bot } = found;

    const turn = this.runtimes.bot(room.id, bot.id).turn;
    const hit = note.toolCallId
      ? (turn?.tools ?? []).find((t) => t.id === note.toolCallId)
      : undefined;

    /* 봇이 적어둔 까닭을 여기서 집어 든다 — 한 번 쓰고 버린다 */
    const fromJudge = note.toolCallId ? this.review.takeWhy(note.toolCallId) : undefined;
    const why = note.why ?? fromJudge;

    if (hit && turn) {
      hit.decision = {
        mark: note.mark,
        label: note.label,
        ...(note.by ? { by: note.by } : {}),
        ...(why ? { why } : {}),
      };
      void this.rooms.saveMessage(room, turn);
      this.emit("message", room.id, turn);
      return;
    }

    const msg: Message = {
      id: messageId(),
      role: "system",
      // 붙일 활동이 없을 때뿐이다 — 그때는 까닭도 여기 같이 적는다(§0)
      text: `${note.mark} ${note.title} — ${note.label}`
        + (note.by ? ` · ${note.by}` : "")
        + (why ? ` · ${why}` : ""),
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.rooms.append(room, msg);
    void this.rooms.saveNewMessage(room, msg);
  }

  private onAgentCrash(agentId: string, reason: string): void {
    for (const [roomId, room] of this.rooms.open) {
      if (!room.participants.some((b) => b.agentId === agentId)) continue;

      // **그 에이전트를 쓰는 봇만** 세션을 잃는다. 단체방에서 Codex가 죽어도
      // 같은 방의 Claude는 멀쩡하다.
      const rt = this.runtimes.get(roomId);
      for (const b of room.participants) {
        if (b.agentId !== agentId) continue;
        const bt = rt?.bots.get(b.id);
        if (!bt) continue;
        /*
         * ★ **쓰던 말풍선을 여기서 닫는다** (2026-10-14).
         *
         * 🔴 여태 `streaming: true` 인 채로 **남겨뒀다.** 아무것도 안 쓰고
         * 있는데 칸은 «쓰는 중»이라고 말한다 — 그냥 거짓말이다. 점이 안 멈추던
         * 버그는 상태(`holding`)로 막았지만 그건 **증상 쪽**이고, 그 칸을 읽는
         * 다음 사람은 또 속는다.
         *
         * ⚠️ **에이전트마다 여기 오는 길이 다르다** (2026-10-14 실측):
         *
         * ```
         * Claude   prompt 약속이 **거절된다** → 턴 코드가 끝까지 돌아 닫는다
         * Codex    약속이 **안 깨진다** → 턴이 영영 안 끝나고 칸이 열린 채 남는다
         * ```
         *
         * 그래서 Codex 쪽은 **다음에 방을 열 때**에야 `healAfterCrash` 가
         * 고쳤다(디스크의 `streaming: true` 를 보고). 여기서 닫으면 **둘 다
         * 그 자리에서** 같은 모양이 된다 — 다시 열 때까지 기다릴 이유가 없다.
         *
         * 적는 것도 `healAfterCrash` 와 **똑같이** 한다. 두 길이 다른 모양을
         * 남기면 그걸 읽는 쪽이 또 갈린다.
         */
        /*
         * 🔴 **조건은 «streaming 인가» 가 아니다** (2026-10-14).
         *
         * 저쪽이 죽을 때 **프롬프트 약속이 먼저 깨지는** 에이전트가 있다
         * (Claude·가짜). 그러면 턴 코드가 먼저 돌아 `streaming` 을 이미
         * 내려놓는다 — 여기서 그 칸만 보면 **아무것도 안 하고 지나간다.**
         * 실제로 그렇게 지었다가 검사에 걸렸다.
         *
         * 기준은 **«그 턴이 돌던 중이었나»** 다. 끝난 턴은 상태가 `idle` 이라
         * 안 걸리고, 돌던 중이면 어느 길로 왔든 걸린다.
         */
        /*
         * ★ **떠 있는 승인 카드를 거둔다** (2026-10-14 실측).
         *
         * 🔴 저쪽은 `request_permission` 에 얼어 있다가 죽었다 — **답할 상대가
         * 없어진 카드**가 화면에 남는다. 사용자가 눌러도 받을 데가 없다.
         * 전체 중지가 쓰는 길을 그대로 쓴다.
         *
         * **그 봇 것만** 거둔다 — 단체방에서 Codex 가 죽었다고 Claude 의 카드를
         * 걷으면, 멈추라고 한 적 없는 일이 멈춘다.
         */
        this.opts.host.cancelPermissions?.(roomId, b.id);

        /*
         * ★ **봇에게 맡긴 심사도 거둔다** (2026-10-14).
         *
         * 사용자: *"심사받을 그것도 다 제거해야되는거 아님? 답이 안나오는 것
         * 처럼 그럼거 아님? 턴이 끊겼잖아"*. 맞다 — 그리고 **방향이 둘**이다:
         *
         * ```
         * 이 봇이 **낸** 요청     답해봐야 받을 데가 없다 → 거절로 닫는다
         * 이 봇이 **맡은** 심사   답할 사람이 없다 → **사용자에게 넘긴다**
         * ```
         *
         * 둘째가 더 급하다 — 안 넘기면 **요청한 봇이 영영 기다린다.**
         * `settleQueued(id, undefined)` 가 곧 «맡길 수 없다» 이고, 그러면
         * `askPermission` 이 사용자에게 물어보는 길로 떨어진다.
         */
        for (const item of this.queue.dropPermissions((i) => i.fromId === b.id)) {
          this.queue.close(item.id, "요청한 봇이 끊겨 거두어졌습니다");
          this.review.settleQueued(item.id, { outcome: "cancelled" });
        }
        for (const item of this.queue.dropPermissions((i) => i.to === b.id)) {
          this.queue.close(item.id, "심사 봇이 끊겨 사용자에게 넘어갔습니다");
          // **조용히 넘기지 않는다** — 맡겼다고 생각하고 자리를 비우면 안 된다
          this.emit("notice", roomId,
            `심사를 맡긴 봇이 끊겨 직접 물어봅니다 — «${item.title}»`);
          this.review.settleQueued(item.id, undefined);
        }

        const live = bt.turn;
        if (live && this.runtimes.statusOf(roomId, b.id) !== "idle") {
          live.streaming = false;
          live.truncated = true;
          if (!live.text && !live.error) live.error = "응답이 중단되었습니다.";
          void this.rooms.saveMessage(room, live);
          this.emit("message", roomId, live);
        }
        bt.sessionId = undefined;
        bt.roleInjected = false;
        delete bt.rosterSent;
      }
      const hit = room.participants.filter((b) => b.agentId === agentId);
      // ★ **그 에이전트를 쓰는 봇만** 오류다 — 같은 방의 다른 봇은 멀줦하다
      /*
       * 🔴 **`isBusy`로 거르면 놓친다.** 프로세스가 죽으면 `prompt`가 먼저
       * 거절돼 상태가 이미 `error`일 수 있고, `isBusy("error")`는 false다.
       * 그러면 «프로세스가 종료되었다»를 안 적게 된다 — 실제로 그렇게 깨졌다.
       * 기준은 «바쁜가»가 아니라 **«조용하지 않았나»**다.
       */
      if (hit.some((b) => this.runtimes.statusOf(roomId, b.id) !== "idle")) {
        for (const b of hit) this.runtimes.setStatus(roomId, "error", b.id);
        /*
         * ★ **기록에 안 남긴다** (2026-10-13).
         *
         * 🔴 여기가 `noteRoom` 이었다 — 디스크에 적히는 **진짜 메시지**라
         * 다음에 열어도 그 자리에 있다. 그런데 프로세스가 죽은 것은 **우리
         * 사정**이지 대화가 아니다. 붙는 일을 기록에서 뺀 것과 같은 규칙이다.
         *
         * 그리고 지금은 말할 것이 **하나 더 있다** — 점이 상태를 따라가므로
         * (`error` 면 멈춘다) 말풍선이 거기서 멈춘 것이 **보인다.** 글이
         * 잘린 것도 보이고. 그러니 이 줄은 «왜» 만 한 번 말하면 된다.
         */
        this.emit(
          "notice",
          roomId,
          `${this.agentOrThrow(agentId).label} 프로세스가 종료되어 ` +
            `답변이 끊겼습니다 (${reason}). 다시 보내면 이어서 합니다. ` +
            "자세한 것은 출력 창에 있습니다.",
        );
      }
    }
  }

  /** 봇에게 보이는 도구 셋 — 글은 `core/mcp/calls.ts` 에 있다 (리팩토링 ②) */
  mcpTools(): McpTool[] {
    return this.mcp.tools();
  }

  /**
   * ★ **봇이 도구를 불렀다** (v3.0 2-H).
   *
   * `owner` 는 **헤더 비밀이 가리키는 봇**이다(2-F) — `방id:봇id` 꼴이고,
   * 이것이 «남의 큐를 들여다보는 것»을 막는 뿌리다.
   */
  async mcpCall(owner: string, tool: string, args: unknown): Promise<McpResult> {
    const out = await this.mcp.answer(owner, tool, args);
    /*
     * ★ **진짜 결과를 활동에 붙이려고 받아둔다** (사용자, 2026-10-15):
     * *"툴 output이 안나옴"*.
     *
     * 🔴 **저쪽이 주는 것은 우리 결과가 아니다.** Antigravity 는
     * `tool_call_update` 에 *"Call say on ai-in-one server"* 같은 **자리표시
     * 글**을 실어 보낸다(`probes/mcpagy.cjs` 실측). 그걸 그대로 보여주면
     * «무엇이 나왔나» 에 거짓으로 답하는 셋이다.
     *
     * 우리 도구의 답은 **우리가 들고 있으므로**, 같은 봇·같은 도구의
     * 활동이 끝날 때 그걸 붙인다. 줄로 두는 까닭: 한 턴에 여러 번 부를
     * 수 있고, 갱신은 **부른 순서대로** 온다.
     */
    this.activity.keepOurOut(owner, tool, out.text);
    return out;
  }

  /**
   * **봇끼리 부르는 길을 세운다** — 그리고 어느 칸인지 알린다 (v3.0 2-F).
   *
   * 확장이 켜질 때 한 번, 그 뒤로는 **사람이 [다시 시도] 를 누를 때만** 부른다.
   *
   * 🔴 **자동으로 되풀이하지 않는다.** 그러면 «몇 초마다» 라는 숫자가 하나
   * 생기는데, 그 숫자는 아무도 고를 수 없다 — 짧으면 막힌 기계에서 계속
   * 두드리고, 길면 고친 사람이 기다린다. 누르면 그때 한다.
   */
  async startMcp(): Promise<McpState> {
    const at = (await this.opts.mcp?.start()) ?? { at: "off" as const };
    this.emit("mcp", at);
    return at;
  }

  /** 지금 어느 칸인가 — 화면을 열 때 한 번 실어 보낸다 */
  mcpState(): McpState {
    return this.opts.mcp?.current() ?? { at: "off" };
  }

  /** 그 에이전트가 광고하는 로그인 길들 (ACP) */
  async authOptionsOf(agentId: string): Promise<{ id: string; name: string; description?: string }[]> {
    return this.pool.connection(agentId).authOptions();
  }

  /** ACP 로 로그인한다. 사람이 브라우저에서 마칠 때까지 안 돌아온다 */
  async authenticateAs(
    agentId: string, methodId: string, onNote?: (line: string) => void,
  ): Promise<void> {
    await this.pool.connection(agentId).authenticate(methodId, onNote);
  }

  /** ACP 로 로그아웃. 광고 안 했으면 `false` */
  async logOutOf(agentId: string): Promise<boolean> {
    return this.pool.connection(agentId).logOut();
  }

  /**
   * 출력 창에 한 줄 적는다.
   *
   * 화면 쪽()에는 출력 창으로 가는 길이 없다 — 호스트를 들고 있는
   * 것은 이쪽뿐이라 여기로 지나간다. 받는 자리의 빗장이 이걸 쓴다.
   */
  log(message: string): void {
    this.opts.host.log(message);
  }

  /**
   * 그 에이전트의 CLI 를 내린다 — `AgentPool.drop` (2026-10-02).
   *
   * ⚠️ 내린 뒤 **모든 봇의** 붙임 표시를 지운다 — 그 에이전트 봇만이 아니다
   * (리팩토링 ⑧ 에서 본 그대로 옮겼다). 대화는 안 날아가고 다음 턴에 되붙는다.
   */
  dropConnection(agentId: string): void {
    if (!this.pool.drop(agentId)) return;
    for (const rt of this.runtimes.values()) {
      for (const bt of rt.bots.values()) bt.sessionId = undefined;
    }
  }

  /**
   * 방의 **유일한** 봇 — 봇이 정확히 하나일 때만 (리팩토링 ⑥, 2026-10-20).
   *
   * 🔴 **예전엔 `participants[0]` 이었다.** 주석은 «단체방에서는 부르는 쪽이 봇을
   * 지목해야 한다» 고 말했지만 **코드는 막지 않았다** — 단체방에서 `botId` 를
   * 빠뜨리면 압축·역할·소개·설정이 **첫 번째 봇에 조용히** 걸렸다. 열 군데가
   * `botId ?? soleBot(room)` 꼴이라 한 군데만 빠뜨려도 그랬다.
   *
   * 이제 둘 이상이면 아무도 고르지 않는다. 부르던 자리들은 이미 «봇이 없으면
   * 그냥 돌아간다» 를 갖고 있어서, **엉뚱한 봇에 거는 대신 아무 일도 안 한다**
   * — 그리고 그걸 로그에 남긴다. 화면은 단체방이면 늘 봇을 짚어 부르므로
   * (`sendCompose` · `m.botId`) 이 로그가 찍히면 그건 **부르는 쪽의 버그**다.
   */
  private soleBot(room: Room): BotInstance | undefined {
    if (room.participants.length === 1) return room.participants[0];
    if (hasManyBots(room)) {
      this.opts.host.log(`[${room.id}] 봇을 지목하지 않은 부름 — 단체방이라 아무에게도 안 건다`);
    }
    return undefined;
  }


  private agentOrThrow(agentId: string): AgentDef {
    const agent = this.opts.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`알 수 없는 에이전트: ${agentId}`);
    return agent;
  }

  dispose(): void {
    /*
     * 🔴 **내린 뒤에 예약이 되살아나면 안 된다** (v3.0 1-E).
     *
     * `maybeFireStaged` 는 턴이 끝나는 자리마다 불린다. 그중에는 **우리가
     * 내린 뒤에 도착하는 것**도 있고, 그때 내보내면 `sendCompose` 가
     * **새 CLI 프로세스를 띄운다** — 끄려던 참에 하나 더 뜨는 꼴이고,
     * 그 프로세스가 이벤트 루프를 붙잡아 **프로세스가 안 끝난다.**
     *
     * 검사에서 먼저 드러났다(`pending.mts` 가 «전부 통과»를 찍고도 안 끝났다).
     */
    this.down = true;
    // 들고 있던 자리를 다 놓는다 — 안 놓으면 다음에 열 때 **내 죽은 pid** 가 막는다
    this.opts.locks?.releaseAll();
    // **쓰다 만 글을 들고 죽지 않는다.** 창을 닫는 순간 디바운스가 돌고 있으면
    // 그대로 사라진다 — 최소한 쓰기를 시작은 해둔다.
    void this.flushDraft();
    this.pool.disposeAll();
    // 유예 타이머가 살아 있으면 지운 방에 써대고 깨어난다
    for (const rt of this.runtimes.values()) {
      for (const bt of rt.bots.values()) clearTimeout(bt.tail);
    }
    this.runtimes.clear();
  }
}


