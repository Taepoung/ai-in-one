import { EventEmitter } from "node:events";
import type * as acp from "@agentclientprotocol/sdk";

import { AcpConnection, describe, type AgentEvent } from "./acpConnection.js";
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
  type Approver,
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
  type SearchHit,
} from "./types.js";
import type { WorkspaceHost } from "./workspaceHost.js";

export interface RoomManagerOptions {
  host: WorkspaceHost;
  store: RoomStore;
  agents: AgentDef[];
  /** 설정 조회를 포기하는 시간. 테스트에서만 줄인다 */
  configProbeMs?: number;
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
  agentMode?: string;
  answerPolicy?: AnswerPolicy;
  /** 그 봇의 세션에 적용할 설정 — 모델·추론 강도 (B15) */
  configValues?: Record<string, string | boolean>;
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

/**
 * **봇 하나**의 실행 상태 (B1).
 *
 * 세션이 봇 단위이므로 세션에 딸린 것은 전부 여기 있다. v2.0 단체방에서
 * 봇이 여럿이면 **봇마다 자기 세션·자기 큐·자기 턴**을 갖는다 — 지금은
 * 하나뿐이라 결과가 같지만, **모양을 먼저 맞춰두면 나중에 다시 짜지 않는다.**
 *
 * 디스크에 저장하지 않는다 — 껐다 켜면 전부 비어 있고 `bot.sessionId`로 복구한다.
 */
interface BotRuntime {
  /** 지금 붙어 있는 ACP 세션. 복구했든 새로 만들었든 여기 담긴다 */
  sessionId?: string;
  /**
   * 진행 중인 턴이 있으면 그 사이 들어온 메시지를 여기 쌓는다 (§4.3).
   *
   * 텍스트가 아니라 **메시지를 통째로** 들고 있어야 응답과 짝지을 수 있고
   * (`replyToIds`), 전송 실패를 표시할 때도 id로 정확히 찾는다.
   *
   * **봇마다 따로다.** 단체방에서 한 봇이 도는 동안 다른 봇에게 보낸 말이
   * 엉뚱한 줄에 끼면 안 된다.
   */
  queue: Message[];
  /** 역할을 이미 주입했는지. 세션이 새로 열리면 다시 false가 된다 */
  roleInjected: boolean;
  /** 그 **세션이** 광고한 슬래시 명령. 압축(C11) 버튼을 여기서 찾는다 */
  commands: string[];
  /** 스트리밍 중 emit을 솎아내기 위한 마지막 발행 시각 */
  lastEmit: number;
  /** 스트리밍 중 디스크 저장을 솎아내기 위한 마지막 저장 시각 */
  lastSave: number;
  /**
   * **이 봇이 지금 뭐 하는중** (v2.0 준비).
   *
   * 방의 상태는 이것들을 합친 것이다(`mergeStatus`). 따로 들고 있으면
   * 둘이 어긋난다 — «방은 idle인데 봇은 도는 중» 같은 게 생긴다.
   */
  status: RoomStatus;
  /** 턴 밖 발화를 담고 있는 메시지 (A11) */
  idle?: { message: Message; at: number };
  /**
   * **지금 도는 턴의 응답 자리.**
   *
   * 있으면 들어오는 것이 그 턴의 말이고, 없으면 턴 밖 발화다(A11).
   * 리스너를 갈아끼우는 대신 이 값으로 가르는 이유는 `watchIdle`에.
   */
  turn?: Message;
  /** 턴을 놓기까지의 유예 타이머. `releaseTurn` 참조 */
  tail?: ReturnType<typeof setTimeout>;
}

/**
 * **방 하나**의 실행 상태 — 봇과 무관한 것만 남긴다.
 *
 * 화면에 뜨는 상태는 방 단위다(«작업 중» 표시가 하나). v2.0에서 봇이 병렬로
 * 돌면 여기서 **봇들의 상태를 합쳐** 정하게 된다.
 */
interface RoomRuntime {
  status: RoomStatus;
  /**
   * 이번 턴에 걸린 blob 쓰기들.
   *
   * 파일 변경 내용은 비동기로 저장되는데, 이걸 기다리지 않고 방을 저장하면
   * **해시가 비어 있는 채로 기록되어 diff를 영영 못 본다.**
   */
  pendingWrites: Promise<unknown>[];
  /** 봇별 상태. 열쇠는 `BotInstance.id` */
  bots: Map<string, BotRuntime>;
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

/**
 * 세션이 쓰는 모델 이름을 봇에 적어 둔다 (B5). 바뀌었으면 `true`.
 *
 * **id가 아니라 보이는 이름이다.** 목록에 `Claude · Opus 5`로 나가는데
 * 거기에 `opus-5`가 뜨면 방 만들기 화면에서 고른 것과 달라 보인다.
 * 선택지는 평평하게도, 그룹으로 묶여서도 오므로 둘 다 훑는다.
 */
function noteModel(bot: BotInstance, options: acp.SessionConfigOption[]): boolean {
  const opt = options.find((o) => o.category === "model");
  if (!opt || opt.type !== "select") return false;

  const current = opt.currentValue;
  for (const entry of opt.options) {
    const found =
      "group" in entry
        ? entry.options.find((v) => v.value === current)
        : entry.value === current
          ? entry
          : undefined;
    if (!found) continue;
    // **id도 같이 적는다** — 이름만으로는 나중에 다시 적용할 수 없다
    bot.model = found.value;
    if (bot.modelLabel === found.name) return false;
    bot.modelLabel = found.name;
    return true;
  }
  return false;
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
function transcriptText(room: Room, batch: Message[]): string {
  const skip = new Set(batch.map((m) => m.id));
  const name = (m: Message) =>
    m.role === "user"
      ? "사용자"
      : (room.participants.find((b) => b.id === m.authorBotId)?.name ?? "에이전트");

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
   */
  let at = -1;
  const summaries: string[] = [];
  room.messages.forEach((m, k) => {
    if (m.mark === "compaction" && m.summary) {
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
      // 🔴 **전달 안 된 메시지는 넣지 않는다.** 보내다 실패한 것이라 **이전 세션도
      // 본 적이 없다.** 넣으면 «했던 얘기»가 하나 생겨서, 에이전트가 답한 적
      // 없는 것에 답한 척하게 된다. 빼는 게 작기도 하고 **맞기도 하다.**
      !m.sendFailed,
  );

  // 최근 것은 손대지 않는다 — 이어서 할 지점이 거기다
  const foldFrom = Math.max(0, kept.length - REFEED_KEEP_RECENT);

  const body = kept
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

/**
 * 봇들의 상태를 **방 하나의 상태로** 합친다 (v2.0 준비).
 *
 * 순서는 «화면이 무엇을 말해야 하나»다 — 사람을 기다리는 것이 가장 급하고,
 * 그다음이 도는 중, 마지막이 조용함.
 *
 * 🔴 **`error`는 `idle`보다만 높다.** 한 봇이 실패했다고 다른 봇이 도는 걸
 * 가릴 수는 없다 — «답하는 중»이 안 뜨면 사용자는 멈춘 줄 안다. 반대로
 * 아무도 안 돌 때는 실패를 보여줘야 한다.
 */
const STATUS_RANK: RoomStatus[] = [
  "permission",
  "asking",
  "tool",
  "streaming",
  "waiting",
  "connecting",
  "error",
  "idle",
];

function mergeStatus(all: RoomStatus[]): RoomStatus {
  if (all.length === 0) return "idle";
  for (const s of STATUS_RANK) {
    if (all.includes(s)) return s;
  }
  return "idle";
}

/** 설정 캐시의 열쇠. **방 하나 안에서도 봇마다 다르다** (B1) */
/**
 * 방 안에서 **겹치지 않는 봇 이름**을 만든다.
 *
 * 이름이 곧 멘션 이름이라(B1) 둘이 같으면 `@Claude`가 누구를 가리키는지
 * 우리가 정할 수 없다. 겹치면 뒤에 수를 붙인다 — `Claude`, `Claude 2`, ...
 */
function uniqueName(wanted: string, others: BotInstance[]): string {
  const taken = new Set(others.map((b) => b.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const tryThis = `${wanted} ${n}`;
    if (!taken.has(tryThis)) return tryThis;
  }
}

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
   * 응답 대기 표시 (C10) — (roomId, 합친 상태, 봇별 상태).
   *
   * 봇별이 필요한 이유는 단체방이다 — «Claude는 답하는 중, Codex는 끝»을
   * 합친 값 하나로는 말할 수 없다.
   */
  status: [string, RoomStatus, Record<string, RoomStatus>];
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
  private readonly runtimes = new Map<string, RoomRuntime>();
  /** 열어둔 방의 전체 내용. 목록만 볼 때는 메타만 쓴다 */
  private readonly open = new Map<string, Room>();
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
   * 나간 방들.
   *
   * 진행 중인 턴이 있는 채로 방을 나가면 `runQueue`가 계속 돌다가 **지워진 파일에
   * 덧붙여 방을 되살린다.** 여기 들어 있으면 저장을 건너뛴다.
   */
  private readonly left = new Set<string>();

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
    return this.opts.store.listMetas();
  }

  /** 방의 상태, 또는 **그 봇의** 상태 (v2.0 준비) */
  statusOf(roomId: string, botId?: string): RoomStatus {
    if (botId) return this.runtimes.get(roomId)?.bots.get(botId)?.status ?? "idle";
    return this.statusOfRoom(roomId);
  }

  private statusOfRoom(roomId: string): RoomStatus {
    return this.runtimes.get(roomId)?.status ?? "idle";
  }

  /** 상태 표시줄 배지용 (F1) */
  totalUnread(): number {
    return this.listMetas().reduce((sum, m) => sum + m.unread, 0);
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
        ...(spec.rolePrompt ? { rolePrompt: spec.rolePrompt } : {}),
        ...(spec.agentMode ? { agentMode: spec.agentMode } : {}),
        ...(spec.answerPolicy ? { answerPolicy: spec.answerPolicy } : {}),
      });
      taken.add(bot.name);
      return bot;
    });

    const now = Date.now();
    const room: Room = {
      id: `room-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: opts.title?.trim() || this.nextDefaultTitle(),
      participants,
      cwd: opts.cwd ?? this.opts.host.defaultCwd(),
      messages: [],
      unread: 0,
      createdAt: now,
      lastActivityAt: now,
    };
    await this.opts.store.createRoom(room);
    this.open.set(room.id, room);
    this.emitMetas();

    // **역할을 방 상단에 보여준다** (B3). 안 보이면 봇이 왜 이렇게
    // 답하는지 모른 채로 대화하게 된다.
    for (const bot of room.participants) {
      if (!bot.rolePrompt?.trim()) continue;
      const note: Message = {
        id: messageId(),
        role: "system",
        // 봇이 여럿이면 **누구의 역할인지** 써준다 — 안 그러면 줄만 늘고 뜻이 없다
        text:
          room.participants.length > 1
            ? `${bot.name}의 역할: ${bot.rolePrompt.trim()}`
            : `역할: ${bot.rolePrompt.trim()}`,
        deliveredTo: [],
        createdAt: now,
      };
      this.append(room, note);
      await this.saveNewMessage(room, note);
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
          this.setStatus(room.id, "error", bot.id);
          this.noteRoom(room, `${bot.name} 세션을 열지 못했습니다 — ${describe(err)}`);
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
  private async openSession(
    room: Room,
    bot: BotInstance,
    configValues?: Record<string, string | boolean>,
  ): Promise<void> {
    const conn = this.connection(bot.agentId);
    const bt = this.botRuntime(room.id, bot.id);

    this.setStatus(room.id, "connecting", bot.id);
    const { sessionId, configOptions } = await conn.newSession(room.cwd, () =>
      this.emit(
        "notice",
        room.id,
        `${this.agentOrThrow(bot.agentId).label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`,
      ),
    );

    bt.sessionId = sessionId;
    this.pointAt(bot, sessionId);
    bt.roleInjected = false;
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

    await this.saveProps(room, { participants: room.participants });
    this.setStatus(room.id, "idle", bot.id);
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

  /**
   * 방을 메모리에 올린다.
   *
   * **읽음 처리는 하지 않는다.** 그건 사용자가 실제로 보고 있을 때(`setActiveRoom`)의
   * 일이다. 목록 렌더링이나 검색 때문에 방을 로드하는 것만으로 미읽음이 사라지면 안 된다.
   */
  async openRoom(roomId: string): Promise<Room> {
    const cached = this.open.get(roomId);
    if (cached) return cached;
    const room = await this.opts.store.loadRoom(roomId);
    if (!room) throw new Error("방을 찾을 수 없습니다.");
    this.open.set(roomId, room);
    return room;
  }

  /**
   * 봇의 역할을 고친다 (B3·B12).
   *
   * 이미 대화 중이면 이번 세션에 **다시 주입해야** 반영된다 —
   * 역할은 프롬프트 프리픽스라 한 번 보낸 뒤에는 다시 보내지 않는다.
   */
  async setRole(roomId: string, rolePrompt: string, botId?: string): Promise<void> {
    const room = await this.openRoom(roomId);
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;

    bot.rolePrompt = rolePrompt || undefined;
    // 역할은 프롬프트 프리픽스라 **그 봇의** 세션에 다시 넣어야 한다
    this.botRuntime(roomId, bot.id).roleInjected = false;

    await this.saveProps(room, { participants: room.participants });
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
    const room = await this.openRoom(roomId);
    const agent = this.agentOrThrow(spec.agentId);

    const taken = new Set(room.participants.map((b) => b.name));
    const bot = createBotInstance(agent, {
      taken,
      ...(spec.rolePrompt ? { rolePrompt: spec.rolePrompt } : {}),
      ...(spec.agentMode ? { agentMode: spec.agentMode } : {}),
      ...(spec.answerPolicy ? { answerPolicy: spec.answerPolicy } : {}),
    });
    room.participants.push(bot);

    const first = room.participants.length === 2;
    const said = room.messages.some((m) => m.role !== "system");
    this.noteRoom(
      room,
      said
        ? `${bot.name}을(를) 초대했습니다. ${bot.name}은(는) 위 대화를 모릅니다 — ` +
            `@${bot.name} 으로 지목해 다시 알려주세요.`
        : `${bot.name}을(를) 초대했습니다.`,
      "info",
    );
    // 봇이 둘이 되는 **그 순간**에 한 번만 (§4.2.3)
    if (first) {
      this.noteRoom(
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
      this.setStatus(room.id, "error", bot.id);
      this.noteRoom(room, `${bot.name} 세션을 열지 못했습니다 — ${describe(err)}`);
    }

    await this.saveProps(room, { participants: room.participants });
    this.emit("room", room);
    this.emitMetas();
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
    const room = await this.openRoom(roomId);
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

    room.participants.splice(at, 1);
    rt?.bots.delete(botId);

    this.noteRoom(room, `${bot.name}을(를) 내보냈습니다. 지금까지의 대화는 그대로 남습니다.`, "info");
    await this.saveProps(room, { participants: room.participants });
    this.emit("room", room);
    this.emitMetas();
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
  async renameBot(roomId: string, botId: string, name: string): Promise<void> {
    const room = await this.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;

    const wanted = name.trim();
    if (!wanted || wanted === bot.name) return;

    bot.name = uniqueName(wanted, room.participants.filter((b) => b.id !== botId));
    await this.saveProps(room, { participants: room.participants });
    this.emit("room", room);
    this.emitMetas();
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
  async setAgent(roomId: string, botId: string, agentId: string): Promise<void> {
    const room = await this.openRoom(roomId);
    const bot = room.participants.find((b) => b.id === botId);
    if (!bot) return;
    if (bot.agentId === agentId) return;

    const next = this.agentOrThrow(agentId);
    const before = this.opts.agents.find((a) => a.id === bot.agentId)?.label ?? bot.agentId;

    // 돌고 있으면 바꾸지 않는다 — 답이 오는 중에 세션을 갈면 그 답은 갈 곳이 없다
    if (this.statusOf(roomId, botId) !== "idle" && this.statusOf(roomId, botId) !== "error") {
      throw new Error("답하는 중에는 에이전트를 바꿀 수 없습니다.");
    }

    const bt = this.botRuntime(roomId, botId);
    const old = bt.sessionId ?? bot.sessionId ?? undefined;

    // 붙어 있던 세션에서 손을 뗀다. **지우지는 않는다** — 그 CLI에 그대로 두고
    // 우리만 놓는다. 사용자가 되돌리고 싶어질 수도 있고, 남의 기록을 우리가
    // 치울 이유도 없다.
    if (old) await this.connections.get(bot.agentId)?.cancel(old).catch(() => undefined);
    bt.sessionId = undefined;
    bt.commands = [];
    bt.roleInjected = false;
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

    // **화면과 에이전트가 어긋난 상태**다 (F7과 같은 자리)
    room.contextLost = true;
    if (old) room.lostSessionId = old;

    this.noteRoom(
      room,
      old
        ? `에이전트를 ${before}에서 ${next.label}(으)로 바꿨습니다. ` +
            `${next.label}은(는) 위 대화를 모릅니다. 이전 세션 ${old}은(는) ${before} 쪽에 그대로 있습니다.`
        : `에이전트를 ${before}에서 ${next.label}(으)로 바꿨습니다. ${next.label}은(는) 위 대화를 모릅니다.`,
      "info",
    );

    await this.saveProps(room, {
      participants: room.participants,
      contextLost: true,
      ...(old ? { lostSessionId: old } : {}),
    });
    this.emit("room", room);
    this.emitMetas();
  }

  async renameRoom(roomId: string, title: string): Promise<void> {
    const room = await this.openRoom(roomId);
    room.title = title.trim() || room.title;
    await this.saveProps(room, { title: room.title });
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

    const room = this.open.get(roomId) ?? (await this.opts.store.loadRoom(roomId));
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
    opts: { atMessageId?: string; title?: string; fallback?: ForkFallback } = {},
  ): Promise<Room> {
    const parent = await this.openRoom(roomId);

    // **진행 중인 턴이 있으면 안 된다** (D4). 반쯤 온 응답을 물려받으면 분기가
    // 원본과 다른 지점에서 시작하고, 원본 쪽 턴이 끝나며 덧쓰는 것도 놓친다.
    if (isBusy(this.statusOf(roomId))) {
      throw new Error("진행 중인 턴이 끝난 뒤에 분기할 수 있습니다.");
    }

    if (parent.participants.length === 0) throw new Error("분기할 봇이 없습니다.");

    // 🔴 **이걸 먼저 본다.** 빈 방은 `cut`이 -1이라 지점 검사에 먼저 걸리는데,
    // 그러면 *"분기할 지점을 찾을 수 없습니다"* 라고 말하게 된다 — 지점을 고른 적도
    // 없는 사람에겐 뜻 모를 소리다. 없는 건 지점이 아니라 **대화**다.
    if (!parent.messages.some((m) => m.role !== "system")) {
      throw new Error("아직 나눌 대화가 없습니다.");
    }

    const cut =
      opts.atMessageId === undefined
        ? parent.messages.length - 1
        : parent.messages.findIndex((m) => m.id === opts.atMessageId);
    if (cut < 0) throw new Error("분기할 지점을 찾을 수 없습니다.");

    const inherited = parent.messages.slice(0, cut + 1);
    // 시스템 메시지는 우리 안내다 — 그것만 물려받는 건 분기가 아니라 새 방이다
    if (!inherited.some((m) => m.role !== "system")) {
      throw new Error("아직 나눌 대화가 없습니다.");
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
    const forks = await Promise.all(
      parent.participants.map(async (b) => ({
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
    return this.createRoomFromFork(parent, forks, cut, opts.title, opts.fallback ?? "refeed");
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
      const res = await conn.forkSession(live, room.cwd);
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
    const { sessionId, configOptions } = await conn.newSession(room.cwd, () =>
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
    const room = await this.openRoom(roomId);
    if (!room.forkedFromRoomId) return { ok: false, reason: "분기된 방이 아닙니다." };

    const failed = room.participants.filter((b) => b.forkFallback);
    if (failed.length === 0) return { ok: false, reason: "다시 할 분기가 없습니다." };
    if (isBusy(this.statusOf(roomId))) {
      return { ok: false, reason: "응답이 끝난 뒤에 다시 시도할 수 있습니다." };
    }

    let parent: Room;
    try {
      parent = await this.openRoom(room.forkedFromRoomId);
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

      const got = await this.connection(origin.agentId).forkSession(live, room.cwd);
      if (!got.ok) continue;

      // 폴백으로 열었던 세션은 **빈 것**이라 지울 것도 없다 — 놓기만 한다
      const bt = this.botRuntime(room.id, bot.id);
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
    // 전부 되살아났으면 되먹임 약속은 필요 없다 — 계획·기억까지 돌아왔다
    if (left.length === 0) delete room.refeedPending;

    this.noteRoom(
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
    await this.saveProps(room, {
      participants: room.participants,
      ...(left.length === 0 ? { refeedPending: undefined } : {}),
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
    const messages: Message[] = parent.messages.slice(0, cut + 1).map((m) => {
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
      // 마지막까지 읽은 상태로 연다 — 물려받은 건 이미 읽은 대화다
      lastReadMessageId: at.id,
      forkedFromRoomId: parent.id,
      forkedAtMessageId: at.id,
      // 폴백이면 에이전트가 백지다. **사용자가 고른 대로** — 글로 옮기거나 백지로 가거나
      // 한 봇이라도 폴백이면 되먹임이 필요하다 — 그 봇은 백지에서 시작하므로
      ...(forks.every((f) => f.forked.native) || fallback === "fresh"
        ? {}
        : { refeedPending: true }),
      createdAt: now,
      lastActivityAt: now,
    };

    await this.opts.store.createRoom(room);
    this.open.set(room.id, room);

    for (const [n, { forked }] of forks.entries()) {
      const fresh = room.participants[n]!;
      const bt = this.botRuntime(room.id, fresh.id);
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
    this.append(room, note);
    await this.saveNewMessage(room, note);

    this.emitMetas();
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
    const taken = new Set(this.listMetas().map((m) => m.title));
    for (let n = 2; ; n++) {
      const name = `${base} (${n})`;
      if (!taken.has(name)) return name;
    }
  }

  /** 이 방에서 갈라져 나간 방들 (D3·분기 목록) */
  childrenOf(roomId: string): RoomMeta[] {
    return this.listMetas().filter((m) => m.forkedFromRoomId === roomId);
  }

  /**
   * 방을 나간다 (B6). **세션과 방 파일이 함께 사라진다.**
   *
   * 진행 중인 턴이 있으면 먼저 중단하고, 그 에이전트의 마지막 방이었으면
   * CLI 프로세스까지 정리한다 — 좀비 프로세스를 남기지 않는다.
   */
  async leaveRoom(roomId: string): Promise<void> {
    const room = this.open.get(roomId) ?? (await this.opts.store.loadRoom(roomId));
    const bot = room ? this.soleBot(room) : undefined;
    const sessionId =
      (bot ? this.runtimes.get(roomId)?.bots.get(bot.id)?.sessionId : undefined) ??
      bot?.sessionId ??
      undefined;

    if (sessionId && room) {
      const conn = this.connections.get(room.participants[0]!.agentId);
      await conn?.cancel(sessionId).catch(() => undefined);
      // **대화가 있으면 삭제, 없으면 해제.** 방을 나가는 건 대화를 지우는 행위이므로
      // 에이전트 쪽 기록도 남기지 않는다. 다만 빈 세션은 CLI 디스크에 아예 없어서
      // `delete`가 실패하므로 구분해야 한다.
      await conn?.deleteSession(sessionId, room.messages.length > 0);
    }

    // 진행 중인 턴이 끝나면서 저장하려 들 수 있다. 되살아나지 않게 막는다.
    this.left.add(roomId);
    this.runtimes.delete(roomId);
    this.open.delete(roomId);
    await this.opts.store.deleteRoom(roomId);
    this.emitMetas();

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
    void this.saveProps(room, { unread: 0, lastReadMessageId: last?.id });
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
  async setActiveRoom(roomId: string | null): Promise<void> {
    if (this.activeRoomId === roomId) return;

    // 나가는 방의 초안을 확정 저장한다 (디바운스 대기 중일 수 있다)
    await this.flushDraft();

    this.activeRoomId = roomId;
    if (roomId) {
      const room = await this.openRoom(roomId);
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
      (b) => !this.botRuntime(room.id, b.id).sessionId,
    );
    if (need.length === 0) return Promise.resolve();

    const running = this.sessionFlight.get(room.id);
    if (running) return running;

    this.setStatus(room.id, "connecting");
    const work = Promise.all(need.map((b) => this.ensureSession(room, b)))
      .then(() => {
        // 붙고 나면 화면이 들고 있는 값이 낡았다 — 이 방의 진짜 값으로 갈아준다
        this.setStatus(room.id, "idle");
        this.emit("room", room);
      })
      .catch((err: unknown) => {
        this.setStatus(room.id, "error");
        this.noteRoom(room, `세션에 붙지 못했습니다 — ${describe(err)}`);
      })
      .finally(() => this.sessionFlight.delete(room.id));

    this.sessionFlight.set(room.id, work);
    return work;
  }

  /**
   * 쓰다 만 메시지를 기억한다.
   *
   * 타이핑마다 디스크를 때리지 않도록 디바운스한다. 방을 나가거나 전송할 때는
   * `flushDraft()`로 즉시 확정한다.
   */
  setDraft(roomId: string, text: string): void {
    const room = this.open.get(roomId);
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
    const room = this.open.get(roomId);
    if (room) await this.saveProps(room, { draft: room.draft });
  }

  // ── 대화 ──────────────────────────────────────────────────────────────

  /**
   * 메시지를 보낸다.
   *
   * 진행 중인 턴이 있으면 **큐에 쌓았다가 끝나면 묶어서** 보낸다(§4.3).
   * 하나씩 순차로 보내면 턴이 여러 번 도는데, 묶으면 한 번이고 에이전트가
   * 전체 요구를 한 번에 본다.
   */
  async send(
    roomId: string,
    text: string,
    attachments?: Attachment[],
    /** 보낼 봇. 안 주면 방의 유일한 봇 (v2.0에서는 멘션이 정한다) */
    botId?: string,
  ): Promise<void> {
    const room = await this.openRoom(roomId);
    // v1.0은 방에 봇이 하나다. 단체방에서는 **멘션된 봇마다** 이 아래가 돈다.
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;
    const bt = this.botRuntime(roomId, bot.id);

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
    this.append(room, sent);

    // **보낸 즉시 저장한다.** 턴이 끝날 때 몰아서 저장하면, 응답을 기다리는 중에
    // VSCode를 닫았을 때 내가 보낸 메시지까지 사라진다.
    await this.saveNewMessage(room, sent);

    // ★ **그 봇이** 도는 중일 때만 쌌는다 — 단체방에서 한 봇이 바쁘다고
    // 다른 봇에게 보낸 말까지 줄을 설 이유가 없다
    const mine = this.statusOf(roomId, bot.id);
    if (mine !== "idle" && mine !== "error") {
      bt.queue.push(sent);
      return;
    }

    // 턴이 끝날 때마다 큐를 비우며 **반복**한다. 재귀로 하면 대화가 길어질수록
    // 스택이 쌓인다.
    let batch = [sent];
    for (;;) {
      await this.runQueue(room, batch, bot.id);
      if (bt.queue.length === 0) return;
      batch = bt.queue.splice(0, bt.queue.length);
    }
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
   * 받았나»가 흐려지고, 봇별 뷰(v2.1)와 응답 짝짓기가 전부 어려워진다. 같이 쓴
   * 것이라는 사실은 `composeGroupId`로 묶어 화면이 붙여 그린다.
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
    const room = await this.openRoom(roomId);
    const parsed = parseCompose(tokens, room.participants);

    // 말해줄 것이 있으면 **보내기 전에** 남긴다 — 건너뛴 그룹을 나중에 알려주면
    // 이미 «보냈다»고 믿은 뒤다.
    for (const w of parsed.warnings) this.noteRoom(room, w, "info");
    if (parsed.blocked) {
      this.noteRoom(room, parsed.blocked, "error");
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
      this.append(room, message);
      await this.saveNewMessage(room, message);
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
        const bt = this.botRuntime(roomId, botId);

        // ★ **그 봇이** 도는 중이면 쌓는다 — 다른 봇이 바쁘다고 줄 설 이유가 없다
        const mine = this.statusOf(roomId, botId);
        if (mine !== "idle" && mine !== "error") {
          bt.queue.push(...batch);
          return;
        }
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
        for (;;) {
          if (bt.queue.length === 0) return;
          await this.runQueue(room, bt.queue.splice(0, bt.queue.length), botId);
        }
      }),
    );
    return parsed;
  }

  /**
   * 전달되지 못한 메시지를 다시 보낸다.
   *
   * 새 말풍선을 만들지 않고 **원래 메시지의 실패 표시만 걷어낸다** — 메신저에서
   * 재전송하면 그 말풍선이 그대로 보내지는 것과 같다.
   */
  async retry(roomId: string, messageId?: string): Promise<void> {
    const room = await this.openRoom(roomId);
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
      await this.saveMessage(room, { id: m.id, sendFailed: undefined, notSentTo: undefined });
      this.emit("message", room.id, m);
    }
    if (byBot.size === 0) return;

    await Promise.all(
      [...byBot].map(async ([botId, batch]) => {
        const bt = this.botRuntime(roomId, botId);
        let run = batch;
        for (;;) {
          await this.runQueue(room, run, botId);
          if (bt.queue.length === 0) return;
          run = bt.queue.splice(0, bt.queue.length);
        }
      }),
    );
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
   * 진행 중인 턴을 중단한다 (C6).
   *
   * ★ **봇 하나만 끊을 수 있다** (v2.0 준비).
   *
   * 단체방에서는 봇마다 자기 턴을 도는데, 그때 «중단»이 방 전체에만 걸리면
   * *"Codex는 그만두고 Claude는 계속"* 이 불가능하다. 세션이 봇 단위이므로(B1)
   * 끊는 단위도 봇이어야 맞다 — `session/cancel`은 애초에 세션에 거는 것이다.
   *
   * 나중에 붙이려면 **부르는 쪽을 전부 고쳐야** 해서 지금 자리를 내둔다.
   * `botId`를 안 주면 예전처럼 **방의 모든 봇**을 끊는다.
   */
  async cancel(roomId: string, botId?: string): Promise<void> {
    const room = this.open.get(roomId);
    const rt = this.runtimes.get(roomId);
    if (!room || !rt) return;

    const targets = botId
      ? room.participants.filter((b) => b.id === botId)
      : room.participants;

    for (const bot of targets) {
      const bt = rt.bots.get(bot.id);
      if (!bt?.sessionId) continue;

      // 큐에 있던 것들은 **아직 안 보냈다.** 그냥 버리면 화면에는 떠 있는데
      // 영영 답이 안 와서 "왜 조용하지"가 된다. 다시 보낼 수 있게 표시한다(C5).
      const dropped = bt.queue.splice(0, bt.queue.length);
      for (const m of dropped) {
        // ★ **안 간 것은 이 봇에게만이다.** 같은 메시지가 옆 봇에게는
        // 멀줦히 갔을 수 있고, 그걸 다시 보내면 **두 번 일하게 된다**.
        m.notSentTo = [...new Set([...(m.notSentTo ?? []), bot.id])];
        m.sendFailed =
          room.participants.length > 1
            ? `${m.notSentTo
                .map((id) => room.participants.find((b) => b.id === id)?.name ?? id)
                .join("·")}에게 보내기 전에 중단했습니다.`
            : "보내기 전에 중단했습니다.";
        await this.saveMessage(room, {
          id: m.id,
          sendFailed: m.sendFailed,
          notSentTo: m.notSentTo,
        });
      }
      await this.connections.get(bot.agentId)?.cancel(bt.sessionId);
    }
  }

  /** 에이전트가 압축 명령을 제공하는지 (C11). 없으면 버튼을 숨긴다 */
  compactCommand(roomId: string, botId?: string): string | undefined {
    const room = this.open.get(roomId);
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
    const room = this.open.get(roomId);
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
    const room = await this.openRoom(roomId);
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.soleBot(room);
    if (!bot) return;
    const cmd = this.compactCommand(roomId, bot.id);
    if (!cmd) throw new Error(`${bot.name}은(는) 압축을 지원하지 않습니다.`);
    await this.send(roomId, `/${cmd}`, undefined, bot.id);
    // 압축되면 역할이 요약에 안 남을 수 있다. 다음 턴에 다시 주입한다 (B3).
    this.botRuntime(room.id, bot.id).roleInjected = false;
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
  ): Promise<acp.SessionConfigOption[]> {
    const room = await this.openRoom(roomId);
    const bot = room.participants[0]!;

    // 🔴 **저장된 `sessionId`를 그대로 쓰면 안 된다.** 창을 껐다 켜면 그 id는
    // 디스크에 남아 있지만 **CLI는 그 세션을 안 들고 있다** — 방을 여는 것만으로는
    // 복구하지 않기 때문이다(복구는 첫 전송에서 일어난다). 그 상태로 설정을 바꾸면
    // 없는 세션에 대고 부르게 된다. `ensureSession`이 복구까지 책임진다.
    // 턴이 도는 중에도 모드를 바꿀 수 있다 — 그 상태를 덮어쓰면 안 된다
    const before = this.statusOf(room.id);
    if (before === "idle") this.setStatus(room.id, "connecting", bot.id);
    let sessionId: string;
    try {
      sessionId = await this.ensureSession(room, bot);
    } finally {
      if (before === "idle") this.setStatus(room.id, "idle", bot.id);
    }

    const conn = this.connection(bot.agentId);
    const updated = await conn.setConfigOption(sessionId, configId, value);
    if (typeof value === "string") this.rememberModel(bot.agentId, configId, value);

    // **권한 모드도 모델 이름도 여기서 봇에 박힌다** (D2·B5) — 응답에 실려 온
    // 현재 값을 그대로 옮기므로, 우리가 보낸 값과 에이전트가 실제로 고른 값이
    // 다르면 에이전트 쪽이 이긴다.
    this.noteRoomConfig(room, bot, updated);
    await this.saveProps(room, { participants: room.participants });

    // 왜 응답 성향이 바뀌었는지 나중에 알 수 있어야 한다
    const opt = updated.find((o) => o.id === configId);

    if (opt?.category === "model") {
      const msg: Message = {
        id: messageId(),
        role: "system",
        // id가 아니라 **보이는 이름으로** 남긴다 — 사용자가 고른 건 그쪽이다
        text: `모델이 ${bot.modelLabel ?? String(value)}(으)로 바뀌었습니다.`,
        deliveredTo: [],
        createdAt: Date.now(),
      };
      this.append(room, msg);
      await this.saveNewMessage(room, msg);
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
    const room = await this.openRoom(roomId);

    // 1:1이면 «그 봇». 여럿인데 지목하지 않으면 누구 얘긴지 알 수 없다.
    const bot = botId
      ? room.participants.find((b) => b.id === botId)
      : room.participants.length === 1
        ? room.participants[0]
        : undefined;
    if (!bot) return;

    if (patch.answerPolicy !== undefined) bot.answerPolicy = patch.answerPolicy;
    if (patch.approver !== undefined) bot.approver = patch.approver;
    await this.saveProps(room, { participants: room.participants });
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
    return this.open.get(roomId)?.usage;
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
    const room = await this.openRoom(roomId);
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

  private async refreshConfigOptions(agentId: string): Promise<acp.SessionConfigOption[]> {
    try {
      const limit = this.opts.configProbeMs ?? CONFIG_PROBE_MS;
      const options = await withTimeout(
        this.connection(agentId).probeConfigOptions(this.opts.host.defaultCwd()),
        limit,
        `${this.agentOrThrow(agentId).label}이(가) 응답하지 않습니다 (${Math.round(
          limit / 1000,
        )}초). 터미널에서 한 번 실행해 로그인·설치를 마쳤는지 확인하세요.`,
      );
      this.configCache.set(agentId, options);
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


  private async runQueue(room: Room, batch: Message[], botId?: string): Promise<void> {
    const rt = this.runtime(room.id);
    // 단체방에서는 **멘션된 봇마다** 이 함수가 돈다. 지금은 하나뿐이다.
    const bot = (botId ? room.participants.find((b) => b.id === botId) : undefined)
      ?? room.participants[0]!;
    const bt = this.botRuntime(room.id, bot.id);
    const conn = this.connection(bot.agentId);

    let sessionId: string;
    try {
      this.setStatus(room.id, "connecting", bot.id);
      sessionId = await this.ensureSession(room, bot);
    } catch (err) {
      // 세션을 못 열었으면 **프롬프트가 아예 안 나갔다.** 해당 메시지들을
      // 실패로 표시해 다시 보낼 수 있게 한다 — 그냥 버리면 다시 타이핑해야 한다.
      const reason = describe(err);
      for (const m of batch) {
        m.sendFailed = reason;
        await this.saveMessage(room, { id: m.id, sendFailed: reason });
      }
      this.setStatus(room.id, "error", bot.id);
      this.emit("roomError", room.id, reason);
      return;
    }

    const prompt = await this.buildPrompt(room, bot, bt, batch);

    const reply: Message = {
      id: messageId(),
      role: "agent",
      authorBotId: bot.id,
      text: "",
      deliveredTo: [bot.id],
      replyToIds: batch.map((m) => m.id),
      createdAt: Date.now(),
      streaming: true,
    };
    this.append(room, reply);

    // **응답 자리를 프롬프트보다 먼저 저장한다.**
    //
    // 이게 없으면 스트리밍 도중에 VSCode가 꺼졌을 때 사용자 메시지만 남고,
    // 다시 켰을 때 "답이 안 달렸으니 전송 실패"로 잘못 판정된다(C5).
    // 실제로는 전송됐고 에이전트가 답까지 했는데 `↻`를 누르면 같은 질문이 두 번 간다.
    await this.saveNewMessage(room, reply);

    this.setStatus(room.id, "waiting", bot.id);

    // 앞 턴이 유예 중이면 **확정하고** 자리를 받는다 — 그냥 밀어내면 디스크에만 빠진다
    this.releaseTurn(room, bot);
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
      this.setStatus(room.id, "error", bot.id);

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
      if (!touched && retryable(reason)) {
        for (const m of batch) {
          m.sendFailed = reason;
          await this.saveMessage(room, { id: m.id, sendFailed: reason });
          this.emit("message", room.id, m);
        }
      }
    }

    // blob 쓰기가 끝나야 해시가 채워진다. 기다리지 않고 저장하면 diff를 잃는다.
    if (rt.pendingWrites.length > 0) {
      await Promise.allSettled(rt.pendingWrites);
      rt.pendingWrites.length = 0;
    }

    reply.streaming = false;

    // 보고 있지 않은 방의 응답만 안 읽은 것으로 센다 (B8)
    if (this.activeRoomId !== room.id) room.unread += 1;

    await this.saveMessage(room, reply);
    await this.saveProps(room, { unread: room.unread, usage: room.usage });
    // 턴이 끝날 때도 바뀐 건 응답 하나다. 방 전체를 보낼 이유가 없다.
    this.emit("message", room.id, reply);
    // **마지막에 놓는다.** 응답보다 늦게 오는 조각이 있어서 — `releaseTurn` 참조
    this.scheduleRelease(room, bot, reply);
    // ★ **이 봇이** 실패한 게 아니면 놓는다 — 다른 봇의 실패가 이 봇을 묶지 않는다
    if (this.statusOf(room.id, bot.id) !== "error") this.setStatus(room.id, "idle", bot.id);
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
        this.setStatus(room.id, "streaming", reply.authorBotId);
        break;

      case "thought":
        reply.thought = (reply.thought ?? "") + ev.delta;
        break;

      case "tool":
        this.setStatus(room.id, "tool", reply.authorBotId);
        this.recordActivity(reply, ev);
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
        if (reply.authorBotId) this.botRuntime(room.id, reply.authorBotId).commands = ev.names;
        break;

      // 🔴 **압축은 «대화의 사건»이다** (C11). 이 지점부터 에이전트가 아는 건
      // 요약본인데 화면에는 전체가 그대로 보인다. 타임라인에 자국을 남기지
      // 않으면 *"아까 말한 거"* 가 왜 안 통하는지 알 길이 없다.
      //
      // **요약 내용은 안 보여준다.** 사용자가 읽을 것은 자기 대화지 요약이 아니다.
      case "compaction":
        this.noteCompaction(room, ev);
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
      mark: "compaction",
      // 보여주려고 담는 게 아니다 — **되먹일 때 앞부분을 대신한다**(F7)
      ...(summary ? { summary } : {}),
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.append(room, mark);
    void this.saveNewMessage(room, mark);
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
    void this.saveProps(room, { participants: room.participants });
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
    const bt = this.botRuntime(room.id, bot.id);
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
    const bt = this.botRuntime(room.id, bot.id);
    const pending = bt.turn;
    if (!pending) return;
    // 예약이 걸린 뒤 다른 턴이 자리를 가져갔으면, 그 예약은 남의 것이다
    if (only && pending !== only) return;

    clearTimeout(bt.tail);
    bt.tail = undefined;
    bt.turn = undefined;
    void this.saveMessage(room, pending);
    this.emit("message", room.id, pending);
  }

  private watchIdle(room: Room, bot: BotInstance, sessionId: string): void {
    this.connection(bot.agentId).listen(sessionId, (ev) => {
      const turn = this.botRuntime(room.id, bot.id).turn;
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
   * 말과 도구 호출은 여기서 방에 심지 않는다. ACP에서 그건 턴에 속하는 것이라
   * 우리가 짝지을 응답이 없고, 늦게 온 꼬리를 새 메시지로 만들면 대화가 겹친다.
   * **다만 조용히 버리지도 않는다** — 로그에 남겨 실제로 오는지 볼 수 있게 한다.
   */
  private onIdleEvent(room: Room, bot: BotInstance, ev: AgentEvent): void {
    switch (ev.type) {
      case "commands":
        this.botRuntime(room.id, bot.id).commands = ev.names;
        this.emit("room", room);
        break;

      case "usage":
        this.noteUsage(room, bot.id, ev);
        void this.saveProps(room, { usage: room.usage, participants: room.participants });
        break;

      case "compaction":
        this.noteCompaction(room, ev);
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
      }
    }
  }

  /**
   * 턴 밖 발화를 담을 메시지 (A11).
   *
   * 잠깐 조용했다가 다시 오면 **다른 말**로 본다 — 한참 전 말풍선에 이어 붙이면
   * 시각이 거짓말을 한다.
   */
  private idleReply(room: Room, bot: BotInstance): Message {
    const bt = this.botRuntime(room.id, bot.id);
    const now = Date.now();
    if (bt.idle && now - bt.idle.at < IDLE_BURST_MS) {
      bt.idle.at = now;
      return bt.idle.message;
    }

    const message: Message = {
      id: messageId(),
      role: "agent",
      authorBotId: bot.id,
      text: "",
      deliveredTo: [bot.id],
      createdAt: now,
    };
    bt.idle = { message, at: now };
    this.append(room, message);
    void this.saveNewMessage(room, message);
    return message;
  }

  /** 에이전트가 스스로 바꾼 모드를 따라간다 (D2) */
  private noteAgentMode(room: Room, botId: string | undefined, modeId: string): void {
    const bot = room.participants.find((b) => b.id === botId) ?? this.soleBot(room);
    if (!bot || bot.agentMode === modeId) return;
    bot.agentMode = modeId;
    void this.saveProps(room, { participants: room.participants });
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
    void this.saveProps(room, { participants: room.participants });
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
    const bt = this.botRuntime(room.id, reply.authorBotId ?? "");
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
    const bt = this.botRuntime(room.id, message.authorBotId ?? "");
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
    reply: Message,
    ev: Extract<AgentEvent, { type: "tool" }>,
  ): void {
    const tools = (reply.tools ??= []);
    const status = ev.status as ToolActivity["status"];
    const at = tools.findIndex((t) => t.id === ev.toolCallId);

    const next: ToolActivity = {
      id: ev.toolCallId,
      // 갱신 이벤트는 제목을 안 줄 수도 있다. 먼저 온 걸 지키자.
      title: ev.title || tools[at]?.title || "도구 사용",
      ...(ev.kind ? { kind: ev.kind } : tools[at]?.kind ? { kind: tools[at]!.kind! } : {}),
      status,
      ...(ev.paths.length > 0 ? { paths: ev.paths } : tools[at]?.paths ? { paths: tools[at]!.paths! } : {}),
      // **명령은 첫 이벤트에만 실려 온다** — 갱신에는 없으니 들고 있던 걸 지킨다
      ...(ev.command ? { command: ev.command } : tools[at]?.command ? { command: tools[at]!.command! } : {}),
      // 결과는 **나중에** 온다 (갱신). 오면 갈아 끼우고, 없으면 있던 걸 지킨다.
      ...(ev.output ? { output: ev.output } : tools[at]?.output ? { output: tools[at]!.output! } : {}),
      // 언제 시작했나. 타임라인으로 읽으려면 시각이 있어야 한다
      ...(tools[at]?.at ? { at: tools[at]!.at! } : { at: Date.now() }),
      // **글의 어디쯤이었나.** 처음 본 시점을 지킨다 — 갱신 때 옮기면 순서가 흐트러진다
      ...(tools[at]?.textAt !== undefined
        ? { textAt: tools[at]!.textAt! }
        : { textAt: reply.text.length }),
    };

    if (at >= 0) tools[at] = next;
    else tools.push(next);
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
    };
    if (!existing) files.push(change);

    // 줄 수는 즉시 계산해 카드에 바로 보여준다
    const counts = countChangedLines(ev.oldText ?? "", ev.newText);
    change.added = counts.added;
    change.removed = counts.removed;

    // blob 쓰기는 비동기지만 **턴이 끝나기 전에 반드시 끝나야 한다** —
    // 안 그러면 해시가 빈 채로 저장되어 diff를 잃는다.
    const write = (async () => {
      if (ev.oldText !== null && !change.oldSha256) {
        change.oldSha256 = await store.putBlob(ev.oldText);
      }
      change.newSha256 = await store.putBlob(ev.newText);
    })().catch((err) => this.opts.host.log(`blob 저장 실패: ${describe(err)}`));

    this.runtime(room.id).pendingWrites.push(write);
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
    // 끊긴 맥락을 되먹인다 (F7). **역할보다 뒤, 실제 요청보다 앞.**
    if (room.refeedPending) {
      const history = transcriptText(room, batch);
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
      room.refeedPending = false;
      void this.saveProps(room, { refeedPending: false });
    }
    if (bot.answerPolicy === "auto") {
      parts.push(
        "[사용자가 자리에 없습니다. 묻지 말고 스스로 판단해 진행하세요.]",
      );
    }
    parts.push(body);

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
    this.noteRoom(
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
    const bt = this.botRuntime(room.id, bot.id);
    if (bt.sessionId) return bt.sessionId;

    const conn = this.connection(bot.agentId);

    if (bot.sessionId) {
      const resumed = await conn.resumeSession(bot.sessionId, room.cwd);
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
        if (room.lostSessionId === bot.sessionId || room.contextLost) {
          const promised = room.refeedPending === true;
          room.contextLost = false;
          delete room.lostSessionId;
          delete room.refeedPending;
          await this.saveProps(room, {
            contextLost: false,
            lostSessionId: undefined,
            refeedPending: undefined,
          });
          this.noteRoom(
            room,
            promised
              ? "이전 세션에 다시 붙었습니다 — 대화를 글로 옮길 필요가 없어졌습니다."
              : "이전 세션에 다시 붙었습니다.",
            "info",
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
        const note: Message = {
          id: messageId(),
          role: "system",
          // 🔴 **왜인지도 같이 적는다** (§0 원칙). 이유가 출력 채널에만 있으면
          // 대부분은 안 열어보고, 그러면 «우리가 끊었나»로 남는다.
          text: `${head} 여기서부터는 새 세션입니다. — ${resumed.reason}`,
          deliveredTo: [],
          createdAt: Date.now(),
        };
        this.append(room, note);
        void this.saveNewMessage(room, note);

        // **화면과 에이전트가 어긋났다.** 사용자가 고를 때까지 들고 있는다.
        room.contextLost = true;
        room.lostSessionId = bot.sessionId;
        await this.saveProps(room, { contextLost: true, lostSessionId: bot.sessionId });
        this.emit("room", room);
      }
    }

    const { sessionId, configOptions } = await conn.newSession(room.cwd, () =>
      // `npx`로 CLI를 처음 받으면 수십 초가 걸린다. 멈춘 줄 알지 않게 알린다.
      this.emit(
        "notice",
        room.id,
        `${this.agentOrThrow(bot.agentId).label}을(를) 처음 시작하는 중입니다. 잠시 걸릴 수 있습니다…`,
      ),
    );
    bt.sessionId = sessionId;
    this.pointAt(bot, sessionId);
    // 세션이 새로 열렸으므로 역할을 다시 넣어야 한다
    bt.roleInjected = false;
    // 새 세션이면 에이전트 기본값으로 시작한다 — 고른 것들을 다시 넣어준다
    if (configOptions.length > 0) await this.restoreChoices(room, bot, sessionId, configOptions);
    this.watchIdle(room, bot, sessionId);

    await this.saveProps(room, {
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
  async decideRefeed(roomId: string, accept: boolean): Promise<void> {
    const room = await this.openRoom(roomId);
    room.contextLost = false;
    room.refeedPending = accept;
    // 사용자가 정했으니 이제 옛 세션을 놓는다
    delete room.lostSessionId;
    await this.saveProps(room, {
      contextLost: false,
      refeedPending: accept,
      lostSessionId: undefined,
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
    const room = await this.openRoom(roomId);
    const bot = this.soleBot(room);
    const lost = room.lostSessionId;
    if (!bot || !lost) return false;

    const resumed = await this.connection(bot.agentId).resumeSession(lost, room.cwd);
    if (!resumed.ok) {
      this.noteRoom(room, `아직 이어받을 수 없습니다 — ${resumed.reason}`);
      return false;
    }

    const bt = this.botRuntime(room.id, bot.id);
    bt.sessionId = lost;
    bt.roleInjected = true;
    bot.sessionId = lost;
    bot.sessionPrompted = true;
    room.contextLost = false;
    delete room.refeedPending;
    delete room.lostSessionId;

    if (resumed.options.length > 0) await this.restoreChoices(room, bot, lost, resumed.options);
    this.watchIdle(room, bot, lost);

    const note: Message = {
      id: messageId(),
      role: "system",
      text: "이전 세션을 다시 이어받았습니다.",
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.append(room, note);
    await this.saveNewMessage(room, note);
    await this.saveProps(room, {
      participants: room.participants,
      contextLost: false,
      refeedPending: undefined,
      lostSessionId: undefined,
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

    // **권한을 먼저.** 모델·강도를 바꾸는 사이에도 권한은 지켜져야 한다.
    const order = (o: acp.SessionConfigOption) => (o.category === "mode" ? 0 : 1);
    for (const opt of [...options].sort((a, b) => order(a) - order(b))) {
      const value = want[opt.id];
      if (value === undefined) continue;

      const live = now.find((o) => o.id === opt.id);
      if (!live || live.currentValue === value) continue;

      // 에이전트가 더 이상 안 주는 값이면 **우기지 않는다** — 그쪽이 진실이다
      if (live.type === "select") {
        const offered = live.options.some((e) =>
          "group" in e ? e.options.some((v) => v.value === value) : e.value === value,
        );
        if (!offered) continue;
      }

      try {
        now = await this.connection(bot.agentId).setConfigOption(sessionId, opt.id, value);
      } catch (err) {
        this.opts.host.log(`[${bot.agentId}] ${opt.id} 복원 실패: ${describe(err)}`);
      }
    }
    this.noteRoomConfig(room, bot, now);
  }

  private noteRoomConfig(
    room: Room,
    bot: BotInstance,
    options: acp.SessionConfigOption[],
  ): void {
    this.roomConfigs.set(configKeyOf(room.id, bot.id), options);
    // 만들기 화면의 기본값으로도 쓴다 — 최소한 최근에 본 목록이다
    this.configCache.set(bot.agentId, options);
    if (noteModel(bot, options)) this.emitMetas();

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
   * 방에 **기록으로** 남긴다 (§0 P5).
   *
   * 🔴 예전에는 이런 안내를 `roomError`·`notice` 이벤트로만 보냈다. 웹뷰는 그걸
   * **DOM에 직접** 붙이는데, 방을 다시 그릴 때 목록을 통째로 갈아끼우므로
   * **이름만 바꿔도 사라졌다.** 실제로 그렇게 날아가던 것들:
   *
   * - *"프로세스가 종료되어 답변이 끊겼습니다. 다시 보내면 이어서 합니다."*
   * - *"…는 이미지를 받지 못해 «캡처.png»를 보내지 않았습니다."* ← **정보 손실 통보**
   * - *"세션을 열지 못했습니다 — …"*
   *
   * **우리는 껍데기다.** 무엇을 남기고 무엇을 지울지 고를 처지가 아니고,
   * 특히 «못 했다»는 사실은 나중에 *"왜 그때 답이 없었지"* 를 푸는 유일한 단서다.
   * 그러니 **대화에 박아 둔다** — 껐다 켜도, 다시 그려도 남는다.
   *
   * 진행 안내(*"처음 시작하는 중입니다"*)는 여전히 `notice`로 흘린다. 그건 곧
   * 해소되는 것이라 남기면 방마다 부스러기가 쌓인다.
   *
   * ★ **같은 말을 연달아 쌓지 않는다.** 방을 열 때마다 붙기를 실패하면 같은 줄이
   * 계속 늘어난다 — 권한 카드가 쌓이던 것과 같은 실수를 반복하지 않는다.
   */
  private noteRoom(room: Room, text: string, kind: "error" | "info" = "error"): void {
    const last = room.messages.at(-1);
    if (last?.role === "system" && last.text === text) return;

    const msg: Message = {
      id: messageId(),
      role: "system",
      text,
      deliveredTo: [],
      createdAt: Date.now(),
      ...(kind === "error" ? { mark: "error" as const } : {}),
    };
    this.append(room, msg);
    void this.saveNewMessage(room, msg);
    this.emit("message", room.id, msg);
  }

  private recordDecision(sessionId: string, note: string): void {
    const room = this.roomForSession(sessionId);
    if (!room) return;
    const msg: Message = {
      id: messageId(),
      role: "system",
      text: note,
      deliveredTo: [],
      createdAt: Date.now(),
    };
    this.append(room, msg);
    void this.saveNewMessage(room, msg);
  }

  private onAgentCrash(agentId: string, reason: string): void {
    for (const [roomId, room] of this.open) {
      if (!room.participants.some((b) => b.agentId === agentId)) continue;

      // **그 에이전트를 쓰는 봇만** 세션을 잃는다. 단체방에서 Codex가 죽어도
      // 같은 방의 Claude는 멀쩡하다.
      const rt = this.runtimes.get(roomId);
      for (const b of room.participants) {
        if (b.agentId !== agentId) continue;
        const bt = rt?.bots.get(b.id);
        if (!bt) continue;
        bt.sessionId = undefined;
        bt.roleInjected = false;
      }
      const hit = room.participants.filter((b) => b.agentId === agentId);
      // ★ **그 에이전트를 쓰는 봇만** 오류다 — 같은 방의 다른 봇은 멀줦하다
      /*
       * 🔴 **`isBusy`로 거르면 놓친다.** 프로세스가 죽으면 `prompt`가 먼저
       * 거절돼 상태가 이미 `error`일 수 있고, `isBusy("error")`는 false다.
       * 그러면 «프로세스가 종료되었다»를 안 적게 된다 — 실제로 그렇게 깨졌다.
       * 기준은 «바쁜가»가 아니라 **«조용하지 않았나»**다.
       */
      if (hit.some((b) => this.statusOf(roomId, b.id) !== "idle")) {
        for (const b of hit) this.setStatus(roomId, "error", b.id);
        this.noteRoom(
          room,
          `${this.agentOrThrow(agentId).label} 프로세스가 종료되어 ` +
            `답변이 끊겼습니다 (${reason}). 다시 보내면 이어서 합니다.`,
        );
      }
    }
  }

  private connection(agentId: string): AcpConnection {
    let conn = this.connections.get(agentId);
    if (!conn) {
      conn = new AcpConnection(
        this.agentOrThrow(agentId),
        this.opts.host,
        (sessionId) => this.answerPolicyForSession(sessionId),
        (reason) => this.onAgentCrash(agentId, reason),
        (sessionId, note) => this.recordDecision(sessionId, note),
        (sessionId, req) => this.askApprover(sessionId, req),
      );
      this.connections.set(agentId, conn);
    }
    return conn;
  }

  /** 쓰이지 않는 CLI 프로세스를 정리한다 (B6) */
  private disposeUnusedConnections(): void {
    const inUse = new Set(this.listMetas().flatMap((m) => m.agentIds));
    for (const [agentId, conn] of this.connections) {
      if (inUse.has(agentId)) continue;
      conn.dispose();
      this.connections.delete(agentId);
    }
  }

  private runtime(roomId: string): RoomRuntime {
    let rt = this.runtimes.get(roomId);
    if (!rt) {
      rt = { status: "idle", pendingWrites: [], bots: new Map() };
      this.runtimes.set(roomId, rt);
    }
    return rt;
  }

  /**
   * 그 **봇의** 실행 상태 (B1).
   *
   * 1:1에서는 방에 하나뿐이라 `runtime(roomId)`과 같은 말이지만, 세션에 딸린
   * 것을 여기서 읽어두면 **단체방에서 봇을 늘릴 때 부르는 쪽을 안 고친다.**
   */
  private botRuntime(roomId: string, botId: string): BotRuntime {
    const rt = this.runtime(roomId);
    let bt = rt.bots.get(botId);
    if (!bt) {
      bt = {
        status: "idle",
        queue: [],
        roleInjected: false,
        commands: [],
        lastEmit: 0,
        lastSave: 0,
      };
      rt.bots.set(botId, bt);
    }
    return bt;
  }

  /** 방의 유일한 봇 (v1.0). 단체방에서는 부르는 쪽이 봇을 지목해야 한다 */
  private soleBot(room: Room): BotInstance | undefined {
    return room.participants[0];
  }

  /**
   * 상태를 바꾼다 — **봇 단위로** (v2.0 준비).
   *
   * 🔴 예전에는 방에 상태가 하나뿐이었다. 봇이 하나일 때는 같은 말이지만,
   * 여럿이 각자 턴을 돌면 **누가 답하는 중인지 말할 수가 없다.** 세션이 봇
   * 단위이므로(B1) 상태도 봇 단위여야 맞다.
   *
   * `botId`를 안 주면 **방의 모든 봇**에 건다 — 세션을 붙이거나 방이 통째로
   * 실패할 때처럼 진짜 방 단위인 일들이 있다.
   *
   * 방의 상태는 **봇들에서 파생된다**(`mergeStatus`) — 따로 들고 있으면 둘이
   * 어긋난다.
   */
  private setStatus(roomId: string, status: RoomStatus, botId?: string): void {
    const rt = this.runtime(roomId);
    const room = this.open.get(roomId);
    const ids = botId
      ? [botId]
      : (room?.participants.map((b) => b.id) ?? [...rt.bots.keys()]);

    for (const id of ids) this.botRuntime(roomId, id).status = status;

    const bots: Record<string, RoomStatus> = {};
    for (const [id, bt] of rt.bots) bots[id] = bt.status;
    const merged = mergeStatus(Object.values(bots));

    // 방 상태가 그대로여도 **봇별 상태는 바뀌었을 수 있다** — 화면이 알아야 한다
    const same = rt.status === merged;
    rt.status = merged;
    if (!same || botId !== undefined) this.emit("status", roomId, merged, bots);
  }

  private append(room: Room, message: Message): void {
    room.messages.push(message);
    room.lastActivityAt = message.createdAt;
    this.emit("message", room.id, message);
  }

  /**
   * 방 속성만 갱신한다 (제목·미읽음·초안 등).
   *
   * 트랜스크립트가 JSONL이라 **한 줄만 덧붙인다** — 방이 길어져도 비용이 같다.
   */
  private async saveProps(
    room: Room,
    patch: Partial<Omit<Room, "messages">>,
  ): Promise<void> {
    if (this.left.has(room.id)) return;
    await this.opts.store.updateRoom(room, patch);
    this.emitMetas();
  }

  private async saveNewMessage(room: Room, message: Message): Promise<void> {
    if (this.left.has(room.id)) return;
    await this.opts.store.appendMessage(room, message);
    this.emitMetas();
  }

  private async saveMessage(
    room: Room,
    patch: Partial<Message> & { id: string },
  ): Promise<void> {
    if (this.left.has(room.id)) return;
    await this.opts.store.updateMessage(room, patch);
    this.emitMetas();
  }

  private emitMetas(): void {
    this.emit("metas", this.listMetas());
  }

  /**
   * 승인을 **대상에게 묻고 답을 돌려준다** (D2).
   *
   * 권한은 「봇 : 범위 : 대상」이다. 범위(`autoApprove`)가 자동 승인을 안 해주면
   * 여기로 오고, 대상(`approver`)이 누가 답할지 정한다.
   *
   * **승인 주체가 넘어가는 게 아니다.** `session/request_permission`은 클라이언트
   * 메서드라 응답은 언제나 우리가 만든다 — 대상은 «누구 말을 듣나»일 뿐이고,
   * 그래서 기록(D3)도 제한도 우리 손에 남는다.
   */
  private async askApprover(
    sessionId: string,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    const found = this.botForSession(sessionId);
    const approver = found?.bot.approver ?? ASK_USER;

    if (approver.kind === "bot") {
      // v2.0에서 붙는다 (§4.2.2). 아직은 사람에게 넘기되 **조용히 넘기지 않는다** —
      // 맡겼다고 생각하고 자리를 비우면 안 된다.
      this.emit(
        "notice",
        found!.room.id,
        `봇 심사는 아직 준비되지 않아 «${req.title}»을 직접 물어봅니다.`,
      );
    }
    return this.opts.host.requestPermission(req);
  }


  /** 그 세션의 질문 정책 (D5). 같은 이유로 봇에서 읽는다 */
  private answerPolicyForSession(sessionId: string): AnswerPolicy {
    return this.botForSession(sessionId)?.bot.answerPolicy ?? "ask";
  }

  /** 세션 하나는 봇 하나에 속한다 (B1). 방까지 함께 돌려준다 */
  private botForSession(sessionId: string): { room: Room; bot: BotInstance } | undefined {
    for (const room of this.open.values()) {
      const bot = room.participants.find((b) => b.sessionId === sessionId);
      if (bot) return { room, bot };
    }
    return undefined;
  }

  private roomForSession(sessionId: string): Room | undefined {
    return this.botForSession(sessionId)?.room;
  }

  private agentOrThrow(agentId: string): AgentDef {
    const agent = this.opts.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`알 수 없는 에이전트: ${agentId}`);
    return agent;
  }

  private nextDefaultTitle(): string {
    const used = this.listMetas().filter((m) => /^새 대화 \d+$/.test(m.title));
    return `새 대화 ${used.length + 1}`;
  }

  dispose(): void {
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

function messageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

