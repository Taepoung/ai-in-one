/**
 * ★ **열린 방 · 저장** — 맨 아래층 (리팩토링 ⑧ L0, 2026-10-20 · `docs/REFACTOR.md` §4 ⑤).
 *
 * 방 관리자의 다른 층이 **다** 이걸 쓰고, 이건 **아무 층도 안 빌린다** — 디스크와
 * 자물쇠와 알리는 길 둘만 받는다(`RoomsPort`). 그래서 맨 먼저 뗐다: 위층을 떼려 할 때
 * 저장을 낱낱이 빌리던 칸이 이 객체 하나로 줄어든다.
 *
 * 들고 있는 상태는 둘이다 — 열린 방(`open`)과 나간 방(`left`). 나간 방은 저장을
 * 건너뛰는 데만 쓰이므로 저장과 같이 산다.
 */
import { messageId } from "../ids.js";
import type { RoomLocks } from "../roomLock.js";
import type { RoomStore } from "../store.js";
import {
  hasManyBots,
  type BotInstance,
  type Message,
  type Room,
  type RoomMeta,
} from "../types.js";

/** 방 저장층이 받는 것 — 이게 전부다 */
export interface RoomsPort {
  /** 디스크 */
  readonly disk: RoomStore;
  /** 옆 창 자물쇠 — 없으면 이 창 혼자다 */
  readonly locks: RoomLocks | undefined;
  emitMessage(roomId: string, message: Message): void;
  emitMetas(metas: RoomMeta[]): void;
}

/**
 * ★ **누구 이야기인지** 앞에 붙인다 (§4).
 *
 * 🔴 단체방에서 *"모델이 Haiku 4.5(으)로 바뀌었습니다"* 는 **어느 봇인지
 * 알 수가 없다.** 봇마다 모델이 따로고(B1) 바꾸는 자리도 봇마다라서,
 * 이름이 없으면 기록을 나중에 읽을 때 **무엇이 왜 바뀌었는지 못 짚는다.**
 *
 * 1:1에서는 안 붙인다 — 봇이 하나뿐인데 이름을 적으면 군더더기다.
 */
export function whose(room: Room, bot: BotInstance): string {
  return hasManyBots(room) ? `${bot.name}의 ` : "";
}

/**
 * 봇들의 «맥락 잃음»을 **방 값으로 굴려 올린다**.
 *
 * 진실은 봇에 있다(B1). 방 값은 **«하나라도 그런가»** 로만 남긴다 —
 * 목록과 배너가 방 단위로 묻기 때문이고, 없애면 화면이 봇을 하나하나
 * 훑어야 한다. **읽기 전용 요약이지 근거가 아니다.**
 */
export function rollUpLost(room: Room): void {
  const anyLost = room.participants.some((b) => b.contextLost);
  const anyFeed = room.participants.some((b) => b.refeedPending);
  if (anyLost) room.contextLost = true;
  else delete room.contextLost;
  if (anyFeed) room.refeedPending = true;
  else delete room.refeedPending;
  const one = room.participants.find((b) => b.lostSessionId)?.lostSessionId;
  if (one) room.lostSessionId = one;
  else delete room.lostSessionId;
}

export class Rooms {
  constructor(private readonly port: RoomsPort) {}

  /** 열어둔 방의 전체 내용. 목록만 볼 때는 메타만 쓴다 */
  readonly open = new Map<string, Room>();

  /**
   * 나간 방들.
   *
   * 진행 중인 턴이 있는 채로 방을 나가면 `runQueue`가 계속 돌다가 **지워진 파일에
   * 덧붙여 방을 되살린다.** 여기 들어 있으면 저장을 건너뛴다.
   */
  readonly left = new Set<string>();

  listMetas(): RoomMeta[] {
    return this.port.disk.listMetas();
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
    /*
     * ★ **옆 창이 산 채로 들고 있으면 «끊겼다» 로 안 읽는다** (2026-10-14).
     *
     * 「기록만 읽기」는 자물쇠를 안 잡고 연다 — 붙이지 않으니 잡을 이유가 없다.
     * 그래서 **옆 창이 지금 답을 받고 있는 방**도 열리는데, 디스크에 남은
     * `streaming: true` 를 보고 고치면 **멀쩡히 돌고 있는 답에 「중단되었습니다」**
     * 가 붙는다. 그쪽 창은 멀쩡한데 이쪽만 거짓말을 하는 꼴이다.
     */
    const elsewhere = this.port.locks?.heldByOther(roomId);
    const room = await this.port.disk.loadRoom(
      roomId, elsewhere ? { heal: false } : undefined,
    );
    if (!room) throw new Error("방을 찾을 수 없습니다.");
    /*
     * 🔴 **남의 방은 안 들고 있는다.** 캐시에 넣으면 그 뒤로 이 창의 쓰기가
     * 그 위에서 일어나고, 옆 창이 끝낸 결과와 어긋난다. 「기록만 읽기」는
     * **그때 한 번 읽는 것**이라 캐시가 필요 없다.
     */
    if (!elsewhere) this.open.set(roomId, room);
    return room;
  }

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
  noteRoom(
    room: Room,
    text: string,
    kind: "error" | "info" = "error",
    /** **누구 이야기인가** (v2.1). 비우면 방 전체 — 봇별 뷰 어디서나 보인다 */
    about?: string[],
  ): void {
    const last = room.messages.at(-1);
    if (last?.role === "system" && last.text === text) return;

    const msg: Message = {
      id: messageId(),
      role: "system",
      text,
      deliveredTo: [],
      createdAt: Date.now(),
      ...(about?.length ? { aboutBotIds: about } : {}),
      ...(kind === "error" ? { mark: "error" as const } : {}),
    };
    this.append(room, msg);
    void this.saveNewMessage(room, msg);
    this.port.emitMessage(room.id, msg);
  }

  append(room: Room, message: Message): void {
    room.messages.push(message);
    room.lastActivityAt = message.createdAt;
    this.port.emitMessage(room.id, message);
  }

  /**
   * **줄에서 나온 그때** 자리를 잡는다 (대기 정렬).
   *
   * 한 번 잡으면 안 바꾼다 — 여러 봇에게 가는 말은 **먼저 받은 쪽**이 자리를
   * 정한다. 그게 «대화에 들어온 시각»이다.
   */
  placeNow(room: Room, m: Message): void {
    if (m.role !== "user" || m.placedAt !== undefined) return;
    const at = Date.now();
    m.placedAt = at;
    void this.saveMessage(room, { id: m.id, placedAt: at });
  }

  /**
   * **이 봇에게는 안 갔다**고 메시지에 적는다 (C5 · §0의 뺄셈 규칙).
   *
   * ⏪ 한때 버리는 길이 둘이었다 — 중단과 빼내기. 이제 **전체 중지 하나**다
   * (v3.0 1-D). 그래도 자국은 같은 모양이어야 한다 — «화면에는 떠 있는데
   * 영영 답이 없는» 말풍선은 어떤 이유로 생겼든 같은 것이기 때문이다.
   *
   * 🔴 **안 간 것은 이 봇에게만이다.** 같은 메시지가 옆 봇에게는 멀쩡히 갔을 수
   * 있고, 그걸 다시 보내면 **두 번 일하게 된다** — 코딩 에이전트에서는 파일을
   * 두 번 고치는 일이다.
   */
  async markNotSent(
    room: Room,
    m: Message,
    botId: string,
    why: string,
  ): Promise<void> {
    /*
     * ★ **안 갔어도 줄에서는 나왔다** — 여기서도 자리를 잡는다.
     *
     * 🔴 이걸 빠뜨렸더니 「빼기」를 누른 말풍선이 **위로 튀었다.** 대기 중에는
     * 바닥에 있다가, 물리는 순간 조건이 풀려 쓴 시각 자리로 돌아간 것이다 —
     * **누른 것이 눈앞에서 달아난다.**
     */
    this.placeNow(room, m);
    m.notSentTo = [...new Set([...(m.notSentTo ?? []), botId])];
    m.sendFailed =
      hasManyBots(room)
        ? `${m.notSentTo
            .map((id) => room.participants.find((b) => b.id === id)?.name ?? id)
            .join("·")}에게 ${why}`
        : why;
    await this.saveMessage(room, {
      id: m.id,
      sendFailed: m.sendFailed,
      notSentTo: m.notSentTo,
    });
    // 🔴 저장만 하고 알리지 않으면 **방을 다시 열기 전까지 화면이 모른다.**
    this.port.emitMessage(room.id, m);
  }

  /**
   * 방 속성만 갱신한다 (제목·미읽음·초안 등).
   *
   * 트랜스크립트가 JSONL이라 **한 줄만 덧붙인다** — 방이 길어져도 비용이 같다.
   */
  async saveProps(
    room: Room,
    patch: Partial<Omit<Room, "messages">>,
  ): Promise<void> {
    if (this.left.has(room.id)) return;
    await this.port.disk.updateRoom(room, patch);
    this.emitMetas();
  }

  async saveNewMessage(room: Room, message: Message): Promise<void> {
    if (this.left.has(room.id)) return;
    await this.port.disk.appendMessage(room, message);
    this.emitMetas();
  }

  async saveMessage(
    room: Room,
    patch: Partial<Message> & { id: string },
  ): Promise<void> {
    if (this.left.has(room.id)) return;
    await this.port.disk.updateMessage(room, patch);
    this.emitMetas();
  }

  emitMetas(): void {
    this.port.emitMetas(this.listMetas());
  }

  nextDefaultTitle(): string {
    const used = this.listMetas().filter((m) => /^새 대화 \d+$/.test(m.title));
    return `새 대화 ${used.length + 1}`;
  }
}
