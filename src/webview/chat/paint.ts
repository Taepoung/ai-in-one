/**
 * ★ **채팅 화면 — 그리기** · 말풍선 목록 · 상태 · 배달 칩.
 */
import { hasManyBots,
  USER_CHIP,
  botLabel,
  inBotView,
  type Message,
  type Room,
  type RoomStatus,
} from "../../core/types.js";
import type { AgentBrief } from "../../protocol.js";
import { paintApprovals, paintClashes, reviewNode } from "./approvals.js";
import { leaveChat, openBotView } from "./chat.js";
import { forkHeadButton, forkLine } from "./fork.js";
import { openQuota, toggleMenu } from "./menu.js";
import { botToBot, dayKey, dayLine, isSpur, messageNode, saidToUser } from "./message.js";
import { el, icon, replace } from "../common/dom.js";
import { screens } from "../common/screens.js";
import { PAGE, S, agentById, boot, post, statuses, viewBot } from "../common/state.js";
import { shortenPath, statusText } from "../common/text.js";
import { paintDrawer, toggleDrawer, usagePct } from "../drawer/drawer.js";
import { paintPermissionSheet } from "../perm/perm.js";

/**
 * «여기부터 안 갔다» 줄의 글 — **누구에게** 안 갔는지까지.
 *
 * 한 메시지가 여럿에게 갈 수 있고(`@알파 @베타`) 그중 한 쪽만 끊길 수 있다.
 * 그럴 때 «전달되지 않았습니다»만 써두면 **멀줦히 받은 봇에게까지 다시 쓰게** 된다.
 */
function lostLine(m: Message, r: Room): string {
  if (!hasManyBots(r)) return "여기부터 전달되지 않았습니다";
  const ids = m.notSentTo?.length ? m.notSentTo : m.deliveredTo;
  const names = ids
    .map((id) => r.participants.find((b) => b.id === id)?.name)
    .filter((n): n is string => n !== undefined);
  return names.length > 0
    ? `여기부터 ${names.join("·")}에게 전달되지 않았습니다`
    : "여기부터 전달되지 않았습니다";
}

/**
 * ★ **받는 이를 말풍선 안에** (§4.1.1 · §4.1.2).
 *
 * 🔴 아래에 «→ Claude» 한 줄로 적어봤더니 **안 읽혔다.** 10px 회색 글씨가
 * 말풍선 밖에 붙어 있으면 눈이 그냥 지나간다 — 그런데 이건 *"화면엔 보이는데
 * 봇은 서로 모른다"* 를 막으라고 넣은 표시다. **안 읽히면 없는 것과 같다.**
 *
 * 그래서 **쓸 때 보이던 그 칩 그대로** 글 앞에 놓는다. 입력창에서 보던 것과
 * 말풍선이 같아지고(WYSIWYG), 받는 이가 **글의 일부로** 읽힌다.
 *
 * 🔴 **`Message.text` 에는 안 넣는다.** 라우팅 칩은 파서가 소비한 것이라
 * (§4.1.2) 글에는 없고, 넣으면 **에이전트에게 가는 프롬프트가 바뀐다** —
 * 게다가 여럿에게 간 블록이면 «Codex도 이걸 받았다»를 Claude에게 알려주는
 * 꼴이라 §4.1.1을 우리 손으로 깬다. **그릴 때만** 만든다.
 *
 * 1:1에서는 안 만든다 — 상대가 하나뿐이라 자명하다.
 */
export function deliveryChips(m: Message, r: Room): HTMLElement | null {
  /*
   * ⏪ **«1:1에서는 칩을 안 적는다» 를 뺐다** (2026-09-23).
   *
   * 근거는 *"상대가 하나뿐이라 자명하고, 매 말풍선에 같은 이름이 붙으면 읽는
   * 데 방해만 된다"* 였다. 🔴 그런데 **1:1 방은 도중에 단체방이 된다**(§4.2) —
   * 봇을 하나 부르면 참여자가 둘이 되고, 그 순간 **지난 말풍선들이 갑자기 칩을
   * 얻었다.** 과거 기록의 생김새가 **나중 일 때문에 바뀌는** 셈이다.
   *
   * 그건 일관성이 아니라 그 반대다. **받는 이는 언제나 적는다** — 한 명이면
   * 한 장이고, 그 한 장이 나중에도 그대로 있다.
   */
  if (m.role === "system") return null;

  /*
   * ★ **봇이 봇에게 건 말도 «누구에게»를 단다** (v3.0 대비).
   *
   * 🔴 `role !== "user"` 로 잘라내고 있었다. 오늘은 맞다 — 봇의 답은
   * `deliveredTo` 가 **글쓴이 자신뿐**이라 «나에게 갔다»는 군더더기다.
   *
   * 그런데 릴레이(§7)가 들어오면 알파가 베타에게 거는 말이 생긴다. 그건
   * **«봇이 봇에게 한 말»** 이라 말풍선이고(§7의 판정), 그렇다면 사용자 말과
   * 똑같이 **받는 이가 보여야 한다** — 안 보이면 그 말풍선만 «누구에게 갔는지
   * 알 수 없는 말»이 된다. 그 차이를 적는 것이 이 줄의 존재 이유였다(§4.1.1).
   *
   * **글쓴이 자신은 뺀다.** 남는 것이 없으면 평범한 답이므로 아무것도 안 단다 —
   * 오늘 화면은 하나도 안 바뀐다.
   */
  const to = m.role === "agent"
    ? m.deliveredTo.filter((id) => id !== m.authorBotId)
    : m.deliveredTo;

  /*
   * ★ **나에게 한 말에도 칩을 단다** — 단체방에서만 (2026-09-29).
   *
   * 🔴 여태 «칩이 없으면 나에게 한 말»이었다. **없는 것으로 구별하면 약하다** —
   * 긴 대화를 훑을 때 «빠뜨린 것»과 구별이 안 된다. 봇끼리 말하기(§7)가
   * 들어오면 그 차이가 매 줄 필요해진다.
   *
   * ★ **1:1 에서는 안 단다.** 받을 사람이 나뿐이라 아무것도 안 말해주는
   * 군더더기다 — 이름을 1:1 에서 생략하는 것과 같은 이유다(C9).
   */
  const alsoMe = m.role === "agent" && m.toUser === true && manyBots();
  if (to.length === 0 && !alsoMe) return null;

  const lost = new Set(m.notSentTo ?? (m.sendFailed ? m.deliveredTo : []));
  // ⏪ «줄 서 있음»은 없어졌다 (v3.0 1-E) — 말풍선이 있으면 **이미 간 것**이다
  const wait = new Set<string>();

  /*
   * ★ **못 간 곳은 칩에서 뺀다** (2026-09-23).
   *
   * 🔴 예전에는 그어서 남겼다 — «지우지 않는다»는 §0 뺄셈 규칙 때문이었다.
   * 그런데 **뺄셈 규칙은 «사라지면 안 된다»지 «여기 있어야 한다»가 아니다.**
   * 안 갔다는 사실은 말풍선 아래에 **글과 «다시 보내기»로** 더 분명히 남는다.
   *
   * 빼고 나니 칩 줄의 뜻이 **하나로 좁아진다**:
   *
   * ```
   * 예전   «받는 이»   — 간 것도 안 간 것도 섞여 있어 매번 표시를 읽어야 했다
   * 지금   «받은 사람» — 여기 있으면 갔다
   * ```
   *
   * 다 못 갔으면 칩이 **한 장도 안 남는다.** 그게 맞다 — 아무도 못 받았다.
   */
  const gotIt = to.filter((id) => !lost.has(id));
  if (gotIt.length === 0 && !alsoMe) return null;

  const row = el("span", { class: "to-chips" });

  /*
   * ⏪ **«전원이면 `@everyone` 한 장으로» 를 뺐다** (2026-09-23).
   *
   * 짧아서 좋아 보였는데, «전원»은 **«지금 명단»에 기대는 말**이다. 명단이
   * 바뀌면 **같은 메시지가 다르게 읽힌다** — 기록이 나중 일 때문에 흔들린다.
   *
   * 개별 칩은 `deliveredTo` 그대로라 **언제 봐도 같다.** `@everyone` 으로 썼든
   * 이름을 하나씩 불렀든 **받은 사람이 같으면 같게 보이는 것**이 맞고, 그
   * «같음»은 명단이 아니라 **받은 사람 목록**이 정해야 한다.
   */
  for (const id of gotIt) {
    /*
     * 내보낸 봇의 이름은 **안 남는다** — `removeBot`이 `participants`에서
     * 빼기 때문이다. 그래도 **자리는 남긴다**: 둘에게 간 말이 하나에게만
     * 간 것처럼 보이면 안 된다(§0의 뺄셈 규칙).
     */
    /*
     * ★ **나간 봇도 이름으로 보인다** (2026-09-23).
     *
     * 🔴 예전에는 «@나간 봇» 이라는 **익명**이었다 — `removeBot` 이
     * `participants` 에서 빼면서 이름이 통째로 사라졌기 때문이다. 그러면
     * 대화를 다시 읽을 때 *"누구한테 시킨 거였지"* 에 답할 수 없다.
     * 이제 방이 **이름만** 따로 들고 있다(`Room.left`).
     */
    const seen = botLabel(r, id);
    // 못 간 것은 이미 걸러졌다 — 여기 남는 것은 «갔다»와 «줄에 서 있다»뿐이다
    const state = wait.has(id) ? " held" : "";
    /*
     * ★ **어디까지 갔나를 한 글자로** (2026-10-14).
     *
     * 🔴 여태 칩이 아는 것은 「큐에 넣었다」 하나였다. 그래서 **「봤는데 답을
     * 안 한 것」과 「아예 못 본 것」이 똑같이 보였다** — 봇끼리 말이 오가는
     * 방에서 그 둘은 전혀 다른 이야기다.
     *
     * ```
     * @베타     넣었다 — 아직 저쪽 턴이 안 왔다
     * @베타 ✓   건네졌다 — check_queue 가 꺼내줬다 (저쪽 맥락에 들어갔다)
     * @베타 ↩   반응했다 — say 로 돌아왔다
     * ```
     *
     * 🔴 **「읽었다」가 아니라 「건네줬다」다.** 글자가 저쪽에 들어간 것은
     * 확실하지만 모델이 읽었는지는 모른다 — 아는 것만 적는다.
     */
    /*
     * ⏪ **칩에는 «어디까지 갔나» 를 안 단다** (2026-10-14).
     *
     * 한 번 달아봤다 — `@베타 ✓`(건네졌다) · `@베타 ↩`(반응했다), 그리고 ↩ 는
     * 눌러서 그 답으로 뛰게. 사용자: *"칩에는 안해도돼"*.
     *
     * 칩은 **문장 맨 앞에 꽂혀 글과 한 줄로 흐르는 것**이라(여기 바로 위의
     * 주석) 글자가 하나만 더 붙어도 읽는 흐름을 끊는다. 「무엇에 반응했나」는
     * **말풍선 아래 인용**이 이미 말하고, 그쪽은 자리를 안 뺏는다.
     */
    row.append(
      el("span", {
        class: `chip to${state}${seen && !seen.gone ? "" : " gone"}`,
        text: seen ? (seen.gone ? `@${seen.name} (나감)` : `@${seen.name}`) : "@나간 봇",
        title: wait.has(id)
          ? "아직 줄에 서 있습니다"
          : seen?.gone
            ? `${seen.name}에게 전달되었습니다 — 그 뒤 방에서 나갔습니다`
            : seen
              ? `${seen.name}에게 전달되었습니다`
              : "이 봇은 방에서 나갔습니다",
      }),
    );
  }

  /*
   * ★ **«@사용자» 는 맨 뒤에** (2026-09-29).
   *
   * 봇 이름들 다음에 붙는다 — 대화의 흐름이 «봇들끼리 → 나에게» 인 경우가
   * 많고, 읽는 순서가 그 순서와 같은 편이 낫다.
   *
   * ★ **3인칭이다.** 칩은 **보내는 쪽 말풍선 안**에 들어가므로, «@나» 라고
   * 쓰면 그 «나»가 **말하는 봇**으로 읽힌다. «@사용자» 는 누가 읽어도 같은
   * 사람을 가리킨다 — 대화를 내보내거나 남에게 보여줄 때도 안 흔들린다.
   */
  if (alsoMe) {
    row.append(
      el("span", {
        class: "chip to me",
        /*
         * ★ **`@` 를 붙인다** (2026-09-29).
         *
         * 🔴 괄호만 두르고 `@` 를 빼먹었다. 바로 옆 봇 칩은 `@이름` 인데
         * 혼자 `(사용자)` 라서, **같은 줄에서 같은 일을 하는 칩 둘이 다른
         * 말투**였다. 멘션처럼 안 읽히니 «받는 이» 가 아니라 무슨 꼬리표처럼
         * 보인다.
         *
         * `@` 는 봇 칩과 같은 자리에서 붙이고, 괄호는 `USER_CHIP` 이 들고
         * 있는다 — 그게 **봇이 못 가지는 모양**이라 이름과 안 겹친다
         * (`cleanBotName` 이 괄호를 걷어낸다).
         */
        text: `@${USER_CHIP}`,
        title: "나에게 한 말입니다",
      }),
    );
  }
  return row;
}

/*
 * ⏪ **«⏳ 대기 중» 띠를 물린다** (v3.0 1-E).
 *
 * 말풍선 아래에 «이 말이 아직 줄에 서 있다»를 적던 자리다. 줄 자체를
 * 없앴으니 적을 것이 없다 — 보낸 말은 **언제나 이미 간 것**이고, 아직
 * 안 간 글은 애초에 말풍선이 아니라 **입력창 위 예약 칸**에 있다.
 *
 * 받는 이는 원래부터 여기가 아니라 말풍선 **안**이다(`deliveryChips`) —
 * 10px 회색 글씨가 말풍선 밖에 붙으니 안 읽혔고, §4.1.1 의 유일한 위험을
 * 막으려고 넣은 표시가 안 읽히면 아무 값이 없다.
 */

/** 앞 말풍선과 **같은 봇들에게** 못 간 것인가 — 그러면 줄을 또 그여도 소용없다 */
function lostAlike(above: Message | undefined, m: Message): boolean {
  if (!above?.sendFailed) return false;
  const key = (x: Message) => (x.notSentTo?.length ? x.notSentTo : x.deliveredTo).join();
  return key(above) === key(m);
}

/**
 * **이 말을 한 봇의 에이전트** (v2.0 준비).
 *
 * 🔴 예전에는 어느 말풍선이든 `participants[0]`의 에이전트를 썼다. 1:1에서는
 * 맞아떨어졌지만 **단체방에서는 Codex의 답에 «Claude»가 붙는다** — 이름도
 * 색깔도 전부 첫 봇 것이 된다. 실제로 그렇게 나왔다.
 *
 * 메시지는 `authorBotId`로 **누가 말했는지 이미 알고 있다.** 그걸 쓴다.
 * 모르면(시스템 메시지 등) 방의 첫 봇으로 떨어진다.
 */
function agentOf(m: Message, r: Room): AgentBrief | undefined {
  const bot = m.authorBotId
    ? r.participants.find((b) => b.id === m.authorBotId)
    : undefined;
  return agentById.get((bot ?? r.participants[0])?.agentId ?? "");
}

/**
 * **무엇에 대한 답인지 말해줘야 하나** (C4).
 *
 * 바로 위 질문 하나에 답하는 1:1 대화에서는 군더더기다. 그런데 단체방에서는
 * **다른 봇의 말이 사이에 끼어든다** — 그러면 «이게 어느 질문의 답이지»가 되고,
 * 그때는 말해줘야 한다.
 *
 * 🔴 예전에는 «둘 이상에 답할 때»만 봤다. 그건 큐잉(§4.3)만 생각한 규칙이라,
 * 하나에 답하는데 **자리가 멀어진** 경우를 놓친다.
 */
function needsAnswerNote(m: Message, all: Message[]): boolean {
  /*
   * ★ **혼잣말에는 언제나 적는다** (2026-09-28).
   *
   * 짝이 되는 질문이 **없는** 말이다. «자명한가»를 따질 것이 아니라, 짝이
   * 없다는 사실 자체가 적어야 할 이유다 — 안 적으면 앞 답의 뒷부분으로 읽힌다.
   */
  if (isSpur(m)) return true;

  const answers = m.replyToIds ?? [];
  if (answers.length === 0) return false;
  if (answers.length > 1) return true;   // 묶여서 답한 것은 언제나 적는다

  /*
   * ★ **봇에게 건 말에는 언제나 적는다** (사용자, 2026-10-15).
   *
   * 그 말풍선은 **제 상자로 갈려** 나가므로(받는 이마다 하나), 아래의
   * «바로 위가 그 질문이면 자명하다» 가 더는 안 맞는다 — 사이에 사용자에게
   * 한 말이 끼고, 한 턴이 상자 여럿으로 흩어진다.
   *
   * 그리고 그 꼬리표가 **반응인지 답장인지**를 가른다(4.5-AF): 사용자가
   * 물은 것엔 「답합니다」, 봇의 말을 보고 쓴 것엔 「반응했습니다」.
   */
  if (botToBot(m)) return true;

  /*
   * ★ **`say(to: null)` 로 사용자에게 한 말에도 언제나 적는다**
   * (사용자, 2026-10-15).
   *
   * 그 말풍선은 **턴의 산문과 같은 턴, 다른 상자**다. 둘 다 `@(사용자)` 를
   * 달고 서므로, 갈라 읽히게 하는 것은 **이 꼬리표뿐**이다 — 사용자:
   * *"얘는 산문이랑 구별되게 별도의 말풍선으로 나오고 (반응을 달고)"*.
   *
   * 가르는 법: 턴의 산문은 **제가 묶음의 머리**다(`composeGroupId === id`).
   * `say` 가 만든 상자는 그 머리를 가리키므로 둘이 다르다. 새 칸을 안 만들고
   * **이미 있는 사실**로 가른다.
   */
  if (saidToUser(m)) return true;

  // 바로 위가 그 질문이면 자명하다
  const at = all.findIndex((x) => x.id === m.id);
  return at <= 0 || all[at - 1]!.id !== answers[0];
}

export function paintChat(r: Room): void {
  const c = S.chat;
  if (!c) return;
  // 헤더에 쓰는 것 — 방을 대표하는 에이전트. 말풍선은 **각자 말한 봇으로** 잎는다
  const agent = agentById.get(r.participants[0]?.agentId ?? "");

  const seen = viewBot(r);

  // 이름을 고치는 중이면 헤더를 건드리지 않는다 — 입력이 날아간다
  if (!c.head.querySelector("input") && seen) {
    /*
     * ★ **뷰 헤더에는 방 조작이 없다** (§5의 «뷰는 방이 아니다»).
     *
     * 🔴 분기·이름 바꾸기·나가기를 **비활성으로 두지 않고 아예 안 그린다.**
     * 비활성은 «여기서도 되긴 하는데 지금은 안 된다»로 읽혀서, *"단체방 전체가
     * fork되나 이 봇만 갈라지나"* 하는 바로 그 모호함을 남긴다. 없으면 질문이
     * 생기지 않는다 — 방에 대한 일은 방으로 나가서 한다.
     *
     * `←` 는 **방을 나가는 게 아니라 뷰를 푼다.**
     */
    replace(
      c.head,
      el("button", {
        class: "icon", title: "단체방으로",
        onclick: () => openBotView(null),
      }, icon("arrow-left")),
      /*
       * ★ **원본 방 이름을 봇 이름과 같이 둔다** (§5의 «단체방 X의 @codex 뷰»).
       *
       * 🔴 `@구현` 만 크게 띄우고 방 이름은 부제에 흘려뒀더니 **여기가 어디인지
       * 알기 힘들었다.** 방 제목은 평소 헤더에서 늘 그 자리에 있는 것이라,
       * 갑자기 사라지면 **다른 방으로 건너온 것처럼 읽힌다.**
       *
       * 그래서 **방 이름이 먼저, 봇이 뒤**다 — 평소 헤더와 같은 자리에 같은
       * 것이 있고 «· @구현»이 덧붙는 모양이라, 한눈에 «그 방 안의 한 갈래»로
       * 읽힌다.
       */
      el(
        "h1",
        { class: "view-head" },
        r.title,
        el("span", { class: "view-of", text: `· @${seen.name}` }),
        el("span", {
          class: "sub",
          title: r.cwd,
          text: `1:1 뷰 — ${seen.name}와(과) 주고받은 것만`,
        }),
      ),
      /*
       * ★ **분기는 있다 — 그 봇만 가른다** (v2.1).
       *
       * 🔴 로드맵은 «비활성»이라고 적어뒀다. *"단체방 전체가 fork되나, 그 봇만
       * 분리되나"* 하는 모호함 때문이었는데, **모호함을 없애는 길은 막는 것만이
       * 아니라 뜻을 정해주는 것**도 있다. 자리가 뜻을 말한다:
       *
       * ```
       * 단체방 헤더에서   방 전체가 갈라진다
       * 뷰 헤더에서       그 봇만 갈라진다
       * ```
       */
      forkHeadButton(r, seen.id),
      /*
       * ★ **사용량 — 참여자 바로 왼쪽** (사용자, 2026-10-19).
       *
       * 🔴 **봇에 관한 것들 옆에 둔다.** 잔량은 계정에 붙는 값이지만, 사람이
       * «얼마 남았지» 를 떠올리는 순간은 **이 방에서 일을 시키다가**다 —
       * 에이전트 설정 화면까지 가야 보이면 그때 길이 끊긴다.
       *
       * ⚠️ 수를 **달고 있지 않는다.** 머리에 늘 띄우는 것은 한 번 걷어낸
       * 길이다(ROADMAP B14: «노이즈다»). 누를 때만 보여준다.
       */
      el(
        "button",
        { class: "icon", title: "사용량", onclick: () => openQuota(r) },
        icon("pulse"),
      ),
      el(
        "button",
        { class: "icon with-count", title: `참여자 ${r.participants.length}`, onclick: () => toggleDrawer(r) },
        icon("organization"),
        el("span", { class: "count", text: String(r.participants.length) }),
      ),
    );
  } else if (!c.head.querySelector("input")) {
    replace(
      c.head,
      el("button", { class: "icon", title: "목록", onclick: leaveChat }, icon("arrow-left")),
      el(
        "h1",
        {},
        r.title,
        // 줄인 경로만 보이므로 **전체는 툴팁에** — 비슷한 폴더 두 방을 헷갈리면
        // 엉뚱한 데서 일하게 된다. 서랍에서 뻐는 대신 이 자리가 받아준다.
        el("span", {
          class: "sub",
          title: r.cwd,
          /*
           * ★ **«기록만» 이라고 적는다** (2026-10-15). 입력창과 단추를 걷어낸
           * 자리에 아무 말도 없으면 **고장 난 것처럼** 보인다 — 왜 없는지
           * 한 마디가 방 정보 줄에 붙는다.
           */
          text: `${agent?.label ?? "?"} · ${shortenPath(r.cwd)}`
            + (S.peeking === r.id ? " · 기록만" : ""),
        }),
      ),
      /*
       * ★ **기록만 읽는 방에는 여기까지다** (사용자, 2026-10-15) —
       * 뒤로가기와 방 정보만.
       *
       * 🔴 참여자·분기·⋮ 는 전부 **방에 붙어 있어야** 뜻이 있는 것들이다.
       * 세션을 안 붙이고 연 방에서 눌리면 «왜 아무 일도 안 일어나지»가 되고,
       * 어떤 것은 **붙이는 일을 몰래 시작**한다 — 17초를 피하려고 들어온
       * 자리에서 그러면 들어온 까닭이 사라진다.
       */
      // 참여자 서랍 — 봇에 관한 것이 모이는 자리 (§4.2.1)
      // 사용량 — 참여자 바로 왼쪽. 「기록만」 방에는 안 세운다(물을 세션이 없다)
      S.peeking === r.id ? null : el(
        "button",
        { class: "icon", title: "사용량", onclick: () => openQuota(r) },
        icon("pulse"),
      ),
      S.peeking === r.id ? null : el(
        "button",
        { class: "icon with-count", title: `참여자 ${r.participants.length}`, onclick: () => toggleDrawer(r) },
        icon("organization"),
        /*
         * ★ **몇 명인지 눈에 보여야 한다** (§4.2.1).
         *
         * 🔴 수가 **툴팁에만** 있었다. 단체방에서 제일 먼저 알아야 할 것이
         * «지금 몇이 듣고 있나»인데, 그걸 보려고 서랍을 열어야 했다 —
         * 멘션이 누구에게 갈지를 가늠하는 근거가 한 겹 뒤에 있었던 셈이다.
         *
         * 1:1에서는 안 붙인다 — 언제나 1이라 숫자가 뜻을 못 갖는다.
         */
        hasManyBots(r)
          ? el("span", { class: "count", text: String(r.participants.length) })
          : null,
      ),
      // 분기는 서랍 옆에 — «지금 여기서 갈라진다»는 대화를 보며 정하는 것이라
      // ⋮ 안에 두면 떠올리기 어렵다. 모든 조건은 ⋮의 «여기서 분기»와 같다.
      S.peeking === r.id ? null : forkHeadButton(r),
      S.peeking === r.id ? null : el(
        "button",
        { class: "icon", title: "메뉴", onclick: (e: Event) => toggleMenu(e, r) },
        icon("kebab-vertical"),
      ),
    );
  }
  // 서랍이 열려 있으면 **같이 갱신된다** — 사용량과 작업 중 표시가
  // 멈춰 있으면 서랍을 보는 동안에는 아무 일도 안 일어나는 것처럼 보인다.
  if (screens.bots.firstElementChild) paintDrawer(r);
  /*
   * ★ **권한 시트도 같이 갱신된다.**
   *
   * 서랍에서 봇을 불렀는데 시트를 열면 **아까 그 봇이 없었다** — 열던
   * 순간의 참여자로 그려둔 채로 멈춰 있었기 때문이다. 내보낸 봇이 남아
   * 있는 것도 같은 이유다. 시트는 «지금 방에 누가 있나»를 보여주는 곳이므로
   * 방이 바뀌면 따라가야 한다.
   */
  if (screens.perm.firstElementChild) paintPermissionSheet(r);

  const atBottom = S.stick;
  const nodes: Node[] = [];
  /*
   * ★ **뷰에서는 그 봇이 본 것만 남긴다** (§5).
   *
   * 규칙은 코어와 **같은 함수**(`inBotView`)를 쓴다. v2.0 이 «멘션된 것만
   * 전달»하므로 이 뷰가 곧 **«그 봇이 실제로 본 전부»** 인데, 규칙이 어긋나면
   * 그 약속이 바로 거짓말이 된다.
   */
  const inView = S.viewBotId
    ? r.messages.filter((m) => inBotView(m, S.viewBotId!))
    : r.messages;

  /*
   * ★ **아직 안 간 말은 맨 아래로** (v2.x).
   *
   * 🔴 쓴 순서대로 늘어놓으면 **아직 안 간 것이 이미 일어난 일들 위에** 묻힌다 —
   * 줄에 선 사이에 옆 봇이 답하거나 시스템 줄 하나만 생겨도 그렇게 된다.
   * 바닥으로 내려가 «지금 어떻게 됐나»를 보려는데 정작 **안 끝난 것이 위에**
   * 있는 셈이다.
   *
   * 그래서 **«간 시각»으로 늘어놓는다**(`sentAt`). 아직 안 간 것은 그 값이
   * 없으므로 맨 뒤다.
   *
   * 🔴 **«대기 중이면 맨 아래»만으로는 부족했다.** 그러면 보내는 순간 조건이
   * 풀려 말풍선이 **위로 튄다** — 이미 본 것이 두 번 움직인다. `sentAt` 이
   * 박히면 내려간 자리에 그대로 머문다.
   *
   * 정렬은 **안정적**이라(JS `sort`) 같은 시각끼리는 원래 순서를 지킨다.
   */
  const orderAt = (m: Message): number => {
    /*
     * 🔴 **«대기 중이면 바닥»만 보면 안 된다.** 단체방에서는 한 말이 **한 봇에게는
     * 가고 한 봇은 기다리는** 일이 흔하다. 그때도 바닥으로 내리면 **답이 질문
     * 위에** 놓인다 — 실제로 그렇게 나왔다:
     *
     * ```
     * 구현의 답
     * 둘 다 봐줘   ⏳ Codex 대기 중     ← 질문이 답 아래로 내려갔다
     * ```
     *
     * 자리를 정하는 것은 «**대화에 들어온 시각**»이다. 한 명이라도 받았으면
     * 그 말은 이미 들어온 것이고(`sentAt` 이 그때 박힌다), 아무도 못 받았을
     * 때만 «아직 안 들어온 것»이라 바닥이다.
     *
     * 누가 받고 누가 기다리는지는 **한 줄에 이미 다 있다** — 받은 이는 칩으로,
     * 기다리는 이는 «⏳ … 대기 중»으로. 말풍선을 둘로 쪼갤 이유가 없다.
     */
    return m.placedAt ?? m.createdAt;
  };
  const sorted = [...inView].sort((x, y) => orderAt(x) - orderAt(y));

  /*
   * ★ **꼬리부터 백 개** — 그 위는 접는다.
   *
   * 🔴 **못 보면 안 되는 것은 창을 넓힌다.** 안 읽음 줄·찾아가 앉을 자리·
   * 분기 선이 창 밖이면 **그 줄이 통째로 사라진다** — 방을 열자마자 「여기서
   * 부터 안 읽음」이 없는 채로 바닥에 앉게 된다. 자르는 것이 **보이는 것을
   * 바꾸면** 안 된다.
   */
  const spot = (id?: string): number => (id ? sorted.findIndex((m) => m.id === id) : -1);
  let from = Math.max(0, sorted.length - S.shownCount);
  for (const must of [spot(S.firstUnreadId), spot(S.jumpToMessageId), spot(r.forkedAtMessageId)]) {
    if (must >= 0 && must < from) from = must;
  }
  const hidden = from;
  const shownMsgs = sorted.slice(from);
  let day = "";
  /** 바로 위에 붙어 있는 메시지. 선이 끼어들면 끊긴다 */
  let above: Message | undefined;

  for (const m of shownMsgs) {
    const key = dayKey(m.createdAt);
    let broken = false;
    if (key !== day) {
      nodes.push(dayLine(m.createdAt));
      day = key;
      broken = true;
    }
    /*
     * ★ **여기부터 안 갔다** — 끊긴 자리에 줄을 그어 보여준다.
     *
     * 답하는 중에 중단하면 큐에 쌓여 있던 메시지들은 **보내지도 못한 채**
     * 남는다. 말풍선마다 작게 «안 보냈음»이 붙기는 하지만, 여럿이면 **어디서부터**
     * 끊겼는지가 안 보인다 — 앞에 보낸 것까지 안 간 줄 알고 전부 다시 쓰게 된다.
     */
    if (m.sendFailed && !lostAlike(above, m)) {
      nodes.push(el("div", { class: "cut-line lost", text: lostLine(m, r) }));
      broken = true;
    }
    if (m.id === S.firstUnreadId) {
      nodes.push(el("div", { class: "unread-line", text: "여기서부터 안 읽음" }));
      broken = true;
    }
    const built = reuseOrBuild(
      m, agentOf(m, r), !broken && followsSame(above, m), needsAnswerNote(m, r.messages),
    );
    /*
     * ⏪ **앞 말풍선 안으로 밀어 넣어봤다** (2026-10-14) — `say` 도 그 턴에
     * 그 봇이 한 일이므로. 🔴 그러면 **사용자에게 한 말과 봇에게 한 말이 한
     * 상자에** 섞인다: *"> @봇1 이게 별개의 말풍선이 되어야함"*. 상자는
     * 갈리고, 이어 말하는 표시(이름 안 쓰기)가 둘을 묶어준다.
     */
    nodes.push(built);
    above = m;
    // 물려받은 대화가 끝나는 자리에 선 하나 (D2)
    if (r.forkedAtMessageId && m.id === r.forkedAtMessageId) {
      nodes.push(forkLine(r));
      // 선이 끼어들었으므로 다음 말은 이어지는 게 아니다 — 이름을 다시 쓴다
      above = undefined;
    }
  }
  /*
   * ★ **접어둔 것이 있으면 맨 위에 길을 낸다** (사용자, 2026-10-15).
   *
   * 🔴 **수를 적는다.** 「더 보기」만 있으면 **얼마나 묻혀 있는지**를 모르고,
   * 그걸 모르면 누를지 말지를 못 고른다.
   *
   * ⚠️ **누른 뒤에도 보던 자리에 머문다** — 위로 백 개가 끼어들면 읽던 줄이
   * 화면 밖으로 밀려난다. 바닥에서 잰 거리(`scrollHeight - scrollTop`)를
   * 그대로 되돌려 놓는다.
   */
  if (hidden > 0) {
    nodes.unshift(
      el(
        "div",
        { class: "back-jump more-up" },
        el(
          "button",
          {
            class: "link",
            onclick: () => {
              const c2 = S.chat;
              const keep = c2 ? c2.list.scrollHeight - c2.list.scrollTop : 0;
              S.shownCount += PAGE;
              paintChat(r);
              const now = S.chat;
              if (now) now.list.scrollTop = now.list.scrollHeight - keep;
            },
          },
          icon("arrow-up"),
          `이전 대화 ${hidden}개 더 보기`,
        ),
      ),
    );
  }

  // 줄 서 있는 심사는 대화 아래에 — 이건 **기다리는 것**이지 답할 것이 아니다
  for (const w of S.reviews) nodes.push(reviewNode(w, r));
  // 다른 프로젝트의 방이면 열자마자 알려준다 — 엉뚱한 디렉터리에서 일하게 하면 안 된다 (B5)
  // 🔴 **열린 폴더가 없으면 «다른 프로젝트»라는 말 자체가 성립하지 않는다.**
  // `boot.cwd`는 워크스페이스가 없으면 홈으로 떨어지므로(B9), 그것만 보면
  // 사용자가 **직접 고른 폴더**를 두고 «지금 열린 프로젝트가 아니다»라고
  // 우기게 된다 — 대화 맨 위에 영영 안 사라지는 상자가 하나 생긴다.
  if (boot.hasWorkspace && r.cwd !== boot.cwd) {
    nodes.unshift(
      el(
        "div",
        { class: "banner" },
        icon("folder"),
        ` 이 방은 ${shortenPath(r.cwd)} 를 보고 있습니다 — 지금 열린 프로젝트가 아닙니다.`,
      ),
    );
  }


  // 🔴 **화면의 기록과 에이전트가 아는 것이 어긋났다** (F7).
  //
  // 예전 대화가 그대로 보이므로 말해주지 않으면 사용자는 상대가 다 안다고
  // 믿은 채로 대화한다. 비용이 드는 쪽(되먹이기)이라 **우리가 정하지 않는다.**
  if (r.contextLost) {
    const said = r.messages.filter((m) => m.role !== "system");
    const chars = said.reduce((n, m) => n + m.text.length, 0);

    /*
     * **다 안 들어갈 수도 있다.**
     *
     * 되먹임은 통째로 밀어넣으므로, 이전 세션이 이미 컨텍스트를 반 넘게 채우고
     * 있었다면 새 세션도 시작하자마자 그만큼 찬다 — 곧바로 압축이 돌거나 아예
     * 안 들어간다. **글자 수를 토큰으로 환산해 짐작하지 않는다**(에이전트마다
     * 토크나이저가 다르다). 대신 **이전 세션이 실제로 얼마나 찼었는지**를 쓴다 —
     * 그건 우리가 받아 적어둔 측정값이다.
     */
    const filled =
      r.usage?.contextUsed && r.usage.contextSize
        ? r.usage.contextUsed / r.usage.contextSize
        : 0;

    nodes.push(
      el(
        "div",
        { class: "banner warn" },
        el("span", {
          text:
            /*
             * ★ **어느 봇인지 짚는다** (B1).
             *
             * 🔴 «에이전트는»이라고만 했다. 세션은 봇 단위라 한 봇만 끊겨도
             * 이 배너가 뜨는데, 그러면 **멀쩡한 봇까지 못 미더워진다.**
             */
            (() => {
              const hit = r.participants.filter((b) => b.contextLost);
              if (hasManyBots(r) && hit.length > 0) {
                return `${hit.map((b) => b.name).join("·")}의 세션이 끊겨 위 대화를 모릅니다. `;
              }
              return `이전 세션이 끊겨 에이전트는 위 대화를 모릅니다. `;
            })() +
            `지금까지의 대화(메시지 ${said.length}개 · 약 ${chars.toLocaleString()}자)를 ` +
            `다음 메시지에 함께 보낼까요? ` +
            `최근 것은 그대로, 오래된 긴 메시지는 가운데를 줄여서 보냅니다.` +
            (filled >= 0.5
              ? ` 이전 세션에서 컨텍스트의 ${Math.round(filled * 100)}%를 쓰고 있었습니다 —` +
                ` 다시 넣으면 곧 압축이 필요할 수 있습니다.`
              : ""),
        }),
        /*
         * **다시 붙어보는 게 먼저다.** 되면 대화가 통째로 돌아온다 —
         * 되먹임은 글자만 옮기지만 복구는 계획·메모리까지 살린다.
         *
         * 이름이 «다시 시도»인 이유: 하는 일이 **실패한 복구를 한 번 더**
         * 부르는 것뿐이다. 옆의 «대화 넘겨서 시작»과 헷갈리면 안 된다 —
         * **이것만 원래 세션을 되살리고**, 나머지 둘은 새 세션이다.
         */
        r.lostSessionId
          ? el("button", {
              class: "link",
              text: "다시 시도",
              onclick: () => post({ t: "retryResume", roomId: r.id }),
            })
          : null,
        /*
         * **둘 다 새 세션이다.** 차이는 «대화를 넘기느냐»뿐이라 이름도 그렇게 쓴다.
         *
         * 예전 이름(«이어가기» · «새로 시작»)은 앞엣것이 세션을 잇는 것처럼
         * 들렸다. 잇는 건 위의 «다시 시도»뿐이다.
         */
        el("button", {
          class: "link",
          text: "대화 넘겨서 시작",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "log" }),
        }),
        /*
         * ★ **여기에도 «요약만» 이 있어야 한다** (2026-10-02).
         *
         * 사용자: *"세션 끕겼을때도 … 4개 있어야되지 않아?"*.
         * 갈아타기와 **같은 일**이다 — 세션이 없어졌으니 무엇을 실어
         * 다시 시작할지를 정하는 것. 문이 다르다고 고를 수 있는 것이 다르면
         * 사용자는 «어디서 들어왔느냐» 에 따라 다른 선택을 하게 된다.
         */
        el("button", {
          class: "link",
          text: "요약만 넘겨서 시작",
          title: "압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다.",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "summary" }),
        }),
        el("button", {
          class: "link",
          text: "기록만 두고 시작",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: false }),
        }),
      ),
    );
  } else if (r.refeedPending) {
    // 누른 뒤에는 **약속이 살아 있다**는 걸 보여준다 — 턴을 안 쓰므로
    // 아무 표시도 없으면 «눌렀는데 아무 일도 안 일어났다»가 된다.
    /*
     * ★ **되돌릴 수 있어야 한다.**
     *
     * 분기가 예상 못 하게 폴백했을 때는 **미리 물어볼 기회가 없었다.** 그런데
     * 다행히 되먹임은 약속일 뿐 **토큰은 다음 메시지를 보낼 때까지 안 든다.**
     * 그 사이에 끌 수 있게 해두면, «물어보지 못한 경우»에도 선택은 남는다.
     */
    /*
     * ★ **분기가 폴백했을 때도 세 가지를 준다** (F7과 같은 모양).
     *
     * 예전엔 «끄기» 하나뿐이었다. 그런데 폴백은 **일시적인 실패일 수 있다** —
     * 에이전트가 잠깐 바쁜 것뿐인데 그 한 번 때문에 영영 «글자만 옮긴 방»으로
     * 살 이유가 없다. 세션 복구 실패에 «다시 시도»를 둔 것과 같은 이유다.
     */
    const stuck = r.participants.filter((b) => b.forkFallback);
    if (stuck.length > 0) {
      nodes.push(
        el(
          "div",
          { class: "banner warn" },
          el("span", {
            text:
              (hasManyBots(r)
                ? `${stuck.map((b) => b.name).join("·")}는 `
                : "") +
              "세션을 갈라내지 못해 계획·파일 기억을 물려받지 못했습니다. " +
              "다시 해보면 돌아올 수 있습니다.",
          }),
          el("button", {
            class: "link",
            text: "다시 시도",
            title: "되면 계획과 파일 기억까지 돌아옵니다",
            onclick: () => post({ t: "retryFork", roomId: r.id }),
          }),
          el("button", {
            class: "link",
            text: "대화 넘겨서 시작",
            onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "log" }),
          }),
          el("button", {
            class: "link",
            text: "요약만 넘겨서 시작",
            title: "압축 요약과 최근 대화만 보냅니다.",
            onclick: () => post({ t: "refeed", roomId: r.id, accept: true, kind: "summary" }),
          }),
          el("button", {
            class: "link",
            text: "기록만 두고 시작",
            onclick: () => post({ t: "refeed", roomId: r.id, accept: false }),
          }),
        ),
      );
    } else
    nodes.push(
      el(
        "div",
        { class: "banner" },
        icon("history"),
        " 다음 메시지에 이전 대화가 함께 전달됩니다. ",
        el("button", {
          class: "link",
          text: "글 없이 시작",
          title: "지난 대화를 안 보냅니다 — 토큰을 아끼는 대신 상대는 위 대화를 모릅니다",
          onclick: () => post({ t: "refeed", roomId: r.id, accept: false }),
        }),
      ),
    );
  }

  // 컨텍스트가 거의 찼다. 압축은 사용자가 직접 시킨다 (C11)
  if (S.compactable && S.usage?.contextUsed && S.usage.contextSize) {
    const pct = (S.usage.contextUsed / S.usage.contextSize) * 100;
    if (pct >= 90) {
      nodes.push(
        el(
          "div",
          { class: "banner warn" },
          `컨텍스트가 ${Math.round(pct)}% 찼습니다. `,
          el("button", {
            class: "link",
            text: "대화 압축하기",
            onclick: () => post({ t: "compact", roomId: r.id }),
          }),
        ),
      );
    }
  }

  paintApprovals(r);
  paintClashes(r);
  paintLoopBand(r);
  c.list.replaceChildren(...nodes);
  if (atBottom) c.list.scrollTop = c.list.scrollHeight;

  paintStatus(c.status, r, statuses.get(r.id) ?? "idle");
}

/**
 * 메시지 하나만 갱신한다 — 스트리밍의 기본 경로.
 *
 * 전체를 다시 그리면 대화가 길수록 느려진다. 바뀐 말풍선 하나만
 * 갈아끼우므로 **비용이 대화 길이와 무관하다.**
 */
export function applyDelta(msg: Message): void {
  const r = S.room;
  if (!r) return;

  const at = r.messages.findIndex((x) => x.id === msg.id);
  if (at >= 0) r.messages[at] = msg;
  else r.messages.push(msg);

  const c = S.chat;
  if (!c || c.roomId !== r.id) return;

  const node = messageNode(msg, agentOf(msg, r), false, needsAnswerNote(msg, r.messages));
  const hit = nodeCache.get(msg.id);
  nodeCache.set(msg.id, { sig: sigOf(msg), node });

  // id로 들고 있는 노드를 바꾼다 — 셀렉터 이스케이프 문제가 없다.
  if (hit?.node.isConnected) {
    hit.node.replaceWith(node);
  } else {
    const frag = document.createDocumentFragment();
    const prev = r.messages[r.messages.length - 2];
    if (!prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt)) {
      frag.append(dayLine(msg.createdAt));
    }
    frag.append(node);
    // 카드는 항상 대화 아래에 남아야 한다
    const card = c.list.querySelector(".card");
    if (card) c.list.insertBefore(frag, card);
    else c.list.append(frag);
  }

  if (S.stick) c.list.scrollTop = c.list.scrollHeight;
}

/**
 * 상태 줄 (C10).
 *
 * ★ **봇이 여럿이면 누가 뭘 하는지 이름으로 말한다** (v2.0 준비).
 * 합친 값 하나로는 «Claude는 답하는 중, Codex는 끝남»을 말할 수가 없다.
 * 1:1에서는 이름이 군더더기라 예전처럼 상태만 쓴다.
 */
function paintStatus(bar: HTMLElement, r: Room, status: RoomStatus): void {
  /*
   * ★ **뷰에서는 그 봇 것만** (v2.1 감사 · 2026-09-23).
   *
   * 🔴 구현 뷰인데 *"Codex 답하는 중"* 이라고 떴다 — **남의 턴 이야기**다.
   * 그리고 그 옆 «중단»이 `cancel(roomId)` 이라 **방 전체를 끊었다**: 구현
   * 것만 보려고 들어온 화면에서 **리뷰어의 일을 죽이는** 단추였다.
   *
   * 뷰는 «그 봇과의 1:1처럼»이 약속이므로(§5), 여기서는 1:1 방과 **똑같이**
   * 군다 — 그 봇의 상태를 말한다.
   *
   * ⏪ **중단만은 다르다** (v3.0 1-D). 중지는 이제 하나뿐이라 **방이 통째로**
   * 멈춘다. 그러면 뷰의 약속과 어긋나는데, 둘 중 **거짓말을 안 하는 쪽**을
   * 고른다 — 봇이 둘 이상인 방에서는 글자를 «전부 중단»으로 적는다.
   * 「중단」이라고만 두면 **이 봇만 멈추는 줄 알고 누른다.**
   */
  const seen = viewBot(r);
  const shown = seen ? [seen] : r.participants;
  const many = shown.length > 1;
  const busy = shown.filter((b) => {
    const s = S.botStatus[b.id];
    return s !== undefined && s !== "idle" && s !== "error";
  });
  // 뷰에서는 방 상태가 아니라 **그 봇의 상태**가 기준이다
  const at = seen ? (S.botStatus[seen.id] ?? "idle") : status;

  const text =
    many && busy.length > 0
      ? busy
          .map((b) => `${agentById.get(b.agentId)?.label ?? b.name} ${statusText(S.botStatus[b.id]!)}`)
          .join(" · ")
      : statusText(at);

  bar.replaceChildren(
    el("span", { class: "typing" }, el("i"), el("i"), el("i")),
    el("span", { text }),
  );

  /*
   * ★ **중단은 대화 위에 떠 있는 한 자리** (2026-10-13).
   *
   * 여기(상태 줄)와 말풍선 아래, **둘**에 있었다. 같은 일을 하는 단추가 둘이면
   * 어느 쪽이 무엇을 멈추는지부터 헷갈린다 — 실제로 한쪽은 «이 봇만» 이던
   * 시절의 자국이었다. 이제 한 자리다.
   *
   * 턴이 도는 동안에만 뜬다 — 멈출 것이 없을 때 서 있으면 누를 수 있는 줄 안다.
   * 뷰에서는 **그 봇의** 상태를 본다(`at`), 멈추기는 방 전체다(v3.0 1-D) —
   * 그래서 봇이 여럿이면 말이 «전부»로 바뀐다. 「중단」이라고만 두면 **이 봇만
   * 멈추는 줄 알고 누른다.**
   */
  if (!S.chat || S.chat.roomId !== r.id) return;
  const live = at === "streaming" || at === "tool" || at === "waiting";
  S.chat.stop.hidden = !live;
  const all = many || hasManyBots(r);
  const say = S.chat.stop.querySelector(".stop-say");
  if (say) say.textContent = all ? "전부 중단" : "중단";
  S.chat.stop.title = all
    ? "이 방에서 도는 것을 전부 멈춥니다. 줄 서 있던 말도 안 갑니다."
    : "지금 답하는 것을 끊습니다";
}

/**
 * 안 바뀐 말풍선은 그대로 다시 쓴다.
 *
 * 스트리밍 중에는 방 갱신이 초당 열몇 번 온다. 매번 전체 목록을 새로 만들면
 * **대화가 길수록 느려진다** — 실제로 바뀌는 건 대개 마지막 하나뿐이다.
 * 이미 있는 노드를 옮기는 건 공짜에 가깝다.
 */
export const nodeCache = new Map<string, { sig: string; node: HTMLElement }>();

/**
 * 방 안 **모든 봇 이름**을 한 줄로. 하나라도 바뀌면 말풍선을 전부 다시 그린다.
 *
 * 이름은 드물게 바뀌고, 바뀌면 **여러 자리에 동시에** 영향을 준다.
 * 자리마다 서명을 다는 것보다 이게 안전하다.
 */
function nameStamp(): string {
  // 나간 봇 이름도 화면에 쓰인다 — 목록이 바뀌면 말풍선도 다시 그려야 한다
  return [
    ...(S.room?.participants ?? []).map((b) => `${b.id}=${b.name}`),
    ...(S.room?.left ?? []).map((b) => `${b.id}=${b.name}!`),
  ].join(";");
}

function sigOf(m: Message): string {
  // 스트리밍 중 텍스트는 뒤로만 자라므로 길이+꼬리면 변화를 잡아낸다.
  return [
    m.text.length,
    m.text.slice(-24),
    m.streaming ? 1 : 0,
    m.error ?? "",
    m.sendFailed ?? "",
    m.truncated ? 1 : 0,
    m.files?.length ?? 0,
    // 활동은 같은 id로 상태만 바뀌며 여러 번 온다 — 개수만으로는 못 잡는다
    (m.tools ?? []).map((t) => t.status).join(""),
    // 승인 결과가 나중에 그 활동에 붙는다 (D3)
    (m.tools ?? []).map((t) => t.decision?.mark ?? "").join(""),
    // 봇 수가 바뀌면 «이 봇만 중단»이 생기거나 사라진다
    manyBots() ? "m" : "",
    // 이름 옆 사용량 — **반올림한 값**만 넣는다. 토큰 하나마다 다시
    // 그리면 스트리밍 중에 말풍선을 초당 열몇 번씩 다시 만들게 된다.
    usagePct(m.authorBotId ? S.room?.participants.find((b) => b.id === m.authorBotId) : undefined),
    /*
     * ★ **누가 이름을 바꾸든 전부 다시 그린다.**
     *
     * 🔴 예전에는 **글쓴이 이름만** 넣었다. 그런데 말풍선 안에는 이름이 더
     * 있다 — 받는 이 칩(`@리뷰어`), «…에게 전달되지 않았습니다», 심사 대상.
     * 그것들은 **id 로만 서명에 들어가서**(`deliveredTo`) 이름을 바꿔도
     * 서명이 그대로였고, 캐시가 **옛 이름이 박힌 말풍선을 그대로 돌려줬다.**
     *
     * 자리를 하나씩 서명에 넣다 보면 **반드시 하나를 빠뜨린다.** 이름 바꾸기는
     * 드문 일이라 통째로 다시 그려도 싸다 — 도장 하나로 끝낸다.
     */
    nameStamp(),
    // 멈춰 있나 — 타이핑 점이 붙고 떨어진다
    m.authorBotId ? (S.botStatus[m.authorBotId] ?? "") : "",
    // 배달 표시 — 받는 이가 바뀌거나 줄에서 빠지면 다시 그려야 한다
    m.deliveredTo.join(","),
    // 혼잣말 표시 — 늦게 붙을 수 있다 (2026-09-28)
    (m.afterIds ?? []).join(","),
    m.afterToolId ?? "",
    // 봇 색 — 바꾸면 말풍선을 다시 칠해야 한다 (2026-09-28)
    (m.authorBotId ? S.room?.participants.find((b) => b.id === m.authorBotId)?.color : "") ?? "",
    (m.authorBotId ? S.room?.participants.find((b) => b.id === m.authorBotId)?.ink : "") ?? "",
    // 나에게 한 말인가 — 칩이 붙고 떨어진다 (2026-09-29)
    m.toUser ? "me" : "",
    // 버리면서 남긴 말은 접혀서 선다 (2026-10-15)
    m.aside ? "a" : "",
    // 자리를 잡으면 **순서가 바뀐다** — 다시 그려야 한다 (대기 정렬)
    m.placedAt ?? "",
    (m.notSentTo ?? []).join(","),
  ].join(" ");
}

/**
 * **같은 사람이 이어서 말하는가** — 이름을 한 번만 쓰기 위한 판단.
 *
 * 시간이 벌어지면 다시 쓴다. 메신저에서 한참 뒤에 온 말에 이름이 없으면
 * «누가 한 말이지»가 되기 때문이다. 시스템 메시지는 대화가 아니라 **끊는다**.
 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function followsSame(above: Message | undefined, m: Message): boolean {
  if (!above || m.role !== "agent" || above.role !== "agent") return false;
  if (above.authorBotId !== m.authorBotId) return false;
  return m.createdAt - above.createdAt < GROUP_WINDOW_MS;
}

function reuseOrBuild(
  m: Message,
  agent: AgentBrief | undefined,
  grouped = false,
  noteAnswer = false,
): HTMLElement {
  // **묶임 여부도 서명에 넣는다** — 앞 메시지가 지워지면 이름이 다시 나와야 하는데
  // 캐시가 옛 모양을 그대로 돌려주면 이름 없는 말풍선이 혼자 남는다.
  const sig = `${sigOf(m)} ${grouped ? "g" : ""}${noteAnswer ? "a" : ""}`;
  const hit = nodeCache.get(m.id);
  if (hit && hit.sig === sig) return hit.node;

  const node = messageNode(m, agent, grouped, noteAnswer);
  nodeCache.set(m.id, { sig, node });
  return node;
}

/** 방에 봇이 둘 이상인가 — 말풍선 중단이 의미가 생기는 조건 (v2.0) */
export const manyBots = (): boolean => (S.room ? hasManyBots(S.room) : false);

/**
 * ★ **루프모드 띠를 그린다** (2026-10-20). 루프모드를 켠 봇이 없으면 숨긴다.
 * 누구에게 켜져 있는지를 이름으로 적는다 — «켜져 있다» 만으로는 어느 봇이 사람 없이
 * 도는지 모른다.
 */
export function paintLoopBand(r: Room): void {
  const host = S.chat?.loop;
  if (!host) return;
  const on = r.participants.filter((b) => b.answerPolicy === "auto");
  if (on.length === 0) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  host.replaceChildren(
    icon("sync"),
    el("span", { class: "loop-who", text: `루프모드 — ${on.map((b) => b.name).join(" · ")}` }),
    el("span", { class: "loop-what", text: "모두 멈추면 다시 물어 할 일을 이어 갑니다 · «종료» 하면 빠집니다" }),
  );
}
