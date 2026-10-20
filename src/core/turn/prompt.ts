/**
 * ★ **프롬프트 짓기** — 한 턴에 보낼 글과 첨부 (리팩토링 ⑨, 2026-10-20).
 *
 * 순서가 뜻이다: 역할 → 명단 → 되먹임 → 끊긴 자리 → 자리 비움 → 큐 깃발 → 사용자 말
 * → 첨부. 받는 것은 `PromptPort` 가 전부다 — 방 저장 · 연결 풀(받을 수 있는 종류) ·
 * 큐(남은 몫) · 디스크(첨부 blob).
 */
import type * as acp from "@agentclientprotocol/sdk";

import { OUR_MCP_NAME } from "../acpConnection.js";
import type { BotQueue } from "../mcp/botQueue.js";
import { rollUpLost, type Rooms } from "../room/rooms.js";
import type { BotRuntime } from "../room/runtimes.js";
import type { AgentPool } from "../session/pool.js";
import type { RoomStore } from "../store.js";
import {
  DEFAULT_RELAY,
  inBotView,
  rosterText,
  sendsContent,
  type Attachment,
  type BotInstance,
  type Message,
  type Room,
} from "../types.js";

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

/** 프롬프트층이 받는 것 — 이게 전부다 */
export interface PromptPort {
  /** 첨부 blob 을 꺼내는 곳 */
  readonly disk: RoomStore;
  readonly rooms: Rooms;
  readonly pool: AgentPool;
  readonly queue: BotQueue;
}

export class Prompts {
  constructor(private readonly port: PromptPort) {}

  /**
   * 보낼 프롬프트를 만든다.
   *
   * **역할(B3)은 첫 프롬프트 앞에 프리픽스로 붙인다.** ACP `session/new`에는
   * 시스템 프롬프트 파라미터가 없고, 별도 턴으로 보내면 어색한 첫 응답이 생긴다.
   */
  async build(
    room: Room,
    bot: BotInstance,
    bt: BotRuntime,
    batch: Message[],
  ): Promise<acp.ContentBlock[]> {
    const body = batch.map((m) => m.text).join("\n");
    /*
     * ★ **슬래시 명령은 단독으로 보낸다** (2026-10-20).
     *
     * 🔴 어댑터는 **첫 글이 `/` 로 시작해야** 명령으로 본다(Claude 어댑터
     * `acp-agent.js` 의 `firstText.startsWith("/")`). 그런데 아래 줄들을 앞에 붙이면
     * 단체방의 [압축] 이 `[ai-in-one] {…}\n\n/compact` 로 나가 **그냥 글이 됐다** —
     * 압축이 안 되고 모델은 그 글에 답했다.
     *
     * 한 번 보내면 끝나는 것들(역할 · 명단 · 되먹임 · 끊긴 자리)은 **여기서 안 쓴다** —
     * 다음 일반 턴으로 미룬다. 슬래시 턴은 모델이 기억하지 않으므로(`SLASH.md`), 여기
     * 실었다고 표시하면 정작 기억하는 턴에서 빠진다.
     */
    if (body.trimStart().startsWith("/")) {
      return [{ type: "text", text: body.trimStart() }];
    }
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
      void this.port.rooms.saveProps(room, { participants: room.participants, refeedPending: room.refeedPending });
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
    /*
     * ⏪ 여기서 루프모드(예전 «알아서 판단»)면 매 턴 «사용자가 자리에 없습니다. 묻지
     * 말고 스스로 판단해 진행하세요» 를 붙였다. 뺐다 (사용자, 2026-10-20: *"이거는
     * 굳이?"*) — 루프가 다시 물을 때 그 말 안에서 «자리를 비웠다» 를 말한다(`Loops`).
     */
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
    const waiting = this.port.queue.shareLeft(bot.id);

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
    const caps = this.port.pool.connection(bot.agentId).promptCapabilities();

    if (a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/")) {
      const kind = a.mimeType.startsWith("image/") ? "image" : "audio";
      if (!caps[kind]) {
        this.notifyUnsupported(room, a, kind === "image" ? "이미지" : "오디오");
        return null;
      }
      const buf = await this.port.disk.getBlob(a.sha256);
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
    const text = await this.port.disk.getBlobText(a.sha256);
    if (text === null) return null;
    return {
      type: "resource",
      resource: { uri: a.path ? `file://${a.path}` : `blob:${a.sha256}`, text },
    };
  }

  /** 첨부를 조용히 버리지 않는다 — 보냈다고 생각하고 기다리면 안 된다 */
  private notifyUnsupported(room: Room, a: Attachment, kind: string): void {
    // 🔴 **이건 정보 손실 통보다.** 사라지면 사용자는 보낸 줄 알고 기다린다.
    this.port.rooms.noteRoom(
      room,
      `${room.participants[0]?.name ?? "에이전트"}는 ${kind}를 받지 못해 ` +
        `«${a.name}»을 보내지 않았습니다.`,
    );
  }
}
