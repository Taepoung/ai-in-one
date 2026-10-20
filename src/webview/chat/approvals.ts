/**
 * ★ **채팅 화면 — 물어보는 카드** · 부딪힘 띠 · 승인 (D1·D4).
 */
import {
  hasManyBots,
  type PermissionRequest,
  type ReviewWait,
  type Room,
} from "../../core/types.js";
import type { AskCard } from "../../protocol.js";
import { renderChat } from "./chat.js";
import { el, icon } from "../common/dom.js";
import { S, cards, dropCard, post } from "../common/state.js";
import { shortenPath } from "../common/text.js";
import { permIcon } from "../perm/perm.js";

// ── 물어보는 카드 (D1·D4) ───────────────────────────────────────────────

/**
 * ★ **줄 서 있는 심사 한 줄** (§4.2.2).
 *
 * 심사는 그 봇의 **큐에 들어간다** — 바빠도 바로 들어가고, 봇은 제 턴에
 * 꺼내 본다(v3.0 3-I). 그래서 기다리는 데 끝이 정해져 있지 않다.
 *
 * 🔴 그동안 **요청한 봇의 턴은 얼어 있다.** 안 보이면 «왜 아무 일도 안
 * 일어나지»가 되고, 그때 할 수 있는 일도 없다. 보여주고, **빠져나올 길**을 준다.
 *
 * ⏪ 한때 «줄 서는 중» 과 «물어보는 중» 을 갈라 그렸다. 묻는 것이 봇이 제
 * 턴에 꺼내 보는 일이 되면서 **우리가 그 순간을 모르게 됐다** — 한 모양이다.
 */
export function reviewNode(w: ReviewWait, r: Room): HTMLElement {
  const name = (id: string) => r.participants.find((b) => b.id === id)?.name ?? "봇";
  return el(
    "div",
    { class: "card review-wait" },
    el(
      "div",
      { class: "card-title" },
      icon("watch"),
      ` ${name(w.askerBotId)}의 «${w.title}»`,
    ),
    el("div", {
      class: "dim",
      text: `${name(w.judgeBotId)}의 판단을 기다립니다.`,
    }),
    el(
      "div",
      { class: "card-actions" },
      el("button", {
        /*
         * ★ **같은 일이면 같은 이름** (2026-10-14) — 대기 화면의 단추와 한 글자도
         * 다르지 않다. 둘 다 `takeOverReview` 고, 둘 다 **그 하나를 내 큐로**
         * 옮긴다. 이름이 갈리면 «다른 일인가»가 생긴다.
         */
        text: "유저 승인으로",
        title: "이 요청 하나만 내가 답합니다 — 유저 승인 큐로 옮깁니다",
        onclick: () =>
          S.room && post({ t: "takeOverReview", roomId: S.room.id, reviewId: w.id }),
      }),
    ),
  );
}

/** 큐에서 체크해 둔 것들 — 다시 그려도 살아남아야 한다 */
const ticked = new Set<string>();

/**
 * 이 요청에서 **«이번만»에 해당하는 선택지**를 찾는다.
 *
 * 🔴 **일괄 처리에는 «항상»을 쓰지 않는다.** 여러 개를 한 번에 넘길 때는
 * 하나하나를 읽지 않는다는 뜻인데, 거기에 «앞으로 전부»까지 걸면 **읽지 않은
 * 것이 영구 규칙이 된다.** «항상»은 하나씩 펴서 볼 때만 고를 수 있다 —
 * 봇 심사에 `*_once` 만 준 것과 같은 이유다(§4.2.2).
 */
function onceOption(req: PermissionRequest, allow: boolean): string | undefined {
  const want = allow ? "allow_once" : "reject_once";
  return req.options.find((o) => o.kind === want)?.optionId;
}

/**
 * ★ **승인 큐** — 헤더 바로 아래 (D1).
 *
 * 🔴 카드를 대화 맨 아래에 쌓고 있었다. 둘만 넘어가도 **답할 것이 뭔지
 * 흐려지고**, 대화는 자동으로 바닥까지 스크롤되는데 카드는 그보다 아래라
 * 오히려 밀렸다. **답해야 하는 것은 대화와 같이 흐르면 안 된다.**
 *
 * 한 줄 = 한 요청. 펴면 무엇을 승인하는지 전부 보이고(D1), 거기서는
 * 에이전트가 준 선택지를 **그대로** 고를 수 있다 — «항상»도 거기 있다.
 * 줄에서 바로 누르는 «허용/거절»은 **«이번만»** 이다.
 */
/**
 * ★ **부딪힘 띠** (§4.3 · 2026-09-22 실측).
 *
 * 무엇을 말하는가가 실측으로 바뀐 자리다. 예전 문구는 *"나중에 끝나는 쪽이 앞의
 * 변경을 덮어쓸 수 있습니다"* 였는데 **사실이 아니다** — Edit·Write는 겹치면
 * 거부당하고, 안 겹치면 둘 다 살아남는다. 진짜 일어나는 일은 **막혀서 다시 읽는
 * 것**이고, 그건 안 망가지는 대신 **조용히 느려진다.**
 *
 * 그래서 두 단계로 말한다:
 *
 * ```
 * 함께 고치는 중        아직 아무 일도 안 일어났다 — 겹치지 않으면 그냥 지나간다
 * 막혀 다시 읽는 중     에이전트가 실제로 거부당했다고 신고했다
 * ```
 *
 * ★ **«누가»는 우리만 안다.** 에이전트가 주는 사유는 *"by the user or by a
 * linter"* 라 **어느 봇인지 모른다.** 그 자리를 채우는 것이 이 띠의 값이다.
 */
export function paintClashes(r: Room): void {
  const host = S.chat?.clash;
  if (!host) return;
  /*
   * ★ **뷰에서는 그 봇이 낀 것만** (v2.1 감사).
   *
   * 봇이 셋이면 **나와 무관한 둘이 부딪힌 것**까지 떴다. 뷰는 «그 봇과의
   * 1:1처럼»이라 남의 사정은 방으로 나가서 볼 일이다.
   */
  const only = S.viewBotId;
  const mine = only ? S.clashes.filter((c) => c.botIds.includes(only)) : S.clashes;
  if (mine.length === 0) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;

  const name = (id: string) => r.participants.find((b) => b.id === id)?.name ?? id;
  host.replaceChildren(
    ...mine.map((c) => {
      const who = c.botIds.map(name).join("·");
      const what = c.blocked
        ? `${c.blockedBotId ? name(c.blockedBotId) : "한쪽"}가 막혀 다시 읽는 중`
        : "함께 고치는 중";
      return el(
        "div",
        { class: c.blocked ? "clash blocked" : "clash" },
        el(
          "div",
          { class: "clash-line" },
          icon("warning"),
          el("span", { class: "clash-who", text: who }),
          el("span", { class: "clash-path", text: shortPath(c.path), title: c.path }),
          el("span", { class: "clash-what", text: what }),
        ),
        // **CLI가 준 말은 그대로 남긴다**(§0) — 접어두되 버리지 않는다
        c.reason
          ? el(
              "details",
              { class: "clash-why" },
              el("summary", {}, icon("chevron-right"), " 에이전트가 말한 사유"),
              el("pre", { text: c.reason }),
            )
          : false,
      );
    }),
  );
}

/** 띠는 한 줄이라 경로 전체를 못 담는다. 제목(`title`)에는 전체가 남는다 */
function shortPath(p: string): string {
  const cut = p.replace(/\\/g, "/").split("/");
  return cut.length > 2 ? `…/${cut.slice(-2).join("/")}` : p;
}

/** 내가 답할 것들 — 체크해 둔 것 중 사라진 것도 여기서 턴다 */
function asksIn(r: Room): AskCard[] {
  const mine = cards.filter((c) => c.roomId === r.id || c.roomId === "");
  for (const id of [...ticked]) if (!mine.some((c) => c.id === id)) ticked.delete(id);
  return mine;
}

/**
 * ★ **채팅에는 «왔다»만** (§5-M, 2026-10-14) — 답하는 자리는 유저 승인 화면이다.
 *
 * ⏪ 여기에 **카드가 통째로** 쌓였다(최대 44vh). 한 장일 때는 그게 제일 빨랐지만,
 * 🔴 쌓이면 **대화를 덮는다** — 그리고 봇의 큐를 화면으로 빼고 나니 같은 물건이
 * 두 모양이 됐다. 사용자가 고른 쪽: *"알림만 — 답하는 것은 전부 큰 화면에서"*.
 *
 * 🔴 **띠다, 메시지가 아니다.** 대화에 한 번 적고 마는 것은 **스크롤에 밀려**
 * «지금 몇 개가 기다리는지»를 못 말한다 — 부딪힘 띠가 배운 것과 같은 줄(§4.3).
 * 자리도 그대로 둔다: **머리 바로 아래**, 대화와 같이 안 흐른다.
 */
/**
 * ★ **승인은 입력창 바로 위에 쌓인다** (§5-M, 2026-10-14).
 *
 * ⏪ **두 번 옮겼다.** 처음에는 **머리 바로 아래**였다 — 대화가 바닥으로
 * 흐르므로 아래에 두면 밀린다는 것이 근거였다. 그 다음에는 **따로 한 화면**
 * 으로 뺐다 — 쌓이면 대화를 덮으므로. 둘 다 사용자가 물렸다:
 *
 * ```
 * 머리 아래   "승인 대기 알림이 위에 뜨니까 잘 안보임"
 * 따로 한 창  "창을 따로 만드니까 조금 불편한데"
 * ```
 *
 * 🔴 **눈은 입력창에 있다.** 답할 것이 거기 있어야 보이고, 답하고 나서
 * 이어서 칠 자리도 바로 아래다. 대화와 같이 안 흐르는 것은 그대로다 —
 * 스크롤 밖이라 밀려 올라가지 않는다.
 *
 * ★ **서넛까지만 보이고 그 다음은 스크롤** (사용자). 쌓이는 자리라 높이를
 * 안 묶으면 **대화를 덮는다** — 그게 화면으로 뺐던 까닭이었다.
 */
export function paintApprovals(r: Room): void {
  const host = S.chat?.queue;
  if (!host) return;
  const mine = asksIn(r);
  if (mine.length === 0) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  const keep = host.scrollTop;

  const answer = (card: AskCard, optionId?: string) => {
    if (!dropCard(card.id)) return;
    ticked.delete(card.id);
    post({ t: "answer", id: card.id, answer: { kind: "permission", optionId } });
  };
  /** 여러 개를 한 번에 — **«이번만»만** 쓴다 */
  const sweep = (list: AskCard[], allow: boolean) => {
    for (const c of list) answer(c, onceOption(c.req, allow));
    renderChat();
  };

  const rows = mine.map((card) => {
    const tick = el("input", { type: "checkbox" }) as HTMLInputElement;
    tick.checked = ticked.has(card.id);
    tick.addEventListener("change", () => {
      if (tick.checked) ticked.add(card.id);
      else ticked.delete(card.id);
      paintApprovals(r);
    });
    return approvalCard(r, card, (c, optionId) => (answer(c, optionId), renderChat()), tick);
  });

  const picked = mine.filter((c) => ticked.has(c.id));
  const head = el(
      "div",
      { class: "approvals-head" },
      el("span", { class: "count", text: `승인 대기 ${mine.length}` }),
      picked.length > 0
        ? el("button", {
            class: "ok",
            // 개수는 **바로 위 «승인 대기 N»** 과 체크 표시가 이미 말한다.
            // 단추에까지 넣으면 길어지기만 하고, 길이가 계속 바뀌어 자리가 흔들린다.
            text: "선택 허용",
            title: `고른 ${picked.length}개를 «이번만» 허용합니다`,
            onclick: () => sweep(picked, true),
          })
        : null,
      picked.length > 0
        ? el("button", {
            class: "no",
            text: "선택 거절",
            title: `고른 ${picked.length}개를 «이번만» 거절합니다`,
            onclick: () => sweep(picked, false),
          })
        : null,
      /*
       * ★ **«전부 거절»도 있다.**
       *
       * 🔴 «전부 허용»만 달았다가 고쳤다. 비대칭인데다, **거절이 더 안전한
       * 쪽**이라 막아둘 이유가 없다 — 자리를 비우거나 무슨 일인지 모를 때
       * 한 번에 물릴 수 있어야 한다. 거절해도 되돌릴 수 없는 일은 안 생긴다.
       */
      mine.length > 1
        ? el("button", {
            class: "ok",
            text: "전부 허용",
            title: `${mine.length}개를 «이번만» 허용합니다. «항상»은 하나씩 펴서 고르세요.`,
            onclick: () => sweep(mine, true),
          })
        : null,
      mine.length > 1
        ? el("button", {
            class: "no",
            text: "전부 거절",
            title: `${mine.length}개를 «이번만» 거절합니다.`,
            onclick: () => sweep(mine, false),
          })
        : null,
    );

  host.replaceChildren(head, ...rows);
  host.scrollTop = keep;
}

/**
 * ★ **승인 하나를 그린다 — 그리는 곳은 둘, 모양은 하나** (§5-M, 2026-10-14).
 *
 * 채팅의 승인 줄과 **대기 화면 위의 팝업**이 이 함수를 같이 쓴다.
 *
 * 🔴 **복사해 두면 갈린다.** 여기 있는 것은 전부 «무엇을 승인하는지»를 지키는
 * 장치다 — 보낼 말은 코드 상자에 안 넣고, 바꾸는 파일은 눌러서 열 수 있고,
 * «항상»은 펴야 나온다. 한쪽에만 고치면 **다른 쪽이 더 적게 보여주는 자리**가
 * 되고, 적게 보고 누르는 것이 곧 도장 찍기다(D1).
 *
 * 밖에서 받는 둘:
 *
 * ```
 * answer  답하고 **다시 그리는 것까지** — 채팅은 renderChat, 팝업은 닫기
 * tick    여럿 고르기 체크 상자. **팝업에는 없다**(한 장뿐이라 고를 것이 없다)
 * ```
 */
function approvalCard(
  r: Room,
  card: AskCard,
  answer: (card: AskCard, optionId?: string) => void,
  tick: HTMLElement | null,
): HTMLElement {
  const req = card.req;
  const from = req.askerBotId
    ? r.participants.find((b) => b.id === req.askerBotId)
    : undefined;
  const asker = hasManyBots(r) ? from?.name : undefined;

  /*
   * ★ **원래 누가 심사할 것이었나** (§4.2.2의 «대상»).
   *
   * 이 줄이 **내 큐에 있다는 것 자체가** 봇 심사가 안 됐다는 뜻이다 —
   * 맡길 봇이 바쁘거나, 답을 못 읽었거나, 읽기라 안 넘겼거나. 이유는
   * 안내 줄로 한 번 지나가지만 **그건 곧 사라진다.**
   *
   * 그래서 줄에 남긴다: «리뷰어가 볼 예정이었다»를 알면 *"왜 나한테
   * 왔지"* 가 풀리고, 자주 그러면 **맡김이 헛돌고 있다**는 신호가 된다.
   *
   * 대상이 사용자면 안 적는다 — 내 큐에 있는 게 당연한 경우다.
   */
  const meantFor =
    from?.approver.kind === "bot"
      ? r.participants.find((b) => b.id === (from.approver as { botId?: string }).botId)?.name
      : undefined;
  const quick = el(
    "span",
    { class: "quick" },
    /*
     * ★ **허용은 초록, 거절은 빨강** (2026-09-23).
     *
     * 🔴 «거절»이 흰 단추라 **글자를 읽어야만** 어느 쪽인지 알 수 있었다.
     * 승인 큐는 **여럿이 쌓이는 자리**라 하나씩 읽게 하면 안 된다 — 색이
     * 먼저 말하고 글자가 확인해 준다.
     *
     * 파괴적인 쪽(거절)을 **눈에 띄게** 둔다. 거절은 되돌릴 수 있지만
     * «잘못 허용»은 파일을 고치고 나서야 안다.
     */
    el("button", {
      class: "ok",
      text: "허용",
      title: "이번만 허용합니다. «항상»은 펴서 고르세요.",
      onclick: () => answer(card, onceOption(req, true)),
    }),
    el("button", {
      class: "no",
      text: "거절",
      onclick: () => answer(card, onceOption(req, false)),
    }),
  );

  // 펴면 **무엇을 승인하는지** 전부 (D1) — 제목만으로는 rm -rf 와 ls 가 같다
  const body = el("div", { class: "card-body" });
  /*
   * ★ **보낼 말을 그대로 보여준다** (v3.0 4-J).
   *
   * 봇이 봇을 부르는 승인이면 **무엇을 보내는가**가 판단의 전부다. 코드
   * 상자(`perm-cmd`)에 넣지 않는 이유는 그게 **명령처럼 보이기** 때문이다 —
   * 이건 사람 말이라 사람 말처럼 보여야 한다.
   */
  if (req.text) body.append(el("blockquote", { class: "perm-text", text: req.text }));
  if (req.command) body.append(el("pre", { class: "perm-cmd" }, el("code", { text: req.command })));
  for (const path of req.paths ?? []) {
    body.append(el("button", {
      class: "file", text: shortenPath(path), title: "에디터에서 열기",
      onclick: () => post({ t: "openFile", path }),
    }));
  }
  if (req.diff) {
    body.append(el("pre", { class: "preview" }, el("code", { text: req.diff.newText })));
  }
  body.append(
    el(
      "div",
      { class: "card-actions" },
      ...req.options.map((o) =>
        el("button", {
          class: /^allow/.test(o.kind) ? "primary" : "",
          text: o.name,
          onclick: () => answer(card, o.optionId),
        }),
      ),
    ),
  );

  return el(
    "div",
    { class: "approval" },
    el(
      "div",
      { class: "approval-head" },
      tick,
      el(
        "details",
        { class: "act" },
        el(
          "summary",
          { class: "activity" },
          icon("chevron-right"),
          icon(permIcon(req.kind)),
          // 같은 이유로 제 상자에 담는다 — `toolsNode` 의 설명 참조
          el("span", { class: "what", text: req.title }),
          /*
           * ★ **누가 하려는 일인가** (§4.2.2).
           *
           * 🔴 제목만 있었다. 단체방에서 «파일 고치기»가 셋 뜨면 어느 봇
           * 것인지 알 수가 없는데, 그게 허용 여부를 가르는 첫 근거다 —
           * **리뷰어가 파일을 고치려 하면 그것부터 이상하다.**
           *
           * 1:1에서는 안 붙인다. 상대가 하나뿐이라 자명하다.
           */
          asker ? el("span", { class: "by", text: asker }) : null,
          meantFor
            ? el("span", {
                class: "meant",
                text: `↷ ${meantFor}`,
                title: `원래 ${meantFor}에게 맡긴 승인입니다. 지금은 직접 답해야 합니다.`,
              })
            : null,
        ),
        body,
      ),
      quick,
    ),
  );
}
