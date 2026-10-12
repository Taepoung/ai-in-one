/**
 * **봇에게 갈 것들이 모이는 한 칸** (v3.0 2-H).
 *
 * 권한과 메시지를 **같은 큐**에 담는다. 둘은 생긴 것은 다르지만 **관리하는
 * 방식이 같다** — 들어오고, 봇이 꺼내 보고, 답하면 빠진다. 큐를 둘로 두면
 * 중지·스냅샷·소유자 검사를 **두 번씩** 정의해야 한다.
 *
 * ```
 * 들어간다   권한(request_permission 을 가로채서) · 메시지(say 로)
 * 빠진다     **답하면.** 둘 다 같다
 * 턴 몫      프롬프트를 보내는 순간 **스냅샷으로 떼어낸다**
 * 소유자     헤더 비밀이 가리키는 봇 — 남의 것은 못 꺼낸다
 * 재시작     비운다 — 디스크에 안 남긴다
 * ```
 */

/** 큐에 든 것 하나 */
export type QueueItem = QueuePermission | QueueMessage;

/**
 * 넣을 때의 모양 — `id`·`at` 은 큐가 붙인다.
 *
 * ⚠️ `Omit<QueueItem, …>` 로 쓰면 **합집합이 눌려서** 한쪽에만 있는 칸
 * (`readOnly`·`text`)이 사라진다. 갈래마다 따로 적는다.
 */
export type NewQueueItem =
  | Omit<QueuePermission, "id" | "at">
  | Omit<QueueMessage, "id" | "at">;

interface Common {
  id: string;
  /** 누구의 큐인가 — 봇 하나 */
  to: string;
  /** 누가 넣었나 (보여줄 이름) */
  from: string;
  /**
   * ★ **누가 넣었나 — 봇 id** (v3.0 4-J).
   *
   * 🔴 `from` 은 **보여줄 이름**이라 바뀔 수 있고(서랍에서 고친다), 같은
   * 이름이 둘일 수도 있다. 그런데 «`to` 가 이 가닥의 임자인가» 는 **답인지
   * 새로 거는 것인지**를 가르고, 거기에 승인과 상한이 매달린다 — 이름으로
   * 맞춰보면 **이름을 고치는 순간 열린 가닥이 통째로 남의 것이 된다.**
   */
  fromId: string;
  at: number;
}

export interface QueuePermission extends Common {
  kind: "permission";
  title: string;
  /** ACP `ToolKind` — `execute` · `edit` · `read` … */
  tool?: string;
  /**
   * 🔴 **무엇을 하려는지 그대로 싣는다** (D1).
   *
   * 제목만 넘기면 `rm -rf /` 와 `ls` 가 똑같이 «터미널 명령» 으로 보인다 —
   * 그러면 심사가 아니라 **도장 찍기**가 된다.
   */
  command?: string;
  paths?: string[];
  diff?: { path: string; oldText: string | null; newText: string };
  readOnly: boolean;
}

export interface QueueMessage extends Common {
  kind: "message";
  text: string;
  /**
   * ★ **사용자에게서 몇 다리 건너왔나** (v3.0 4-L).
   *
   * 사용자가 부른 턴에서 건 말이 1, 그 말을 받은 봇이 거는 말이 2 다 —
   * **답도 반응이라 한 다리 는다.** `always` 에서 이 수가 상한을 넘으면
   * **그 `say` 가 거절된다.**
   */
  depth: number;
  /** 답이면 **무엇에 대한 답인지** — 봇이 여럿에게 물었을 때 짝을 찾는다 */
  about?: string;
}

/** `check_queue()` 가 돌려주는 것 — **한 번에 한 종류만** */
export interface QueueView {
  kind: "permission" | "message";
  /**
   * ★ **뭐로 답하라고 알려준다.**
   *
   * 도구 설명에도 적지만, 설명은 **한 번 읽고 잊는다.** 꺼낼 때마다 같이
   * 오면 그 턴에서 바로 보인다 — 모델이 엉뚱한 도구를 고르는 일이 준다.
   */
  answer_with: "verdict" | "say";
  items: QueueItem[];
  /**
   * 이 몫에서 **아직 안 보여준** 수. 0 이 되면 이번 턴은 끝이다.
   *
   * ⚠️ **`say_left`(앞으로 몇 번 더 보낼 수 있나)와 다른 물건이다.** 하나는
   * «나에게 온 것», 하나는 «내가 쓸 수 있는 것» — 그래서 나가는 이름이
   * `queue_left` · `say_left` 로 갈려 있다(4-L).
   */
  left: number;
}

interface Lane {
  /** 이번 턴의 몫 — 턴이 시작될 때 고정된다 */
  share: QueueItem[];
  /** 턴 도중에 들어온 것 — **다음 몫**이다 */
  next: QueueItem[];
}

export class BotQueue {
  private readonly lanes = new Map<string, Lane>();
  private seq = 0;

  private lane(owner: string): Lane {
    let lane = this.lanes.get(owner);
    if (!lane) { lane = { share: [], next: [] }; this.lanes.set(owner, lane); }
    return lane;
  }

  /**
   * **넣는다.** 돌려주는 id 로 나중에 답을 짝짓는다.
   *
   * 도는 턴이 있으면 **다음 몫**으로 간다 — 그게 `left` 가 0 에 닿게 해준다
   * (`startTurn` 주석).
   */
  put(item: NewQueueItem): string {
    /*
     * 🔴 **«0» 을 내주면 안 된다** (v3.0 4-L).
     *
     * `say(id: "0")` 이 **«사용자가 방금 한 말 때문에»** 로 쓰는 자리다.
     * 겹치면 «사용자 때문»이 **남의 큐 항목에 대한 답**으로 읽히고, 그 길로
     * 깊은 데 있는 봇이 새 대화를 시작한다 — **조용히** 뚫린다.
     *
     * 지금은 앞글자가 붙고 번호가 1 부터라 겹칠 수가 없다. **둘 중 하나라도
     * 바꾸면 그 보장이 사라지므로** `tests/botqueue.mts` 가 그 줄을 지킨다.
     */
    const id = `${item.kind === "permission" ? "p" : "x"}${++this.seq}`;
    this.lane(item.to).next.push({ ...item, id, at: Date.now() } as QueueItem);
    return id;
  }

  /**
   * ★ **이번 턴의 몫을 떼어낸다** — 프롬프트를 보내는 순간 (v3.0 2-H).
   *
   * 🔴 **안 떼면 턴이 안 끝난다.** 봇이 큐를 비우는 사이에 새 것이 들어오면
   * `left` 가 계속 0 이 안 되고, 모델은 «아직 남았구나» 하며 또 꺼낸다 —
   * 들어오는 속도가 처리 속도보다 빠르면 **영영 안 끝난다.**
   *
   * 떼어내면 도중에 온 것은 **다음 턴**에 간다. 그 턴은 넣는 쪽이 깨운다.
   */
  startTurn(owner: string): void {
    const lane = this.lane(owner);
    lane.share = [...lane.share, ...lane.next];
    lane.next = [];
  }

  /**
   * ★ **이번 몫을 보여준다** — 한 번에 한 종류만, **권한 먼저**.
   *
   * 🔴 섞어 주면 모델이 **한 번에 두 가지 도구를 써야 한다**. 한 종류씩
   * 주면 «이번엔 verdict» 로 끝난다 — 그래서 `answer_with` 를 같이 싣는다.
   *
   * 🔴 **권한이 먼저인 이유**: 권한을 기다리는 봇은 **턴이 얼어 있다**.
   * 메시지를 기다리는 쪽은 안 그렇다 — 급한 쪽이 먼저다.
   *
   * ⚠️ **꺼낸다고 빠지지 않는다.** 빠지는 것은 `answer` 다. 그래야 꺼내 보고
   * 답을 못 한 채 턴이 끝나도 **잃지 않는다.**
   */
  view(owner: string): QueueView | null {
    const share = this.lane(owner).share;
    if (share.length === 0) return null;
    const kind: "permission" | "message" =
      share.some((i) => i.kind === "permission") ? "permission" : "message";
    const items = share.filter((i) => i.kind === kind);
    return {
      kind,
      answer_with: kind === "permission" ? "verdict" : "say",
      items,
      left: share.length - items.length,
    };
  }

  /**
   * **답했으니 뺀다.**
   *
   * 🔴 **소유자를 본다.** 헤더 비밀이 가리키는 봇과 항목의 주인이 다르면
   * 거절한다 — 안 그러면 **봇이 남의 권한 요청을 대신 승인**할 수 있고,
   * 제 요청을 스스로 승인하는 길도 열린다.
   *
   * @returns 뺀 항목. 없거나 남의 것이면 `undefined`
   */
  answer(owner: string, id: string): QueueItem | undefined {
    const lane = this.lanes.get(owner);
    if (!lane) return undefined;
    for (const list of [lane.share, lane.next]) {
      const at = list.findIndex((i) => i.id === id);
      if (at >= 0) return list.splice(at, 1)[0];
    }
    return undefined;
  }

  /** 그 봇이 아직 답 안 한 것들 — 이번 몫과 다음 몫을 합쳐서 */
  pending(owner: string): QueueItem[] {
    const lane = this.lanes.get(owner);
    return lane ? [...lane.share, ...lane.next] : [];
  }

  /** 깨울 거리가 있나 — 다음 몫에 뭔가 들어와 있나 */
  waiting(owner: string): number {
    return this.lanes.get(owner)?.next.length ?? 0;
  }

  /**
   * **이번 몫에 아직 안 답한 것이 몇인가** — 도구 결과의 `left` 다.
   *
   * `view().left` 와 다르다. 그쪽은 «이 봉투에 안 실린 수»(종류가 다른 것)이고,
   * 이쪽은 «아직 남은 전부»다. 답하고 나서 *"몇 개 남았나"* 를 묻는 자리다.
   */
  shareLeft(owner: string): number {
    return this.lanes.get(owner)?.share.length ?? 0;
  }

  /**
   * **꺼내 보기만 한다** — 빼지 않는다 (v3.0 4-J).
   *
   * `say(to, text, id)` 가 «이 가닥의 임자가 `to` 인가» 를 묻는 자리다.
   * 제3자에게 거는 것이면 그 항목은 **열린 채로 남아야** 하므로, 답인 줄
   * 알고 먼저 빼놓고 되돌리는 길을 만들면 안 된다.
   */
  find(owner: string, id: string): QueueItem | undefined {
    const lane = this.lanes.get(owner);
    if (!lane) return undefined;
    return [...lane.share, ...lane.next].find((i) => i.id === id);
  }

  /**
   * **비운다** — 전체 중지, 또는 그 봇이 방을 떠날 때.
   *
   * 뺀 것을 돌려준다 — 권한은 **`cancelled` 로 답해줘야** 에이전트가 안
   * 멈춘다. 그냥 버리면 저쪽은 영영 기다린다.
   */
  drop(owner: string): QueueItem[] {
    const lane = this.lanes.get(owner);
    if (!lane) return [];
    this.lanes.delete(owner);
    return [...lane.share, ...lane.next];
  }

  /** 방 전체 — 중지가 부른다 */
  dropAll(owners: string[]): QueueItem[] {
    return owners.flatMap((o) => this.drop(o));
  }
}
