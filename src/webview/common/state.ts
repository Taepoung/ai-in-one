/**
 * ★ **창 공통 — 상태** · 확장과 말하는 길(`post`) · 부팅 값 · 설정 캐시 · 에이전트 조회.
 */
import type { McpState } from "../../core/mcpServer.js";
import type {
  AgentQuota,
  Attachment,
  BotInstance,
  Clash,
  JoinFail,
  JoinStep,
  ReviewWait,
  Room,
  RoomMeta,
  RoomStatus,
  RoomUsage,
  SearchHit,
  WaitItem,
} from "../../core/types.js";
import type {
  AskCard,
  AuthRow,
  Boot,
  ConfigOptionBrief,
  FromWebview,
  ToWebview,
} from "../../protocol.js";
import type { ChatEls } from "../chat/chat.js";
import type { ScreenName } from "./screens.js";

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };

const vscode = acquireVsCodeApi();

export const post = (m: FromWebview) => vscode.postMessage(m);

export const boot: Boot = JSON.parse(document.getElementById("boot")!.textContent!);

export const statuses = new Map<string, RoomStatus>();

/** 지금 뷰의 봇 (방에서 나갔으면 `undefined` — 그때는 뷰도 풀어야 한다) */
export function viewBot(r: Room): BotInstance | undefined {
  return S.viewBotId ? r.participants.find((b) => b.id === S.viewBotId) : undefined;
}

export const configs = new Map<string, ConfigOptionBrief[]>();

/**
 * 설정을 못 불러온 이유.
 *
 * **«아직 안 왔다» · «없다» · «실패했다» 는 서로 다른 화면이어야 한다.**
 * 셋을 하나로 뭉치면 CLI가 안 뜬 걸 *"이 에이전트는 권한 모드가 없다"* 로
 * 읽게 된다 — 사용자가 고칠 수 있는 문제인데 고칠 수 없는 것처럼 보인다.
 */
export const configErrors = new Map<string, string>();

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
export function configKey(agentId: string, roomId?: string, botId?: string): string {
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
export function askConfig(agentId: string): void {
  const key = configKey(agentId);
  if (configs.has(key) && !configErrors.has(key)) return;
  configs.delete(key);
  configErrors.delete(key);
  post({ t: "needConfig", agentId });
}

export function optionsFor(
  agentId: string,
  roomId?: string,
  botId?: string,
): ConfigOptionBrief[] | undefined {
  return configs.get(configKey(agentId, roomId, botId));
}

/** 답을 기다리는 카드들. 방을 나갔다 와도 남아 있어야 한다 */
export const cards: AskCard[] = [];

/** 답했거나 취소된 카드를 치운다. 실제로 치웠으면 `true` (두 번 답하기 방지) */
export function dropCard(id: string): boolean {
  const at = cards.findIndex((c) => c.id === id);
  if (at < 0) return false;
  cards.splice(at, 1);
  return true;
}

export const agentById = new Map(boot.agents.map((a) => [a.id, a]));

/**
 * ★ **지금 쓸 수 있는 에이전트** (2026-10-01) — `src/core/install/README.md`.
 *
 * 안 받은 것은 방 만들기 목록에 안 뜨고, 이미 쓰던 방은 막힌다.
 * `boot` 으로 시작해서 설정 화면이 줄 `agents` 로 갱신된다 — 받자마자
 * 목록에 뜨게 하려는 것이다.
 */
export const agentAvail = new Set(
  boot.agents.filter((a) => a.available !== false).map((a) => a.id),
);

/** 그 봇이 지금 돌 수 없는 상태인가 */
export function agentGone(b: BotInstance): boolean {
  return !agentAvail.has(b.agentId);
}

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
export const PAGE = 50;



/**
 * ★ **창들이 같이 쓰는 상태** (webview 나누기, 2026-10-20).
 *
 * 한 모듈 안에서만 쓰는 것은 그 모듈의 `let` 으로 둔다. 여기 있는 것은 **둘 이상의
 * 모듈이 읽거나 바꾸는 것**뿐이다 — ES 모듈은 남의 `let` 을 다시 대입할 수 없어서,
 * 한 객체의 칸으로 둔다. 이름은 옮기기 전 그대로다(`room` → `S.room`).
 */
export const S = {
  metas: boot.rooms as RoomMeta[],
  room: null as Room | null,
  compactable: false as boolean,
  /** 압축을 시킬 수 있는 봇들 — 에이전트마다 다르다 */
  compactableBots: [] as string[],
  /**
   * 방의 컨텍스트 점유.
   *
   * **화면에 숫자로 보여주지 않는다** — 토큰·비용은 대화를 읽는 데 방해가 된다.
   * 여기 들고 있는 이유는 **압축 배너(C11)** 하나다: 컨텍스트가 90%를 넘으면
   * «대화 압축하기»를 띄운다. 그건 정보가 아니라 **할 일**이다.
   */
  usage: undefined as RoomUsage | undefined,
  firstUnreadId: undefined as string | undefined,
  /**
   * 봇별 상태 — **지금 보는 방의 것만** (v2.0 준비).
   *
   * 방마다 들고 있을 이유가 없다 — 상태 줄은 열린 방에만 그려진다.
   * 목록은 합친 값하나면 충분하다.
   */
  botStatus: {} as Record<string, RoomStatus>,
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
  reviews: [] as ReviewWait[],
  /**
   * ★ **봇마다 들고 있는 대기** (§5-M) — 지금 보는 방의 것만.
   *
   * 🔴 `reviews` 와 겹쳐 보이지만 다른 물건이다. 저쪽은 «**얼어 있는 봇**이
   * 누구를 기다리나»라 채팅에 띠로 서고, 이쪽은 «**이 봇 앞에** 무엇이
   * 서 있나»라 봇마다 모인다 — 봇이 건 말은 아무도 안 얼리므로 저쪽에는
   * 아예 안 뜬다.
   */
  waiting: [] as WaitItem[],
  /** 대기 화면이 **누구 것인가** — 그 봇이 방을 떠나면 자리가 사라진다 */
  waitBotId: null as string | null,
  /** 지금 부딪히는 파일들 (§4.3). 방을 옮기면 갈아 끼운다 */
  clashes: [] as Clash[],
  /**
   * ★ **지금 보고 있는 봇** (v2.1 · §5) — `null` 이면 방 전체.
   *
   * 🔴 **방이 아니라 필터다.** 데이터는 하나고 보는 창만 다르다. 그래서 별도
   * 화면을 만들지 않았다 — 화면을 나누면 «별개 공간»이라는 오해가 구조에서
   * 생기고, «1:1 뷰에서 보냄» 같은 표시를 만들고 싶어진다(§5가 하지 말라는 것).
   *
   * 방을 옮기면 풀린다. 뷰는 **그 방 안의 상태**다.
   */
  viewBotId: null as string | null,
  /**
   * ★ **봇끼리 부르는 길이 어느 칸인가** (v3.0 2-F).
   *
   * 방마다가 아니라 **창마다**다 — 서버가 창에 하나이기 때문이다.
   */
  mcpAt: { at: "off" } as McpState,
  stack: ["list"] as ScreenName[],
  /** 현재 워크스페이스 방만 보기 토글 */
  onlyHere: false as boolean,
  /** 목록 화면의 필터어. 메타는 이미 메모리에 있어 사실상 공짜다 (H1) */
  filterText: "" as string,
  /** 전문 검색 결과 (H2). 비어 있지 않으면 목록 대신 결과를 그린다 */
  hits: null as SearchHit[] | null,
  /** 방을 열 때 점프할 메시지 (H3) */
  jumpToMessageId: undefined as string | undefined,
  /** 지금 방에서 **몇 개까지 그리나** — 방을 바꾸면 처음으로 돌아간다 */
  shownCount: PAGE as number,
  /**
   * ★ **찾아가기 전에 읽던 자리** (2026-09-23).
   *
   * 위로 뛰면 **자동 따라가기가 풀린다** — 아래에서 턴이 도는데 옛날 것을 보고
   * 있게 된다. 돌아올 자리를 적어두고 띠로 내어준다.
   *
   * 화면이 **실제로 움직였을 때만** 적는다. 안 움직였으면 돌아갈 데가 없다.
   */
  backTo: undefined as number | undefined,
  draftCwd: "" as string,
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
  peeking: null as string | null,
  /**
   * ★ **마지막에 받아둔 구독 잔량** (사용자, 2026-10-19).
   *
   * 🔴 **들고 있는다.** 한 번 받는 데 최대 20초(Antigravity)라, 팝업을 열
   * 때마다 빈 화면부터 보여주면 «눌러도 아무 일이 없다» 가 된다. 지난 것을
   * 먼저 세우고 **언제 받은 것인지**를 같이 적는다 — 낡은 수를 새 수인 척
   * 보여주지만 않으면 된다.
   */
  quota: null as AgentQuota[] | null,
  quotaBusy: false as boolean,
  /** 줄 하나만 다시 받는 중인 에이전트들 — 그 줄만 «받는 중» 이 된다 */
  quotaBusyFor: new Set<string>() as Set<string>,
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
  agentRows: [] as Extract<ToWebview, { t: "agents" }>["list"],
  /**
   * ★ **디스크 정리 칸** (2026-11-19). `spots` 는 마지막으로 잰 것 — 다시 재는 동안에도
   * 그대로 보여준다(칸이 사라졌다 나타나면 누르려던 단추가 도망간다).
   */
  clean: { spots: undefined, busy: undefined, said: undefined } as {
    spots: Extract<ToWebview, { t: "clean" }>["spots"];
    busy: string | undefined;
    said: string | undefined;
  },
  /**
   * ★ **에이전트 설정 화면** (2026-10-01) — `src/core/install/README.md`.
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
  joinFails: new Map<string, { kind: JoinFail; why: string }>() as Map<string, { kind: JoinFail; why: string; }>,
  /** 그 봇이 **어느 칸**에 있나 — 없으면 아직 시작도 안 했거나 이미 붙어 있다 */
  joinSteps: new Map<string, JoinStep>() as Map<string, JoinStep>,
  /** 지금 그리고 있는 확인 줄 — 호스트가 보낼 때마다 갈린다 */
  authList: boot.auth ?? [] as AuthRow[],
  authStuck: false as boolean,
  chat: null as ChatEls | null,
  pickerRows: [] as Array<() => void>,
  pickerAt: 0 as number,
  /** 마지막으로 지목한 그룹 — 자동완성 맨 위에 올린다 */
  lastGroup: [] as string[],
  /** 보낼 준비가 된 첨부들. 전송하면 비워진다 */
  pending: [] as Attachment[],
  stick: true as boolean,
};

