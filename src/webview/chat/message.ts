/**
 * ★ **채팅 화면 — 말풍선 하나** · 릴레이 접기 · 도구 알약 · 계획 · 파일.
 */
import {
  USER_CHIP,
  botColor,
  botLabel,
  type Message,
  type Room,
  type ToolActivity,
} from "../../core/types.js";
import type { AgentBrief } from "../../protocol.js";
import { attachmentsNode, toolImageNode } from "./attach.js";
import { openMessageMenu } from "./fork.js";
import { deliveryChips, manyBots } from "./paint.js";
import { jumpTo } from "./scroll.js";
import { el, icon } from "../common/dom.js";
import { renderMarkdown } from "../common/markdown.js";
import { closeModal, showModal } from "../common/modal.js";
import { S, post } from "../common/state.js";
import { shortenPath } from "../common/text.js";
import { usageChip } from "../drawer/drawer.js";
import { permIcon } from "../perm/perm.js";

export function messageNode(
  m: Message,
  agent: AgentBrief | undefined,
  grouped = false,
  noteAnswer = false,
): HTMLElement {
  if (m.role === "system") {
    // 압축은 메모가 아니라 **경계**다 (C11). 선으로 그어야 «이 위로는 요약»이 읽힌다.
    if (m.mark === "compaction") {
      return el("div", { class: "msg system" }, el("div", { class: "cut-line", text: m.text }));
    }
    /*
     * ★ **우리가 봇에게 물어본 것** (§4.2.2).
     *
     * 사용자가 쓴 말이 아니므로 말풍선이 아니고, 그렇다고 **숨기지도 않는다**
     * (§0). 심사에 무엇을 넘겼는지는 *"왜 저게 통과했지"* 에 답하는 근거이고,
     * **인젝션을 눈으로 확인할 수 있는 유일한 자리**이기도 하다.
     *
     * 다만 diff까지 실려 길다 — 접어서 둔다.
     */
    if (m.mark === "review") {
      const first = m.text.split("\n")[0] ?? "승인 심사";
      return el(
        "div",
        { class: "msg system" },
        el(
          "details",
          { class: "tool review" },
          el("summary", {}, icon("law"), ` ${first}`),
          el("pre", { class: "thought-body" }, el("code", { text: m.text })),
        ),
      );
    }
    return el(
      "div",
      { class: "msg system" },
      el("div", { class: `bubble${m.mark === "error" ? " error" : ""}`, text: m.text }),
    );
  }

  /*
   * ★ **사용자가 고른 색만 싣는다** (2026-09-28).
   *
   * 값은 CSS 변수로만 넘기고 **섞는 일은 스타일시트가 한다** —
   * `color-mix(… , var(--bubble-bot-bg))` 로 **테마가 준 배경**과 섞으므로
   * 다크·라이트가 저절로 따라온다.
   *
   * 🔴 처음에는 에이전트 색으로 **떨어지게** 해놓고 «안 고른 방은 오늘과
   * 똑같이 보인다»고 적었는데 **거짓이었다.** 그러면 모든 봇 말풍선이 처음부터
   * 브랜드색으로 물든다 — 아무도 안 골랐는데 화면이 바뀌는 것이다.
   *
   * 게다가 그 «에이전트 색»(`#d97757`·`#10a37f`)은 **우리가 박아넣은 값**이지
   * 테마가 준 것이 아니다. 작은 점에 쓰는 것은 C9 가 허락한 예외인데, 말풍선
   * 배경까지 그걸로 칠하면 예외가 규칙을 먹는다.
   *
   * **기본은 테마 그대로다.** 고른 적이 있을 때만 칠한다.
   */
  const mineBot = m.role === "agent"
    ? (m.authorBotId ? S.room?.participants.find((b) => b.id === m.authorBotId) : S.room?.participants[0])
    : undefined;
  const chosen = mineBot?.color;

  const node = el("div", {
    class: `msg ${m.role}${m.sendFailed ? " failed" : ""}${grouped ? " grouped" : ""}`,
    ...(chosen
      ? { style: { "--bot": chosen, "--ink": mineBot?.ink === "black" ? "#000" : "#fff" } }
      : {}),
  });

  // 우클릭으로 그 지점에서 분기한다 (D2)
  node.addEventListener("contextmenu", (e) => openMessageMenu(e, m));

  // 이어지는 말에는 이름을 다시 쓰지 않는다 — 같은 사람이 계속 말하는 중이다
  if (m.role === "agent" && !grouped) {
    /*
     * ★ **사용량을 이름 옆에** — 서랍을 안 열어도 보이게.
     *
     * 컨텍스트가 차고 있다는 것은 **대화 중에 알아야** 쓸모가 있다 —
     * 다 차고 나서 서랍에서 보면 이미 압축이 돌아간 뒤다.
     */
    const who = m.authorBotId
      ? S.room?.participants.find((b) => b.id === m.authorBotId)
      : S.room?.participants[0];
    /*
     * ★ **나간 봇이 한 말도 이름이 남는다** (2026-09-23).
     *
     * 🔴 `participants` 에서 빠지면 `who` 가 `undefined` 가 되어 **에이전트
     * 라벨로 떨어졌다** — 같은 에이전트로 봇이 둘이었으면 누가 한 말인지
     * 구별이 안 된다. 바로 위 주석이 걱정하던 그 상황이 **내보내기 한 번으로**
     * 생겼던 셈이다.
     */
    const goneName =
      !who && m.authorBotId && S.room ? botLabel(S.room, m.authorBotId) : undefined;
    /*
     * ★ **이름과 사용량을 알약 하나로** (사용자, 2026-10-14).
     *
     * 🔴 *"봇 이름이 잘 안보여서"*. 흐린 글자 한 줄이라 **대화가 길어지면
     * 누가 말하는지가 묻힌다** — 봇이 여럿이면 그게 제일 먼저 알아야 할
     * 것인데.
     *
     * **테마를 뒤집어 칠한다** — 어두운 테마면 흰 알약, 밝은 테마면 검은
     * 알약. 글자색과 배경색을 **서로 바꿔 쓰면** 테마가 무엇이든 대비가
     * 제일 센 짝이 나온다(색을 우리가 고르지 않는다 — §C9).
     *
     * 사용량도 그 안에 넣는다. 둘 다 «이 봇이 지금 어떤가»라 **한 덩어리**고,
     * 떨어져 있으면 알약 옆에 흐린 숫자가 따로 떠서 더 시끄럽다.
     */
    node.append(
      el(
        "div",
        { class: "who" },
        el("span", { class: "dot", style: { background: botColor(who) } }),
        /*
         * 🔴 **봇 이름이지 에이전트 이름이 아니다.**
         *
         * 에이전트 라벨을 쓰고 있었는데, 그러면 같은 에이전트로 봇을 둘 두면
         * «알파»와 «알파 2»가 **둘 다 «알파»로** 보인다 — 누가 말했는지를
         * 구별할 수 없게 된다. 이름은 봇에 붙고(B1) 멘션도 그 이름으로 간다.
         */
        el(
          "span",
          { class: "name-pill" },
          who?.name ?? (goneName ? `${goneName.name} (나감)` : undefined)
            ?? agent?.label ?? "에이전트",
          usageChip(who),
        ),
      ),
    );
  }

  /*
   * **말과 활동을 번갈아 놓는다** (C3).
   *
   * 🔴 예전에는 한 턴의 말을 통째로 한 말풍선에 넣고 활동을 전부 그 아래에
   * 쌓았다. 실제 대화는 «말하고 → 뭘 하고 → 다시 말하고» 인데 화면은
   * «다 말하고 → 그 밑에 한 일 목록»이 되어, **무엇 때문에 그렇게 했는지**가
   * 끊겼다. 활동이 글의 어디쯤이었는지는 `ToolActivity.textAt`에 있다.
   */
  /*
   * ★ **말풍선 하나가 전체를 감싼다** (사용자, 2026-10-14).
   *
   * ⏪ 조각마다 말풍선이었다 — 글·활동·글이면 상자가 셋. 🔴 그러면 **고른
   * 색이 조각마다 끊긴다**: *"그 색을 고른 말풍선이 전체를 감싸야함"*.
   * 한 턴은 **한 덩어리**고, 그 안에서 순서를 지키는 것은 그대로다(C3).
   */
  const wrap = el("div", { class: "bubble" });

  /*
   * ★ **토큰은 제 줄에** (사용자, 2026-10-14) — *"메시지는 항상 토큰에서
   * 줄 바꿈 이후 나옴 (토큰과 같은 라인에는 토큰만 존재)"*.
   *
   * ⏪ 첫 문단 **안**에 꽂았다 — 메신저의 멘션처럼 글과 한 줄로 흐르게.
   * 🔴 그런데 받는 이가 둘셋이면 **첫 문장이 칩에 밀려** 어디서 시작하는지
   * 가 흐려진다. 토큰은 «누구에게»를 말하는 머리고, 글은 그 다음이다.
   */
  /*
   * 🔴 **접히는 말은 여기서 토큰 줄을 안 만든다** (2026-10-14 · 2026-10-15).
   *
   * 그 칩은 **접는 머리로** 올라간다(`relayFold`) — 거기 이미 «누구에게»가
   * 있는데 안에서 또 적으면 **같은 칩이 두 번** 보인다.
   *
   * 🔴 버린 말(`aside`)에서 실제로 그렇게 떴다 (사용자, 2026-10-15):
   *
   * ```
   * >@(사용자)      ← 접는 머리
   * @(사용자)       ← 말풍선 안 토큰 줄 (중복)
   * 봇2 자기소개 수신 완료
   * ```
   *
   * 봇끼리 말은 `toUser` 가 아니라 안 걸렸고, 버린 말은 **`toUser` 라** 걸렸다 —
   * 가르는 것은 «봇에게인가»가 아니라 **«접히는가»** 였다.
   */
  const folded = botToBot(m) || (m.aside === true && m.toUser === true);
  if (S.room && !folded) {
    const to = deliveryChips(m, S.room);
    if (to) wrap.append(el("div", { class: "to-line" }, to));
  }

  let lastSay: HTMLElement | undefined;
  for (const part of weave(m)) {
    if (part.kind === "tools") {
      wrap.append(toolPills(part.tools));
      continue;
    }
    const say = el("div", { class: "say" });
    renderMarkdown(say, part.text);
    wrap.append(say);
    lastSay = say;
  }

  /*
   * 점은 **«턴을 쥐고 있나»** 다 — 글자가 오나가 아니라(2026-10-13).
   * 승인 대기도 쥐고 있는 것이고(저쪽 턴은 열린 채 살아 있다), 조각이
   * 아니라 **감싼 것 하나**에 붙는다.
   */
  const at = m.authorBotId !== undefined ? S.botStatus[m.authorBotId] : undefined;
  const holding = at === "waiting" || at === "streaming" || at === "tool"
    || at === "permission";
  if (m.streaming && holding) {
    (lastSay ?? wrap).append(el("span", { class: "typing" }, el("i"), el("i"), el("i")));
  }

  /*
   * ★ **말풍선에 붙는 중단.**
   *
   * 멈추고 싶어지는 순간 **보고 있는 것은 흐르는 말풍선**이다. 거기 버튼이
   * 없으면 눈을 떼고 다른 자리를 찾아야 하는데, 그 사이에 답이 끝나 버린다.
   *
   * 🔴 처음에는 **1:1에서 숨겼다** — 입력창 위의 «중단»과 하는 일이 똑같아
   * «뭐가 다르지»가 될까 봐. 그건 틀린 걱정이었다. 둘이 같은 일을 하는 것은
   * **혼란이 아니라 편의**고, 진짜 문제는 *"어디서 멈추지"* 였다.
   *
   * ⏪ **«이 봇만 중단»이었다** (v3.0 1-D). 이제는 봇이 여럿이어도 같은 일을
   * 한다 — **방이 통째로** 멈춘다. 중지가 넷이면 각각이 MCP 큐·권한 대기·
   * 심사 줄과 어떤 관계인지 따로 정의해야 해서 하나로 모았다.
   *
   * 그래서 **자리는 그대로 두고 말만 바꾼다.** 멈추고 싶은 순간 보고 있는
   * 자리가 여기라는 사실은 안 변했고, 하는 일이 달라졌으니 **글자가 그걸
   * 말해야** 한다 — 「이 봇만」이 남아 있으면 거짓말이 된다.
   *
   * 말풍선은 스크롤하면 사라지므로 **위의 «중단»을 없애지 않는다** — 그건
   * 언제나 닿을 수 있는 자리다.
   */
  /*
   * ⏪ **말풍선 아래에서 걷었다** (2026-10-13).
   *
   * 사용자: *"전부 중단 버튼이 말풍선 아래있는게 맘에 안듬, 전송버튼 왼쪽에
   * 있게 하자"*.
   *
   * 말풍선마다 달리면 **답이 길어질수록 아래로 밀려 내려가고**, 스크롤하면
   * 사라진다. 그래서 위 상태 줄에도 같은 단추를 두고 있었는데 — 같은 일을
   * 하는 단추가 둘이었다. 이제 **입력줄 왼쪽 한 자리**다: 거긴 안 움직이고,
   * 멈추고 다시 쓰는 손이 이미 가 있는 자리다.
   */

  // 생각은 기본 접힘 — 읽고 싶을 때만 편다 (C2)
  if (m.thought) {
    wrap.append(
      el(
        "details",
        { class: "tool thought" },
        el("summary", {}, icon("lightbulb"), " 생각"),
        el("pre", { class: "thought-body" }, el("code", { text: m.thought })),
      ),
    );
  }

  /*
   * 뭐에 대한 답인지 — **자명하지 않을 때만** 보여준다 (C4).
   *
   * 🔴 **말풍선 «아래»다** (사용자, 2026-10-14). 한 번 안에 넣어봤는데
   * (「전체를 감싼다」를 넓게 읽어서) 그건 **글이 아니라 꼬리표**다 —
   * 안에 들어가면 봇이 한 말처럼 읽히고, 인용이 글 흐름을 끊는다.
   */
  const note = noteAnswer ? answerNote(m) : null;

  // 누구에게 갔고 누가 아직 줄에 서 있나 (§4.1.1)
  if (S.room) {
    const sent = null;
    if (sent) node.append(sent);
  }

  // 계획은 **결과가 아니라 약속**이다 — 접지 않고 말풍선 아래 그대로 보여준다
  if (m.plan) wrap.append(planNode(m.plan, m.id));
  if (m.attachments?.length) wrap.append(attachmentsNode(m));
  /*
   * 🔴 **파일 변경은 말풍선 «아래»다** (사용자, 2026-10-14).
   *
   * 활동 알약과 같은 모양이지만 자리가 다르다 — 활동은 **글 사이에** 끼는
   * 그 순간의 일이고, 이것은 **턴이 끝나고 난 뒤의 결과**다(그 턴에 무엇이
   * 바뀌었나). 안에 넣으면 마지막 문장 뒤에 붙어 **말의 일부처럼** 읽힌다.
   */
  const changed = m.files?.length ? filesNode(m) : null;

  /*
   * ★ **같은 말을 두 번 하지 않는다** (2026-10-13).
   *
   * 🔴 사용자가 받은 것: 「응답이 중단되었습니다.」 가 **두 줄.**
   *
   * 끊긴 답이 **빈 답**이면 `healAfterCrash` 가 둘을 같이 세운다 —
   * `truncated` 와 `error = "응답이 중단되었습니다."`. 말풍선이 통째로 비면
   * 아무 말도 없는 것보다는 낫기 때문인데, 그 둘이 **글자까지 똑같아서**
   * 나란히 두 번 떴다.
   *
   * 「잘렸다」 는 **자를 글이 있을 때** 하는 말이다. 글이 없으면 자를 것도
   * 없고, 그 자리는 `error` 한 줄이 맡는다.
   */
  if (m.truncated && m.text) {
    wrap.append(el("div", { class: "meta", text: "응답이 중단되었습니다." }));
  }
  if (m.error) wrap.append(el("div", { class: "meta error", text: m.error }));

  if (m.sendFailed) {
    wrap.append(
      el("div", { class: "meta error", text: m.sendFailed }),
      el("button", {
        class: "retry",
        text: "다시 보내기",
        onclick: () => S.room && post({ t: "retry", roomId: S.room.id, messageId: m.id }),
      }),
    );
  }

  /*
   * ★ **봇끼리 주고받은 말은 접는다** (사용자, 2026-10-14).
   *
   * 🔴 사용자: *"자기들끼리 주고 받는 메세지는 … 약간 주고받을때 정신없이
   * 엄청 길어져"*. 봇 둘이 세 번만 오가도 **내가 한 말이 화면 밖으로** 나간다 —
   * 그런데 그 말들은 **나에게 한 말이 아니다.**
   *
   * 🔴 **안 지운다**(§0). 접을 뿐이다 — 누가 누구에게 보냈는지는 **칩으로
   * 그 줄에 남고**, 펴면 글도 활동도 그대로 있다.
   */
  /*
   * ★ **봇끼리 보낸 말은 말풍선 «안»의 묶음 칩이다** (사용자, 2026-10-14).
   *
   * ⏪ 말풍선을 통째로 접었다 — 그러면 **말풍선 밖에 줄이 하나 더** 생긴다.
   * 사용자: *"전체 말풍선 안에 들어가있어야지, 이것도 봇1이 하는 메시지
   * 활동이잖아"*. 맞는 말이다 — `say` 는 그 턴에 그 봇이 **한 일**이고,
   * 활동 알약이 말풍선 안에 서는 것과 같은 자리다.
   *
   * 왼쪽 `>` 가 «숨겨진 것이 있다»는 표고, 누르면 **칩은 그대로 있고**
   * 글이 아래로 난다(`details` 가 원래 그렇게 생겼다).
   */
  /*
   * ★ **봇에게 보낸 말은 제 말풍선이다 — 받는 이마다 하나씩** (사용자,
   * 2026-10-14~15).
   *
   * ⏪ 두 번 돌았다. ① 말풍선을 통째로 접었다(밖에 줄이 하나 더 생겼다).
   * ② 앞 말풍선 **안에** 묶음 칩으로 넣었다 — 그러면 사용자에게 한 말과
   * 봇에게 한 말이 **한 상자에 섞인다**: *"> @봇1 이게 별개의 말풍선이
   * 되어야함"*.
   *
   * 지금은 **상자가 갈린다.** 사용자가 `@봇1 @봇2` 로 쓰면 코어가 받는
   * 이별로 쪼개 보내는 것과 같은 규칙이다(`mentions.ts`) — 받는 쪽에서는
   * 각각 한 통이므로 화면도 한 통씩이어야 읽기가 같다.
   */
  /*
   * ★ **버리면서 남긴 말도 접는다** (사용자, 2026-10-15):
   * *"그거는 사용자에게만 가지만, 확장형 말풍선(다른 봇에 보내는 것과
   * 같이)로 분리하게 / to user로 명시하면 그냥 말풍선"*.
   *
   * 🔴 가르는 것은 **적어 보냈나**다. `to: ["user"]` 는 사용자에게 한
   * 말이니 그냥 선다. `to: null` 은 **버린 것**이고, 사용자가 읽으라고
   * 쓴 글이 아니라 **장부에 남는 글**이라 펼쳐두면 대화가 그것으로 덮인다.
   */
  if (m.aside === true && m.toUser === true) {
    node.append(
      el(
        "div",
        { class: "row" },
        el("div", { class: "bubble" }, relayFold(m, S.room, USER_FOLD, [...wrap.childNodes])),
        !m.streaming ? el("span", { class: "time", text: hhmm(m.createdAt) }) : null,
      ),
    );
    if (changed) node.append(changed);
    if (note) node.append(note);
    return node;
  }

  if (botToBot(m)) {
    const ids = m.deliveredTo.filter((id) => id !== m.authorBotId);
    const inner = [...wrap.childNodes];
    ids.forEach((id, n) => {
      const kids = n === 0 ? inner : inner.map((k) => k.cloneNode(true) as ChildNode);
      node.append(
        el(
          "div",
          { class: "row" },
          el("div", { class: "bubble" }, relayFold(m, S.room, id, kids)),
          !m.streaming && n === ids.length - 1
            ? el("span", { class: "time", text: hhmm(m.createdAt) })
            : null,
        ),
      );
    });
  } else {
    node.append(
      el(
        "div",
        { class: "row" },
        wrap,
        !m.streaming ? el("span", { class: "time", text: hhmm(m.createdAt) }) : null,
      ),
    );
  }
  if (changed) node.append(changed);
  if (note) node.append(note);
  return node;
}

/** 펼쳐 둔 봇끼리 말풍선 — 글자가 올 때마다 다시 그리므로 **기억해 둬야 산다** */
const relayOpen = new Set<string>();

/**
 * **봇이 봇에게만 한 말인가.**
 *
 * 🔴 `toUser` 를 본다 — 「칩이 없으면 나에게 한 말」로 가르던 시절의 약점을
 * 메우려고 둔 칸이다(`Message.toUser`). 사용자에게도 한 말이면 **접지
 * 않는다**: 나한테 한 말을 감추는 것은 다른 이야기다.
 */
export function botToBot(m: Message): boolean {
  if (m.role !== "agent" || m.toUser === true) return false;
  return m.deliveredTo.some((id) => id !== m.authorBotId);
}

/**
 * **`say(to: null)` 로 사용자에게 보낸 말인가** (사용자, 2026-10-15).
 *
 * 턴의 산문도 사용자에게 가지만 그것은 **묶음의 머리**다 — `composeGroupId`
 * 가 제 `id` 와 같다. `say` 가 만든 상자는 그 머리를 가리키므로 둘이 다르다.
 */
export const saidToUser = (m: Message): boolean =>
  m.role === "agent"
  && m.toUser === true
  && m.composeGroupId !== undefined
  && m.composeGroupId !== m.id;

/**
 * **묶음 칩 하나** — 누르면 그 아래로 숨겨둔 것이 난다.
 *
 * ⚠️ **글은 안 건드린다.** 받은 자식들을 그대로 안에 넣을 뿐이라, 펴면
 * 평소와 똑같다(마크다운·활동·계획·답장 인용까지).
 */
/** 접힌 말풍선의 받는 이 자리에 쓰는 «사용자» 표 — 봇 id 와 안 섮인다 */
const USER_FOLD = "(사용자)";

function relayFold(m: Message, r: Room | null, to: string, kids: ChildNode[]): HTMLElement {
  const nameOfBot = (id: string): string => {
    if (id === USER_FOLD) return `@${USER_CHIP}`;
    const seen = r ? botLabel(r, id) : undefined;
    return seen ? `@${seen.name}` : "@나간 봇";
  };

  const key = `${m.id}:${to}`;
  const box = el("details", { class: "relay-fold", open: relayOpen.has(key) });
  box.append(
    el(
      "summary",
      {
        class: "relay-head",
        /*
         * 🔴 **`toggle` 로 적으면 놓친다** — 그 사건은 다음 차례에 오는데,
         * 같은 차례에 글자 조각이 또 오면 다시 그리는 쪽이 먼저다(계획을
         * 접을 때 겪은 그것). 누르는 순간 적는다.
         */
        onclick: () => {
          if (box.open) relayOpen.delete(key);
          else relayOpen.add(key);
        },
      },
      /*
       * ★ **접히면 «누가 누구에게» 하나뿐** (사용자, 2026-10-14) —
       * *"(@봇2->@봇1) 이렇게만 있는 메시지를 클릭하면 전체 메시지가 나오는
       * 느낌이 나을듯"*.
       *
       * ⏪ 한 줄 미리보기를 달아봤다. 🔴 그런데 **미리보기는 반쯤 읽히는
       * 글**이다 — 줄 끝이 «…» 로 잘리면 눈이 거기 머물고, 접은 보람이
       * 그만큼 준다. 봇끼리의 말은 **나에게 한 말이 아니므로** 평소엔
       * «오갔다»만 알면 되고, 궁금하면 누른다.
       */
      /*
       * ★ **받는 이 칩 하나** (사용자, 2026-10-14) — *"말풍선 안에 있으니까
       * @봇2 → @봇1 대신에 그냥 @봇1 칩이 나오고 누르면 메시지가 아래"*.
       *
       * ⏪ 한 알에 «보낸 이 → 받는 이» 를 다 넣었다. 🔴 그건 **말풍선 밖에
       * 혼자 섰을 때** 쓰던 모양이다 — 안으로 들어오면 **보낸 이는 말풍선이
       * 이미 말한다**(이름 알약). 같은 것을 두 번 적는 셈이다.
       *
       * 그래서 `@사용자` 와 **같은 취급**이다: 같은 `.chip.to`, 같은 자리.
       * 다른 것은 왼쪽의 `>` 하나뿐이고, 그게 «여기 숨은 글이 있다»를 말한다.
       */
      el("span", { class: "relay-mark", text: ">" }),
      el("span", { class: "chip to relay-token", text: nameOfBot(to) }),
    ),
  );
  for (const k of kids) box.append(k);
  return box;
}

/** 발췌 길이 — 한 줄에 여럿이 설 수 있어야 하므로 짧게 */
const EXCERPT = 20;

/**
 * ★ **무엇에 대한 답인지 — 질문마다 하나씩, 눌러서 갈 수 있게** (C4 · 2026-09-23).
 *
 * 🔴 여태 **둘 이상이면 발췌가 아예 없었다**: «질문 2개에 한 번에 답합니다».
 * 그런데 그게 **가장 헷갈리는 경우**다 — 줄에 서 있던 봇이 턴 끝에 묶어서
 * 받은 것이라, 묶인 질문들 사이에 **남의 말이 끼어 있다.** 하나일 때보다
 * 되레 안 보였다.
 *
 * 그래서 **개수 대신 발췌를 늘어놓는다.** 그러면 «누를 대상»이 곧 «발췌»가
 * 되어, 되돌아가기가 따로 붙는 기능이 아니라 **같은 것의 두 쓰임**이 된다.
 *
 * 🔴 **못 찾는 질문은 그냥 뺀다.** 압축(C11)으로 사라졌을 수 있는데, 그때
 * 눌러도 아무 일이 없는 단추를 두면 «고장»으로 읽힌다. 하나도 못 찾으면
 * 옛 문구로 떨어진다 — 그래도 «몇 개에 답했다»는 남겨야 한다.
 */
/**
 * **봇이 먼저 보낸 말인가** (2026-09-28).
 *
 * 턴 응답에는 «무슨 질문에 답하는지»가 **언제나** 붙는다(`replyToIds`).
 * 혼잣말에는 없다 — 가리킬 질문이 애초에 없기 때문이다. 그래서 그 빈칸이
 * 곧 «봇이 먼저 말했다»는 표시다.
 */
export const isSpur = (m: Message): boolean =>
  m.role === "agent" && (m.replyToIds?.length ?? 0) === 0;

function answerNote(m: Message): HTMLElement | null {
  /*
   * ★ **«답합니다»와 «끝나서»를 가른다** (2026-09-28).
   *
   * 물어봐서 온 답이 아니라 **봇이 먼저 보낸 말**일 때가 있다. «답합니다»라고
   * 쓰면 거짓말이 된다 — 사용자는 그 질문을 한 적이 없다.
   *
   * 🔴 처음에는 «어느 대화에서 이어졌는지»만 적었는데, 그 판정이 **«마지막으로
   * 답한 턴»** 이라 **도중에 딴 말을 하면 그쪽으로 걸렸다.** 지금은 **깨운
   * 활동**을 짚고(`afterToolId`), 그 활동이 든 답변의 **원래 요청**으로 간다 —
   * 대화 순서가 아니라 **일**을 따라가므로 안 흔들린다.
   */
  /*
   * ★ **혼잣말은 «한 줄»로 끝낸다** (결정 2026-09-28).
   *
   * 한때 깨운 활동을 짚어 ««빌드 돌려놔줘»의 «npm run build»가 끝났습니다» 까지
   * 보여줬다. 실제로 짚였다. 그런데 **그 실이 우연에 가깝다** — 에이전트가
   * 결과를 말하려고 출력 파일을 «읽어주기 때문»이지 프로토콜이 이어준 것이
   * 아니다. 언젠가 그냥 *"끝났어"* 라고만 하면 끊긴다.
   *
   * 그러면 **같은 종류의 말풍선이 어떤 날은 가리키고 어떤 날은 안 가리킨다.**
   * 사용자는 그 차이가 무슨 뜻인지 알 수 없고, 있을 때는 믿게 된다. 그래서
   * **늘 같은 한 줄**로 둔다.
   *
   * ★ **«백그라운드 작업»이라고 단정하지 않는다.** 여태 본 혼잣말은 전부
   * 백그라운드 때문이었지만, 그것만이라고 확인한 적은 없다. 늘 참인 것만 쓴다.
   *
   * ⚠️ 표시는 안 해도 **기록은 남긴다**(`afterToolId`·`afterIds`). 마음이
   * 바뀌었을 때 지난 대화까지 되살릴 수 있어야 한다 — 우리는 기록자다(§0).
   */
  const spur = isSpur(m);
  if (spur) return el("div", { class: "meta", text: "↩ 봇이 먼저 보냈습니다" });

  const ids = m.replyToIds ?? [];
  if (ids.length === 0) return null;

  const asked = ids
    .map((id) => S.room?.messages.find((x) => x.id === id))
    .filter((x): x is Message => x !== undefined);

  if (asked.length === 0) {
    // «질문 1개에 한 번에» 는 말이 안 된다 — 하나면 그냥 «앞선 질문»이다
    return el("div", {
      class: "meta",
      text: ids.length === 1 ? "↩ 앞선 질문에 답합니다"
                             : `↩ 질문 ${ids.length}개에 한 번에 답합니다`,
    });
  }

  const note = el("div", { class: "meta answer-note" });
  note.append("↩ ");
  asked.forEach((q, i) => {
    // 띄어쓰기는 **글자로** 넣는다 — flex gap 으로 주면 뒤의 «에 답합니다»까지 떨어진다
    if (i > 0) note.append(" ");
    const one = q.text.replace(/\s+/g, " ").trim();
    note.append(
      el(
        "button",
        {
          class: "link jump",
          // 잘린 뒤를 보려면 여기 — 발췌는 짧아야 여럿이 한 줄에 선다
          title: one.slice(0, 200),
          onclick: () => jumpTo(q.id, true),
        },
        `«${one.length > EXCERPT ? `${one.slice(0, EXCERPT)}…` : one}»`,
      ),
    );
  });
  /*
   * ★ **«답합니다» 와 «반응했습니다» 를 가른다** (2026-10-14).
   *
   * 사용자가 물은 것에는 **답한다.** 그런데 봇이 봇의 말을 보고 쓴 글은
   * 물음에 대한 답이 아니다 — 받아서 **반응한** 것이다. 같은 말로 적으면
   * «내가 언제 그걸 물었지» 가 된다.
   *
   * 잇는 길과 찾아가기는 **똑같다** — 사용자: *"우리 말에 답장하는 메세지에
   * 연결된 것 처럼"*.
   */
  const toBot = asked.every((q) => q.role === "agent");
  note.append(
    asked.length > 1
      ? (toBot ? "에 한 번에 반응했습니다" : "에 한 번에 답합니다")
      : (toBot ? "에 반응했습니다" : "에 답합니다"),
  );
  return note;
}

/** 같은 날이면 같은 값. 날짜 구분선을 그을 자리를 이걸로 찾는다 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLine(ts: number): HTMLElement {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);

  const label =
    dayKey(ts) === dayKey(today.getTime())
      ? "오늘"
      : dayKey(ts) === dayKey(yesterday.getTime())
        ? "어제"
        : d.getFullYear() === today.getFullYear()
          ? `${d.getMonth() + 1}월 ${d.getDate()}일`
          : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

  return el("div", { class: "day-line" }, el("span", { text: label }));
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * 에이전트가 한 일 (C3).
 *
 * **기본으로 접힌다** — 채팅은 대화를 읽는 곳이지 로그를 읽는 곳이 아니다.
 * 다만 **실패한 건 펼친 채로 둔다.** 테스트 실패나 명령 에러는 바로 보여야 한다.
 */
/**
 * 한 턴을 **말 조각과 활동 묶음**으로 쪼갠다 (C3).
 *
 * 활동이 글의 어디쯤이었는지(`textAt`)로 가른다. **옛 기록에는 그게 없다** —
 * 그때는 예전처럼 전부 맨 뒤에 모아 보여준다. 기록을 고치지 않는다.
 */
type Part =
  | { kind: "text"; text: string; last: boolean }
  | { kind: "tools"; tools: ToolActivity[]; last: boolean };

function weave(m: Message): Part[] {
  const tools = [...(m.tools ?? [])].sort(
    (a, b) => (a.textAt ?? Number.MAX_SAFE_INTEGER) - (b.textAt ?? Number.MAX_SAFE_INTEGER),
  );
  const parts: Part[] = [];
  let at = 0;

  // 같은 자리에서 연달아 일어난 것들은 **한 묶음**으로 — 줄마다 접는 건 시끄럽다
  for (let i = 0; i < tools.length; ) {
    const cut = Math.min(tools[i]!.textAt ?? m.text.length, m.text.length);
    const run: ToolActivity[] = [];
    while (i < tools.length && Math.min(tools[i]!.textAt ?? m.text.length, m.text.length) === cut) {
      run.push(tools[i]!);
      i++;
    }
    const text = m.text.slice(at, cut);
    if (text.trim()) parts.push({ kind: "text", text, last: false });
    parts.push({ kind: "tools", tools: run, last: false });
    at = cut;
  }

  const tail = m.text.slice(at);
  // 답하는 중이면 **빈 꼬리도 넣는다** — 타이핑 표시가 붙을 자리가 필요하다.
  // 끝난 응답에 빈 말풍선을 만들면 허공에 상자가 하나 뜬다.
  if (tail.trim() || parts.length === 0 || (m.streaming && parts[parts.length - 1]!.kind === "tools")) {
    parts.push({ kind: "text", text: tail, last: false });
  }

  parts[parts.length - 1]!.last = true;
  return parts;
}

/**
 * ★ **활동 하나 = 알약 하나** (사용자, 2026-10-14).
 *
 * ⏪ 여기는 **접는 묶음**이었다 — `▸ 활동 2개` 를 눌러 펴고, 그 안의 줄을
 * 또 펴서 명령과 결과를 봤다. 🔴 두 번 눌러야 보이는 것은 **안 보는 것**과
 * 비슷하고, 묶음이 접혀 있으면 «무엇을 했나»가 숫자 하나로 뭉개진다.
 * 사용자: *"활동 드랍테이블 삭제 및 각 활동을 알약으로"*.
 *
 * ★ **가로로 늘어놓는다 — 넘치면 줄을 바꾼다** (사용자). 말풍선 밖으로는
 * 안 나간다: 알약이 글보다 넓어지면 **말풍선이 활동 때문에 늘어난다.**
 *
 * 글자는 **도구 이름**이다(`pillLabel`) — `Bash`·`Read` 처럼 짧은 것이 와야
 * 한 줄에 여럿이 선다. 무엇을 했는지 자세히는 눌러서 본다.
 *
 * 누르면 상세가 **팝업**으로 뜬다 — 말풍선 안에서 펴면 글이 멀어진다.
 */
/**
 * ★ **알약 글자** (사용자, 2026-10-23: *"search로만 나와야하는데 길게 나옴 … 말풍선이 넘침"*).
 *
 * 🔴 `title` 은 이름이 아니다 — Claude 어댑터는 거기에 **명령 전체**나 `Search "…"` 를
 * 싣는다. 이름은 애드온이 알아낸 `name` 을 쓴다. 이름이 없는 에이전트(Codex ·
 * Antigravity)는 제목이 짧으면 그대로, 길면 **종류(`kind`)로 줄인다** — 원문은 툴팁과
 * 상세에 그대로 있다.
 */
const KIND_LABEL: Record<string, string> = {
  execute: "Shell", search: "Search", fetch: "Fetch", read: "Read", edit: "Edit",
  delete: "Delete", move: "Move", think: "Think",
};
const PILL_MAX = 24;

export function pillLabel(t: ToolActivity): string {
  if (t.name) return t.name;
  const title = t.title.trim();
  if (title.length <= PILL_MAX && !title.includes("\n")) return title;
  return (t.kind && KIND_LABEL[t.kind]) ?? `${title.split("\n")[0]!.slice(0, PILL_MAX - 1)}…`;
}

function toolPills(list: ToolActivity[]): HTMLElement {
  const box = el("div", { class: "acts" });
  for (const t of list) {
    box.append(
      el(
        "button",
        {
          class: `act-pill ${t.status}`,
          // 제목만으로는 `rm -rf` 와 `ls` 가 같다 — 손대기 전에 툴팁으로 한 번 (D1)
          title: t.command ?? t.paths?.join("\n") ?? t.title,
          onclick: () => showActivity(t),
        },
        icon(permIcon(t.kind)),
        el("span", { class: "what", text: pillLabel(t) }),
        /* 승인 결과는 **그 활동에 붙는다**(D3) — 알약에는 표만, 까닭은 팝업에 */
        t.decision
          ? el("span", {
              class: `seal ${t.decision.mark === "✓" ? "ok" : t.decision.mark === "✕" ? "no" : ""}`,
              text: t.decision.mark,
            })
          : null,
      ),
    );
  }
  return box;
}

/**
 * 활동 하나의 **상세** — 무엇을 했고 무엇이 나왔나 (C3).
 *
 * 🔴 **그대로 보여준다.** 요약하면 판단 근거가 사라진다 — `Bash` 라고만
 * 적힌 줄로는 `ls` 인지 `rm -rf` 인지 알 수 없다(D1).
 */
function showActivity(t: ToolActivity): void {
  const why = t.decision
    ? `${t.decision.mark} ${t.decision.label}`
      + (t.decision.by ? ` · ${t.decision.by}` : "")
      + (t.decision.why ? ` · ${t.decision.why}` : "")
    : "";
  showModal(
    el(
      "div",
      { class: "card act-pop" },
      el(
        "div",
        { class: "card-title" },
        icon(permIcon(t.kind)),
        el("span", { class: "what", text: pillLabel(t) }),
        t.at ? el("span", { class: "at", text: hhmm(t.at) }) : null,
      ),
      // 줄인 제목의 원문 — 명령과 같으면 아래 상자에 이미 있다
      pillLabel(t) !== t.title && t.title !== t.command
        ? el("div", { class: "act-title", text: t.title })
        : null,
      why
        ? el("div", {
            class: `seal ${t.decision?.mark === "✓" ? "ok" : t.decision?.mark === "✕" ? "no" : ""}`,
            text: why,
          })
        : null,
      t.command ? el("pre", { class: "act-in" }, el("code", { text: t.command })) : null,
      t.output ? el("pre", { class: "act-out" }, el("code", { text: t.output })) : null,
      // ★ 무엇을 봤나 — 브라우저 스크린샷. 누르면 크게 (2026-11-19)
      ...(t.images ?? []).map((img) => toolImageNode(img)),
      ...(t.paths ?? []).map((p) =>
        el("button", {
          class: "file", text: shortenPath(p), title: "에디터에서 열기",
          onclick: () => post({ t: "openFile", path: p }),
        })),
      el(
        "div",
        { class: "card-actions" },
        el("button", { text: "닫기", onclick: () => closeModal() }),
      ),
    ),
  );
}

/**
 * ★ **펼쳐 둔 계획** (§5-N) — 말풍선 id 로.
 *
 * 🔴 **기억 안 하면 못 펼친다.** 이 화면은 글자가 올 때마다 다시 그려지는데,
 * `<details>` 는 새로 만들어지면 **닫힌 채**다 — 펼쳐놓고 보는 사이에 다음
 * 조각이 오면 눈앞에서 접힌다. 체크해 둔 승인(`ticked`)과 같은 자리다.
 */
const planOpen = new Set<string>();

/**
 * 에이전트가 세운 계획 (계획 모드).
 *
 * 🔴 여태 **받아서 버리고 있었다** — 계획을 세우라고 시켜놓고 화면에는
 * 아무것도 안 나왔다. 항목형이면 체크리스트로, 마크다운이면 그대로 그린다.
 *
 * ★ **접는다 — 머리 한 줄이 약속을 계속 말해주므로** (§5-N, 2026-10-14).
 *
 * ```
 * 접힘   ▸ 계획 — ▶ 테스트 돌려보기 (2/3)
 * 펼침   ☑ auth.ts 읽기 · ▶ 토큰 만료 처리 고치기 · ☐ 테스트 돌려보기
 * ```
 *
 * ⏪ 여기 *"계획은 결과가 아니라 **약속**이라 접지 않는다"* 고 적혀 있었다.
 * 그 근거가 **머리줄로 옮겨간다** — 지금 하는 칸이 머리에 떠 있으면 약속은
 * 안 깨진다. 🔴 반대로 **다 펴두면 긴 계획이 대화를 밀어낸다**: 열두 칸짜리
 * 계획이 말풍선마다 붙으면 **정작 봇이 한 말이 화면 밖**으로 나간다.
 */
function planNode(plan: NonNullable<Message["plan"]>, msgId: string): HTMLElement {
  const entries = plan.entries ?? [];
  const done = entries.filter((e) => e.status === "completed").length;
  /*
   * **지금 하는 칸.** 없으면 아직 시작 안 한 첫 칸 — 그것도 없으면 다 끝났다.
   * 🔴 «맨 앞»을 적으면 안 된다. 끝난 칸이 머리에 떠 있으면 **멈춘 것처럼**
   * 보인다.
   */
  const now = entries.find((e) => e.status === "in_progress")
    ?? entries.find((e) => e.status !== "completed");

  const box = el("details", { class: "plan", open: planOpen.has(msgId) });
  box.append(
    el(
      "summary",
      {
        class: "plan-head",
        /*
         * 🔴 **`toggle` 로 적으면 놓친다.** 그 사건은 **다음 차례**에 오는데,
         * 같은 차례에 글자 조각이 한 번 더 오면 다시 그려지는 쪽이 **먼저**다 —
         * 방금 편 것이 눈앞에서 접힌다(검사가 실제로 그걸 잡았다).
         *
         * 누르는 순간 적는다. 이때 `open` 은 **아직 바뀌기 전 값**이라 뒤집어
         * 읽는다.
         */
        onclick: () => {
          if (box.open) planOpen.delete(msgId);
          else planOpen.add(msgId);
        },
      },
      icon("chevron-right"),
      icon("checklist"),
      " 계획",
      now ? el("span", { class: "plan-now" }, " — ", icon(planIcon(now.status)), ` ${now.text}`) : null,
      entries.length > 0
        ? el("span", { class: "plan-count", text: ` (${done}/${entries.length})` })
        : null,
    ),
  );

  if (plan.markdown) {
    const body = el("div", { class: "plan-body" });
    renderMarkdown(body, plan.markdown);
    box.append(body);
    return box;
  }

  box.append(
    el(
      "ul",
      { class: "plan-list" },
      ...entries.map((e) =>
        el("li", { class: `plan-item ${e.status}` }, icon(planIcon(e.status)), ` ${e.text}`),
      ),
    ),
  );
  return box;
}

function planIcon(status: string): string {
  if (status === "completed") return "check";
  if (status === "in_progress") return "sync";
  return "circle-outline";
}

/** 메시지를 보여주고 활동은 «자세히»로 접어 둔다 (E) */
function filesNode(m: Message): HTMLElement {
  const files = m.files ?? [];
  const changed = files.filter((f) => f.kind !== "read").length;
  const label = changed > 0 ? `파일 ${changed}개 변경` : `파일 ${files.length}개 읽음`;

  /*
   * ★ **누가 고쳤나** (§4.2).
   *
   * 봇이 여럿이면 카드가 «누구의 것»인지 말해야 한다. 이름은 바로 위
   * 말풍선에 있지만, **이어 말하면 이름이 안 나오고**(`grouped`) 카드는
   * 접혀 있어서 펼 때쯤엔 이름이 화면 밖일 수 있다. 되돌릴 일이 생겼을 때
   * 제일 먼저 묻는 게 *"누가 건드렸지"* 다.
   *
   * 봇이 하나면 안 붙인다 — 답이 하나뿐인 질문이다.
   */
  const who = manyBots() && m.authorBotId
    ? S.room?.participants.find((b) => b.id === m.authorBotId)?.name
    : undefined;

  /*
   * ★ **파일 변경도 활동이다** (사용자, 2026-10-14) — *"봇2 파일 1개 변경 →
   * 활동인데 안잡힘"*.
   *
   * ⏪ 여기만 **접는 상자**로 남아 있었다. 활동을 알약으로 바꾸면서 놓친
   * 자리다 — 「무엇을 했나」 중 하나인데 혼자 다른 모양이면 **눈이 두 규칙을
   * 외운다.** 같은 알약, 같은 손놀림(누르면 팝업).
   */
  const body = el(
      "div",
      { class: "files" },
      ...files.map((f) =>
        el("button", {
          class: "file",
          // 변경 전/후가 남아 있으면 diff로, 읽기만 했으면 파일로
          title: f.newSha256 ? "변경 내용 보기" : "파일 열기",
          text:
            `${kindMark(f.kind)} ${shortenPath(f.path)}` +
            (f.added || f.removed ? `  +${f.added ?? 0} −${f.removed ?? 0}` : ""),
          onclick: () =>
            f.newSha256 && S.room
              ? post({ t: "diffFile", roomId: S.room.id, messageId: m.id, path: f.path })
              : post({ t: "openFile", path: f.path }),
        }),
      ),
    );

  return el(
    "div",
    { class: "acts" },
    el(
      "button",
      {
        class: "act-pill",
        title: files.map((f) => f.path).join("\n"),
        onclick: () =>
          showModal(
            el(
              "div",
              { class: "card act-pop" },
              el("div", { class: "card-title" }, icon("files"), ` ${label}`),
              body,
              el(
                "div",
                { class: "card-actions" },
                el("button", { text: "닫기", onclick: () => closeModal() }),
              ),
            ),
          ),
      },
      icon("files"),
      who ? el("span", { class: "by", text: who }) : null,
      el("span", { class: "what", text: label }),
    ),
  );
}

function kindMark(kind: string): string {
  return kind === "create" ? "+" : kind === "delete" ? "−" : kind === "edit" ? "~" : "·";
}
