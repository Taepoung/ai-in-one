/**
 * ★ **활동 · 부딪힘** — 에이전트가 한 일을 대화에 적는다 (리팩토링 ⑨, 2026-10-20).
 *
 * 턴이 받은 사건 중 도구(`tool`)와 파일 변경(`diff`)을 메시지에 적고, 두 봇이 같은
 * 파일을 동시에 만지면 띠(clash)를 세운다. 받는 것은 `ActivityPort` 가 전부다 —
 * 아래층 둘(방 저장 · 봇 상태)과 디스크 · 알리기 하나.
 */
import { describe, OUR_MCP_NAME, type AgentEvent } from "../acpConnection.js";
import { messageId } from "../ids.js";
import type { Rooms } from "../room/rooms.js";
import type { ClashState, Runtimes } from "../room/runtimes.js";
import type { RoomStore } from "../store.js";
import {
  hasManyBots,
  isBusy,
  type Clash,
  type FileChange,
  type Message,
  type Room,
  type ToolActivity,
} from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";

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

/**
 * 카드에 보여줄 `+N -M`을 센다 (E2).
 *
 * **줄 수 차이만 보면 안 된다.** 10줄을 전부 고쳐도 개수는 그대로라 `+0 -0`이
 * 나온다 — 잘못된 숫자는 없느니만 못하다.
 *
 * 앞뒤로 같은 줄을 걷어내고 남은 것을 센다. 중간에 흩어진 변경은 실제보다 크게
 * 잡히지만 **틀린 방향으로는 가지 않고** O(n)이다. 정확한 diff는 E4가 보여준다.
 */
export function countChangedLines(
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

/** 활동층이 받는 것 — 이게 전부다 */
export interface ActivityPort {
  readonly host: WorkspaceHost;
  /** blob 을 넣는 곳 */
  readonly disk: RoomStore;
  readonly rooms: Rooms;
  readonly runtimes: Runtimes;
  emitClashes(roomId: string, list: Clash[]): void;
}

export class Activity {
  /** 우리 도구가 돌려준 진짜 답 — `방:봇:도구` 마다 줄로 (활동에 붙인다)
   *
   * 저쪽이 실어 보내는 것은 자리표시 글일 수 있다(Antigravity 실측). */
  private readonly ourOut = new Map<string, string[]>();

  constructor(private readonly port: ActivityPort) {}

  /**
   * 우리 도구의 답을 받아둔다 — 같은 봇·같은 도구의 활동이 끝날 때 붙인다.
   *
   * 🔴 **저쪽이 주는 것은 우리 결과가 아니다.** Antigravity 는 `tool_call_update` 에
   * *"Call say on ai-in-one server"* 같은 **자리표시 글**을 실어 보낸다
   * (`probes/mcpagy.cjs` 실측). 줄로 두는 까닭: 한 턴에 여러 번 부를 수 있고,
   * 갱신은 **부른 순서대로** 온다. 여덟 개만 남긴다.
   */
  keepOurOut(owner: string, tool: string, text: string): void {
    const line = (this.ourOut.get(`${owner}:${tool}`) ?? []);
    line.push(text);
    if (line.length > 8) line.shift();
    this.ourOut.set(`${owner}:${tool}`, line);
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
  recordActivity(
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
      // 이름도 첫 이벤트에만 올 수 있다 — 지킨다. 우리 도구는 위 `mine` 이 이름이다
      ...(!mine && (ev.name || tools[at]?.name) ? { name: (ev.name || tools[at]?.name)! } : {}),
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
  recordDiff(
    room: Room,
    reply: Message,
    ev: Extract<AgentEvent, { type: "diff" }>,
  ): void {
    const store = this.port.disk;
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
      await this.port.rooms.saveMessage(room, { id: reply.id, files: reply.files });
    })().catch((err) => this.port.host.log(`blob 저장 실패: ${describe(err)}`));

    if (reply.authorBotId) this.port.runtimes.bot(room.id, reply.authorBotId).pendingWrites.push(write);
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
    const rt = this.port.runtimes.get(room.id);
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
      if (isBusy(this.port.runtimes.statusOf(room.id, id)) !== true) continue;
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
    const rt = this.port.runtimes.get(room.id);
    if (!rt) return;
    const paths = act.paths ?? [];
    if (paths.length === 0) return;

    for (const filePath of paths) {
      // 그 파일을 **지금 도는 다른 봇**이 건드렸나 — `noteClash` 와 같은 잣대
      const others: string[] = [];
      for (const [id, bt] of rt.bots) {
        if (id === mine || !bt.turn) continue;
        if (isBusy(this.port.runtimes.statusOf(room.id, id)) !== true) continue;
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
      this.port.rooms.append(room, note);
      void this.port.rooms.saveNewMessage(room, note);
    }
  }

  /**
   * 그 방에서 **살아 있는** 부딪힘만 — 방을 새로 열었을 때도 실어 보낸다.
   *
   * 「살아 있다」 = **그 봇들 중 둘 이상이 아직 도는 중**. 하나만 남으면 부딪힐
   * 상대가 없으니 끝난 것이다. 이 잣대 덕에 따로 걷어낼 필요가 없다.
   */
  clashesIn(roomId: string): Clash[] {
    const rt = this.port.runtimes.get(roomId);
    if (!rt) return [];
    const live: Clash[] = [];
    for (const [path, c] of rt.clashes) {
      const busy = c.botIds.filter(
        (id) => isBusy(this.port.runtimes.statusOf(roomId, id)) === true,
      );
      if (busy.length < 2) continue;
      const { noted: _drop, ...rest } = c;
      live.push({ ...rest, path });
    }
    return live;
  }

  private emitClashes(roomId: string): void {
    this.port.emitClashes(roomId, this.clashesIn(roomId));
  }
}
