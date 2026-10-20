/**
 * ★ **보내기 · 예약 · 초안** — 사용자의 말이 방에 들어오는 문 (리팩토링 ⑨, 2026-10-20).
 *
 * 말을 받아 방에 적고 받을 봇들의 턴으로 넘긴다(`send` · `sendCompose`). 지금 도는
 * 봇이 있으면 **예약**해 두었다가 턴이 끝날 때 보낸다(`stage` · `maybeFireStaged`).
 * 쓰다 만 글은 방마다 따로 든다(`setDraft` · `flushDraft`).
 *
 * 받는 것은 `OutboxPort` 가 전부다 — 방 저장 · 봇 상태 · 턴, 그리고 함수 셋.
 */
import { describe } from "../acpConnection.js";
import { messageId } from "../ids.js";
import { parseCompose, type ComposeParse, type ComposeToken } from "../mentions.js";
import type { Turns } from "../turn/turns.js";
import { isBusy, type Attachment, type BotInstance, type Message, type Room, type Staged } from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";
import type { Rooms } from "./rooms.js";
import type { Runtimes } from "./runtimes.js";

/** 보내기층이 받는 것 — 이게 전부다 */
export interface OutboxPort {
  readonly host: WorkspaceHost;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  readonly turns: Turns;
  /** 내리는 중인가 — 그러면 예약을 안 내보낸다 */
  isDown(): boolean;
  /** 방의 유일한 봇 — 둘 이상이면 없다 */
  soleBot(room: Room): BotInstance | undefined;
  /** 안 보는 방이면 자리를 놓는다 */
  releaseIfUnseen(roomId: string): void;
  emitMessage(roomId: string, message: Message): void;
  emitRoom(room: Room): void;
}

export class Outbox {
  /** 초안 저장 디바운스. 타이핑마다 디스크를 때리지 않는다 */
  private draftTimer?: ReturnType<typeof setTimeout>;
  /** 그 초안이 **어느 방 것인지**. 활성 방과 다를 수 있다 */
  private draftRoomId?: string;
  /**
   * 지금 예약을 내보내는 중인 방들.
   *
   * 🔴 턴이 끝나는 자리가 여러 군데라 **같은 예약을 두 번 보낼 수 있다** —
   * 단체방에서 둘이 거의 동시에 끝나면 양쪽 끝에서 한 번씩 부른다. 칸을
   * 먼저 비우긴 하지만, 비우는 것과 보내는 것 사이에 `await` 가 있어서
   * 그것만으로는 안 된다 — **먼저 찜하고 그다음 await** 다.
   */
  private readonly firing = new Set<string>();

  constructor(private readonly port: OutboxPort) {}

  /**
   * 쓰다 만 메시지를 기억한다.
   *
   * 타이핑마다 디스크를 때리지 않도록 디바운스한다. 방을 나가거나 전송할 때는
   * `flushDraft()`로 즉시 확정한다.
   */
  setDraft(roomId: string, text: string): void {
    const room = this.port.rooms.open.get(roomId);
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
    const room = this.port.rooms.open.get(roomId);
    if (room) await this.port.rooms.saveProps(room, { draft: room.draft });
  }

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
    const room = await this.port.rooms.openRoom(roomId);
    // v1.0은 방에 봇이 하나다. 단체방에서는 **멘션된 봇마다** 이 아래가 돈다.
    const bot = botId ? room.participants.find((b) => b.id === botId) : this.port.soleBot(room);
    if (!bot) return;

    /*
     * 🔴 **올려둔 것이 있으면 아무것도 안 나간다** (2026-10-12).
     *
     * 화면이 단추를 끄지만, 규칙은 **여기서도** 지킨다 — 안 그러면 화면이
     * 늦게 알거나 다른 길로 들어왔을 때 **나중에 친 말이 먼저 나간다.**
     */
    if (room.staged) {
      this.port.rooms.noteRoom(room, "올려둔 글이 먼저 나가야 합니다.", "error");
      return;
    }
    if (isBusy(this.port.runtimes.statusOf(roomId, bot.id)) === true) {
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
    this.port.rooms.append(room, sent);

    // **보낸 즉시 저장한다.** 턴이 끝날 때 몰아서 저장하면, 응답을 기다리는 중에
    // VSCode를 닫았을 때 내가 보낸 메시지까지 사라진다.
    await this.port.rooms.saveNewMessage(room, sent);

    await this.port.turns.runQueue(room, [sent], bot.id);
    this.maybeFireStaged(room);
    this.port.releaseIfUnseen(room.id);
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
    const room = await this.port.rooms.openRoom(roomId);
    const parsed = parseCompose(tokens, room.participants);

    // 말해줄 것이 있으면 **보내기 전에** 남긴다 — 건너뛴 그룹을 나중에 알려주면
    // 이미 «보냈다»고 믿은 뒤다.
    for (const w of parsed.warnings) this.port.rooms.noteRoom(room, w, "info");
    if (parsed.blocked) {
      this.port.rooms.noteRoom(room, parsed.blocked, "error");
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
      this.port.rooms.noteRoom(room, "올려둔 글이 먼저 나가야 합니다.", "error");
      return parsed;
    }
    const busy = [...new Set(parsed.blocks.flatMap((b) => b.botIds))]
      .filter((id) => isBusy(this.port.runtimes.statusOf(roomId, id)) === true)
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
      this.port.rooms.append(room, message);
      await this.port.rooms.saveNewMessage(room, message);
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
        for (const one of batch) await this.port.turns.runQueue(room, [one], botId);
      }),
    );
    this.maybeFireStaged(room);
    this.port.releaseIfUnseen(room.id);
    return parsed;
  }

  /**
   * 전달되지 못한 메시지를 다시 보낸다.
   *
   * 새 말풍선을 만들지 않고 **원래 메시지의 실패 표시만 걷어낸다** — 메신저에서
   * 재전송하면 그 말풍선이 그대로 보내지는 것과 같다.
   */
  async retry(roomId: string, messageId?: string): Promise<void> {
    const room = await this.port.rooms.openRoom(roomId);
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
      await this.port.rooms.saveMessage(room, { id: m.id, sendFailed: undefined, notSentTo: undefined });
      this.port.emitMessage(room.id, m);
    }
    if (byBot.size === 0) return;

    await Promise.all(
      [...byBot].map(([botId, batch]) => this.port.turns.runQueue(room, batch, botId)),
    );
    this.maybeFireStaged(room);
  }

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
    const room = await this.port.rooms.openRoom(roomId);
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
    await this.port.rooms.saveProps(room, { staged: room.staged });
    this.port.emitRoom(room);

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
      this.port.rooms.noteRoom(
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
    this.port.rooms.noteRoom(room, "올려둘 수가 없습니다 — 받을 봇이 없습니다.", "error");
  }

  /**
   * **내린다** — 글까지 버린다.
   *
   * 🔴 흔적을 안 남긴다. 아무도 못 봤으므로 지울 수 있고, 지우면 자국이
   * 없어야 한다(§0 — «간 적 없는 것만 지울 수 있고, 지우면 흔적이 없다»).
   */
  async unstage(roomId: string): Promise<void> {
    const room = await this.port.rooms.openRoom(roomId);
    if (!room.staged) return;
    delete room.staged;
    await this.port.rooms.saveProps(room, { staged: undefined });
    this.port.emitRoom(room);
  }

  /**
   * **수정한다** — 예약을 풀고 글을 돌려준다. 화면이 입력창에 꽂는다.
   *
   * 내리기와 **같은 동작이고 «글을 살리느냐»만 다르다.** 그래서 예약 칸은
   * 입력란을 따로 안 들어도 된다 — 보여주기만 한다.
   */
  async takeStaged(roomId: string): Promise<Staged | undefined> {
    const room = await this.port.rooms.openRoom(roomId);
    const was = room.staged;
    if (!was) return undefined;
    delete room.staged;
    await this.port.rooms.saveProps(room, { staged: undefined });
    this.port.emitRoom(room);
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
  maybeFireStaged(room: Room): void {
    const want = room.staged;
    if (!want || this.port.isDown() || this.firing.has(room.id)) return;
    // 그사이 나간 봇은 기다릴 것이 없다 — 남은 사람만 본다
    const live = want.botIds.filter((id) => room.participants.some((b) => b.id === id));
    if (live.length === 0) {
      void this.unstage(room.id);
      return;
    }
    if (live.some((id) => isBusy(this.port.runtimes.statusOf(room.id, id)) === true)) return;

    this.firing.add(room.id);
    delete room.staged;
    void this.port.rooms.saveProps(room, { staged: undefined });
    this.port.emitRoom(room);
    void this.sendCompose(room.id, want.tokens, want.attachments)
      .catch((err) => this.port.host.log(`[${room.id}] 예약 보내기 실패: ${describe(err)}`))
      .finally(() => this.firing.delete(room.id));
  }
}
