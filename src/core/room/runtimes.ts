/**
 * ★ **봇 상태** — 턴·깊이·상태처럼 디스크에 안 남는 것 (리팩토링 ⑧ L1, 2026-10-20).
 *
 * 껐다 켜면 전부 비어 있고 `bot.sessionId` 로 되살린다. 받는 것은 열린 방을 보는
 * 길과 알리는 길뿐이다(`RuntimesPort`) — 저장(L0) 바로 위층이다.
 *
 * `get` 은 **있으면 보기**(안 만든다), `room`·`bot` 은 **없으면 만든다**. 상태를
 * 묻기만 하는 자리가 빈 칸을 만들어 두면, 나간 방의 칸이 되살아난다.
 */
import type { BotInstance, Clash, Message, Room, RoomStatus } from "../types.js";

/**
 * **봇 하나**의 실행 상태 (B1).
 *
 * 세션이 봇 단위이므로 세션에 딸린 것은 전부 여기 있다. v2.0 단체방에서
 * 봇이 여럿이면 **봇마다 자기 세션·자기 큐·자기 턴**을 갖는다 — 지금은
 * 하나뿐이라 결과가 같지만, **모양을 먼저 맞춰두면 나중에 다시 짜지 않는다.**
 *
 * 디스크에 저장하지 않는다 — 껐다 켜면 전부 비어 있고 `bot.sessionId`로 복구한다.
 */
export interface BotRuntime {
  /** 지금 붙어 있는 ACP 세션. 복구했든 새로 만들었든 여기 담긴다 */
  sessionId?: string;
  /**
   * ★ **루프모드** (2026-10-20) — 이 봇에게 몇 번 다시 물었나 · «종료» 했나 ·
   * 마지막으로 언제 물었나(그 뒤의 답을 보고 «종료» 를 가린다). 사용자가 새로 말을
   * 걸면 셋 다 비운다(`Loops`).
   */
  loopRounds?: number;
  loopDone?: boolean;
  loopAskedAt?: number;
  /** 역할을 이미 주입했는지. 세션이 새로 열리면 다시 false가 된다 */
  roleInjected: boolean;
  /**
   * ★ **이 턴이 사용자에게서 몇 다리 건너왔나** (v3.0 4-L).
   *
   * 사용자가 연 턴은 `0`. 이 봇이 이 턴에 거는 말은 전부 `depth + 1` 이다.
   *
   * **턴에 붙는 값**이라 `say` 의 인자로는 못 흔든다. 그게 요점이다.
   */
  depth?: number;
  /**
   * ★ **이 턴의 사용자 말에 대해 이미 보낸 봇들** (v3.0 4-L, 2026-10-12).
   *
   * 🔴 `say(id: "0")` 은 **깊이가 1 이라 상한에 구조적으로 안 걸린다.** 그리고
   * 한 턴에 몇 번이든 부를 수 있었다 — 실측에서 **스무 번이 다 나갔다.**
   * 사용자 말 한 마디가 가지를 **무한히** 열 수 있었다는 뜻이다.
   *
   * 「같은 봇에게 한 번」으로 묶으면 **방의 봇 수가 곧 상한**이 되고, 숫자를
   * 하나도 안 늘린다. 여럿에게는 `to` 가 목록이라 손해도 없다.
   */
  saidZero?: Set<string>;
  /**
   * ★ **이 턴을 사용자가 열었나** (v3.0 4-L) — `say(id: "0")` 이 여기에 걸린다.
   *
   * ⏪ 한때 `depth === 0` 으로 갈음했다. **깨졌다** — 사용자가 끼어들면 밀린
   * 항목들의 깊이를 0 으로 되돌리는데(`resetDepth`), 그러면 **봇이 깨운 턴도**
   * 깊이 0 이 되어 «사용자가 열었다»로 읽힌다. 그 길로 사슬 깊은 데 있는 봇이
   * 새 가닥을 시작할 수 있다.
   *
   * **둘은 다른 질문이다** — «얼마나 멀리 왔나»와 «누가 열었나».
   */
  fromUser?: boolean;
  /**
   * ★ **마지막으로 보낸 명단 글** (v3.0 4-K).
   *
   * 🔴 **«언제 다시 보내나» 를 목록으로 관리하지 않는다.** 이름 · 설명 ·
   * 구성 · 릴레이 토글 — 무효화할 자리를 하나씩 적어두면 **새로 생기는 자리를
   * 반드시 빠뜨린다.** 대신 **지은 글을 그대로 들고** 있다가 달라졌을 때만
   * 보낸다. «표에 적히는 것이 바뀌면 다시» 가 저절로 지켜진다.
   *
   * `undefined` 는 **한 번도 안 보냈다**는 뜻이고, 그 구별이 필요하다 —
   * 처음부터 꺼진 방에는 «못 겁니다» 조차 안 보낸다(봇은 누가 있는지도 모른다).
   */
  rosterSent?: string;
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
  /**
   * ★ **사용자가 방금 끊었다** (전체 중지).
   *
   * 다음 프롬프트 앞에 **무슨 일이 있었는지 한 줄**을 얹으라는 표시다.
   *
   * 🔴 ACP 의 `session/cancel` 은 턴을 끊을 뿐 **«왜»를 안 알려준다**(실측
   * 2026-09-23). 그 빈칸을 모델이 **추측으로 메우는데 그 추측이 판마다 다르다** —
   * 한 판은 «권한이 거부돼서»라고 지어냈다. 그러면 우회를 시도하거나 «권한을
   * 열어달라»는 엉뚱한 말을 한다. **빈칸은 우리가 채운다.**
   *
   * ⏪ 원래는 «끼어들기» 가 세우던 표시였다. 끼어들기는 없앴지만(v3.0 1-D)
   * **이 한 줄은 중지에도 그대로 필요하다** — 끊긴 이유를 모르는 건 똑같다.
   */
  interrupted?: boolean;
  /** 턴을 놓기까지의 유예 타이머. `releaseTurn` 참조 */
  tail?: ReturnType<typeof setTimeout>;
  /**
   * ★ **턴 밖 발화를 닫는 타이머** (2026-09-28).
   *
   * 봇이 스스로 깨어나 말할 때도 «끝»이 있어야 한다 — 상태를 내리고 미읽음을
   * 센다. `closeIdle` 참조.
   */
  idleClose?: ReturnType<typeof setTimeout>;
  /**
   * **줄을 빼내는 중인가** (2026-09-28).
   *
   * 빼는 자리가 둘이 되었으므로(`send` 와 `closeIdle`) 겹치면 **한 묶음이 두
   * 턴으로** 돌 수 있다. 하나만 돌게 한다.
   */
  /**
   * ★ **이 봇이 아직 못 적은 blob 쓰기들** (E6).
   *
   * 파일 변경 전문은 대화에 안 담는다 — 100KB짜리를 스무 번 고치면 방 파일이
   * 4MB가 되어 열기도 검색도 망가진다. 대신 `blobs/<sha256>` 에 쓰고 **해시만**
   * 기록한다. 그 쓰기가 비동기라, **끝나기 전에 메시지를 저장하면 해시가 빈
   * 채로 남아 diff를 영영 못 본다.**
   *
   * 🔴 예전에는 `RoomRuntime` 에 있었다. 봇이 나란히 돌면 **한 봇이 «다
   * 기다렸다»며 목록을 비울 때 다른 봇의 영수증까지 지웠다** — 그 봇은
   * 기다릴 것이 없다고 보고 해시가 빈 채로 저장할 수 있었다.
   */
  pendingWrites: Promise<unknown>[];
  /**
   * ★ **이 세션을 열 때 우리 MCP 를 실어 보냈나** (리팩토링 ⑦-2, 2026-10-20).
   *
   * 🔴 도구는 **세션을 열 때** 붙는다. MCP 가 꺼져 있던 때 연 세션은, 나중에
   * MCP 가 살아나도 `say`·`check_queue`·`verdict` 가 **없다.** 심사 봇에게 권한을
   * 넘길 때 «세션이 열렸나» 만 보면, 판정할 길이 없는 봇에게 넘겨 요청한 봇의
   * 턴이 얼어붙는다 — 사람이 가로채야 풀린다. `mcpFor` 가 적는다.
   */
  mcpOffered?: boolean;
}

/**
 * **방 하나**의 실행 상태 — 봇과 무관한 것만 남긴다.
 *
 * 화면에 뜨는 상태는 방 단위다(«작업 중» 표시가 하나). v2.0에서 봇이 병렬로
 * 돌면 여기서 **봇들의 상태를 합쳐** 정하게 된다.
 */
export interface RoomRuntime {
  status: RoomStatus;
  /** 봇별 상태. 열쇠는 `BotInstance.id` */
  bots: Map<string, BotRuntime>;
  /**
   * **지금 부딪히고 있는 파일들** — 열쇠는 경로 (§4.3).
   *
   * 한 파일을 스무 줄 고치면 이벤트도 여러 번 온다. 그때마다 적으면 대화가
   * 경고로 덮이므로 **파일마다 하나만** 들고 상태만 갱신한다.
   */
  clashes: Map<string, ClashState>;
}

/** 방 안에서만 쓰는 여벌 — 「이미 기록했나」는 화면에 보낼 것이 아니다 */
export interface ClashState extends Clash {
  /** 시스템 메시지를 이미 남겼나 — 같은 부딪힘으로 두 번 적지 않는다 */
  noted?: boolean;
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

/** 봇 상태층이 받는 것 — 이게 전부다 */
export interface RuntimesPort {
  /** 열린 방 — 닫혔으면 없다 */
  roomById(roomId: string): Room | undefined;
  openRooms(): Iterable<Room>;
  emitStatus(roomId: string, status: RoomStatus, bots: Record<string, RoomStatus>): void;
  /** 부딪힘 띠는 상태가 정한다 — 상태가 바뀌면 다시 알린다 */
  emitClashes(roomId: string): void;
}

export class Runtimes {
  /** 방마다. 열쇠는 방 id */
  private readonly byRoom = new Map<string, RoomRuntime>();

  constructor(private readonly port: RuntimesPort) {}

  /** 있으면 본다 — **안 만든다** */
  get(roomId: string): RoomRuntime | undefined {
    return this.byRoom.get(roomId);
  }

  /** 방을 나갈 때 — 그 방의 칸을 걷는다 */
  delete(roomId: string): void {
    this.byRoom.delete(roomId);
  }

  values(): IterableIterator<RoomRuntime> {
    return this.byRoom.values();
  }

  clear(): void {
    this.byRoom.clear();
  }

  room(roomId: string): RoomRuntime {
    let rt = this.byRoom.get(roomId);
    if (!rt) {
      rt = { status: "idle", bots: new Map(), clashes: new Map() };
      this.byRoom.set(roomId, rt);
    }
    return rt;
  }

  /**
   * 그 **봇의** 실행 상태 (B1).
   *
   * 1:1에서는 방에 하나뿐이라 `room(roomId)`과 같은 말이지만, 세션에 딸린
   * 것을 여기서 읽어두면 **단체방에서 봇을 늘릴 때 부르는 쪽을 안 고친다.**
   */
  bot(roomId: string, botId: string): BotRuntime {
    const rt = this.room(roomId);
    let bt = rt.bots.get(botId);
    if (!bt) {
      bt = {
        status: "idle",
        roleInjected: false,
      pendingWrites: [],
        commands: [],
        lastEmit: 0,
        lastSave: 0,
      };
      rt.bots.set(botId, bt);
    }
    return bt;
  }

  /** 방의 상태, 또는 **그 봇의** 상태 (v2.0 준비) */
  statusOf(roomId: string, botId?: string): RoomStatus {
    if (botId) return this.byRoom.get(roomId)?.bots.get(botId)?.status ?? "idle";
    return this.statusOfRoom(roomId);
  }

  statusOfRoom(roomId: string): RoomStatus {
    return this.byRoom.get(roomId)?.status ?? "idle";
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
  setStatus(roomId: string, status: RoomStatus, botId?: string): void {
    const rt = this.room(roomId);
    const room = this.port.roomById(roomId);
    const ids = botId
      ? [botId]
      : (room?.participants.map((b) => b.id) ?? [...rt.bots.keys()]);

    for (const id of ids) this.bot(roomId, id).status = status;

    const bots: Record<string, RoomStatus> = {};
    for (const [id, bt] of rt.bots) bots[id] = bt.status;
    const merged = mergeStatus(Object.values(bots));

    // 방 상태가 그대로여도 **봇별 상태는 바뀌었을 수 있다** — 화면이 알아야 한다
    const same = rt.status === merged;
    rt.status = merged;
    if (!same || botId !== undefined) this.port.emitStatus(roomId, merged, bots);
    // 띠가 살아 있는지는 **상태가 정한다**(`clashesIn`) — 바뀌었으면 다시 알린다
    this.port.emitClashes(roomId);
  }

  /** 세션 하나는 봇 하나에 속한다 (B1). 방까지 함께 돌려준다 */
  botForSession(sessionId: string): { room: Room; bot: BotInstance } | undefined {
    for (const room of this.port.openRooms()) {
      const bot = room.participants.find((b) => b.sessionId === sessionId);
      if (bot) return { room, bot };
    }
    return undefined;
  }
}
