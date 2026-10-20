import { EventEmitter } from "node:events";
import type * as acp from "@agentclientprotocol/sdk";

import {
  AcpConnection,
  type AgentEvent,
  type DecisionNote,
  describe,
  OUR_MCP_NAME,
} from "./acpConnection.js";
import { cachedOptions, dirFor, keepOptions } from "./install/agentInstaller.js";
import type { McpResult, McpServer, McpState, McpTool } from "./mcpServer.js";
import type { RoomLocks } from "./roomLock.js";
import { BotQueue } from "./mcp/botQueue.js";
import { McpCalls, type McpPort } from "./mcp/calls.js";
import { Review, type ReviewPort } from "./review/review.js";
import { Rooms, rollUpLost, whose, type RoomsPort } from "./room/rooms.js";
import { Runtimes, type BotRuntime, type ClashState, type RuntimesPort } from "./room/runtimes.js";
import { messageId } from "./ids.js";
import {
  parseCompose,
  type ComposeParse,
  type ComposeToken,
} from "./mentions.js";
import type { RoomStore } from "./store.js";
import {
  createBotInstance,
  sendsContent,
  type AgentDef,
  type AnswerPolicy,
  type ReviewWait,
  type WaitItem,
  type Approver,
  type JoinFail,
  type JoinStep,
  ASK_USER,
  type BotInstance,
  type ForkFallback,
  type Attachment,
  type FileChange,
  type Message,
  type Room,
  type RoomMeta,
  type PermissionDecision,
  type PermissionRequest,
  isBusy,
  type RoomStatus,
  type RoomUsage,
  type ToolActivity,
  type Clash,
  uniqueBotName,
  inBotView,
  cleanBotName,
  taskIdOf,
  type SearchHit,
  type Staged,
  type RelayMode,
  DEFAULT_RELAY,
  DEFAULT_DEPTH_CAP,
  rosterText,
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

/**
 * 갈라낸 세션 하나 (v1.1).
 *
 * **`native`가 핵심이다.** 에이전트가 복제해준 것이면 계획·메모리까지 따라오고,
 * 폴백이면 글만 따라온다 — 사용자에게 다르게 말해야 하는 차이라 숨기지 않는다.
 */
export interface ForkedSession {
  sessionId: string;
  /** 에이전트의 `session/fork`로 갈랐나. 아니면 새 세션이다 */
  native: boolean;
  options: acp.SessionConfigOption[];
  /** 폴백으로 간 이유. 네이티브면 없다 */
  reason?: string;
}

/** 스트리밍 델타마다 전체 방을 내보내면 웹뷰가 감당하지 못한다 */
const EMIT_INTERVAL_MS = 60;

/**
 * 스트리밍 중 응답을 디스크에 남기는 간격.
 *
 * 트랜스크립트가 JSONL이라 **한 줄 덧붙이기**로 끝나므로 대화가 길어져도 비용이
 * 같다. 그래서 받다 만 응답도 남길 수 있다 — 단일 JSON이었다면 매번 전체를
 * 다시 써야 해서 엄두를 못 냈다.
 */
const SAVE_INTERVAL_MS = 2000;

/**
 * 설정 조회에 기다려 주는 시간.
 *
 * **기다리기만 하는 건 실패보다 나쁘다.** CLI가 설치가 안 됐거나 로그인이
 * 안 됐으면 `session/new`가 응답 없이 멈춰 있을 수 있는데, 그러면 권한 시트가
 * *"불러오는 중…"* 에서 영원히 멈춘다 — 사용자는 기능이 없는 줄 안다.
 * 처음 받는 npm 패키지를 감안해 넉넉히 주되, **끝은 있다.**
 */
const CONFIG_PROBE_MS = 90_000;

/** 세션을 새로 열고 한 턴을 묻는 길이라 설정 조회보다 넉넉히 둔다 */
const USAGE_PROBE_MS = 120_000;

/**
 * ★ **붙는 데 걸 한도 — 둘로 가른다** (2026-10-13).
 *
 * 🔴 **여태 하나도 없었다.** `ensureStarted` 도 `newSession` 도 끝을 안 둬서,
 * 저쪽이 답을 안 하면 **영영 기다린다** — 붙는 화면에 「여는 중…」이 선 채로
 * 멈추고, 실패 신호가 안 오니 [다시 시도] 도 안 생긴다. 오늘 다섯 자리에서
 * 고친 것과 같은 종류다: *끝이 안 난다.*
 *
 * 둘을 따로 재는 까닭은 **단위가 다르기 때문**이다 — CLI 는 **에이전트마다
 * 하나**고 같은 에이전트의 봇들이 그 하나를 같이 쓴다. 세션은 봇마다다.
 *
 * ```
 * 실측            띄우기            세션
 * Claude            375ms           962ms
 * Codex             585ms         1,662ms
 * Antigravity    12,505ms         5,056ms   ← 398MB 네이티브 서버
 * ```
 *
 * 제일 느린 것에 서너 배 여유를 뒀다. 넘겼다는 것은 그 자체로 «뭔가
 * 잘못됐다» 는 신호고, 그때는 **다시 해볼 길**을 주는 것이 할 일이다.
 */
const START_MS = 60_000;
const SESSION_MS = 30_000;

/**
 * 턴 밖 발화를 **한 덩어리로 볼** 시간.
 *
 * 이보다 조용했다가 다시 오면 다른 말로 본다 — 한참 전 말풍선에 이어 붙이면
 * 시각이 거짓말을 한다.
 */
const IDLE_BURST_MS = 30_000;

/**
 * 응답이 온 뒤에도 **이만큼은 그 턴의 말로 친다.**
 *
 * 손으로 재보니 늦게 오는 조각은 수십 ms 안에 들어왔다. 여기서 더 늘리면
 * 진짜 턴 밖 발화(A11)까지 삼키게 된다 — 그건 숨기면 안 되는 것이다.
 */
const TURN_TAIL_MS = 1500;

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
 * 칸 하나의 **보이는 이름** (`opus` → `Opus 5`). 없으면 id 를 그대로 돌려준다.
 *
 * 사용자가 고른 것은 이름 쪽이다 — 시스템 줄에 `sonnet` 이라고 적으면
 * «내가 고른 그것» 과 같은 것인지 한 번 더 생각해야 한다.
 */
function nameOf(
  options: acp.SessionConfigOption[],
  id: string,
  value: unknown,
): string | undefined {
  const opt = options.find((o) => o.id === id);
  if (!opt || opt.type !== "select") return undefined;
  for (const entry of opt.options) {
    const found =
      "group" in entry
        ? entry.options.find((v) => v.value === value)
        : entry.value === value
          ? entry
          : undefined;
    if (found) return found.name;
  }
  return undefined;
}

/** 칸 범주를 사람 말로. 에이전트가 주는 이름은 영어다 (`Model`) */
const CONFIG_WORD: Record<string, string> = {
  model: "모델",
  mode: "권한 모드",
  thought_level: "사고 강도",
};

/**
 * 세션이 쓰는 모델 이름을 봇에 적어 둔다 (B5).
 *
 * **id가 아니라 보이는 이름이다.** 목록에 `Claude · Opus 5`로 나가는데
 * 거기에 `opus-5`가 뜨면 방 만들기 화면에서 고른 것과 달라 보인다.
 * 선택지는 평평하게도, 그룹으로 묶여서도 오므로 둘 다 훑는다.
 *
 * ★ **판이 올라간 것도 여기서 잡힌다** (2026-09-29).
 *
 * 실측해보니(`tests/probes/modelids.cjs`) 어댑터가 주는 모델 id 는 **전부
 * 별명**이다 — `default`, `opus[1m]`, `sonnet`, `haiku`. 날짜 박힌 id 가
 * 하나도 없다. 그래서 `sonnet` 뒤의 판이 갈려도 **id 는 그대로**고, 사라진
 * 값을 지켜보는 `restoreChoices` 의 감시망에는 **처음부터 안 걸린다.**
 *
 *   바뀌는 것은 **이름**이다 — `Sonnet 5` → `Sonnet 6`.
 *
 * 그 신호가 바로 이 함수의 «달라졌다» 였는데, 화면 새로고침에만 쓰고
 * **말은 안 했다.** 이제 «같은 id 인데 이름이 달라진 것»을 따로 알린다.
 */
function noteModel(
  bot: BotInstance,
  options: acp.SessionConfigOption[],
): { changed: boolean; renamed?: string } {
  const opt = options.find((o) => o.category === "model");
  if (!opt || opt.type !== "select") return { changed: false };

  const current = opt.currentValue;
  for (const entry of opt.options) {
    const found =
      "group" in entry
        ? entry.options.find((v) => v.value === current)
        : entry.value === current
          ? entry
          : undefined;
    if (!found) continue;

    /*
     * **id 는 그대로인데 이름이 달라졌다** — 별명 뒤의 판이 바뀐 것이다.
     *
     * 사용자가 직접 고르면 id 가 바뀌므로 여기 안 걸린다 — 그쪽은 `setConfig`
     * 가 이미 알린다. 처음 붙는 봇도 옛 이름이 없어 안 걸린다.
     */
    const was =
      bot.model === current && bot.modelLabel !== undefined && bot.modelLabel !== found.name
        ? bot.modelLabel
        : undefined;

    // **id도 같이 적는다** — 이름만으로는 나중에 다시 적용할 수 없다
    bot.model = found.value;
    if (bot.modelLabel === found.name) return { changed: false };
    bot.modelLabel = found.name;
    return { changed: true, ...(was !== undefined ? { renamed: was } : {}) };
  }
  return { changed: false };
}

/**
 * 최근 이만큼의 메시지는 **손대지 않는다.**
 *
 * 되돌아보면 «방금 뭘 하던 중이었나»가 제일 중요하고, 거기서 한 글자만 틀려도
 * 이어서 하기가 어긋난다. 줄이는 건 그 바깥에서만 한다.
 */
const REFEED_KEEP_RECENT = 12;

/** 오래된 메시지 하나에 허용하는 길이. 넘으면 **가운데를** 접는다 */
const REFEED_MAX_CHARS = 1200;

/**
 * 긴 글의 가운데를 접는다 — 앞뒤는 남긴다.
 *
 * 맥락은 **시작과 끝에 몰려 있다.** 무엇을 하려는지는 앞에, 결론은 뒤에 있고,
 * 가운데는 대개 그 사이를 채우는 본문이다. 뒤에서 자르면 결론이 날아간다.
 *
 * **접었다는 걸 글 안에 적는다.** 에이전트도 «여기 뭔가 더 있었다»를 알아야
 * 넘겨짚지 않고 되물을 수 있다.
 */
function foldMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n…[중략 ${cut.toLocaleString()}자]…\n${text.slice(-tail)}`;
}

/**
 * 되먹일 대화를 글로 만든다 (F7).
 *
 * **«적게, 최대한 보존»** — 싼 것부터 쓰고 손해 보는 건 마지막에, 그것도 눈에
 * 보이게 한다.
 *
 * ```
 * 1  시스템 메시지          뺀다   우리 안내다. 에이전트에겐 잡음
 * 2  전달 안 된 메시지      뺀다   **애초에 상대가 못 봤다** — 넣으면 없던 일이 생긴다
 * 3  압축된 구간            요약   에이전트가 준 것. 그가 기억하던 것도 그 요약이었다
 * 4  최근 12개              원문   방금 뭘 하던 중이었나가 제일 중요하다
 * 5  그 앞의 긴 메시지      가운데를 접는다   `…[중략 N자]…` 로 **표시하면서**
 * ```
 *
 * 1~3은 **손해가 없다.** 4~5만 맞바꾸기이고, 5는 접었다는 사실이 글 안에 남아
 * 에이전트가 되물을 수 있다 — 조용히 사라지는 것과는 다르다.
 *
 * ★ **다만 이미 압축된 구간은 요약으로 대신한다.**
 *
 * 그 요약은 우리가 지어낸 게 아니라 **에이전트가 압축하면서 준 것**이다
 * (`CompactionUpdate.summary`). 우리는 모델이 없어 요약을 만들 수 없고, 시키려면
 * 에이전트 턴을 써야 하는데 **세션이 죽은 뒤에는 시킬 상대가 없다.** 살아 있을 때
 * 받아 둔 것을 쓰는 게 유일한 길이다.
 *
 * 그리고 이건 손해가 아니다 — **에이전트가 기억하던 것도 그 요약이었다.**
 * 압축 이전 원문을 다시 넣으면 오히려 압축 전보다 더 많은 걸 보내게 된다.
 */
function transcriptText(
  room: Room,
  /**
   * ★ **누구에게 되먹이나** (2026-10-09).
   *
   * 🔴 여태 이 칸이 없었다 — `room.messages` 를 **통째로** 훑어서 `system`·
   * 지금 보낼 batch·`sendFailed` 만 거르고 나머지를 다 실었다. 단체방에서
   * 알파를 되먹이면 **베타에게만 갔던 대화가 이름까지 붙어** 들어갔다.
   *
   * §4.1.1 — «봇은 자기가 받은 것만 안다» — 를 **v2.0 부터 깨고 있었다.**
   * 되먹임은 세션이 끊겼을 때만 도는 길이라 눈에 잘 안 띄었을 뿐이다.
   */
  bot: BotInstance,
  batch: Message[],
  kind?: "log" | "summary",
): string {
  const skip = new Set(batch.map((m) => m.id));
  const nameOf = (id: string | undefined) =>
    room.participants.find((b) => b.id === id)?.name ?? "에이전트";

  /**
   * 한 줄 앞에 붙는 이름.
   *
   * ★ **받는 이는 «되먹는 봇이 당사자인 쪽»만 적는다.**
   *
   * ```
   * 사용자 → 알파 (+베타)   «사용자:»          다른 수신자는 안 적는다
   * 알파 → 베타             «알파 → 베타:»      알파가 되먹을 때 — 제가 한 말이다
   * 알파 → 베타             «알파 → 베타:»      베타가 되먹을 때 — 제가 받은 말이다
   * ```
   *
   * 🔴 수신자를 다 적으면 **«베타도 이걸 받았다»를 알파에게 알려주는 꼴**이
   * 된다 — 칩을 `Message.text` 에 안 넣은 것과 **같은 자리**다. 되먹임이라고
   * 예외일 수 없다.
   */
  const name = (m: Message): string => {
    if (m.role === "user") return "사용자";
    const who = nameOf(m.authorBotId);
    // 받는 이가 안 적힌 옛 메시지가 있다 (`inBotView` 주석) — 그때는 안 적는다
    const went = (m.deliveredTo as string[] | undefined) ?? [];
    // 봇에게 간 데가 없으면 사용자에게 한 말이다 — 적을 받는 이가 없다
    if (went.every((id) => id === m.authorBotId)) return who;
    const to = m.authorBotId === bot.id
      // 내가 보낸 말 — 누구에게 보냈는지는 **내가 이미 안다**
      ? went.filter((id) => id !== bot.id)
      // 내가 받은 말 — 받는 이는 나다. 같이 받은 남은 안 적는다
      : [bot.id];
    return to.length > 0 ? `${who} → ${to.map(nameOf).join(", ")}` : who;
  };

  /*
   * 마지막 압축 지점 뒤부터가 원문 구간이고, 그 앞은 요약이 대신한다.
   *
   * 🔴 **마지막 요약 하나만 쓰면 안 된다.** 압축이 여러 번 일어났을 때 나중
   * 요약이 앞의 요약까지 품는지는 **스펙이 정하지 않는다** — 각자 자기 구간만
   * 요약했을 수도 있다. 하나만 쓰면 그 경우 앞 구간이 **말없이 사라진다.**
   *
   * 그래서 **전부 순서대로** 넣는다. 나중 요약이 앞을 품는 에이전트라면 조금
   * 겹치는 것뿐이지만, 아니라면 이게 유일하게 안 잃는 방법이다.
   * 겹침은 토큰 몇, 누락은 맥락이다.
   *
   * 🔴 **요약도 봇마다 다르다** (2026-10-09). 압축은 **세션 단위**라 자국에
   * `aboutBotIds` 가 붙는다(B1) — 알파가 압축했다고 베타의 기억이 준 게 아니다.
   *
   * 여기가 그걸 안 보고 **방의 모든 요약을 긁어모았다.** 그러면 알파에게
   * 되먹이는 글머리에 **베타가 압축하며 남긴 요약**이 «이전 요약» 으로
   * 붙는다 — 알파가 한 적 없는 대화다. 아래 `kept` 와 **같은 병**이다.
   */
  let at = -1;
  const summaries: string[] = [];
  room.messages.forEach((m, k) => {
    if (m.mark === "compaction" && m.summary && inBotView(m, bot.id)) {
      summaries.push(m.summary.trim());
      at = k;
    }
  });

  const head = summaries.length > 0 ? `[이전 요약] ${summaries.join("\n\n")}` : "";

  const rest = at >= 0 ? room.messages.slice(at + 1) : room.messages;

  const kept = rest.filter(
    (m) =>
      m.role !== "system" &&
      !skip.has(m.id) &&
      // 🔴 **그 봇이 실제로 본 것만** (§4.1.1). 이 줄이 없어서 단체방 되먹임이
      // 남의 대화를 통째로 실어 날랐다 — v2.0 부터 열려 있던 길이다.
      inBotView(m, bot.id) &&
      // 🔴 **전달 안 된 메시지는 넣지 않는다.** 보내다 실패한 것이라 **이전 세션도
      // 본 적이 없다.** 넣으면 «했던 얘기»가 하나 생겨서, 에이전트가 답한 적
      // 없는 것에 답한 척하게 된다. 빼는 게 작기도 하고 **맞기도 하다.**
      !m.sendFailed,
  );

  /*
   * ★ **«요약 넘기기» 는 요약만이 아니다** (2026-10-02).
   *
   * ⏪ 처음엔 정말 **요약만** 돌려보냈다. 사용자가 바로 짚었다 —
   * *"최근 채팅내역도 넘기는거 아니였음?"*. 맞다. 요약만 보내면
   * **방금 하던 이야기가 통째로 사라진다** — 이어서 할 지점이 바로
   * 거기인데.
   *
   * 그래서 둘의 차이는 «요약이냐 원문이냐» 가 아니라 **옮은 것을
   * 얼마나 실는가** 다:
   *
   * ```
   * log       요약 + 전부 (예전 것은 줄여서)
   * summary   요약 + **최근 것만**
   * ```
   *
   * 그래서 압축한 적 없는 방에서도 쓸모가 있다 — 그때는 그냥
   * «짧게 넘기기» 가 된다. 예전에는 요약이 없으면 이 갈래를 아예
   * 안 띄웠는데, 그건 «요약만» 이었기 때문이고 이젠 아니다.
   */
  const shown = kind === "summary" ? kept.slice(-REFEED_KEEP_RECENT) : kept;

  // 최근 것은 손대지 않는다 — 이어서 할 지점이 거기다
  const foldFrom = Math.max(0, shown.length - REFEED_KEEP_RECENT);

  const body = shown
    .map((m, k) => {
      // 🔴 **첨부는 다시 안 보낸다.** 이미지를 통째로 재전송하면 비용이 글자와
      // 비교가 안 되고, 워크스페이스 파일은 에이전트가 직접 읽으면 된다(I4).
      // 그렇다고 말없이 빼면 *"이 스크린샷 봐줘"* 만 남아 **있지도 않은 것을
      // 가리키게 된다** — 자리는 남긴다.
      const marks = (m.attachments ?? []).map((a) => `[첨부: ${a.name}]`).join(" ");
      const text = k < foldFrom ? foldMiddle(m.text.trim(), REFEED_MAX_CHARS) : m.text.trim();
      const line = [text, marks].filter(Boolean).join(" ");
      return line ? `${name(m)}: ${line}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  return [head, body].filter(Boolean).join("\n\n");
}

/**
 * **다시 눌러볼 만한 실패인가** (v1.1).
 *
 * `↻ 다시 보내기`를 붙일지 정한다. 나눠야 하는 이유는 **버튼이 약속이기 때문**이다 —
 * 눌러도 같은 벽이면 사용자는 토큰만 쓰면서 «왜 안 되지»를 반복한다.
 *
 * ```
 * 다시 해볼 만하다   한도 · 과부하 · 프로세스 죽음 · 타임아웃 · 연결 끊김
 * 눌러도 그대로     로그인 필요 · 세션 없음 · 내용 거부 · 잘못된 요청
 * ```
 *
 * 🔴 **모르는 것은 «안 된다» 쪽에 둔다.** 반대로 두면 우리가 모르는 새 오류마다
 * 버튼이 뜨고, **되는 척하는 버튼**이 된다. 없는 버튼이 낫다.
 */
function retryable(reason: string): boolean {
  const s = reason.toLowerCase();
  // 사람 손이 필요한 것들 — 여기 걸리면 아무리 눌러도 같다
  if (/auth|login|\ub85c\uadf8\uc778|not found|\ucc3e\uc744 \uc218 \uc5c6|invalid|refus|\uac70\ubd80/.test(s)) return false;
  return /closed|crash|\uc885\ub8cc|overload|rate.?limit|usage limit|quota|\ud55c\ub3c4|too many|timeout|\uc2dc\uac04 \ucd08\uacfc|econnreset|epipe|socket|temporar|unavailable|5\d\d/.test(s);
}

/** 설정 캐시의 열쇠. **방 하나 안에서도 봇마다 다르다** (B1) */
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
 * ★ **우리 도구의 한글 이름** — 활동 알약에 설 글자 (사용자, 2026-10-15).
 *
 * 알약은 말풍선보다 옵으로 더 나가면 안 되므로 **짧아야** 한다(§5 활동 알약).
 * 모르는 이름이 오면 그대로 둔다 — 지어내지 않는다.
 */
const OUR_TOOL_LABEL: Record<string, string> = {
  say: "말 전함",
  check_queue: "큐 확인",
  verdict: "심사",
};

function configKeyOf(roomId: string, botId: string): string {
  return `${roomId}:${botId}`;
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
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
  private readonly connections = new Map<string, AcpConnection>();
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
   * 에이전트별 설정 선택지 (B15).
   *
   * **방 만들기 화면 몫이다** — 거기엔 아직 방도 세션도 없다. 방이 생긴 뒤의
   * «지금 값»은 `roomConfigs`를 봐야 한다.
   */
  private readonly configCache = new Map<string, acp.SessionConfigOption[]>();
  /** 방별 — 그 방 세션이 실제로 들고 있는 값 */
  private readonly roomConfigs = new Map<string, acp.SessionConfigOption[]>();
  /**
   * 그 방 **그 봇의** 설정. 모드·모델은 세션 것이고 세션은 봇 것이다(B1).
   *
   * 🔴 방까지만 내렸다가 또 샐 뻔했다 — 단체방에 에이전트가 다른 봇 둘이
   * 들어오면 방 열쇠 하나로는 둘을 못 가른다.
   */
  /** 세션을 붙이는 중인 방들. 방을 빠르게 오가도 CLI를 두 번 부르지 않는다 */
  private readonly sessionFlight = new Map<string, Promise<void>>();
  /**
   * 이미 자국을 남긴 압축들 (C11).
   *
   * `compaction_update`는 **같은 id로 여러 번 온다**(진행 → 완료). 그대로
   * 두면 구분선이 겹쳐 쌓인다.
   */
  private readonly compacted = new Set<string>();
  /** 아직 받는 중인 요약 조각들. 열쇠는 둘 다 `방id:압축id`다 */
  private readonly compacting = new Map<string, string>();
  /** 조회 중인 것들 — 같은 에이전트를 두 번 띄우지 않기 위해 */
  private readonly configFlight = new Map<string, Promise<acp.SessionConfigOption[]>>();
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
  /** 우리 도구가 돌려준 진짜 답 — `방:봇:도구` 마다 줄로 (활동에 붙인다)
   *
   * 저쪽이 실어 보내는 것은 자리표시 글일 수 있다(Antigravity 실측). */
  private readonly ourOut = new Map<string, string[]>();

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
      emitClashes: (roomId) => { this.emit("clashes", roomId, this.clashesIn(roomId)); },
    };
  }

  private reviewPort(): ReviewPort {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 안에서 쓴다
    const self = this;
    return {
      get queue() { return self.queue; },
      get host() { return self.opts.host; },
      mcpReady: () => this.opts.mcp?.current().at === "ready",
      mcpHttp: (agentId) => this.connection(agentId).mcpHttp,
      roomById: (roomId) => this.rooms.open.get(roomId),
      openRooms: () => this.rooms.open.values(),
      botRuntime: (roomId, botId) => this.runtimes.bot(roomId, botId),
      botForSession: (sessionId) => this.runtimes.botForSession(sessionId),
      statusOf: (roomId, botId) => this.runtimes.statusOf(roomId, botId),
      setStatus: (roomId, status, botId) => this.runtimes.setStatus(roomId, status, botId),
      noteRoom: (room, text, kind, about) => this.rooms.noteRoom(room, text, kind, about),
      maybeWake: (room, botId) => this.maybeWake(room, botId),
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
      maybeWake: (room, botId) => this.maybeWake(room, botId),
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
    for (const [id, conn] of this.connections) {
      const next = list.find((a) => a.id === id);
      if (next) conn.retarget(next);
    }
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
          await this.openSession(room, bot, specs[at]?.configValues);
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

  /**
   * 세션을 열고 방 만들기에서 고른 설정을 적용한다.
   *
   * **첫 프롬프트 전이라 모델 변경 비용이 0이다** — 그래서 사용자 입장에서는
   * "만들 때 고른 것"과 같다 (B15).
   */
  /**
   * ★ **CLI 가 떠 있나 — 띄워야 하면 띄운다** (2026-10-13).
   *
   * `newSession` 안에서 같이 일어나던 것을 **앞으로 뺀다.** 둘을 가르는
   * 까닭은 둘이고, 둘 다 사용자가 보는 것에 관한 것이다:
   *
   * ```
   * 단위가 다르다   CLI 는 **에이전트마다** 하나 — 같은 에이전트의 봇들이 공유한다
   * 걸리는 데가 다르다  Antigravity 는 띄우는 데 12.5초, 세션은 5초다
   * ```
   *
   * 합쳐두면 화면이 「여는 중…」 한 줄밖에 못 말한다. 갈라두면 **어디서
   * 걸렸는지** 보이고, 다시 해볼 때도 **필요한 쪽만** 다시 한다.
   *
   * ⚠️ **겹쳐 불러도 공짜다.** `ensureStarted` 가 이미 «떠 있으면 바로
   * 돌아오고, 뜨는 중이면 그 약속을 같이 기다린다» 로 되어 있다 — 봇 셋이
   * 다 Antigravity 라도 **CLI 는 하나만 뜬다.**
   */
  private async startAgent(room: Room, bot: BotInstance): Promise<void> {
    const label = this.agentOrThrow(bot.agentId).label;
    await withTimeout(
      this.connection(bot.agentId).ensureStarted(() =>
        // `npx`로 CLI를 처음 받으면 수십 초가 걸린다. 멈춘 줄 알지 않게 알린다.
        this.emit("notice", room.id, `${label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`),
      ),
      START_MS,
      `${label}이(가) ${Math.round(START_MS / 1000)}초 안에 뜨지 않았습니다.`,
    );
  }

  private async openSession(
    room: Room,
    bot: BotInstance,
    configValues?: Record<string, string | boolean>,
  ): Promise<void> {
    const conn = this.connection(bot.agentId);
    const bt = this.runtimes.bot(room.id, bot.id);

    this.runtimes.setStatus(room.id, "connecting", bot.id);
    const { sessionId, configOptions } = await conn.newSession(room.cwd, this.mcpFor(room, bot), () =>
      this.emit(
        "notice",
        room.id,
        `${this.agentOrThrow(bot.agentId).label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`,
      ),
    );

    bt.sessionId = sessionId;
    /*
     * ★ **열쇠를 이 세션에 맨다** (2026-10-15). 내줄 때는 세션 id 가 없었다 —
     * `session/new` 의 **인자로** 나가므로 답이 와야 알았다. 매어두면 그
     * 세션이 바뀔 때 **그 열쇠만** 거둘 수 있다.
     */
    this.opts.mcp?.tie(`${room.id}:${bot.id}`, sessionId);
    this.pointAt(bot, sessionId);
    bt.roleInjected = false;
    delete bt.rosterSent;
    // 세션을 연 **직후부터** 듣는다 — 명령 목록이 여기서 온다 (A11)
    this.watchIdle(room, bot, sessionId);
    // 세션이 들고 있는 값이 답이다 — 사용자가 안 골랐으면 에이전트 기본값이 온다
    if (configOptions.length > 0) this.noteRoomConfig(room, bot, configOptions);

    for (const [configId, value] of Object.entries(configValues ?? {})) {
      try {
        const updated = await conn.setConfigOption(sessionId, configId, value);
        this.noteRoomConfig(room, bot, updated);
        if (typeof value === "string") this.rememberModel(bot.agentId, configId, value);
      } catch (err) {
        this.opts.host.log(`[${bot.agentId}] 설정 적용 실패 (${configId}): ${describe(err)}`);
      }
    }

    await this.rooms.saveProps(room, { participants: room.participants });
    this.runtimes.setStatus(room.id, "idle", bot.id);
  }

  /** 다음 방의 기본값이 되도록 에이전트별 마지막 선택을 남긴다 (F6) */
  private rememberModel(agentId: string, configId: string, value: string): void {
    const options = this.configCache.get(agentId) ?? [];
    const opt = options.find((o) => o.id === configId);
    if (opt?.category !== "model") return;
    const prev = this.opts.store.getAppState().lastModelByAgent ?? {};
    void this.opts.store.patchAppState({
      lastModelByAgent: { ...prev, [agentId]: value },
    });
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
      await this.openSession(room, bot, spec.configValues);
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
      const conn = this.connections.get(bot.agentId);
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
    if (old) await this.connections.get(bot.agentId)?.cancel(old).catch(() => undefined);
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

  /**
   * 대화를 그 지점에서 갈라 **새 방**을 만든다 (v1.1).
   *
   * 원본은 손대지 않는다. *"이 방향으로 가보고 아니면 되돌아오기"* 가 목적이므로
   * 갈라진 뒤의 두 방은 서로를 모른 채 각자 살아간다.
   *
   * ⚠️ **파일은 갈라지지 않는다** (D1). 두 방이 같은 워크스페이스를 보므로 분기
   * 방에서 고친 코드는 원본 쪽에도 그대로 반영된다. 격리하지 않고 **알린다** —
   * 코드까지 가르려면 git worktree가 필요하고 그건 백로그다.
   *
   * @param atMessageId 여기까지 물려받는다. 없으면 **지금까지 전부**.
   */
  async forkRoom(
    roomId: string,
    opts: {
      atMessageId?: string;
      title?: string;
      fallback?: ForkFallback;
      /**
       * ★ **이 봇만 가른다** (v2.1 · §5).
       *
       * 🔴 로드맵은 «1:1 뷰에서는 분기 비활성»이라고 적어뒀다 — *"단체방 전체가
       * fork되나, 그 봇만 분리되나"* 하는 모호함 때문이었다. 그런데 모호함을
       * 없애는 길은 **막는 것만이 아니라 뜻을 정해주는 것**도 있다:
       *
       * ```
       * 단체방에서 분기   방 전체가 갈라진다  (여태 하던 것)
       * 뷰에서 분기       그 봇만 갈라진다    (여기)
       * ```
       *
       * ★ **뷰가 곧 «그 봇이 아는 전부»**라(§5) 그걸 그대로 가르면 **정확히 그
       * 맥락의 1:1 방**이 나온다 — 물려받는 대화도 그 봇이 본 것만이다.
       * 남의 줄기를 끌고 가면 새 방의 첫 화면이 **그 봇은 본 적 없는 말**로
       * 채워진다.
       */
      botId?: string;
    } = {},
  ): Promise<Room> {
    const parent = await this.rooms.openRoom(roomId);

    const only = opts.botId
      ? parent.participants.find((b) => b.id === opts.botId)
      : undefined;
    if (opts.botId && !only) throw new Error("분기할 봇을 찾을 수 없습니다.");

    /*
     * **진행 중인 턴이 있으면 안 된다** (D4). 반쯤 온 응답을 물려받으면 분기가
     * 원본과 다른 지점에서 시작하고, 원본 쪽 턴이 끝나며 덧쓰는 것도 놓친다.
     *
     * ★ 봇 하나만 가를 때는 **그 봇만 본다** — 옆 봇이 도는 것은 이 분기와
     * 상관이 없고(그 말은 이 봇 뷰에 안 들어온다), 막으면 «남이 일하는 동안
     * 내 갈래를 못 딴다»가 된다.
     */
    if (isBusy(only ? this.runtimes.statusOf(roomId, only.id) : this.runtimes.statusOf(roomId))) {
      throw new Error("진행 중인 턴이 끝난 뒤에 분기할 수 있습니다.");
    }

    if (parent.participants.length === 0) throw new Error("분기할 봇이 없습니다.");

    // 🔴 **이걸 먼저 본다.** 빈 방은 `cut`이 -1이라 지점 검사에 먼저 걸리는데,
    // 그러면 *"분기할 지점을 찾을 수 없습니다"* 라고 말하게 된다 — 지점을 고른 적도
    // 없는 사람에겐 뜻 모를 소리다. 없는 건 지점이 아니라 **대화**다.
    // 봇 하나를 가를 때는 **그 봇이 본 것**으로 따진다 — 방에 대화가 있어도
    // 그 봇과는 한 마디도 안 나눴을 수 있다
    const mine = (m: Message) => (only ? inBotView(m, only.id) : true);
    if (!parent.messages.some((m) => m.role !== "system" && mine(m))) {
      throw new Error(
        only ? `${only.name}와(과) 나눈 대화가 아직 없습니다.` : "아직 나눌 대화가 없습니다.",
      );
    }

    const cut =
      opts.atMessageId === undefined
        ? parent.messages.length - 1
        : parent.messages.findIndex((m) => m.id === opts.atMessageId);
    if (cut < 0) throw new Error("분기할 지점을 찾을 수 없습니다.");

    const inherited = parent.messages.slice(0, cut + 1).filter(mine);
    // 시스템 메시지는 우리 안내다 — 그것만 물려받는 건 분기가 아니라 새 방이다
    if (!inherited.some((m) => m.role !== "system")) {
      throw new Error(
        only ? `${only.name}와(과) 나눈 대화가 아직 없습니다.` : "아직 나눌 대화가 없습니다.",
      );
    }

    /*
     * ★ **참여 봇 전부를 가른다** (v2.0).
     *
     * 분기는 «이 대화를 여기서 두 갈래로»라는 뜻이다. 한 봇만 갈라내면
     * 새 방은 나머지 봇을 잃은 채로 시작하고, 그것은 분기가 아니라 이사다.
     *
     * **병렬로** 가른다 — 세션끼리 무관하고, 봇이 셋이면 순차는 세 배 기다린다.
     * 한 봇이 폴백으로 떨어져도 나머지는 네이티브로 간다(§4.4 «성공분만»).
     */
    const atTail = cut === parent.messages.length - 1;
    const split = only ? [only] : parent.participants;
    const forks = await Promise.all(
      split.map(async (b) => ({
        bot: b,
        forked: await this.forkSession(parent, b, atTail),
      })),
    );
    /*
     * 폴백일 때만 선택이 의미가 있다. 화면이 미리 물어봤으면 그걸 쓰고,
     * **예상 못 한 실패**라 못 물어봤으면 `refeed`로 둔다 — 그쪽이 분기의
     * 목적에 가깝고, 실제 토큰은 **다음 메시지를 보낼 때까지** 안 든다.
     * 방의 배너에서 그 전에 따로 끌 수 있다.
     */
    return this.createRoomFromFork(
      parent, forks, cut,
      opts.title ?? (only ? `${parent.title} — ${only.name}` : undefined),
      opts.fallback ?? "refeed",
      only?.id,
    );
  }

  /**
   * **세션만** 가른다. 방은 만들지 않는다.
   *
   * ★ 방 생성과 나눠둔 이유는 실험실의 LAB-1(KV 캐시 리프레시)이다 — 거기서는
   * 세션만 갈라 한 번 쓰고 버리므로 방이 없어야 한다. 여기서 안 나누면 나중에
   * 다시 뜯어야 한다.
   *
   * ★ **끝에서 가르는 것과 과거 지점에서 가르는 것은 길이 다르다.**
   *
   * ACP `session/fork`에는 «어느 메시지 지점에서»가 **없다** — 세션을 **지금
   * 상태 그대로** 복제할 뿐이다. 그래서 과거 지점 분기는 네이티브로 갈 수 없고,
   * 새 세션을 열어 **물려받은 데까지만** 글로 다시 읽히는 폴백을 쓴다.
   *
   * 폴백이 손해인 건 분명하다(계획·메모리·도구 이력이 안 따라온다). 그래도
   * **되는 척하는 것보다 낫다** — 네이티브로 과거 지점을 가르면 잘라낸 뒤의
   * 대화까지 에이전트가 기억한 채로 시작한다. 화면에는 없는데 상대는 아는,
   * D2가 경계한 바로 그 상태다.
   */
  async forkSession(room: Room, bot: BotInstance, atTail: boolean): Promise<ForkedSession> {
    const conn = this.connection(bot.agentId);

    // 가르려면 **붙어 있어야** 한다. 창을 껐다 켠 직후일 수 있다.
    const live = atTail ? await this.ensureSession(room, bot).catch(() => undefined) : undefined;

    if (live && atTail) {
      /*
       * 🔴 **지금 붙어 있는 세션이 «대화를 나눈 그 세션»인가.**
       *
       * 두 가지가 어긋날 수 있다:
       *
       *   1. 말을 안 건 세션 — 에이전트는 성공한 첫 프롬프트를 받아야 세션을
       *      디스크에 남긴다(§13.1). 갈라도 물려받을 게 없다.
       *   2. **복구에 실패해 새로 연 세션** — 이게 고약하다. `bot.sessionId`는
       *      «유령이 진짜를 밀어내지 않는다»는 규칙(`pointAt`) 때문에 여전히
       *      **잃어버린 진짜 세션**을 가리키는데, 런타임은 방금 연 **빈 세션**을
       *      들고 있다. 그 빈 것을 갈라놓고 *"계획과 파일 기억까지 물려받았습니다"*
       *      라고 말하면 **거짓말**이다 — 사용자는 상대가 다 안다고 믿고 대화한다.
       *
       * 그래서 **둘이 같은 것일 때만** 네이티브로 간다. 아니면 폴백이다:
       * 글로 옮기는 건 비싸지만, 비어 있는 걸 물려받았다고 하는 것보다 낫다.
       */
      if (!bot.sessionPrompted) {
        return await this.freshFork(room, bot, "원본이 아직 에이전트와 대화한 적이 없습니다");
      }
      if (live !== bot.sessionId) {
        return await this.freshFork(
          room,
          bot,
          "원본의 세션이 끊겨 지금은 빈 세션에 붙어 있습니다 — 복제해도 물려받을 것이 없습니다",
        );
      }
      const res = await conn.forkSession(live, room.cwd, this.mcpFor(room, bot));
      if (res.ok) return { sessionId: res.sessionId, native: true, options: res.options };
      return await this.freshFork(room, bot, res.reason);
    }
    return await this.freshFork(
      room,
      bot,
      atTail
        ? "원본 세션에 붙지 못했습니다"
        : "ACP의 세션 분기에는 «어느 지점에서»가 없어 과거 지점은 복제할 수 없습니다",
    );
  }

  /** 폴백 — 새 세션을 열고 **왜 그랬는지** 들고 나온다 */
  private async freshFork(
    room: Room,
    bot: BotInstance,
    reason: string,
  ): Promise<ForkedSession> {
    const conn = this.connection(bot.agentId);
    const { sessionId, configOptions } = await conn.newSession(room.cwd, this.mcpFor(room, bot), () =>
      this.emit(
        "notice",
        room.id,
        `${this.agentOrThrow(bot.agentId).label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`,
      ),
    );
    return { sessionId, native: false, options: configOptions, reason };
  }

  /**
   * **분기를 다시 해본다** (v1.1 보완).
   *
   * 네이티브 분기가 실패하면 우리는 `session/new`로 폴백하고 «글만 옮긴다»고
   * 적어둔다. 그런데 그 실패는 **일시적일 수 있다** — 에이전트가 잠깐 바빴거나
   * 막 뜨는 중이었을 수도 있다. 세션 복구 실패(F7)에 «다시 시도»를 둔 것과
   * 똑같은 이유로, 여기에도 한 번 더 해볼 길이 있어야 한다.
   *
   * 되면 **계획과 파일 기억까지 돌아온다.** 되먹임은 글자만 옮기지만 분기는
   * 세션을 복제하기 때문이다.
   *
   * 🔴 **원본이 그 뒤로 더 말했으면 안 한다.** `session/fork`는 «어느 지점에서»를
   * 못 받으므로 **지금 상태**를 복제한다 — 원본이 세 턴을 더 돌았다면 다시
   * 분기한 세션은 그 세 턴까지 알고 있다. 사용자가 고른 지점이 아니다.
   * 그럴 때는 조용히 다른 것을 주지 않고 **안 된다고 말한다**(§0).
   */
  async retryFork(roomId: string): Promise<{ ok: boolean; reason?: string }> {
    const room = await this.rooms.openRoom(roomId);
    if (!room.forkedFromRoomId) return { ok: false, reason: "분기된 방이 아닙니다." };

    const failed = room.participants.filter((b) => b.forkFallback);
    if (failed.length === 0) return { ok: false, reason: "다시 할 분기가 없습니다." };
    if (isBusy(this.runtimes.statusOf(roomId))) {
      return { ok: false, reason: "응답이 끝난 뒤에 다시 시도할 수 있습니다." };
    }

    let parent: Room;
    try {
      parent = await this.rooms.openRoom(room.forkedFromRoomId);
    } catch {
      return { ok: false, reason: "원본 방이 없어졌습니다." };
    }

    // 원본이 더 말했으면 **지금 분기해도 그 지점이 아니다**
    const tail = [...parent.messages].reverse().find((m) => m.role !== "system");
    if (tail && tail.id !== room.forkedAtMessageId) {
      return {
        ok: false,
        reason:
          "원본이 그 뒤로 더 대화해서 다시 분기할 수 없습니다. " +
          "세션 분기는 **지금 상태를 통째로 복제**하는 것이라, " +
          "여기서 다시 하면 이 방에 안 보이는 원본의 뒤 대화까지 알게 됩니다. " +
          "그때 지점을 원하면 «대화 넘겨서 시작»이 유일한 길입니다.",
      };
    }

    let won = 0;
    for (const bot of failed) {
      // 원본 쪽 짝을 이름으로 찾는다 — 분기할 때 이름을 그대로 물려줬다
      const origin = parent.participants.find((b) => b.name === bot.name);
      const live = origin
        ? (this.runtimes.get(parent.id)?.bots.get(origin.id)?.sessionId ?? origin.sessionId)
        : undefined;
      if (!origin || !live) continue;

      const got = await this.connection(origin.agentId).forkSession(live, room.cwd, this.mcpFor(room, origin));
      if (!got.ok) continue;

      // 폴백으로 열었던 세션은 **빈 것**이라 지울 것도 없다 — 놓기만 한다
      const bt = this.runtimes.bot(room.id, bot.id);
      if (bt.sessionId) {
        await this.connections.get(bot.agentId)?.closeSession(bt.sessionId).catch(() => undefined);
      }
      bt.sessionId = got.sessionId;
      // 네이티브로 갈라낸 세션은 역할을 이미 알고 있다
      bt.roleInjected = true;
      bot.sessionId = got.sessionId;
      bot.sessionPrompted = true;
      delete bot.forkFallback;
      this.watchIdle(room, bot, got.sessionId);
      if (got.options.length > 0) await this.restoreChoices(room, bot, got.sessionId, got.options);
      won++;
    }

    if (won === 0) return { ok: false, reason: "다시 해봐도 갈라지지 않았습니다." };

    const left = room.participants.filter((b) => b.forkFallback);
    /*
     * 되살아난 봇은 **계획·기억까지 돌아왔으므로** 되먹임이 필요 없다.
     * 🔴 방 값 하나를 지우면 **아직 폴백인 봇의 약속까지** 같이 지워진다.
     */
    for (const b of room.participants) {
      if (!b.forkFallback) delete b.refeedPending;
    }

    this.rooms.noteRoom(
      room,
      left.length === 0
        ? "다시 분기했습니다 — 계획과 파일 기억까지 물려받았습니다."
        : `${failed
            .filter((b) => !b.forkFallback)
            .map((b) => b.name)
            .join("·")}는 다시 분기했습니다. ` +
            `${left.map((b) => b.name).join("·")}는 여전히 글로만 옮깁니다.`,
      "info",
    );
    rollUpLost(room);
    await this.rooms.saveProps(room, {
      participants: room.participants,
      refeedPending: room.refeedPending,
    });
    this.emit("room", room);
    return { ok: true };
  }

  /**
   * 갈라낸 세션에 **방을 만들어 붙인다** (v1.1).
   *
   * 분기 방은 «평범한 새 방»이다 (D2) — 특별한 모드도 지속 상태도 없다.
   * 물려받은 메시지가 끝나는 자리를 `forkedAtMessageId`로 적어두면, 화면이
   * 거기에 구분선 하나를 끼운다. 그게 전부다.
   */
  private async createRoomFromFork(
    parent: Room,
    forks: Array<{ bot: BotInstance; forked: ForkedSession }>,
    cut: number,
    title: string | undefined,
    fallback: ForkFallback,
    /** 그 봇만 가르는 경우 — 물려받는 대화도 **그 봇이 본 것**만이다 (v2.1) */
    onlyBotId?: string,
  ): Promise<Room> {
    const now = Date.now();
    const at = parent.messages[cut]!;

    /*
     * **메시지 id를 그대로 물려받는다.**
     *
     * 방마다 파일이 따로라 겹쳐도 부딪히지 않고, 대신 `forkedAtMessageId` 하나가
     * **두 방 모두에서** 유효해진다 — 분기 지점으로 점프할 때 짝을 따로 만들 필요가 없다.
     *
     * 진행 중이던 흔적은 지운다. 물려받은 건 이미 끝난 대화다.
     */
    const messages: Message[] = parent.messages
      .slice(0, cut + 1)
      /*
       * ★ **그 봇이 본 것만** (v2.1 · §5).
       *
       * 🔴 남의 줄기를 끌고 가면 새 방의 첫 화면이 **그 봇은 본 적 없는 말**로
       * 채워진다 — «화면엔 보이는데 봇은 모른다»(§4.1.1의 위험)를 **분기가
       * 새로 만들어내는** 셈이다.
       */
      .filter((m) => (onlyBotId ? inBotView(m, onlyBotId) : true))
      .map((m) => {
        const copy: Message = structuredClone(m);
        delete copy.streaming;
        return copy;
      });

    const room: Room = {
      id: `room-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: title?.trim() || this.nextForkTitle(parent.title),
      // 봇은 전부 **새 것**이다 — 세션이 다르고 설정도 여기서부터 따로 간다
      participants: forks.map(({ bot, forked }, n) => ({
        ...structuredClone(bot),
        id: `${bot.agentId}-${now.toString(36)}-${n}-${Math.random().toString(36).slice(2, 6)}`,
        sessionId: forked.sessionId,
        /*
         * **갈라낸 세션은 «말 걸기 전»에도 디스크에 남는다** (§13.2 실측).
         *
         * `session/new`로 연 세션은 성공한 첫 프롬프트를 받아야 남지만(§13.1),
         * 분기는 **이미 내용이 있는 세션의 복제**라 곱바로 남는다.
         *
         * ⚠ 처음엔 «모르니까 보수적으로» false로 둥는데, **그게 손해였다.**
         * 이 값이 false면 `pointAt`의 보호가 풀려 일시적인 복구 실패 한 번에
         * 진짜 분기 세션 포인터를 유령이 덮어쓴다 — v1.0에서 한 번 당한 사고다.
         *
         * 폴백으로 만든 것(`session/new`)은 여전히 false다. 그건 진짜로 비어 있다.
         */
        sessionPrompted: forked.native,
        // 폴백이면 **다시 해볼 수 있게** 이유를 들고 있는다
        ...(forked.native ? {} : { forkFallback: forked.reason }),
      })),
      cwd: parent.cwd,
      messages,
      unread: 0,
      /*
       * 마지막까지 읽은 상태로 연다 — 물려받은 건 이미 읽은 대화다.
       *
       * ★ 봇 하나만 가르면 **분기 지점 메시지가 그 봇 뷰에 없을 수 있다**
       * (남에게 간 말에서 갈랐을 때). 그러면 여기가 **새 방에 없는 id** 를
       * 가리켜 «안 읽음»이 어긋난다 — 실제로 물려받은 마지막 것을 쓴다.
       */
      lastReadMessageId: messages.at(-1)?.id ?? at.id,
      forkedFromRoomId: parent.id,
      forkedAtMessageId: at.id,
      /*
       * 폴백이면 에이전트가 백지다. **사용자가 고른 대로** — 글로 옮기거나 백지로.
       *
       * 🔴 여기 있는 것은 **요약**이다. 진짜 약속은 아래에서 **폴백한 봇에게만**
       * 건다. 방에 하나로 두었더니 네이티브로 갈라져 **이미 계획·기억을
       * 물려받은 봇에게도** 지난 대화가 통째로 다시 들어갔다 — 토큰만 쓰고
       * 맥락은 두 겹이 된다.
       */
      ...(forks.every((f) => f.forked.native) || fallback === "fresh"
        ? {}
        : { refeedPending: true }),
      createdAt: now,
      lastActivityAt: now,
    };

    /*
     * ★ **심사자 지목도 새 id 로 옮긴다** (v3.0 3-P).
     *
     * 🔴 봇은 전부 **새 것**인데 `structuredClone` 은 `approver.botId` 까지
     * 그대로 베낀다 — 가리키는 곳이 **부모 방의 봇**이라 분기한 방에서는
     * 심사가 통째로 안 듣는다. 조용히 사용자에게 되돌아오므로 **화면만
     * 보고는 모른다.**
     *
     * 봇 하나만 가른 경우에는 지목한 상대가 새 방에 아예 없다 — 그때는
     * 사용자로 되돌린다.
     */
    const moved = new Map(forks.map(({ bot }, n) => [bot.id, room.participants[n]!.id]));
    for (const b of room.participants) {
      if (b.approver?.kind !== "bot") continue;
      const landed = moved.get(b.approver.botId);
      b.approver = landed ? { kind: "bot", botId: landed } : ASK_USER;
    }

    await this.opts.store.createRoom(room);
    this.rooms.open.set(room.id, room);

    for (const [n, { forked }] of forks.entries()) {
      const fresh = room.participants[n]!;
      // ★ **폴백한 봇에게만** 되먹임 약속 — 네이티브는 이미 다 물려받았다
      if (fallback !== "fresh" && !forked.native) fresh.refeedPending = true;
      const bt = this.runtimes.bot(room.id, fresh.id);
      bt.sessionId = forked.sessionId;
      // 네이티브 분기는 역할을 이미 알고 있다 — 원본이 들은 것을 그대로 물려받았다
      bt.roleInjected = forked.native;
      this.watchIdle(room, fresh, forked.sessionId);
      if (forked.options.length > 0) {
        await this.restoreChoices(room, fresh, forked.sessionId, forked.options);
      }
    }

    /*
     * **어떻게 갈라졌는지 말해준다** (§0 원칙).
     *
     * 네이티브면 계획·메모리까지 따라왔고, 폴백이면 글만 따라온다 — 사용자가
     * 기대를 맞출 수 있어야 하는 차이다. 조용히 지나가면 «왜 얘는 아까 얘기를
     * 모르지»가 된다.
     */
    const note: Message = {
      id: messageId(),
      role: "system",
      /*
       * 🔴 **폴백은 «새 세션»이 아니라 «상태를 잃었다»가 핵심이다.**
       *
       * 예전 문구는 *"새 세션으로 시작합니다"* 였는데, 그건 **우리 사정**이지
       * 사용자에게 달라지는 것이 아니다. 실제로 달라지는 건 이쪽이다:
       * 네이티브면 에이전트가 세운 **계획과 읽은 파일 기억**까지 따라오고,
       * 폴백이면 **대화 글자만** 따라온다. 그걸 안 적으면 사용자는 상대가
       * 아까 읽은 파일을 기억한다고 믿은 채로 대화한다.
       *
       * 그래서 폴백은 **무엇을 잃었는지 먼저**, 이유는 그다음이다.
       */
      /*
       * 봇이 여럿이면 **섞일 수 있다** — Claude는 네이티브로 갈라지고
       * Gemini는 폴백으로 떨어지는 식이다. 그럴 때 **잔치를 이름으로 짚는다** —
       * «일부는 잃었습니다»만 써두면 누구에게 다시 설명해야 하는지 모른다.
       */
      text: (() => {
        const lost = forks.filter((f) => !f.forked.native);
        if (lost.length === 0) {
          return "원본 세션을 갈라 시작했습니다 — 대화뿐 아니라 계획과 파일 기억까지 물려받았습니다.";
        }
        // 봇이 하나면 이름을 안 붙인다 — 군더더기다. 조사도 그에 따라 갈린다.
        const subject =
          forks.length === 1
            ? "계획과 파일 기억은"
            : `${lost.map((f) => f.bot.name).join("·")}는 계획과 파일 기억을`;
        const why = lost[0]!.forked.reason;
        return fallback === "refeed"
          ? `⚠ ${subject} 물려받지 못했습니다 — 위 대화를 글로만 옮깁니다. ` +
            `(${why}) 다음 메시지에 함께 전달됩니다.`
          : `⚠ ${subject} 물려받지 못했습니다 — 위 기록만 남기고 백지에서 시작합니다. ` +
            `(${why}) 에이전트는 위 대화를 모릅니다.`;
      })(),
      ...(forks.every((f) => f.forked.native) ? {} : { mark: "error" as const }),
      deliveredTo: [],
      createdAt: now,
    };
    this.rooms.append(room, note);
    await this.rooms.saveNewMessage(room, note);

    this.rooms.emitMetas();
    return room;
  }

  /**
   * 분기 방의 기본 제목 — `원본 (2)`, 그다음은 `(3)`.
   *
   * 분기의 분기도 형제로 센다(D4). `논의 (2)`에서 또 가르면 `논의 (2) (2)`가 아니라
   * `논의 (3)`이다 — 꼬리표가 겹치면 목록에서 읽을 수 없게 된다.
   */
  private nextForkTitle(parentTitle: string): string {
    const base = parentTitle.replace(/\s*\(\d+\)\s*$/, "").trim() || parentTitle;
    const taken = new Set(this.rooms.listMetas().map((m) => m.title));
    for (let n = 2; ; n++) {
      const name = `${base} (${n})`;
      if (!taken.has(name)) return name;
    }
  }

  /** 이 방에서 갈라져 나간 방들 (D3·분기 목록) */
  childrenOf(roomId: string): RoomMeta[] {
    return this.rooms.listMetas().filter((m) => m.forkedFromRoomId === roomId);
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
      const conn = this.connections.get(bot.agentId);
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

    this.disposeUnusedConnections();
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
        await this.startAgent(room, bot);
        this.emit("joinStep", room.id, bot.id, "session");
      }
      await this.ensureSession(room, bot);
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

    await this.runQueue(room, [sent], bot.id);
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
        for (const one of batch) await this.runQueue(room, [one], botId);
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
      [...byBot].map(([botId, batch]) => this.runQueue(room, batch, botId)),
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
      await this.connections.get(bot.agentId)?.cancel(bt.sessionId);
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
      sessionId = await this.ensureSession(room, bot);
    } finally {
      if (before === "idle") this.runtimes.setStatus(room.id, "idle", bot.id);
    }

    const conn = this.connection(bot.agentId);
    const updated = await conn.setConfigOption(sessionId, configId, value);
    if (typeof value === "string") this.rememberModel(bot.agentId, configId, value);

    // **권한 모드도 모델 이름도 여기서 봇에 박힌다** (D2·B5) — 응답에 실려 온
    // 현재 값을 그대로 옮기므로, 우리가 보낸 값과 에이전트가 실제로 고른 값이
    // 다르면 에이전트 쪽이 이긴다.
    this.noteRoomConfig(room, bot, updated);
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
    return this.connection(agentId).forkSupport();
  }

  promptCapabilities(agentId: string): { image: boolean; audio: boolean; embeddedContext: boolean } {
    return this.connection(agentId).promptCapabilities();
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

    const known = this.roomConfigs.get(configKeyOf(room.id, bot.id));
    if (known) return known;

    await this.bindSession(room);
    const after = this.roomConfigs.get(configKeyOf(room.id, bot.id));
    if (after) return after;

    // 붙는 데 실패했으면 이유가 있어야 한다 — 빈 목록으로 삼키면
    // «이 에이전트는 권한 모드가 없다»로 읽힌다
    return this.configOptions(bot.agentId);
  }

  async configOptions(agentId: string): Promise<acp.SessionConfigOption[]> {
    const cached = this.configCache.get(agentId);
    if (cached) {
      // 백그라운드 갱신은 실패해도 조용히 넘어간다 — 보여줄 값이 이미 있다.
      void this.refreshConfigOptions(agentId).catch(() => {});
      return cached;
    }

    /*
     * ★ **디스크에 적어둔 것이 있으면 CLI 를 안 띄운다** (2026-10-13).
     *
     * 🔴 여기가 **18.6초**짜리 자리다(Antigravity 실측: 띄우기 12.5 + 세션 5).
     * 목록을 알려면 세션을 열어야 하고, 세션을 열려면 CLI 를 띄워야 하니까.
     * 그런데 캐시가 메모리에만 있어서 **창을 열 때마다** 다시 냈다.
     *
     * ⚠️ **뒤에서 갱신도 안 한다.** 갱신하려면 결국 띄워야 해서, 그러면
     * 아낀 것이 없다. 진짜 목록은 **방에 들어갈 때** 세션이 준다 —
     * 거기서 이 값이 덮인다.
     */
    const kept = this.keptOptions(agentId);
    if (kept) {
      this.configCache.set(agentId, kept);
      return kept;
    }
    // **같은 에이전트를 동시에 두 번 띄우지 않는다.** 방에 들어오면서 한 번,
    // 권한 시트를 열면서 또 한 번 부르는 게 정상 경로다.
    const flight = this.configFlight.get(agentId);
    if (flight) return flight;

    const started = this.refreshConfigOptions(agentId).finally(() =>
      this.configFlight.delete(agentId),
    );
    this.configFlight.set(agentId, started);
    return started;
  }

  /** 받아둔 자리 옆의 캐시 — `agentRoot` 가 없으면 안 쓴다 */
  private keptOptions(agentId: string): acp.SessionConfigOption[] | undefined {
    const root = this.opts.agentRoot;
    const pkg = this.opts.agents.find((a) => a.id === agentId)?.pkg;
    if (!root || !pkg) return undefined;
    return cachedOptions<acp.SessionConfigOption>(dirFor(root, agentId), pkg);
  }

  private async keepConfigOptions(
    agentId: string,
    options: acp.SessionConfigOption[],
  ): Promise<void> {
    const root = this.opts.agentRoot;
    const pkg = this.opts.agents.find((a) => a.id === agentId)?.pkg;
    if (!root || !pkg) return;
    await keepOptions(dirFor(root, agentId), pkg, options);
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
          this.connection(agentId).probeUsage(this.opts.host.defaultCwd(), q.commands),
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

  private async refreshConfigOptions(agentId: string): Promise<acp.SessionConfigOption[]> {
    try {
      const limit = this.opts.configProbeMs ?? CONFIG_PROBE_MS;
      const options = await withTimeout(
        this.connection(agentId).probeConfigOptions(this.opts.host.defaultCwd()),
        limit,
        /*
         * ⚠️ **첫 실행이면 이건 고장이 아니다** (2026-10-01).
         *
         * 어댑터를 `npx` 가 그때 받는다 — Codex 쪽은 **445MB** 라 느린 망에선
         * 90초를 넘긴다. 예전 문구는 «응답하지 않습니다 · 설치를 마쳤는지
         * 확인하세요» 였는데, 둘 다 틀렸다 — 저쪽은 멀줦히 살아서 **받는 중**
         * 이고, 사용자가 깔 것은 우리가 쓰지도 않는다(`docs/PIN.md` §F5).
         *
         * 물어볼 것은 둘이다: **다시 해보기**(받기가 끝나면 된다)와
         * **로그인**. 설치 판을 맞추라고 하면 엉뙡한 일을 시키는 것이다.
         */
        `${this.agentOrThrow(agentId).label}이(가) ${Math.round(limit / 1000)}초 안에 ` +
          `응답하지 않았습니다. 첫 실행이라면 어댑터를 받는 중일 수 있습니다 ` +
          `(Codex 는 445MB). 잠시 뒤 다시 해보고, 계속 그러면 터미널에서 ` +
          `한 번 실행해 로그인을 마쳤는지 확인하세요.`,
      );
      this.configCache.set(agentId, options);
      void this.keepConfigOptions(agentId, options);
      return options;
    } catch (err) {
      this.opts.host.log(`[${agentId}] 설정 조회 실패: ${describe(err)}`);

      // 이전 값이 있으면 그걸 쓴다 — 일시적인 실패로 목록을 비울 이유가 없다.
      const cached = this.configCache.get(agentId);
      if (cached) return cached;

      // **빈 배열로 삼키지 않는다.** 그러면 셀이 *"모델이 없다"* 와
      // *"CLI를 못 띄웠다"* 를 구별하지 못해 방 만들기 화면이 아무 설명 없이 비어 보인다.
      throw err;
    }
  }

  // ── 내부 ──────────────────────────────────────────────────────────────


  private async runQueue(
    room: Room,
    batch: Message[],
    botId?: string,
    /**
     * ★ **알림만으로 연 턴인가** (v3.0 4-J).
     *
     * 그때 `batch` 는 **대화에 없는 가짜**다 — 프롬프트를 짓는 데만 쓰고,
     * 자리(`placedAt`)도 실패 표시도 `replyToIds` 도 안 붙인다. 붙이면
     * 디스크에 **아무도 안 만든 말풍선**이 한 줄 남는다.
     */
    wake?: boolean,
  ): Promise<Message | undefined> {
    // 단체방에서는 **멘션된 봇마다** 이 함수가 돈다. 지금은 하나뿐이다.
    const bot = (botId ? room.participants.find((b) => b.id === botId) : undefined)
      ?? room.participants[0]!;
    const bt = this.runtimes.bot(room.id, bot.id);
    const conn = this.connection(bot.agentId);

    let sessionId: string;
    try {
      this.runtimes.setStatus(room.id, "connecting", bot.id);
      sessionId = await this.ensureSession(room, bot);
    } catch (err) {
      /*
       * 세션을 못 열었으면 **프롬프트가 아예 안 나갔다.** 해당 메시지들을
       * 실패로 표시해 다시 보낼 수 있게 한다 — 그냥 버리면 다시 타이핑해야 한다.
       *
       * 🔴 **어느 봇에게 안 갔는지도 적는다** (2026-10-09). 여기가 `sendFailed`
       * 만 적고 `notSentTo` 를 비워뒀다 — 그래서 `retry` 의 «안 간 봇에게만»
       * 이 **한 번도 안 돌았다.** 빈칸이면 `deliveredTo`(전원)로 떨어지므로,
       * 알파는 멀쩡히 받았는데 ↻ 를 누르면 **알파가 같은 일을 또 한다.**
       * 코딩 에이전트에서는 파일을 두 번 고치는 일이다.
       */
      const reason = describe(err);
      // 🔴 **가짜 묶음에는 안 적는다** — `markNotSent` 는 디스크에 한 줄을
      // 쓰는데, 그 메시지는 `room.messages` 에 없다. 다시 열면 **빈 말풍선**이다.
      if (!wake) for (const m of batch) await this.rooms.markNotSent(room, m, bot.id, reason);
      this.runtimes.setStatus(room.id, "error", bot.id);
      this.emit("roomError", room.id, reason);
      return undefined;
    }

    // ★ **줄에서 나왔다** — 여기서 자리를 잡는다 (대기 정렬)
    for (const m of batch) this.rooms.placeNow(room, m);

    /*
     * ★ **이번 턴의 몫을 여기서 떼어낸다** (v3.0 2-H).
     *
     * 🔴 **안 떼면 턴이 안 끝난다.** 봇이 큐를 비우는 사이에 새 것이 들어오면
     * `left` 가 영영 0 이 안 되고, 모델은 «아직 남았구나» 하며 또 꺼낸다 —
     * 들어오는 속도가 처리 속도보다 빠르면 끝이 없다.
     *
     * **프롬프트를 짓기 직전이어야 한다.** 세는 자리와 떼는 자리가 갈리면
     * 프롬프트에 적힌 수와 `check_queue` 가 주는 수가 어긋난다.
     */
    const incoming = this.queue.startTurn(bot.id);
    /*
     * ★ **이 턴이 몇 다리 건너온 것인가** (v3.0 4-L).
     *
     * **이 턴을 연 것**의 깊이다(`startTurn` 이 돌려준다). 몫 전체로 재면
     * **답 안 한 옛 항목**이 섞여 다른 사슬이 서로를 오염시킨다.
     *
     * 🔴 **사용자가 말을 걸었다고 0 으로 내리지 않는다.** 한 턴에 사용자 말과
     * **밀려 있던 깊은 항목이 같이** 실릴 수 있다. 그때 턴을 0 으로 내리면
     * 그 깊은 사슬의 답까지 1다리째가 되어, **사용자가 그 봇에게 한 마디만
     * 하면 돌던 사슬이 통째로 되살아난다.**
     *
     * 사용자 말은 «깊이 0 짜리 항목이 하나 더 온 것»이다 — 그래서 `max` 가
     * 저절로 맞는다. 「누가 열었나」는 `fromUser` 가 따로 들고 있다.
     */
    bt.fromUser = batch.some((m) => m.role === "user");
    // 턴마다 새로 — «이 턴의 사용자 말»에 대해 누구에게 보냈나는 턴 안에서만 뜻이 있다
    bt.saidZero = new Set<string>();
    bt.depth = incoming || (bt.fromUser ? 0 : (bt.depth ?? 0));

    const prompt = await this.buildPrompt(room, bot, bt, batch);

    const reply: Message = {
      id: messageId(),
      role: "agent",
      authorBotId: bot.id,
      text: "",
      deliveredTo: [bot.id],
      // 알림 턴에는 **답할 대상이 없다** — 가짜 id 를 적으면 짝짓기가 깨진다
      ...(wake ? {} : { replyToIds: batch.map((m) => m.id) }),
      /*
       * ★ **봇의 산문은 언제나 «나에게 한 말»이다** (2026-09-29 · v3.0 4-14).
       *
       * ⏪ 그날은 «사용자가 부른 턴이면» 이라고 적고 *"봇끼리 말하기가 들어오면
       * 이 값이 갈린다"* 고 미뤄뒀다. **그날이 왔고, 안 갈린다.**
       *
       * 갈리는 것은 **산문이 아니라 도구 인자**였다. 받는 이를 정하는 것은
       * `@` 도 턴을 연 사람도 아니고 **어디서 왔나**다:
       *
       * ```
       * say(to, …) 의 내용   받는 봇     → 말풍선 하나 (deliveredTo = 그 봇)
       * 그 턴의 산문          없음 → 사용자  → 말풍선 하나 (toUser)
       * ```
       *
       * 알림만으로 깨어난 턴에도 산문은 온다 — 에이전트는 **턴을 말로 닫기**
       * 때문이다. 그 말에 칩이 안 붙으면 «누구에게 한 말인지 알 수 없는 줄»이
       * 하나 생긴다. **없는 것으로 구별하면 약하다.**
       */
      toUser: true,
      createdAt: Date.now(),
      streaming: true,
    };
    this.rooms.append(room, reply);

    // **응답 자리를 프롬프트보다 먼저 저장한다.**
    //
    // 이게 없으면 스트리밍 도중에 VSCode가 꺼졌을 때 사용자 메시지만 남고,
    // 다시 켰을 때 "답이 안 달렸으니 전송 실패"로 잘못 판정된다(C5).
    // 실제로는 전송됐고 에이전트가 답까지 했는데 `↻`를 누르면 같은 질문이 두 번 간다.
    await this.rooms.saveNewMessage(room, reply);

    this.runtimes.setStatus(room.id, "waiting", bot.id);

    // 앞 턴이 유예 중이면 **확정하고** 자리를 받는다 — 그냥 밀어내면 디스크에만 빠진다
    this.releaseTurn(room, bot);
    /*
     * ★ **턴 밖 묶음은 여기서 끝난다** (2026-09-28).
     *
     * 안 끊으면 `IDLE_BURST_MS`(30초) 안에 온 다음 턴 밖 발화가 **턴을 건너뛴
     * 옛 말풍선에** 이어 붙는다 — 사이에 사용자 말과 답이 통째로 들어갔는데도.
     */
    clearTimeout(bt.idleClose);
    bt.idleClose = undefined;
    delete bt.idle;
    // **이 턴의 말은 여기로 모인다.** 리스너를 갈지 않고 표시만 켜둔다 — 이유는 `watchIdle`에.
    bt.turn = reply;
    try {
      const res = await conn.prompt(sessionId, prompt);
      // **이제 이 세션은 디스크에 남는다** — 되살릴 값이 여기서 확정된다 (F7)
      this.notePrompted(room, bot, sessionId);
      if (res.usage) this.applyUsage(room, bot, res.usage);
      // 왜 끝났는지 알려준다. 그냥 두면 거부나 길이 초과가 **짧은 응답**으로 보인다.
      const note = stopReasonNote(res.stopReason);
      if (note) reply.error = note;
    } catch (err) {
      const reason = describe(err);
      reply.error = reason;
      this.runtimes.setStatus(room.id, "error", bot.id);

      /*
       * ★ **다시 해볼 만한 실패에는 `↻`를 붙인다.**
       *
       * 한도나 과부하로 막히면 사용자가 할 수 있는 건 «나중에 다시»뿐인데,
       * 그때 **같은 말을 다시 타이핑하게 하면 안 된다.** `sendFailed`를 달아두면
       * 말풍선에 `↻ 다시 보내기`가 붙고, 누르면 `retry()`가 그 메시지를 그대로
       * 다시 보낸다 — 새 말풍선도 안 만든다.
       *
       * 🔴 **두 가지는 안 붙인다.**
       *
       * 1. **이미 일이 일어난 턴** — 에이전트가 말을 했거나 도구를 돌렸으면
       *    되돌릴 수 없는 것이 이미 있다. 다시 보내면 **같은 편집이 한 번 더** 간다.
       * 2. **사람이 풀어야 하는 실패** — 로그인이나 내용 거부는 다시 눌러봐야
       *    같은 벽이다. 누를 수 있게 해두면 누르게 되고, 그때마다 토큰만 쓴다.
       *
       * 모르는 오류는 «안 된다» 쪽이다(`retryable`). 되는 척하는 버튼보다
       * 없는 버튼이 낫다.
       */
      const touched = reply.text.length > 0 || (reply.tools?.length ?? 0) > 0;
      if (!touched && retryable(reason) && !wake) {
        // 🔴 여기도 **어느 봇에게 안 갔는지**를 같이 적는다 (위 주석 참고)
        for (const m of batch) await this.rooms.markNotSent(room, m, bot.id, reason);
      }
    }

    /*
     * blob 쓰기가 끝나야 해시가 채워진다 — **이 봇 것만** 기다린다.
     *
     * 🔴 방 단위였을 때는 `length = 0` 이 **옆 봇의 영수증까지 지웠다.**
     * 지워진 쪽은 기다릴 것이 없다고 보고 빈 해시로 저장할 수 있었다.
     */
    if (bt.pendingWrites.length > 0) {
      const mine = bt.pendingWrites.splice(0, bt.pendingWrites.length);
      await Promise.allSettled(mine);
    }

    reply.streaming = false;

    /*
     * ★ **꺼내 본 메시지는 여기서 닫는다** (2026-10-13).
     *
     * 사용자: *"봇이 반응을 나한테 할때, say를 안쓰니까 큐에서 안빠지는 문제가
     * 있네"*. 사용자에게 답하는 것도 반응인데 장부에는 안 빠져서, 그 항목이
     * **영영 몫에 남아** 매 턴 «queue: 1 · do: check_queue» 로 찔렀다.
     *
     * 🔴 **오류로 끝난 턴은 안 닫는다** — 모델이 반응할 기회를 못 가졌을 수
     * 있다. 꺼내 보고 답을 못 한 채 끊긴 것까지 닫으면 그때는 **잃는 것**이다.
     */
    if (!reply.error) this.queue.closeSeen(bot.id);

    // 보고 있지 않은 방의 응답만 안 읽은 것으로 센다 (B8)
    if (this.activeRoomId !== room.id) room.unread += 1;

    await this.rooms.saveMessage(room, reply);
    await this.rooms.saveProps(room, { unread: room.unread, usage: room.usage });
    // 턴이 끝날 때도 바뀐 건 응답 하나다. 방 전체를 보낼 이유가 없다.
    this.emit("message", room.id, reply);
    // **마지막에 놓는다.** 응답보다 늦게 오는 조각이 있어서 — `releaseTurn` 참조
    this.scheduleRelease(room, bot, reply);
    // ★ **이 봇이** 실패한 게 아니면 놓는다 — 다른 봇의 실패가 이 봇을 묶지 않는다
    if (this.runtimes.statusOf(room.id, bot.id) !== "error") this.runtimes.setStatus(room.id, "idle", bot.id);
    /*
     * ★ **턴 중에 들어온 것은 여기서 깨운다** (v3.0 4-J).
     *
     * 넣는 쪽이 깨우려 했지만 **그때 이 봇은 바빴다.** 스냅샷이 몫을 떼어놔서
     * 그 턴에는 보이지도 않았다 — 턴이 닫히는 지금이 그 다음 자리다.
     */
    this.maybeWake(room, bot.id);
    // 부른 쪽이 **답을 읽어야 할 때가 있다** — 봇 심사(§4.2.2)가 그렇다
    return reply;
  }

  private applyUsage(room: Room, bot: BotInstance, usage: acp.Usage): void {
    bot.usage = {
      ...bot.usage,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
      ...(usage.cachedReadTokens != null
        ? { cachedReadTokens: usage.cachedReadTokens }
        : {}),
      ...(usage.cachedWriteTokens != null
        ? { cachedWriteTokens: usage.cachedWriteTokens }
        : {}),
    };
    this.rollUpUsage(room);
  }

  /**
   * 컨텍스트가 얼마나 찼는지 **그 봇에** 적는다.
   *
   * 봇을 모르면(턴에 주인이 없는 희귀한 경우) 방 하나뿐인 봇으로 본다 —
   * 1:1에서는 언제나 맞고, 단체방에서는 모르는 채로 아무 봇에게 씌우지 않는다.
   */
  private noteUsage(
    room: Room,
    botId: string | undefined,
    ev: Extract<AgentEvent, { type: "usage" }>,
  ): void {
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;
    bot.usage = {
      ...bot.usage,
      contextUsed: ev.used,
      contextSize: ev.size,
      ...(ev.cost ? { cost: ev.cost } : {}),
    };
    this.rollUpUsage(room);
  }

  /**
   * 봇들의 사용량을 **방 하나의 눈금**으로 접는다.
   *
   * 목록의 고리와 «거의 찼다» 경고는 방당 하나뿐이라 숫자가 하나여야 한다.
   * 더하지 않고 **가장 많이 찬 봇**을 고른다 — 셋이 30%씩이라고 90%가 아니다.
   * 컨텍스트는 세션마다 따로 차고, 급한 것은 제일 많이 찬 쪽이다.
   */
  private rollUpUsage(room: Room): void {
    const filled = (u: RoomUsage | undefined): number =>
      u?.contextUsed && u.contextSize ? u.contextUsed / u.contextSize : -1;
    const worst = room.participants.reduce<BotInstance | undefined>(
      (a, b) => (a && filled(a.usage) >= filled(b.usage) ? a : b),
      undefined,
    );
    if (worst?.usage) room.usage = worst.usage;
  }

  private applyEvent(room: Room, reply: Message, ev: AgentEvent): void {
    switch (ev.type) {
      case "text":
        reply.text += ev.delta;
        this.runtimes.setStatus(room.id, "streaming", reply.authorBotId);
        break;

      case "thought":
        reply.thought = (reply.thought ?? "") + ev.delta;
        break;

      case "tool":
        this.runtimes.setStatus(room.id, "tool", reply.authorBotId);
        this.recordActivity(room, reply, ev);
        break;

      case "diff":
        this.recordDiff(room, reply, ev);
        break;

      // 🔴 **세션마다 오는 값이다.** 방에 적으면 봇이 둘일 때 서로 덮어쓴다
      case "usage":
        this.noteUsage(room, reply.authorBotId, ev);
        break;

      case "commands":
        // 슬래시 명령은 **그 세션이** 광고한 것이다
        if (reply.authorBotId) this.runtimes.bot(room.id, reply.authorBotId).commands = ev.names;
        break;

      // 🔴 **압축은 «대화의 사건»이다** (C11). 이 지점부터 에이전트가 아는 건
      // 요약본인데 화면에는 전체가 그대로 보인다. 타임라인에 자국을 남기지
      // 않으면 *"아까 말한 거"* 가 왜 안 통하는지 알 길이 없다.
      //
      // **요약 내용은 안 보여준다.** 사용자가 읽을 것은 자기 대화지 요약이 아니다.
      case "compaction":
        this.noteCompaction(room, reply.authorBotId, ev);
        break;

      // 계획 (계획 모드의 알맹이). 메시지에 붙여 화면에 그대로 보여준다
      case "plan":
        reply.plan = ev.markdown
          ? { markdown: ev.markdown }
          : { entries: ev.entries ?? [] };
        break;

      case "planRemoved":
        delete reply.plan;
        break;

      // 에이전트가 스스로 모드를 바꿨다 — 우리 기록이 낡는다
      case "mode":
        this.noteAgentMode(room, reply.authorBotId, ev.modeId);
        break;

      case "config":
        this.noteAgentConfig(room, reply.authorBotId, ev.options);
        break;

      // 🔴 **모르는 것도 조용히 넘기지 않는다** (§0 P5)
      case "unknown":
        this.opts.host.log(`[${room.id}] 아직 다루지 않는 업데이트: ${ev.kind}`);
        break;
    }
    room.lastActivityAt = Date.now();
    this.emitThrottled(room, reply);
    this.saveThrottled(room, reply);
  }

  /**
   * 압축 알림을 방에 반영한다 (C11).
   *
   * **턴 안에서도 밖에서도 온다** — 에이전트는 컨텍스트가 차면 스스로 압축하는데,
   * 그게 우리가 프롬프트를 보낸 동안일 거라는 보장이 없다.
   */
  private noteCompaction(
    room: Room,
    /** **누구의 기억이 줄었나** (v2.1). 압축은 세션 단위라 봇 단위다 (B1) */
    botId: string | undefined,
    ev: { id: string; status: string; summary?: string; summaryDelta?: string },
  ): void {
    // 🔴 **방까지 붙여야 유일하다.** `compactionId`는 스펙상 «세션 안에서»
    // 유일할 뿐이라, 같은 에이전트의 두 방이 같은 id를 쓸 수 있다.
    const key = `${room.id}:${ev.id}`;

    // 요약은 **조각으로 나뉘어 먼저** 올 수 있다. 끝날 때까지 모은다.
    if (ev.summaryDelta) {
      this.compacting.set(key, (this.compacting.get(key) ?? "") + ev.summaryDelta);
    }
    if (ev.status !== "completed" || this.compacted.has(key)) return;
    this.compacted.add(key);

    // `summary`는 «통째로 교체», 조각은 «덧붙이기». 준 쪽을 쓴다.
    const summary = (ev.summary ?? this.compacting.get(key) ?? "").trim();
    this.compacting.delete(key);
    const mark: Message = {
      id: messageId(),
      role: "system",
      text: "여기까지 압축됨 — 위쪽은 에이전트가 요약으로 기억합니다",
      // **그 봇의 기억이 줄어든 것**이다 — 다른 봇은 멀쩡하다 (B1)
      ...(botId ? { aboutBotIds: [botId] } : {}),
      mark: "compaction",
      // 보여주려고 담는 게 아니다 — **되먹일 때 앞부분을 대신한다**(F7)
      ...(summary ? { summary } : {}),
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.rooms.append(room, mark);
    void this.rooms.saveNewMessage(room, mark);
    this.emit("message", room.id, mark);
  }

  /**
   * 기록이 가리킬 세션을 정한다 (F7).
   *
   * 🔴 **유령으로 진짜를 밀어내지 않는다.** 에이전트는 첫 프롬프트를 받아야
   * 세션을 디스크에 남기므로(§13.1), 말을 안 건 세션 id는 되살릴 수 없다.
   * 그런 id가 기록을 덮으면 **진짜 세션을 가리키던 포인터를 잃는다** —
   * 일시적인 복구 실패 한 번이 영구 손실이 된다. 실제로 그랬다.
   *
   * 그래서 **써본 세션은 써본 세션으로만** 밀어낸다. 새 세션이 프롬프트를
   * 받으면 그때 `notePrompted()`가 기록을 옮긴다.
   */
  private pointAt(bot: BotInstance, sessionId: string): void {
    if (bot.sessionPrompted && bot.sessionId) return;
    bot.sessionId = sessionId;
    bot.sessionPrompted = false;
  }

  /** 그 세션이 실제로 쓰였다 — 이제 이게 되살릴 값이다 */
  private notePrompted(room: Room, bot: BotInstance, sessionId: string): void {
    if (bot.sessionId === sessionId && bot.sessionPrompted) return;
    bot.sessionId = sessionId;
    bot.sessionPrompted = true;
    void this.rooms.saveProps(room, { participants: room.participants });
  }

  /** 세션이 붙어 있는 동안 **계속** 듣는다 (A11) */
  /**
   * 그 세션의 이벤트를 받는다. **리스너는 세션당 하나뿐이다.**
   *
   * 🔴 예전에는 턴이 시작될 때 «턴 리스너»로 갈아끼우고 `prompt()`가 끝나면
   * «턴 밖 리스너»로 되돌렸다. 그런데 **`session/prompt`의 응답과 그 턴의
   * `session/update`는 도착 순서가 보장되지 않는다** — 응답이 먼저 처리되면
   * 리스너는 이미 갈려 있고, 그 턴의 말이 **턴 밖 발화로 오인된다.**
   *
   * 그 결과가 «빈 말풍선 + 그 아래 따로 뜬 말풍선»이고, 30초 안에 여러 턴이
   * 돌면 그것들이 **한 말풍선에 뭉쳐서** `알겠습니다알겠습니다알겠습니다`가 된다.
   *
   * 그래서 **갈아끼우지 않는다.** 리스너는 하나로 두고, 턴이 도는 중인지는
   * `bt.turn`으로 가른다 — 그건 우리가 정확히 언제 놓을지 정할 수 있다.
   */
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
   * 턴을 놓을 **예약**을 건다 — 응답이 온 순간이 아니라 조금 뒤에 (A11 경계).
   *
   * 🔴 `session/prompt`의 응답과 그 턴의 `session/update`는 **도착 순서가 보장되지
   * 않는다.** 가짜 에이전트로 재보니 8턴 중 2턴에서 응답이 먼저 왔다 — 파이프는
   * 순서를 지키지만 SDK가 그 순서대로 넘겨주지는 않는다.
   *
   * 그래서 응답을 받자마자 턴을 닫으면 **그 턴의 마지막 말이 턴 밖 발화로 오인된다.**
   * 화면에는 «빈 말풍선 + 엉뚱한 자리에 붙은 말»이 되고, 30초 안에 여러 턴이 돌면
   * 그것들이 한 말풍선에 뭉친다.
   */
  private scheduleRelease(room: Room, bot: BotInstance, reply: Message): void {
    const bt = this.runtimes.bot(room.id, bot.id);
    if (bt.turn !== reply) return;
    clearTimeout(bt.tail);
    bt.tail = setTimeout(() => this.releaseTurn(room, bot, reply), TURN_TAIL_MS);
  }

  /**
   * 턴을 **지금** 놓는다. 예약이 다 됐거나, 다음 턴이 시작하려 할 때.
   *
   * 🔴 **다음 턴이 밀고 들어올 때 그냥 버리면 안 된다.** 예약해둔 것을 «임자가
   * 바뀌었으니 없던 일»로 치면, 유예 중에 늦게 붙은 조각이 **디스크에만 빠진다** —
   * 화면에는 있는데 껐다 켜면 빈 말풍선이 된다. 실제로 그렇게 나왔다.
   * 그래서 밀려날 때도 **확정하고** 넘긴다.
   *
   * 저장은 **조건 없이** 한다. «바뀌었으면»으로 걸러봤더니, 늦게 온 조각이
   * 마지막 저장과 비교 시점 **사이에** 도착하면 비교 기준이 이미 그걸 품고
   * 있어서 «안 바뀌었다»가 됐다. 줄 하나 더 쓰는 값으로 **화면과 디스크가 같다**를
   * 산다 — JSONL은 같은 id를 병합하고 주기적으로 정리한다(`maybeCompact`).
   */
  private releaseTurn(room: Room, bot: BotInstance, only?: Message): void {
    const bt = this.runtimes.bot(room.id, bot.id);
    const pending = bt.turn;
    if (!pending) return;
    // 예약이 걸린 뒤 다른 턴이 자리를 가져갔으면, 그 예약은 남의 것이다
    if (only && pending !== only) return;

    clearTimeout(bt.tail);
    bt.tail = undefined;
    bt.turn = undefined;
    void this.rooms.saveMessage(room, pending);
    this.emit("message", room.id, pending);
  }

  private watchIdle(room: Room, bot: BotInstance, sessionId: string): void {
    this.connection(bot.agentId).listen(sessionId, (ev) => {
      const turn = this.runtimes.bot(room.id, bot.id).turn;
      if (turn) this.applyEvent(room, turn, ev);
      else this.onIdleEvent(room, bot, ev);
    });
  }

  /**
   * **턴 밖에서** 온 것들 (A11).
   *
   * 🔴 예전에는 `listen`을 프롬프트 직전에 붙이고 끝나면 뗐다. 그래서 턴 사이에
   * 오는 건 **받는 사람이 없어 그냥 사라졌다.** 실제로 잃고 있던 것들:
   *
   * - `available_commands_update` — 보통 **세션을 열자마자** 온다. 그래서
   *   압축 버튼이 첫 턴을 돌기 전에는 안 보였다
   * - `compaction_update` — 에이전트가 **스스로** 압축하는 시점은 우리 턴과 무관하다
   * - `usage_update` — 컨텍스트가 얼마나 찼는지
   *
   * 🔴 **여기 적혀 있던 설명이 코드와 반대였다** (2026-09-28에 발견).
   * *"말과 도구 호출은 여기서 방에 심지 않는다"* 고 적혀 있었는데, 아래
   * `default:` 는 **심는다**(`idleReply`). 같은 커밋에서 글과 코드가 갈렸고,
   * 그대로 굳었다. 이 파일은 설명으로 굴러가므로 **틀린 설명은 없는 것보다
   * 나쁘다** — 읽고 «안 오는구나» 하고 딴 데를 판다.
   *
   * 실제 규칙은 이렇다: **말과 계획은 방에 심는다.** 턴 밖이라고 버리면
   * «CLI가 준 걸 우리가 숨긴» 것이 된다(§0 P5). 짝지을 응답이 없으면
   * `idleReply` 로 **새 말풍선을 만든다.**
   *
   * ★ **그래서 봇이 스스로 깨어나면 우리는 막지 않는다** — 화면에 그대로 뜬다.
   * 다만 «깨어나는가»는 어댑터에 달린 일이다(`tests/probes/selfwake.cjs` 참조).
   */
  private onIdleEvent(room: Room, bot: BotInstance, ev: AgentEvent): void {
    switch (ev.type) {
      case "commands":
        this.runtimes.bot(room.id, bot.id).commands = ev.names;
        this.emit("room", room);
        break;

      case "usage":
        this.noteUsage(room, bot.id, ev);
        void this.rooms.saveProps(room, { usage: room.usage, participants: room.participants });
        break;

      case "compaction":
        this.noteCompaction(room, bot.id, ev);
        break;

      case "mode":
        this.noteAgentMode(room, bot.id, ev.modeId);
        break;

      case "config":
        this.noteAgentConfig(room, bot.id, ev.options);
        break;

      case "unknown":
        this.opts.host.log(`[${bot.agentId}] 아직 다루지 않는 업데이트: ${ev.kind}`);
        break;

      // 🔴 **말과 계획은 방에 심는다.** 턴 밖이라고 버리면 «CLI가 준 걸 우리가
      // 숨긴» 것이 된다(§0 P5). 짝지을 응답이 없으면 **새로 만든다.**
      default: {
        const idle = this.idleReply(room, bot);
        this.applyEvent(room, idle, ev);
        this.scheduleIdleClose(room, bot, idle);
      }
    }
  }

  /**
   * ★ **무엇이 이 말을 깨웠나** (2026-09-28).
   *
   * 깨어난 봇이 **제일 먼저 하는 일은 백그라운드 결과 파일을 읽는 것**이다.
   * 그 파일 이름은 띄울 때 도구 결과에 적혀 왔다 — 양쪽에 같은 조각이 있다.
   *
   * ```
   * 띄울 때   output: "…Output is being written to: …\tasks\bxgzrpssp.output"
   * 깨어나서  paths : ["…\tasks\bxgzrpssp.output"]
   * ```
   *
   * 짚으면 **그 활동이 든 말풍선**을 찾고, 거기서 **원래 요청**까지 간다.
   * 그래서 «도중에 딴 말» 이 있어도 안 흔들린다 — 대화 순서가 아니라 **일** 을
   * 따라가기 때문이다.
   *
   * 🔴 **못 짚으면 아무것도 안 적는다.** 이 연결은 CLI 의 내부 구현(출력 파일을
   * `tasks/<id>.output` 에 쓴다)에 기대고 있어 **언제든 조용히 안 맞게 될 수**
   * 있다. 그때 틀린 곳을 가리키느니 «먼저 보낸 말»로만 두는 편이 낫다.
   */
  private traceWake(room: Room, bot: BotInstance, message: Message): void {
    const want = (message.tools ?? []).map((t) => taskIdOf(t)).find(Boolean);
    if (!want) return;

    for (let i = room.messages.length - 1; i >= 0; i--) {
      const m = room.messages[i]!;
      if (m === message || m.authorBotId !== bot.id) continue;
      const hit = (m.tools ?? []).find((t) => taskIdOf(t) === want);
      if (!hit) continue;
      message.afterToolId = hit.id;
      if (m.replyToIds?.length) message.afterIds = m.replyToIds;
      return;
    }
  }

  /**
   * ★ **턴 밖 발화도 «끝»이 있어야 한다** (2026-09-28).
   *
   * 🔴 없을 때 두 가지가 깨졌다 — 실측으로 잡았다(`tests/selfwake.mts`):
   *
   * ```
   * 상태  : streaming   ← 영영 안 내려온다
   * 미읽음: 1 → 1       ← 안 보는 방인데도 안 오른다
   * ```
   *
   * 상태가 걸리는 쪽이 더 나쁘다. `isBusy` 가 참이라 **다음 말이 줄에 서는데,
   * 줄은 턴이 끝날 때 나간다.** 끝날 턴이 없으므로 **대화가 통째로 멈춘다.**
   *
   * 미읽음 쪽은 조용한 실패다. 이건 **아무도 안 기다리던 말**이라 — 사용자가
   * 물어본 적이 없다 — 표시가 없으면 다른 방에 있다가 영영 모른다. 턴 응답은
   * «내가 물었으니 보러 간다»가 되지만 이건 아니다.
   *
   * 유예는 턴과 **같은 값**을 쓴다. 조각이 이어 오는 동안은 한 묶음이고,
   * 1.5초 조용하면 끝난 것으로 본다.
   */
  private scheduleIdleClose(room: Room, bot: BotInstance, message: Message): void {
    const bt = this.runtimes.bot(room.id, bot.id);
    clearTimeout(bt.idleClose);
    bt.idleClose = setTimeout(() => this.closeIdle(room, bot, message), TURN_TAIL_MS);
  }

  private closeIdle(room: Room, bot: BotInstance, message: Message): void {
    const bt = this.runtimes.bot(room.id, bot.id);
    bt.idleClose = undefined;
    // 그새 진짜 턴이 시작됐으면 그쪽이 주인이다 — 상태를 가로채면 안 된다
    if (bt.turn) return;
    // 다른 말풍선이 자리를 가져갔으면 이 예약은 남의 것이다 (`releaseTurn` 과 같은 이유)
    if (bt.idle?.message !== message) return;

    this.traceWake(room, bot, message);

    // 보고 있지 않은 방의 말만 안 읽은 것으로 센다 (B8 — 턴 경로와 같은 규칙)
    if (this.activeRoomId !== room.id) room.unread += 1;
    void this.rooms.saveMessage(room, message);
    void this.rooms.saveProps(room, { unread: room.unread });
    this.emit("message", room.id, message);
    if (this.runtimes.statusOf(room.id, bot.id) !== "error") this.runtimes.setStatus(room.id, "idle", bot.id);

    /*
     * ★ **올려둔 것도 여기서 본다** (2026-09-28 의 이어달리기 고리가 있던 자리).
     *
     * 🔴 **혼잣말에는 끝낼 턴이 없다.** 봇이 스스로 깨어나 말하는 동안 상태는
     * `streaming` 이고, 그동안 올려둔 글을 내보낼 «턴의 끝»이 아무 데도 없다 —
     * 사용자가 **다음 말을 보낼 때까지** 안 나간다. 여기가 그 자리다.
     */
    this.maybeFireStaged(room);
    this.maybeReleaseRoom(room.id);
  }

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

  /**
   * 턴 밖 발화를 담을 메시지 (A11).
   *
   * 잠깐 조용했다가 다시 오면 **다른 말**로 본다 — 한참 전 말풍선에 이어 붙이면
   * 시각이 거짓말을 한다.
   */
  private idleReply(room: Room, bot: BotInstance): Message {
    const bt = this.runtimes.bot(room.id, bot.id);
    const now = Date.now();
    if (bt.idle && now - bt.idle.at < IDLE_BURST_MS) {
      bt.idle.at = now;
      return bt.idle.message;
    }

    /*
     * 🔴 **여기서 «마지막으로 답한 턴»을 물려받았었다.** 그럴듯했지만 틀린다 —
     * 백그라운드가 도는 사이에 사용자가 딴 말을 하면 **그 턴으로 걸린다.**
     * 실제로 «2 더하기 2는?» 을 가리켰다.
     *
     * 이어진 자리는 **깨운 활동을 짚고 나서** `closeIdle` 이 적는다. 못 짚으면
     * 비워 둔다 — 틀린 연결은 없느니만 못하다.
     */
    const message: Message = {
      id: messageId(),
      role: "agent",
      authorBotId: bot.id,
      text: "",
      deliveredTo: [bot.id],
      createdAt: now,
    };
    bt.idle = { message, at: now };
    this.rooms.append(room, message);
    void this.rooms.saveNewMessage(room, message);
    return message;
  }

  /** 에이전트가 스스로 바꾼 모드를 따라간다 (D2) */
  private noteAgentMode(room: Room, botId: string | undefined, modeId: string): void {
    const bot = room.participants.find((b) => b.id === botId) ?? this.soleBot(room);
    if (!bot || bot.agentMode === modeId) return;
    bot.agentMode = modeId;
    void this.rooms.saveProps(room, { participants: room.participants });
    this.emit("room", room);
  }

  /** 우리가 안 시킨 설정 변경도 반영한다 (B15) */
  private noteAgentConfig(
    room: Room,
    botId: string | undefined,
    options: acp.SessionConfigOption[],
  ): void {
    const bot = room.participants.find((b) => b.id === botId) ?? this.soleBot(room);
    if (!bot) return;
    this.noteRoomConfig(room, bot, options);
    void this.rooms.saveProps(room, { participants: room.participants });
    this.emit("room", room);
  }

  /**
   * 스트리밍 중에도 응답을 디스크에 남긴다.
   *
   * 중간에 VSCode가 꺼져도 **받은 데까지는 남는다.** JSONL이라 한 줄 덧붙이기로
   * 끝나므로 대화가 길어져도 비용이 같다.
   */
  private saveThrottled(room: Room, reply: Message): void {
    // **봇마다 따로 솎는다.** 단체방에서 둘이 동시에 답하면 서로의 저장을
    // 밀어내게 되고, 그러면 한쪽 응답이 중간 저장 없이 통째로 날아갈 수 있다.
    const bt = this.runtimes.bot(room.id, reply.authorBotId ?? "");
    const now = Date.now();
    if (now - bt.lastSave < SAVE_INTERVAL_MS) return;
    bt.lastSave = now;
    void this.opts.store
      .updateMessage(room, { id: reply.id, text: reply.text })
      .catch((err) => this.opts.host.log(`중간 저장 실패: ${describe(err)}`));
  }

  /**
   * 스트리밍 중에는 발행을 솎아낸다.
   *
   * 토큰 델타마다 방 전체를 내보내면 초당 수십 번 전체 대화를 직렬화하게 된다.
   * 턴이 끝날 때 한 번 더 확실히 내보내므로 마지막 델타를 놓치지 않는다.
   */
  private emitThrottled(room: Room, message: Message): void {
    // 같은 이유로 봇마다 따로 (위)
    const bt = this.runtimes.bot(room.id, message.authorBotId ?? "");
    const now = Date.now();
    if (now - bt.lastEmit < EMIT_INTERVAL_MS) return;
    bt.lastEmit = now;
    this.emit("message", room.id, message);
  }

  /**
   * 에이전트가 한 일을 기록한다 (C3).
   *
   * **같은 `toolCallId`로 여러 번 온다** — `pending` → `in_progress` → `completed`.
   * 합쳐서 하나로 두고 상태만 갱신한다.
   *
   * 기록이 없으면 *"무슨 명령이 돌았나"* 를 알 방법이 승인 기록(D3)뿐인데,
   * 그러면 **자동 승인된 것들만 골라서 흔적이 없어진다.**
   */
  private recordActivity(
    room: Room,
    reply: Message,
    ev: Extract<AgentEvent, { type: "tool" }>,
  ): void {
    const tools = (reply.tools ??= []);
    const status = ev.status as ToolActivity["status"];
    const at = tools.findIndex((t) => t.id === ev.toolCallId);

    /*
     * ★ **우리 도구는 이름을 우리가 단다** (사용자, 2026-10-15): *"title같게
     * 안맞아서 알약이 길고"* — Antigravity 는 `ai-in-one_say` 를 그대로 쓰고,
     * Claude 는 `mcp__ai-in-one__say` 를 쓴다. 둘 다 **서버 이름이 군더더기**다 —
     * 읽는 사람은 «무엇을 했나»만 알면 된다.
     *
     * 저쪽 이름을 긁지 않는 까닭: **우리 것인지 알아본 뒤에만** 갈아끼운다
     * (`mcpIdentity`). 모르면 저쪽 이름 그대로 — 넘겨짚지 않는다.
     */
    const mine = ev.mcp?.server === OUR_MCP_NAME
      ? (OUR_TOOL_LABEL[ev.mcp.tool] ?? ev.mcp.tool)
      : undefined;

    /*
     * ★ **결과도 우리 것을 붙인다** — 끝났을 때 한 번만.
     * 저쪽이 실어 보낸 자리표시 글보다 **진짜 답**이 낫다.
     */
    const done = ev.status === "completed" || ev.status === "failed";
    const ourOut = mine && done && ev.mcp
      ? this.ourOut.get(`${room.id}:${reply.authorBotId}:${ev.mcp.tool}`)?.shift()
      : undefined;

    const next: ToolActivity = {
      id: ev.toolCallId,
      // 갱신 이벤트는 제목을 안 줄 수도 있다. 먼저 온 걸 지키자.
      title: mine || ev.title || tools[at]?.title || "도구 사용",
      ...(ev.kind ? { kind: ev.kind } : tools[at]?.kind ? { kind: tools[at]!.kind! } : {}),
      status,
      ...(ev.paths.length > 0 ? { paths: ev.paths } : tools[at]?.paths ? { paths: tools[at]!.paths! } : {}),
      // **명령은 첫 이벤트에만 실려 온다** — 갱신에는 없으니 들고 있던 걸 지킨다
      ...(ev.command ? { command: ev.command } : tools[at]?.command ? { command: tools[at]!.command! } : {}),
      // 결과는 **나중에** 온다 (갱신). 오면 갈아 끼우고, 없으면 있던 걸 지킨다.
      ...(ourOut
        ? { output: ourOut }
        : ev.output
          ? { output: ev.output }
          : tools[at]?.output
            ? { output: tools[at]!.output! }
            : {}),
      // 언제 시작했나. 타임라인으로 읽으려면 시각이 있어야 한다
      ...(tools[at]?.at ? { at: tools[at]!.at! } : { at: Date.now() }),
      // **글의 어디쯤이었나.** 처음 본 시점을 지킨다 — 갱신 때 옮기면 순서가 흐트러진다
      ...(tools[at]?.textAt !== undefined
        ? { textAt: tools[at]!.textAt! }
        : { textAt: reply.text.length }),
    };

    if (at >= 0) tools[at] = next;
    else tools.push(next);

    // **막힌 수정**은 diff가 안 오므로 여기서만 볼 수 있다 (§4.3)
    if (next.status === "failed") this.noteBlocked(room, reply, next);
  }

  /**
   * 파일 변경을 기록한다 (E2). 전문은 blob으로 빼고 해시만 남긴다 (E6).
   *
   * 같은 파일을 여러 번 고치면 **최종 상태 하나로 합친다** — 카드가 중복으로 쌓이면
   * 무엇이 최종인지 알 수 없다.
   */
  private recordDiff(
    room: Room,
    reply: Message,
    ev: Extract<AgentEvent, { type: "diff" }>,
  ): void {
    const store = this.opts.store;
    const files = (reply.files ??= []);
    const existing = files.find((f) => f.path === ev.path);
    const change: FileChange = existing ?? {
      path: ev.path,
      kind: ev.oldText === null ? "create" : "edit",
      // **누가 고쳤나** (v2.0). 메시지의 `authorBotId`로도 알 수 있지만, 파일
      // 카드는 메시지 밖으로 새어 나갈 수 있는 것이라(diff·검색) 자기 자리에
      // 들고 있어야 한다.
      ...(reply.authorBotId ? { byBotId: reply.authorBotId } : {}),
    };
    if (!existing) files.push(change);

    // 다른 봇이 **지금 같은 파일을 고치는 중**이면 말해준다 (§4.3)
    this.noteClash(room, reply, ev.path);

    // 줄 수는 즉시 계산해 카드에 바로 보여준다
    const counts = countChangedLines(ev.oldText ?? "", ev.newText);
    change.added = counts.added;
    change.removed = counts.removed;

    /*
     * blob 쓰기는 비동기다. 턴 끝에서 기다리기는 하지만(`runQueue`),
     * ★ **끝나면 스스로 적는다.**
     *
     * 🔴 기다리기만 하면 **기다릴 사람이 없어지는 순간 날아간다** — 에이전트가
     * 죽거나, 창을 닫거나, 턴이 예외로 끊기면 해시가 빈 채로 남는다. 그러면
     * blob은 디스크에 멀쩡히 있는데 **가리킬 번호가 없어** diff를 영영 못 본다.
     *
     * 트랜스크립트는 JSONL 병합이라 **같은 메시지에 한 줄 더 붙이면 그만**이다.
     * 그래서 «턴이 기다려주면 빠르고, 못 기다려줘도 잃지 않는» 모양이 된다.
     */
    const write = (async () => {
      if (ev.oldText !== null && !change.oldSha256) {
        change.oldSha256 = await store.putBlob(ev.oldText);
      }
      change.newSha256 = await store.putBlob(ev.newText);
      await this.rooms.saveMessage(room, { id: reply.id, files: reply.files });
    })().catch((err) => this.opts.host.log(`blob 저장 실패: ${describe(err)}`));

    if (reply.authorBotId) this.runtimes.bot(room.id, reply.authorBotId).pendingWrites.push(write);
  }

  /**
   * ★ **두 봇이 같은 파일을 동시에 고쳤다** (§4.3).
   *
   * 턴은 봇 단위로만 직렬이고 **방 단위로는 병렬**이다. 그래서 «둘 다 이거
   * 고쳐줘»가 그대로 통하는데, 같은 파일이면 **나중에 끝난 쪽이 앞의 변경을
   * 통째로 덮어쓴다** — 에이전트는 자기가 읽은 시점의 내용을 기준으로 쓰기
   * 때문이다. 조용히 지나가면 사용자는 **한쪽 작업이 사라진 줄도 모른다.**
   *
   * 🔴 **막지 않는다.** 우리는 연결·전달 서비스고, 어느 쪽을 살릴지는 사용자가
   * 안다. 우리가 할 일은 **일어났다고 적는 것**이다 — 그래야 git으로 되살리든
   * 한쪽을 다시 시키든 할 수 있다.
   *
   * **지금 도는 턴만 본다.** 앞 봇이 이미 끝났으면 뒤 봇은 그 결과를 읽고
   * 고친 것이라 충돌이 아니다 — 그것까지 경고하면 «순서대로 시킨 일»마다
   * 경고가 뜬다.
   */
  private noteClash(room: Room, reply: Message, filePath: string): void {
    const mine = reply.authorBotId;
    if (!mine || !hasManyBots(room)) return;
    const rt = this.runtimes.get(room.id);
    if (!rt) return;

    const others: string[] = [];
    for (const [id, bt] of rt.bots) {
      if (id === mine || !bt.turn) continue;
      /*
       * 🔴 **`bt.turn`만 보면 안 된다.** 응답이 온 뒤에도 `TURN_TAIL_MS`(1.5초)
       * 동안 자리를 붙들고 있다 — 늦게 오는 조각을 그 턴의 말로 받으려고
       * 일부러 둔 유예다(`scheduleRelease`). 그걸 «도는 중»으로 읽으면
       * **순서대로 시킨 일**에도 경고가 뜬다. 실제로 그렇게 나왔다.
       *
       * 실제로 도는지는 상태가 말한다.
       */
      if (isBusy(this.runtimes.statusOf(room.id, id)) !== true) continue;
      const touched = (bt.turn.files ?? []).some(
        (f) => f.path === filePath && f.kind !== "read",
      );
      if (touched) others.push(id);
    }
    if (others.length === 0) return;

    const who = [mine, ...others].sort();
    const had = rt.clashes.get(filePath);
    // 봇 짝이 그대로면 그냥 둔다 — 같은 파일로 몇 번이고 다시 알릴 일이 아니다
    if (had && had.botIds.join(",") === who.join(",")) return;
    rt.clashes.set(filePath, {
      ...(had ?? {}),
      path: filePath,
      botIds: who,
      at: had?.at ?? Date.now(),
    });
    this.emitClashes(room.id);
  }

  /**
   * ★ **에이전트가 «막혔다»고 신고했다** (§4.3 · 2026-09-22 실측).
   *
   * 여기가 `noteClash` 와 갈리는 자리다:
   *
   * ```
   * noteClash    diff 두 개가 같은 파일에 왔다        → **정황**
   * noteBlocked  tool_call 이 failed 로 돌아왔다      → **사실**
   * ```
   *
   * 🔴 **정황만으로는 이 경우를 아예 못 본다.** 막힌 수정은 **아무것도 안 쓰므로
   * diff가 안 온다** — 그래서 `noteClash` 의 «둘 다 이 파일을 만졌다» 조건에
   * 영영 걸리지 않는다. 정작 사용자가 알아야 할 쪽이 안 보였던 것이다.
   *
   * 사유 글로 판별하지 않는다 — 영어고 버전 따라 바뀐다. **실패 + 그 파일을
   * 지금 만지는 다른 봇**이면 충분하고, 문구는 **보여줄 때만** 쓴다.
   */
  private noteBlocked(room: Room, reply: Message, act: ToolActivity): void {
    const mine = reply.authorBotId;
    if (!mine || !hasManyBots(room)) return;
    const rt = this.runtimes.get(room.id);
    if (!rt) return;
    const paths = act.paths ?? [];
    if (paths.length === 0) return;

    for (const filePath of paths) {
      // 그 파일을 **지금 도는 다른 봇**이 건드렸나 — `noteClash` 와 같은 잣대
      const others: string[] = [];
      for (const [id, bt] of rt.bots) {
        if (id === mine || !bt.turn) continue;
        if (isBusy(this.runtimes.statusOf(room.id, id)) !== true) continue;
        const touched = (bt.turn.files ?? []).some(
          (f) => f.path === filePath && f.kind !== "read",
        );
        if (touched) others.push(id);
      }
      if (others.length === 0) continue;

      const who = [mine, ...others].sort();
      const had = rt.clashes.get(filePath);
      const state: ClashState = {
        ...(had ?? {}),
        path: filePath,
        botIds: who,
        blocked: true,
        blockedBotId: mine,
        ...(act.output ? { reason: act.output } : {}),
        at: had?.at ?? Date.now(),
      };
      rt.clashes.set(filePath, state);
      this.emitClashes(room.id);

      /*
       * 기록은 **사실일 때만** 남긴다.
       *
       * 🔴 예전에는 **정황**에도 시스템 메시지를 적었다 — 그것도 «덮어쓸 수
       * 있습니다»라는 **틀린 말**로. 자리가 안 겹치면 아무 일도 안 일어나는데
       * 사용자는 그 말을 믿고 멀쩡한 작업을 다시 시킬 수 있었다.
       * 정황은 이제 **띠로만** 보이고, 대화에는 진짜 막혔을 때만 남는다.
       */
      if (state.noted) continue;
      state.noted = true;
      const name = (id: string) =>
        room.participants.find((b) => b.id === id)?.name ?? id;
      const note: Message = {
        id: messageId(),
        role: "system",
        text:
          `${name(mine)}의 수정이 거부됐습니다 — ${filePath}. ` +
          `${others.map(name).join("·")}가 먼저 바꿔서, 다시 읽고 시도합니다.`,
        // **둘 다의 이야기다** — 한쪽 뷰에만 두면 «왜 막혔지»의 답이 반쪽이 된다
        aboutBotIds: who,
        deliveredTo: [],
        createdAt: Date.now(),
      };
      this.rooms.append(room, note);
      void this.rooms.saveNewMessage(room, note);
    }
  }

  /**
   * 그 방에서 **살아 있는** 부딪힘만 — 방을 새로 열었을 때도 실어 보낸다.
   *
   * 「살아 있다」 = **그 봇들 중 둘 이상이 아직 도는 중**. 하나만 남으면 부딪힐
   * 상대가 없으니 끝난 것이다. 이 잣대 덕에 따로 걷어낼 필요가 없다.
   */
  clashesIn(roomId: string): Clash[] {
    const rt = this.runtimes.get(roomId);
    if (!rt) return [];
    const live: Clash[] = [];
    for (const [path, c] of rt.clashes) {
      const busy = c.botIds.filter(
        (id) => isBusy(this.runtimes.statusOf(roomId, id)) === true,
      );
      if (busy.length < 2) continue;
      const { noted: _drop, ...rest } = c;
      live.push({ ...rest, path });
    }
    return live;
  }

  private emitClashes(roomId: string): void {
    this.emit("clashes", roomId, this.clashesIn(roomId));
  }

  /**
   * 보낼 프롬프트를 만든다.
   *
   * **역할(B3)은 첫 프롬프트 앞에 프리픽스로 붙인다.** ACP `session/new`에는
   * 시스템 프롬프트 파라미터가 없고, 별도 턴으로 보내면 어색한 첫 응답이 생긴다.
   */
  private async buildPrompt(
    room: Room,
    bot: BotInstance,
    bt: BotRuntime,
    batch: Message[],
  ): Promise<acp.ContentBlock[]> {
    const body = batch.map((m) => m.text).join("\n");
    const parts: string[] = [];

    if (bot.rolePrompt && !bt.roleInjected) {
      parts.push(bot.rolePrompt.trim(), "---");
      bt.roleInjected = true;
    }
    /*
     * ★ **명단은 «표에 적히는 것이 바뀌면» 다시 나간다** (v3.0 4-K).
     *
     * 지은 글을 그대로 비교한다 — 이름 · 설명 · 구성 · 릴레이 토글 중 무엇이
     * 바뀌어도 글이 달라지고, 안 바뀌면 **아무것도 안 나간다.**
     *
     * 🔴 **차분을 보내지 않는다.** «베타가 나갔습니다» 한 줄은 싸 보이지만
     * 모델이 머릿속에서 합쳐야 하고, **틀려도 우리가 못 본다.** 전체를 다시
     * 보내면 마지막 글이 곧 지금 상태다.
     *
     * 🔴 **역할보다 뒤**다. 역할은 «너는 누구인가»고 명단은 «방이 어떻게
     * 생겼나»라, 순서가 뒤집히면 지시가 상태에 묻힌다.
     */
    const roster = rosterText(room, bot);
    if (roster !== (bt.rosterSent ?? undefined)) {
      /*
       * **처음부터 꺼진 방에는 아무것도 안 보낸다** — 봇은 누가 있는지도
       * 모른다(§7). «못 겁니다»는 **켜져 있다가 꺼졌을 때만** 뜻이 있다.
       */
      const first = bt.rosterSent === undefined;
      // 꺼진 방의 명단은 `"relay":"off"` 를 달고 온다 — 그게 «못 겁니다» 다
      const isOff = roster.includes('"relay":"off"');
      if (roster && !(first && isOff)) parts.push(roster);
      bt.rosterSent = roster;
    }
    // 끊긴 맥락을 되먹인다 (F7). **역할보다 뒤, 실제 요청보다 앞.**
    if (bot.refeedPending) {
      const history = transcriptText(room, bot, batch, bot.refeedKind);
      if (history) {
        parts.push(
          // **줄여 보냈다는 걸 말해준다.** 모르면 «[중략]»을 만난 에이전트가
          // 빈자리를 넘겨짚는다 — 알면 되물을 수 있다.
          "[이전 대화 기록] 세션이 초기화되어 지금까지의 대화를 다시 전달합니다. " +
            "길이를 줄이려고 오래된 메시지는 가운데를 접었습니다(`…[중략 N자]…`). " +
            "그 부분이 필요하면 넘겨짚지 말고 물어보세요.",
          history,
          "[기록 끝] 위는 참고용 맥락입니다. 아래가 지금 요청입니다.",
        );
      }
      delete bot.refeedPending;
      rollUpLost(room);
      void this.rooms.saveProps(room, { participants: room.participants, refeedPending: room.refeedPending });
    }
    /*
     * ★ **끊긴 자리를 설명한다** (전체 중지).
     *
     * 🔴 안 적으면 모델이 **지어낸다.** 같은 실험 두 판에서 한 번은 «백그라운드로
     * 실행했지만 결과를 확인 못 했고»(맞음), 한 번은 «거부돼서 실행되지
     * 않았습니다»(틀림)라고 했다 — `session/cancel` 이 **«왜»를 안 남기기**
     * 때문이다. 지어낸 것이 «권한이 막혔다»면 우회를 시도한다.
     *
     * **역할·되먹임보다 뒤, 실제 요청보다 앞**이다 — 방금 일어난 일이므로.
     */
    if (bt.interrupted) {
      parts.push(
        "[사용자가 진행 중이던 작업을 중단했습니다. 권한 거부나 오류가 아닙니다. " +
          "하던 일은 거기서 멈춘 것이고, 아래가 새 요청입니다. " +
          "필요하면 멈춘 지점을 언급해도 됩니다.]",
      );
      delete bt.interrupted;
    }
    if (bot.answerPolicy === "auto") {
      parts.push(
        "[사용자가 자리에 없습니다. 묻지 말고 스스로 판단해 진행하세요.]",
      );
    }
    /*
     * ★ **큐 알림은 프롬프트에 얹혀 간다** (v3.0 4-J).
     *
     * 🔴 **따로 턴을 쓰지 않는다.** «확인할 것이 있다» 한 줄을 전하려고 모델을
     * 깨우면, 사용자가 말을 건 턴과 **합쳐서 한 번** 갈 수 있는 것을 두 번 쓴다.
     *
     * 🔴 **이 줄은 우리가 하는 말이다.** 프롬프트에 섞여 들어가는 글의 기본값은
     * «사용자가 한 말»이라, 서버 이름을 앞에 안 대면 모델이 **사용자 지시로
     * 읽는다.**
     */
    const others = room.participants.some((b) => b.id !== bot.id);
    const relayOn = others && (room.relay ?? DEFAULT_RELAY) !== "off";
    const waiting = this.queue.shareLeft(bot.id);

    /*
     * ★ **구조로 적는다 — 산문이 아니라** (2026-10-13).
     *
     * 🔴 **프롬프트에 섞여 들어가는 산문의 기본값은 «사용자가 한 말»이다.**
     * 길게 쓸수록 그렇게 읽힌다 — 막으려던 바로 그것이다. JSON 은 **우리
     * 도구 결과와 같은 말투**라(`{"kind":…,"use":…}`) 같은 데서 온 것으로
     * 읽히고, 사람 말로는 안 읽힌다.
     *
     * ★ **빈 것도 모양이 같다** — `do` 는 할 일이 없으면 `null` 이다.
     * 칸이 사라지면 «빠뜨린 건가»가 생기고, 그건 `check_queue` 의 `use`·
     * `item` 을 `null` 로 남긴 것과 같은 줄이다.
     *
     * ★ **«쓸 수 있나»를 그대로 적는다.** 전에는 «가능» 만 적고 «없으면 못
     * 쓴다»를 도구 설명에 규칙으로 박았는데, **적혀 있으면 규칙을 안 외워도
     * 된다.** 그리고 이 줄은 매 턴 새로 나가므로 설명처럼 굳지 않는다.
     *
     * 🔴 **`do` 는 남긴다.** 깨우는 줄이 행동을 끌어내는 것은 **실측으로
     * 확인된 부분**이다(`probes/agysay.mts`). 순수 데이터로만 두면 읽고
     * 아무것도 안 할 수 있고, 그건 안 재봤다.
     */
    const flag: Record<string, unknown> = {};
    // 릴레이가 꺼진 방에서는 `say` 자체가 없는 일이라 **그 칸을 안 만든다**
    // ⏪ `say_id_0` 이었다 — 「0」이 없어졌으므로 이름도 같이 간다
    if (relayOn) flag["null_id"] = bt.fromUser ? "valid" : "invalid";
    /*
     * ★ **이 말을 같이 받은 봇** (사용자, 2026-10-15).
     *
     * 🔴 **사용자가 둘에게 한 말도 각자에게는 «나한테 온 말»로 보인다.**
     * 사용자: *"봇1이 봇2한테 명령을 한 전적이 있을때 봇2한테 다시
     * 전달하더라고?"* — 받은 봇이 친절하게 옮기면 같은 지시가 두 번 가고,
     * 상대는 두 번 일한다. 그리고 그 두 번째는 **우리 상한(4-L)을 한 칸
     * 쓰면서** 간다.
     *
     * 큐 항목의 `also_got` 과 **같은 이름, 같은 뜻**이다 — 한 낱말이 두 군데서
     * 다르게 읽히면 규칙을 두 번 외워야 한다.
     *
     * ⚠️ 깨어난 턴에는 `batch` 가 비어 있다 — 그러면 이 칸도 빈 배열이고,
     * 그게 맞다(«사용자 말이 없다»).
     */
    /*
     * ★ **사용자 말이 있을 때만 싫는다** (사용자의 글, 2026-10-15).
     * 깨어난 턴에는 사용자가 한 말이 없어서 «같이 받은 이» 도 없다 —
     * 빈 배열을 실으면 «나한테만 왔다» 로 읽힐 거리가 아예 없는 것을
     * 있는 것처럼 말하는 꼴이다.
     */
    if (relayOn && batch.length > 0) {
      const mates = new Set<string>();
      for (const m of batch) {
        for (const id of m.deliveredTo ?? []) {
          if (id === bot.id) continue;
          const other = room.participants.find((b) => b.id === id);
          if (other) mates.add(other.name);
        }
      }
      flag["also_got"] = [...mates];
    }
    if (relayOn || waiting > 0) {
      /*
       * ★ **`check_queue` 와 같은 이름을 쓴다** (사용자, 2026-10-15):
       * *"queue_left랑 의미가 통하지 않아?"* — 통한다. 둘 다
       * **«아직 안 끝낸 나머지»** 라, 턴 시작 2 → 꺼내면 1 → 0 으로
       * 이어진다. 깃발은 **아무것도 건네기 전**이라 포함할 «현재 객체»가
       * 없다 — 한 낱말이 두 수를 가리키는 것이 아니다.
       */
      flag["queue_left"] = waiting;
      flag["do"] = waiting > 0 ? "check_queue" : null;
      parts.push(`[${OUR_MCP_NAME}] ${JSON.stringify(flag)}`);
    }

    // 알림만으로 깨어난 턴에는 **사용자의 말이 없다** — 빈 줄을 안 밀어 넣는다
    if (body) parts.push(body);

    const blocks: acp.ContentBlock[] = [{ type: "text", text: parts.join("\n\n") }];
    for (const m of batch) {
      for (const a of m.attachments ?? []) {
        const block = await this.toContentBlock(room, bot, a);
        if (block) blocks.push(block);
      }
    }
    return blocks;
  }

  /**
   * 첨부를 ACP 블록으로 만든다 (I4).
   *
   * **워크스페이스 안 파일은 내용을 싣지 않고 경로만 준다.** 에이전트가
   * `fs/read_text_file`로 직접 읽는데, 그게 우리 핸들러를 타서 **미저장 버퍼까지
   * 반영**된다. 토큰도 아끼고 정확도도 높다.
   */
  private async toContentBlock(
    room: Room,
    bot: BotInstance,
    a: Attachment,
  ): Promise<acp.ContentBlock | null> {
    // **경로로 갈지 내용으로 갈지는 한 곳에서 정한다** (I4). 셸도 같은 함수를 보고
    // blob에 담을지 정하므로, 규칙이 갈리면 기록이 실제와 어긋난다.
    if (!sendsContent(a, room.cwd)) {
      return { type: "resource_link", uri: `file://${a.path}`, name: a.name };
    }

    // 보내봐야 받지 못하는 종류는 애초에 보내지 않는다 (I5).
    // 스펙이 못 박는다 — *"The Client MUST adapt its interface
    // according to PromptCapabilities"*.
    const caps = this.connection(bot.agentId).promptCapabilities();

    if (a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/")) {
      const kind = a.mimeType.startsWith("image/") ? "image" : "audio";
      if (!caps[kind]) {
        this.notifyUnsupported(room, a, kind === "image" ? "이미지" : "오디오");
        return null;
      }
      const buf = await this.opts.store.getBlob(a.sha256);
      if (!buf) return null;
      return kind === "image"
        ? { type: "image", data: buf.toString("base64"), mimeType: a.mimeType }
        : { type: "audio", data: buf.toString("base64"), mimeType: a.mimeType };
    }

    // 붙여넣은 로그, 워크스페이스 밖 파일 — 에이전트가 접근할 수 없으니 실어 보낸다
    if (!caps.embeddedContext) {
      this.notifyUnsupported(room, a, "파일 내용 첨부");
      return null;
    }
    const text = await this.opts.store.getBlobText(a.sha256);
    if (text === null) return null;
    return {
      type: "resource",
      resource: { uri: a.path ? `file://${a.path}` : `blob:${a.sha256}`, text },
    };
  }

  /** 첨부를 조용히 버리지 않는다 — 보냈다고 생각하고 기다리면 안 된다 */
  private notifyUnsupported(room: Room, a: Attachment, kind: string): void {
    // 🔴 **이건 정보 손실 통보다.** 사라지면 사용자는 보낸 줄 알고 기다린다.
    this.rooms.noteRoom(
      room,
      `${room.participants[0]?.name ?? "에이전트"}는 ${kind}를 받지 못해 ` +
        `«${a.name}»을 보내지 않았습니다.`,
    );
  }

  /**
   * 쓸 수 있는 세션을 확보한다.
   *
   * **저장된 세션에 다시 붙는 것을 먼저 시도한다 (F7).** 에이전트 CLI가 세션을
   * 디스크에 남기므로, VSCode를 껐다 켜도 원래 세션으로 돌아가면 계획·메모리·
   * 도구 이력까지 살아난다. 새로 만들면 대화 텍스트조차 모르는 상태가 된다.
   */
  private async ensureSession(room: Room, bot: BotInstance): Promise<string> {
    const bt = this.runtimes.bot(room.id, bot.id);
    if (bt.sessionId) return bt.sessionId;

    const conn = this.connection(bot.agentId);

    /*
     * 🔴 **말을 안 건 세션은 이어받으려 하지 않는다** (2026-10-02).
     *
     * 에이전트는 **첫 프롬프트를 받아야** 세션을 디스크에 남긴다
     * (§13.1 실측). 그래서 만들기만 하고 말은 안 건 세션은 **없어진 게
     * 아니라 처음부터 없고**, 이어받기는 반드시 실패한다.
     *
     * ⏪ 아래에 이미 같은 생각으로 막은 줄이 있었는데 **눈금이 한 칸
     * 어긋났다** — «방에 말이 있나» 로 보고 있었다. 그런데 말을 건
     * 것은 **봇마다** 다르다. Claude 가 떠든 방에 Codex 를 불러놓고
     * 안 시켰으면, 방엔 말이 있지만 **그 봇의 세션은 비어 있다.**
     * 그때 사용자가 본 것이 이것이다:
     *
     * ```
     * 아직 이어받을 수 없습니다 — Internal error —
     * no rollout found for thread id 01a0fb40-…
     * ```
     *
     * 우리가 지운 게 아니다. **쓴 적이 없어 써지지 않은 것**을 달라고
     * 한 것이다. 지우는 쪽(`deleteSession`)은 이미 봇 단위로 보고 있었다
     * (`sessionPrompted`) — 이어받는 쪽만 안 보고 있었다.
     */
    if (bot.sessionId && !bot.sessionPrompted) {
      bot.sessionId = null;
    }

    /** 이어받기가 실패했을 때 들고 있는 줄 — **새 세션이 열려야** 적는다 */
    let lostNote: string | undefined;

    if (bot.sessionId) {
      const resumed = await conn.resumeSession(bot.sessionId, room.cwd, this.mcpFor(room, bot));
      if (resumed.ok) {
        bt.sessionId = bot.sessionId;
        // 복구된 세션은 역할을 이미 알고 있다
        bt.roleInjected = true;
        // **이 방이 지금 어떤 모드·모델인지는 복구 응답에만 있다.**
        // 다만 사용자가 고른 값은 우리 기록이 우선이다 — 먼저 되살린다.
        if (resumed.options.length > 0) {
          await this.restoreChoices(room, bot, bot.sessionId, resumed.options);
        }
        this.watchIdle(room, bot, bot.sessionId);

        /*
         * ★ **잃었다고 표시해둔 그 세션에 다시 붙었으면 표시를 걷는다.**
         *
         * 🔴 복구 실패는 일시적일 수 있어서 `contextLost`를 디스크에 남긴다.
         * 그런데 나중에 **저절로 붙었을 때** 그걸 지우는 코드가 없었다 —
         * «다시 시도»를 눌렀을 때만(`retryResume`) 지웠다. 그래서 한 번 실패한
         * 방은 **다시 붙은 뒤에도** *"에이전트는 위 대화를 모릅니다"* 를 달고
         * 있었다. 실제로는 알고 있는데.
         *
         * 되먹임 약속도 함께 거둔다 — 세션이 이미 아는 대화를 글로 또 밀어넣으면
         * 돈만 쓴다.
         */
        if (bot.lostSessionId === bot.sessionId || bot.contextLost) {
          const promised = bot.refeedPending === true;
          delete bot.contextLost;
          delete bot.lostSessionId;
          delete bot.refeedPending;
          rollUpLost(room);
          await this.rooms.saveProps(room, {
            // 방 값은 **요약**이다 — 봇들에서 굴려 올린 것을 그대로 쓴다
            contextLost: room.contextLost,
            lostSessionId: room.lostSessionId,
            refeedPending: room.refeedPending,
          });
          /*
           * ★ **기록에 안 남긴다** (2026-10-13).
           *
           * 여기가 `noteRoom` 이었다 — 디스크에 적히는 **진짜 메시지**라 다음에
           * 열어도 그 자리에 있다. 그런데 **다시 붙은 것은 일이 아니다** —
           * 원래대로 돌아갔다는 말일 뿐이고, 남겨두면 나중에 읽는 사람은
           * «무슨 일이 있었나» 가 된다. 배너가 사라지는 것이 이미 답이다.
           *
           * 사용자: *"완전 모델 변경, 에이전트 변경, 이름 변경, 완전 새 세션,
           * 봇 추가 이런거 아니면 안나와도 될듯, fix에서 인지 가능하니까"*.
           */
          this.emit(
            "notice",
            room.id,
            promised
              ? "이전 세션에 다시 붙었습니다 — 대화를 글로 옮길 필요가 없어졌습니다."
              : "이전 세션에 다시 붙었습니다.",
          );
          this.emit("room", room);
        }
        return bot.sessionId;
      }
      // 복구 실패는 정상 경로다. 새로 열고 **말해준다** —
      // 기록을 되먹이는 건 아직 안 한다(미구현).
      //
      // 🔴 **잃을 게 있을 때만 말한다.** 에이전트는 첫 프롬프트를 받아야 세션을
      // 디스크에 남긴다(§13.1 실측). 그래서 «만들고 말은 안 건» 방의 세션은
      // 없어진 게 아니라 **처음부터 없었고**, 복구는 반드시 실패한다. 방을 열
      // 때마다 세션을 붙이므로(B1) 그대로 두면 **빈 방을 열 때마다**
      // *"맥락이 빠질 수 있습니다"* 가 쌓인다 — 빠질 맥락이 없는데.
      if (room.messages.some((m) => m.role !== "system")) {
        const known = await conn.listSessions(room.cwd);
        const gone = known !== null && !known.includes(bot.sessionId);
        const head = gone
          ? "이전 세션이 에이전트에서 사라졌습니다."
          : "이전 세션을 이어받지 못했습니다.";
        /*
         * ★ **못 이어받은 자리에서는 안 적는다** (2026-10-13).
         *
         * 🔴 여기서 바로 기록에 박았다. 그런데 바로 아래 `newSession` 이
         * **같은 까닭으로 또 실패할 때** — 로그인이 풀렸으면 둘 다 안 된다 —
         * **새 세션도 없는데 「여기서부터는 새 세션입니다」 가 쌓인다.** 방을
         * 열 때마다 한 줄씩 늘어난다. 실제로 다섯 줄을 받았다:
         *
         * ```
         * 이전 세션을 이어받지 못했습니다. … — Authentication required
         * 이전 세션을 이어받지 못했습니다. … — Authentication required
         * …
         * ```
         *
         * **붙다가 걸린 것은 화면이 말한다** — 붙는 화면과 `fix` 가 «로그인이
         * 필요합니다» 를 봇마다 세워준다(4.5-T). 기록에 남길 것은 **정말로
         * 바뀐 것**뿐이다. 그래서 여기서는 **들고만 있고**, 아래에서 새 세션이
         * 진짜로 열렸을 때 한 번 적는다 — 그때서야 「새 세션」 이 참말이 된다.
         */
        lostNote = `${head} 여기서부터는 새 세션입니다. — ${resumed.reason}`;

        // **화면과 에이전트가 어긋났다.** 사용자가 고를 때까지 들고 있는다.
        bot.contextLost = true;
        bot.lostSessionId = bot.sessionId ?? undefined;
        rollUpLost(room);
        await this.rooms.saveProps(room, { contextLost: true, lostSessionId: bot.sessionId });
        this.emit("room", room);
      }
    }

    /*
     * 🔴 **한도를 건다** — 안 그러면 저쪽이 답을 안 할 때 영영 기다린다.
     * 띄우는 값은 `startAgent` 가 이미 치렀으므로 여기는 **세션만** 잰다.
     */
    const { sessionId, configOptions } = await withTimeout(
      conn.newSession(room.cwd, this.mcpFor(room, bot)),
      SESSION_MS,
      `${this.agentOrThrow(bot.agentId).label}의 세션이 ` +
        `${Math.round(SESSION_MS / 1000)}초 안에 열리지 않았습니다.`,
    );
    bt.sessionId = sessionId;
    /*
     * ★ **열쇠를 이 세션에 맨다** (2026-10-15). 내줄 때는 세션 id 가 없었다 —
     * `session/new` 의 **인자로** 나가므로 답이 와야 알았다. 매어두면 그
     * 세션이 바뀔 때 **그 열쇠만** 거둘 수 있다.
     */
    this.opts.mcp?.tie(`${room.id}:${bot.id}`, sessionId);
    this.pointAt(bot, sessionId);
    /*
     * ★ **여기가 「새 세션」 이 참말이 되는 자리다** (2026-10-13).
     *
     * 위에서 이어받기가 실패했고, 그 뒤 `newSession` 이 **정말로 열렸을 때**만
     * 한 번 적는다. 중간에 터졌으면 이 줄은 안 쌓인다 — 거기까지 오지도 않고
     * `joinFail` 로 빠지므로 화면이 대신 말한다.
     *
     * 🔴 **왜인지도 같이 적는다** (§0 원칙). 이유가 출력 채널에만 있으면
     * 대부분은 안 열어보고, 그러면 «우리가 끊었나»로 남는다.
     */
    if (lostNote) {
      const note: Message = {
        id: messageId(),
        role: "system",
        text: lostNote,
        deliveredTo: [],
        createdAt: Date.now(),
      };
      this.rooms.append(room, note);
      void this.rooms.saveNewMessage(room, note);
      this.emit("room", room);
    }
    // 세션이 새로 열렸으므로 역할을 다시 넣어야 한다
    bt.roleInjected = false;
    delete bt.rosterSent;
    // 새 세션이면 에이전트 기본값으로 시작한다 — 고른 것들을 다시 넣어준다
    if (configOptions.length > 0) await this.restoreChoices(room, bot, sessionId, configOptions);
    this.watchIdle(room, bot, sessionId);

    await this.rooms.saveProps(room, {
      participants: room.participants,
      ...(room.contextLost ? { contextLost: true } : {}),
    });
    return sessionId;
  }

  /**
   * 끊긴 맥락을 어떻게 할지 정한다 (F7).
   *
   * `true`면 **다음 메시지에** 지금까지의 대화를 함께 보낸다. 별도 턴을 쓰지
   * 않으므로 «이어가기»를 눌러도 화면에서는 아무 일도 안 일어난다 — 배너가
   * *"다음 메시지에 함께 전달됩니다"* 로 바뀌는 것이 피드백이다.
   *
   * `false`면 그냥 새 대화처럼 간다. **다시 묻지 않는다.**
   */
  async decideRefeed(roomId: string, accept: boolean, kind?: "log" | "summary"): Promise<void> {
    const room = await this.rooms.openRoom(roomId);
    /*
     * ★ **맥락을 잃은 봇들에게만** 건다 (B1).
     *
     * 🔴 방에 하나로 두었더니 **먼저 말을 거는 봇이 남의 되먹임을 먹었다** —
     * 알파가 잃은 맥락이 베타에게 들어가고, 한 번 쓰이면 꺼지므로 정작
     * 알파는 못 받았다. 실측으로 확인한 자리다.
     */
    const lost = room.participants.filter((b) => b.contextLost);
    for (const b of (lost.length > 0 ? lost : room.participants)) {
      delete b.contextLost;
      /*
       * 🔴 **놓는 것과 두고 오는 것은 다르다** (2026-10-07).
       *
       * 사용자가 물었다 — *"대화 도중에 에이전트 바꾸면 이전
       * 에이전트에 물려있던 세션은 자동으로 삭제되나?"*. 안 됐었다.
       *
       * 갈아탈 때는 `cancel` 만 하고 **되돌릴 수 있게** 남겨두었는데,
       * 바로 여기서 `lostSessionId` 를 버린다 — 그 순간부터 **우리는
       * 돌아갈 길이 없는데 세션만 남는** 꼴이 된다. 그래서 버리는
       * 자리에서 같이 지운다 — 방을 나갈 때와 같은 기준이다.
       *
       * ⚠️ **없는 연결을 새로 띄우지는 않는다.** 세션 하나 지우려고
       * 파이썬 서버를 20초 띄우는 것은 바꿔치기다. 갈아탄 직후라면
       * 그 연결은 보통 살아 있다.
       */
      const lostId = b.lostSessionId;
      const lostAgent = b.lostAgentId ?? b.agentId;
      const lostTalk = b.lostPrompted ?? true;
      delete b.lostSessionId;
      delete b.lostAgentId;
      delete b.lostPrompted;
      if (lostId) {
        await this.connections.get(lostAgent)
          ?.deleteSession(lostId, lostTalk)
          .catch(() => undefined);
      }
      if (accept) {
        b.refeedPending = true;
        /* 무엇을 넘길지도 같이 정한다 — 안 주면 원문이 기본이다 */
        if (kind) b.refeedKind = kind;
        else delete b.refeedKind;
      } else {
        delete b.refeedPending;
        delete b.refeedKind;
      }
    }
    rollUpLost(room);
    await this.rooms.saveProps(room, {
      participants: room.participants,
      contextLost: room.contextLost,
      refeedPending: room.refeedPending,
      lostSessionId: room.lostSessionId,
    });
    this.emit("room", room);
  }

  /**
   * 못 이어받은 세션에 **다시 붙어본다** (F7).
   *
   * 🔴 복구 실패가 늘 영구적인 건 아니다 — 에이전트가 늦게 떴거나 잠깐 바빴던
   * 것뿐일 수 있다. 그래서 실패했다고 바로 갈아타지 않고 옛 id를 들고 있다가
   * 여기서 한 번 더 시도한다. **되면 대화가 통째로 돌아온다.**
   */
  async retryResume(roomId: string): Promise<boolean> {
    const room = await this.rooms.openRoom(roomId);
    // 맥락을 잃은 **그 봇**을 찾는다 — 방 값은 요약일 뿐이다
    const bot = room.participants.find((b) => b.lostSessionId) ?? this.soleBot(room);
    const lost = bot?.lostSessionId ?? room.lostSessionId;
    if (!bot || !lost) return false;

    const resumed = await this.connection(bot.agentId)
      .resumeSession(lost, room.cwd, this.mcpFor(room, bot));
    if (!resumed.ok) {
      this.rooms.noteRoom(room, `아직 이어받을 수 없습니다 — ${resumed.reason}`);
      return false;
    }

    const bt = this.runtimes.bot(room.id, bot.id);
    bt.sessionId = lost;
    bt.roleInjected = true;
    bot.sessionId = lost;
    bot.sessionPrompted = true;
    // 되살아난 것은 **이 봇**이다 — 다른 봇이 잃은 것까지 걷으면 안 된다
    delete bot.contextLost;
    delete bot.refeedPending;
    /* 이쪽은 **되살린** 것이다 — 지우면 안 된다. 자국만 같이 치운다 */
    delete bot.lostSessionId;
    delete bot.lostAgentId;
    delete bot.lostPrompted;
    rollUpLost(room);

    if (resumed.options.length > 0) await this.restoreChoices(room, bot, lost, resumed.options);
    this.watchIdle(room, bot, lost);

    const note: Message = {
      id: messageId(),
      role: "system",
      text: "이전 세션을 다시 이어받았습니다.",
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.rooms.append(room, note);
    await this.rooms.saveNewMessage(room, note);
    await this.rooms.saveProps(room, {
      participants: room.participants,
      contextLost: room.contextLost,
      refeedPending: room.refeedPending,
      lostSessionId: room.lostSessionId,
    });
    this.emit("room", room);
    return true;
  }

  /**
   * 이 방의 세션이 들고 있는 설정을 갈무리한다.
   *
   * 🔴 **방마다 따로 둔다.** 예전에는 에이전트별 캐시 하나뿐이라 방 A에서 모델을
   * 바꾸면 그 값이 방 B의 화면에도 나왔다 — 세션은 방마다 다른데(B1) 화면에
   * 쓰는 값은 하나였다. 에이전트별 캐시는 **아직 방이 없는** 만들기 화면 몫으로만
   * 남긴다.
   */
  /**
   * 세션을 붙인 직후, **사용자가 고른 것들을 되살린다** (D2·B15).
   *
   * 🔴 저장만 하고 **다시 적용한 적이 없었다.** `bot.agentMode`·`bot.model`에
   * 담아두고 주석에는 *"다음에 열 때 다시 적용할 수 있게"* 라고 써두고선 적용하는
   * 코드가 없었다. 게다가 복구 응답을 그대로 받아 적느라(`noteRoomConfig`)
   * **세션이 말하는 기본값으로 우리 기록까지 덮어썼다** — Sonnet으로 쓰던 방이
   * 창을 껐다 켜면 Opus로 돌아오고, 디스크에서도 지워졌다.
   *
   * 그래서 **덮어쓰기 전에 먼저 적용한다.** 세션이 이미 같은 값이면 아무것도
   * 하지 않는다. 하나를 바꾸면 다른 선택지가 함께 바뀔 수 있으므로(B15)
   * **응답으로 받은 목록을 다음 판단에 쓴다.**
   */
  private async restoreChoices(
    room: Room,
    bot: BotInstance,
    sessionId: string,
    options: acp.SessionConfigOption[],
  ): Promise<void> {
    const want = bot.configValues ?? {};
    let now = options;
    /**
     * ★ **사라진 칸을 모아둔다** (2026-09-29).
     *
     * 아래에서 «안 주는 값이면 우기지 않는다» 로 접는데, 접고 **말을 안 했다.**
     * 그래서 CLI 가 올라가며 모델 하나가 목록에서 빠지면 — 이름이 바뀌든
     * 내려가든 실제로 일어난다 — Sonnet 으로 쓰던 방이 창을 껐다 켜면 조용히
     * Opus 가 되어 있었다. 게다가 바로 뒤 `noteRoomConfig` 가 저장값까지
     * 덮으므로 **되돌릴 근거도 남지 않았다.**
     *
     * 접는 것 자체는 맞다 — 세션이 진실이다. 다만 §0 뺄셈 규칙대로,
     * **뺐으면 적는다.**
     */
    const gone: Array<{ id: string; category?: string; was: string; value: string }> = [];

    // **권한을 먼저.** 모델·강도를 바꾸는 사이에도 권한은 지켜져야 한다.
    const order = (o: acp.SessionConfigOption) => (o.category === "mode" ? 0 : 1);
    for (const opt of [...options].sort((a, b) => order(a) - order(b))) {
      const value = want[opt.id];
      if (value === undefined) continue;

      const live = now.find((o) => o.id === opt.id);
      if (!live) continue;

      /*
       * 🔴 **«지금 값과 같다» 고 넘어가면 사라진 걸 못 본다** (2026-10-06).
       *
       * 예전엔 `live.currentValue === value` 이면 바로 `continue` 했다. 고쳐줄
       * 게 없으니 맞는 말 같은데, **사라지는 것과 바뀜는 것은 다르다.**
       * 세션은 여전히 그 모델로 돌고 있으므로 둘은 같은데, 그 모델이
       * **고를 수 있는 목록에서는 빠졌을** 수 있다.
       *
       * 실제로 그렇게 됐다. Codex 의 `~/.codex/models_cache.json` 은 모델마다
       * `visibility` 를 들고 있고 **서버가 내려준다** — `gpt-5.5` 가 닷사이에
       * `list` 에서 `hide` 로 바뀜었다. 우리 핀은 그대로였는데도.
       * 그런데 여기서 넘어가는 바람에 **막음 화면이 안 떠고** 그대로
       * 보내서, 사용자는 채팅창에서 404 를 받았다:
       *
       * ```
       * The model gpt-5.5 does not exist or you do not have access to it.
       * ```
       *
       * 그래서 **아직 고를 수 있나를 먼저 본다.** 같은지는 그 다음이다.
       */
      if (live.type === "select") {
        const offered = live.options.some((e) =>
          "group" in e ? e.options.some((v) => v.value === value) : e.value === value,
        );
        if (!offered) {
          gone.push({
            id: live.id,
            // **무엇이 없어졌나** — 다시 고를 때 «이것이 없어졌습니다» 를 적으려면 필요하다
            value: String(value),
            ...(live.category != null ? { category: live.category } : {}),
            // 이 값은 **이미 목록에 없으므로** 지금 목록에서는 이름을 못 찾는다.
            // 모델이라면 지난 세션에서 받아 적어둔 이름이 남아 있다.
            was: (live.category === "model" ? bot.modelLabel : undefined)
              ?? nameOf(options, live.id, value)
              ?? String(value),
          });
          continue;
        }
      }

      /* 여전히 고를 수 있고 이미 그 값이면 건드릴 것이 없다 */
      if (live.currentValue === value) continue;

      try {
        now = await this.connection(bot.agentId).setConfigOption(sessionId, opt.id, value);
      } catch (err) {
        this.opts.host.log(`[${bot.agentId}] ${opt.id} 복원 실패: ${describe(err)}`);
      }
    }
    this.noteRoomConfig(room, bot, now);

    // **바뀐 것을 적는다.** 조용히 넘어가면 «왜 얘가 갑자기 딴 소리를 하지»가 된다
    for (const g of gone) {
      const live = now.find((o) => o.id === g.id);
      const label = nameOf(now, g.id, live?.currentValue) ?? String(live?.currentValue ?? "");
      if (!label) continue;
      /*
       * 🔴 **이름이 그대로면 입을 다문다** (2026-09-29).
       *
       * id 만 갈리고 모델은 같은 경우가 있다. 실제로 어댑터 0.81.2 → 0.84.0
       * 에서 `opus[1m]` 이 `opus` 가 되는데 **둘 다 「Opus 5.5」**다. 그대로
       * 두면 모든 방에 이렇게 뜬다:
       *
       *   「Opus 5.5이(가) 더 이상 없어 Opus 5.5(으)로 바뀌었습니다」
       *
       * 읽는 사람에게는 아무 일도 안 일어난 것이고, 그런 줄이 방마다 하나씩
       * 쌓이면 **진짜 변화를 못 알아본다.** 알릴 것이 없으면 안 알린다.
       */
      if (label === g.was) continue;
      const what = (g.category && CONFIG_WORD[g.category]) ?? live?.name ?? g.id;
      this.rooms.noteRoom(
        room,
        `${whose(room, bot)}${what} ${g.was}이(가) ` +
          `${this.agentOrThrow(bot.agentId).label}에 더 이상 없어 ${label}(으)로 바뀌었습니다.`,
        "info",
        [bot.id],
      );

      /*
       * ★ **모델이면 알리는 데서 끝내지 않는다 — 고르게 한다** (2026-09-30).
       *
       * 🔴 여기서 접고 남는 것은 «그 판의 기본값» 이고, **그건 계열째 다를 수
       * 있다.** 실측한 것만 둘이다:
       *
       * ```
       * Codex    gpt-6-luna(빠름)  →  gpt-5.6-terra(균형)
       * Claude   sonnet            →  opus
       * ```
       *
       * 우리가 계열을 안 보기 때문이다. 빠른 모델을 쓰려고 고른 방이 조용히
       * 다른 성격으로 넘어간다 — 위 한 줄로는 그게 **얼마나 다른지** 가 안
       * 읽힌다(`6 Luna` 와 `GPT-5.6-Terra` 는 이름만으로 못 잰다).
       *
       * **모델만 그런다.** 권한 모드·사고 강도는 대체돼도 성격이 안 갈린다.
       */
      if (g.category === "model") bot.modelGone = { value: g.value, label: g.was };
    }
  }

  private noteRoomConfig(
    room: Room,
    bot: BotInstance,
    options: acp.SessionConfigOption[],
  ): void {
    this.roomConfigs.set(configKeyOf(room.id, bot.id), options);
    // 만들기 화면의 기본값으로도 쓴다 — 최소한 최근에 본 목록이다
    this.configCache.set(bot.agentId, options);
    /*
     * ★ **방 세션이 준 것이 제일 참이다** — 그러니 이것도 적어둔다.
     * 조회용 세션을 따로 안 열고도 디스크 캐시가 저절로 최신이 된다.
     */
    void this.keepConfigOptions(bot.agentId, options);
    const model = noteModel(bot, options);
    if (model.changed) this.rooms.emitMetas();
    if (model.renamed !== undefined) {
      // **고른 값은 그대로**라는 것까지 적는다 — 안 그러면 «내가 뭘 잘못 눌렀나»가 된다
      this.rooms.noteRoom(
        room,
        `${whose(room, bot)}${model.renamed}이(가) ${bot.modelLabel}(으)로 ` +
          `바뀌었습니다 — 고른 값 «${bot.model ?? ""}»은 그대로입니다.`,
        "info",
        [bot.id],
      );
    }

    const mode = options.find((o) => o.category === "mode");
    if (mode && typeof mode.currentValue === "string") bot.agentMode = mode.currentValue;

    // **범주를 가리지 않고 전부 담는다.** 사고 강도든 Fast mode든, 우리가 뜻을
    // 모르는 것이든 — 세션이 들고 있던 값이면 다음에도 그 값이어야 한다.
    const values: Record<string, string | boolean> = {};
    for (const o of options) {
      if (o.currentValue !== undefined && o.currentValue !== null) values[o.id] = o.currentValue;
    }
    bot.configValues = values;
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
    const line = (this.ourOut.get(`${owner}:${tool}`) ?? []);
    line.push(out.text);
    if (line.length > 8) line.shift();
    this.ourOut.set(`${owner}:${tool}`, line);
    return out;
  }

  /**
   * ★ **큐에 거리가 있으면 깨운다** (v3.0 4-J).
   *
   * 🔴 **주기적으로 세어보면 안 된다.** «0 이 아니면 알린다»를 돌리면 0 이라고
   * 판단한 **직후에** 들어온 것은 아무도 안 깨운다. 그래서 두 자리에서만 부른다:
   *
   * ```
   * 넣는 쪽      say · 심사 요청 — 놀고 있으면 그 자리에서
   * 턴이 끝날 때  바쁜 동안 들어온 것 — 스냅샷이 떼어놔서 그 턴에는 안 보인다
   * ```
   *
   * **둘을 같이 두면 놓칠 수가 없다.** 그리고 고리가 안 생긴다 — 프롬프트를
   * 보낼 때 `startTurn` 이 다음 몫을 비우므로, 새로 들어온 것이 없으면
   * `waiting` 이 0 이라 여기서 그냥 돌아간다.
   */
  private maybeWake(room: Room, botId?: string): void {
    if (this.down) return;
    const who = botId
      ? room.participants.filter((b) => b.id === botId)
      : room.participants;
    for (const bot of who) {
      if (this.queue.waiting(bot.id) === 0) continue;
      // 바쁘면 안 깨운다 — 지금 도는 턴이 끝나면서 여기를 다시 부른다
      if (isBusy(this.runtimes.statusOf(room.id, bot.id))) continue;
      /*
       * ★ **말풍선을 안 만든다** (§4.2.2 가 걱정한 그것).
       *
       * *"에이전트가 스무 번 물으면 대화가 시스템 줄로 덮인다"* — 깨우는 줄은
       * **전달 방식**이지 누가 한 말이 아니다. 실린 말은 이미 말풍선으로 떠
       * 있고(`relaySay`), 이 줄은 그걸 **꺼내 보라고 찌르는 것**뿐이다.
       */
      const poke: Message = {
        id: messageId(),
        role: "system",
        text: "",
        deliveredTo: [bot.id],
        createdAt: Date.now(),
      };
      void this.runQueue(room, [poke], bot.id, true)
        .catch((err) => this.opts.host.log(`[${room.id}] 깨우기 실패: ${describe(err)}`))
        .finally(() => this.maybeFireStaged(room));
    }
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

  /**
   * ★ **이 봇이 쓸 MCP 서버 목록** (v3.0 2-F).
   *
   * 🔴 **세션마다 다른 비밀**을 발급한다. 하나로 돌려쓰면 **봇이 자기 권한
   * 요청을 스스로 승인할 수 있다** — 큐에서 남의 항목을 꺼내는 것을 막을
   * 근거가 사라진다(2-H 의 소유자 검사).
   *
   * 🔴 **포트는 실행마다 바뀐다.** 그래서 «한 번 실어두면 되는» 값이 아니라
   * 세션이 생기거나 다시 붙을 때마다 **지금 주소로** 다시 만드는 값이다.
   *
   * ⚠️ **부르는 자리가 넷이다** — `new`·`resume`·`load`·`fork`. 한 군데만
   * 빠져도 그 길로 선 세션은 **조용히 도구를 잃는다.** 그래서 여기 한 자리에
   * 모으고, `mcpcarry.mts` 가 넷을 다 지킨다.
   */
  private mcpFor(room: Room, bot: BotInstance): acp.McpServer[] {
    const server = this.opts.mcp;
    const at = server?.current();
    // ★ 무엇을 실어 보냈는지 적는다 — 심사 봇에게 넘길 수 있나가 이걸 본다(⑦-2)
    const bt = this.runtimes.bot(room.id, bot.id);
    if (!server || at?.at !== "ready") {
      bt.mcpOffered = false;
      return [];
    }
    bt.mcpOffered = true;
    const owner = `${room.id}:${bot.id}`;
    /*
     * ⏪ **여기서 지난 열쇠를 거두던 것을 물렀다** (사용자, 2026-10-15).
     *
     * 🔴 Antigravity 가 뱉었다: *"The MCP server 'ai-in-one' failed to
     * initialize: … Unauthorized."* — 그쪽은 **한 프로세스가 세션 여럿을
     * 품고** MCP 서버를 이름당 한 번 붙인다. 새 세션을 여느라 열쇠를
     * 바꿔 끼우면, **아직 살아 있는 그 붙임**이 통째로 도구를 잃는다.
     *
     * 지금은 `issue` 가 **최근 몇 개만 남기고** 오래된 것부터 걷는다 —
     * 맵은 안 커지고, 같은 임자의 열쇠는 둘이어도 권한이 똑같다.
     */
    return [{
      type: "http",
      name: OUR_MCP_NAME,
      url: at.url,
      headers: [{ name: "x-aio-secret", value: server.issue(owner) }],
    }];
  }

  /**
   * **치우다 만 세션 파일을 적어둔다** (2026-10-12).
   *
   * 🔴 저쪽 프로세스가 아직 들고 있어 안 지워진다. 다음에 켤 때 **버려진
   * 프로세스를 죽인 뒤에** 치운다(`sweepBacklog`).
   *
   * ⚠️ **«그 집에 남는 것» 을 쓸지 않는다** — 같은 집을 보는 다른 ACP
   * 클라이언트가 있을 수 있고, 그러면 남이 만든 세션까지 지운다.
   * 우리가 지우려다 못 지운 것만 적는다.
   */
  private rememberPurge(agentId: string, sessionId: string): void {
    const prev = this.opts.store.getAppState().purgeBacklog ?? [];
    if (prev.some((x) => x.agentId === agentId && x.sessionId === sessionId)) return;
    void this.opts.store.patchAppState({
      purgeBacklog: [...prev, { agentId, sessionId, at: Date.now() }],
    });
  }

  private connection(agentId: string): AcpConnection {
    /*
     * 🔴 **내린 뒤에는 새로 안 만든다** (v3.0 1-E).
     *
     * 여기가 CLI 가 뜨는 **유일한 자리**다. `dispose()` 가 연결을 다 내린
     * 뒤에도 **도중이던 호출**이 이 자리에 닿을 수 있는데, 그때 하나를
     * 새로 만들면 끄려던 참에 CLI 가 하나 더 뜬다.
     */
    if (this.down) throw new Error("이미 내려가는 중입니다");
    let conn = this.connections.get(agentId);
    if (!conn) {
      conn = new AcpConnection(
        this.agentOrThrow(agentId),
        this.opts.host,
        (reason) => this.onAgentCrash(agentId, reason),
        (sessionId, note) => this.recordDecision(sessionId, note),
        (sessionId, req) => this.askApprover(sessionId, req),
        (agentId, sessionId) => this.rememberPurge(agentId, sessionId),
      );
      this.connections.set(agentId, conn);
    }
    return conn;
  }

  /**
   * ★ **그 에이전트의 CLI 를 내린다** (2026-10-02).
   *
   * 로그아웃했는데 프로세스가 그대로 떠 있으면 **옆 계정으로 계속
   * 돌아간다** — 계정을 바�려는 사람 입장엔 «바�는데 옇 것으로
   * 답한다» 가 된다.
   *
   * ⚠️ **세션 id 는 안 건드린다.** 사용자: *"세션은 유지되어야한다"*.
   * 다음에 방을 열 때 먼저 이어받아 보고, 새 계정으로 되면 그대로
   * 이어진다. 안 되면 **이미 있는 끕김 흐름**이 받아준다(대화 넘겨서 /
   * 요약만 / 기록만 두고). 여기서 지워버리면 고를 거리를 없애는 셌이다.
   */
  /** 그 에이전트가 광고하는 로그인 길들 (ACP) */
  async authOptionsOf(agentId: string): Promise<{ id: string; name: string; description?: string }[]> {
    return this.connection(agentId).authOptions();
  }

  /** ACP 로 로그인한다. 사람이 브라우저에서 마칠 때까지 안 돌아온다 */
  async authenticateAs(
    agentId: string, methodId: string, onNote?: (line: string) => void,
  ): Promise<void> {
    await this.connection(agentId).authenticate(methodId, onNote);
  }

  /** ACP 로 로그아웃. 광고 안 했으면 `false` */
  async logOutOf(agentId: string): Promise<boolean> {
    return this.connection(agentId).logOut();
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

  dropConnection(agentId: string): void {
    const conn = this.connections.get(agentId);
    if (!conn) return;
    conn.dispose();
    this.connections.delete(agentId);
    for (const rt of this.runtimes.values()) {
      for (const bt of rt.bots.values()) bt.sessionId = undefined;
    }
  }

  /** 쓰이지 않는 CLI 프로세스를 정리한다 (B6) */
  private disposeUnusedConnections(): void {
    const inUse = new Set(this.rooms.listMetas().flatMap((m) => m.agentIds));
    for (const [agentId, conn] of this.connections) {
      if (inUse.has(agentId)) continue;
      conn.dispose();
      this.connections.delete(agentId);
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
    for (const conn of this.connections.values()) conn.dispose();
    this.connections.clear();
    // 유예 타이머가 살아 있으면 지운 방에 써대고 깨어난다
    for (const rt of this.runtimes.values()) {
      for (const bt of rt.bots.values()) clearTimeout(bt.tail);
    }
    this.runtimes.clear();
  }
}


/**
 * 카드에 보여줄 `+N -M`을 센다 (E2).
 *
 * **줄 수 차이만 보면 안 된다.** 10줄을 전부 고쳐도 개수는 그대로라 `+0 -0`이
 * 나온다 — 잘못된 숫자는 없느니만 못하다.
 *
 * 앞뒤로 같은 줄을 걷어내고 남은 것을 센다. 중간에 흩어진 변경은 실제보다 크게
 * 잡히지만 **틀린 방향으로는 가지 않고** O(n)이다. 정확한 diff는 E4가 보여준다.
 */
function countChangedLines(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  return {
    removed: a.length - head - tail,
    added: b.length - head - tail,
  };
}

/**
 * 턴이 왜 끝났는지 사용자에게 알릴 말. 정상 종료면 `undefined`.
 *
 * 이걸 버리면 **거부나 길이 초과가 그냥 짧은 응답으로 보인다** — 사용자는
 * 에이전트가 왜 말을 하다 말았는지 알 수 없다.
 */
function stopReasonNote(reason: string): string | undefined {
  switch (reason) {
    case "refusal":
      return "에이전트가 이 요청에 응답하지 않았습니다.";
    case "max_tokens":
      return "응답 길이 제한에 도달해 중간에 끊겼습니다.";
    case "max_turn_requests":
      return "한 턴에서 도구를 너무 많이 호출해 중단되었습니다.";
    case "cancelled":
      return "중단했습니다.";
    default:
      return undefined;
  }
}

