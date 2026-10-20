/**
 * ★ **채팅 화면 — 분기** · 말풍선 메뉴 (v1.1).
 */
import { hasManyBots,
  inBotView,
  type BotInstance,
  type Message,
  type Room,
  type RoomMeta,
} from "../../core/types.js";
import { capsOf } from "./attach.js";
import { openBotView, openRoom, renderChat } from "./chat.js";
import { scrollInside } from "./scroll.js";
import { el, icon, type Kids } from "../common/dom.js";
import { screens } from "../common/screens.js";
import { S, agentById, post, statuses } from "../common/state.js";

// ── 분기 (v1.1) ─────────────────────────────────────────────────────────

/** 이 방에서 갈라져 나간 방들 (D3) */
export function childrenOf(roomId: string): RoomMeta[] {
  return S.metas.filter((m) => m.forkedFromRoomId === roomId);
}

/**
 * 원본 방의 **분기 지점으로** 간다 (D2·D3).
 *
 * 분기한 메시지 id를 두 방이 공유하므로(코어가 id를 그대로 물려준다) 검색
 * 결과로 점프하는 것과 같은 길을 쓴다 — 짝을 따로 들고 있을 필요가 없다.
 *
 * 원본이 없어졌으면 **아무 일도 안 한다.** 분기는 유지되지만(D4) 갈 곳이 없다.
 */
export function jumpToOrigin(r: { forkedFromRoomId?: string; forkedAtMessageId?: string }): void {
  if (!r.forkedFromRoomId || !S.metas.some((x) => x.id === r.forkedFromRoomId)) return;
  if (r.forkedAtMessageId) S.jumpToMessageId = r.forkedAtMessageId;
  openRoom(r.forkedFromRoomId);
}

/**
 * 헤더의 «여기서 분기» 버튼 — 서랍 버튼 옆.
 *
 * ⋮ 안에도 같은 것이 있지만, **분기는 대화를 보며 정하는 것**이라 메뉴를 열어
 * 찾게 하면 떠올리기 어렵다. 조건은 ⋮의 것과 **똑같이** 쓴다 — 한쪽에서만
 * 막히면 «왜 저기선 되는데»가 된다.
 *
 * 🔴 **못 할 때는 지우지 않고 죽여 둔다.** 버튼이 사라졌다 나타나면 헤더가
 * 들썩이고, 무엇보다 *"아까 있던 게 어디 갔지"* 가 된다. 이유는 툴팁에 적는다.
 */
export function forkHeadButton(r: Room, botId?: string): HTMLElement {
  const bot = botId ? r.participants.find((b) => b.id === botId) : undefined;
  // 봇만 가를 때는 **그 봇만** 본다 — 옆 봇이 도는 건 이 갈래와 상관이 없다
  const busy = bot ? isBusyBot(bot.id) : isBusyHere(r);
  const mine = bot
    ? r.messages.filter((m) => inBotView(m, bot.id))
    : r.messages;
  const empty = !mine.some((m) => m.role !== "system");
  const why = busy
    ? "응답이 끝난 뒤에 분기할 수 있습니다"
    : empty
      ? bot ? `${bot.name}와(과) 나눈 대화가 아직 없습니다` : "아직 나눌 대화가 없습니다"
      : bot ? `${bot.name}만 갈라 새 방으로` : "여기서 분기";
  return el("button", {
    class: "icon",
    title: why,
    disabled: busy || empty,
    onclick: () => askFork(r, undefined, botId),
  }, icon("git-branch"));
}

/** 그 봇이 도는 중인가 — 방 전체가 아니라 (v2.1) */
function isBusyBot(botId: string): boolean {
  const at = S.botStatus[botId] ?? "idle";
  return at !== "idle" && at !== "error";
}

/**
 * 분기 물어보기 (D1).
 *
 * ⚠️ **파일은 갈라지지 않는다.** 여기가 그걸 말할 유일한 자리다 — 분기 방은
 * «평범한 새 방»이라 상단 배너를 두지 않기로 했으므로(D2), 고르는 순간에
 * 말하지 않으면 영영 말하지 않는 셈이 된다. (방 정보에도 남긴다.)
 */
function askFork(r: Room, atMessageId?: string, botId?: string): void {
  const bot = botId ? r.participants.find((b) => b.id === botId) : undefined;
  const at = atMessageId ? r.messages.findIndex((m) => m.id === atMessageId) : r.messages.length - 1;
  // **그 봇이 본 것만** 물려받는다 — 수도 그것으로 세야 말이 맞는다
  const inherited = r.messages
    .slice(0, at + 1)
    .filter((m) => m.role !== "system" && (bot ? inBotView(m, bot.id) : true)).length;

  /*
   * ★ **폴백이 될 걸 알면 누르기 전에 말한다** (§0 P5).
   *
   * 분기의 값어치는 «계획과 파일 기억까지 그대로»에 있다. 그게 안 되는 경우에
   * 같은 얼굴로 물으면, 사용자는 세션이 복제된 줄 알고 *"아까 읽은 파일"* 을
   * 가리키며 대화한다. **잃는 걸 알고 고르는 것과 모르고 고르는 것은 다르다.**
   *
   * 두 가지를 확실히 알 수 있다:
   *   · 과거 지점 — ACP에 «어느 지점에서»가 없다. **프로토콜상 언제나** 폴백
   *   · 에이전트가 분기를 광고 안 함 — 이미 붙어 있으므로 알 수 있다
   *
   * `unknown`이면 **아무 말도 안 한다.** 모르는 걸 단정하면 멀쩡한 에이전트를
   * 못 한다고 모함하게 된다.
   */
  const past = at < r.messages.length - 1;
  /*
   * ★ **누가 잃는지까지 말한다** (v2.0).
   *
   * 단체방은 봇마다 에이전트가 다르다. «일부는 잃습니다»만 써두면
   * **누구에게 다시 설명해야 하는지** 모른 채로 고르게 된다.
   *
   * 과거 지점은 프로토콜상 전원이 폴백이다 — `ForkSessionRequest`에 «어느
   * 지점에서»가 없기 때문이다. 끝에서 가를 때만 봇마다 갈린다.
   */
  const split = bot ? [bot] : r.participants;
  const losers = past
    ? split
    : split.filter((b) => capsOf(b.agentId).fork === "no");
  const lossy = losers.length > 0;
  // 봇이 하나면 이름을 안 붙인다 — 군더더기다. 조사도 그에 따라 갈린다.
  const subject =
    split.length > 1 && !past && lossy
      ? `${losers.map((b) => b.name).join("·")}는 계획과 파일 기억을`
      : "계획과 파일 기억은";
  const title = el("input", {
    type: "text",
    placeholder: bot
      ? `비우면 «${r.title} — ${bot.name}»`
      : `비우면 «${r.title.replace(/\s*\(\d+\)\s*$/, "")} (2)»`,
  }) as HTMLInputElement;

  const go = (fallback?: "refeed" | "fresh") => {
    post({
      t: "fork",
      roomId: r.id,
      ...(atMessageId ? { atMessageId } : {}),
      ...(botId ? { botId } : {}),
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
      ...(fallback ? { fallback } : {}),
    });
    renderChat();
  };

  const node = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title" }, icon("git-branch"),
       bot ? ` ${bot.name}만 갈라내기` : " 여기서 분기"),
    el("div", {
      class: "dim",
      text: bot
        /*
         * ★ **무엇이 따라가고 무엇이 안 따라가는지**를 한 줄에 담는다.
         *
         * 봇만 가르는 것은 «이사»에 가까워서, 남는 쪽이 어떻게 되는지를 같이
         * 말하지 않으면 **원본에서 그 봇이 사라지는 줄 안다.**
         */
        ? `${bot.name}와(과) 나눈 대화 ${inherited}개를 물려받아 ` +
          `${bot.name} 혼자 있는 새 방을 만듭니다. 이 방은 ${bot.name}을(를) 포함해 그대로 남습니다.`
        : `지금까지의 대화 ${inherited}개를 물려받아 새 방을 만듭니다. ` +
          `이 방은 그대로 남습니다.`,
    }),
    el("div", { class: "card-body" }, title),
    // ★ 잎는 것을 **누르기 전에** — 위 주석 참조
    lossy
      ? el(
          "div",
          { class: "warn-row" },
          icon("warning"),
          ` ${subject} 물려받지 못합니다 — 대화만 글로 옮깁니다. ` +
            (past
              ? "과거 지점은 세션을 복제할 수 없습니다."
              : `${[...new Set(losers.map((b) => agentById.get(b.agentId)?.label ?? "이 에이전트"))].join("·")}는 세션 분기를 지원하지 않습니다.`) +
            (r.participants.length > losers.length
              ? ` 나머지 봇은 그대로 갈라집니다.`
              : "") +
            " 다음 메시지에 실려 가므로 토큰이 듭니다.",
        )
      : null,
    /*
     * **fork의 목적이 코드에 대해서는 성립하지 않는다** (D1).
     * 대화는 갈라지지만 워크스페이스는 하나라, 분기 방에서 고친 파일은
     * 원본 쪽 결과도 같이 바꾼다. 격리하지 않기로 했으므로 **분명히 알린다.**
     */
    el(
      "div",
      { class: "warn-row" },
      icon("warning"),
      " 파일과 **에이전트의 기억**은 분기되지 않습니다 — 두 방이 같은 폴더를 보므로, "
        + "분기에서 «기억해»한 것이 CLAUDE.md 같은 파일에 적힐 수 있고, 그러면 원본도 읽게 됩니다.",
    ),
    el(
      "div",
      { class: "card-actions" },
      el("button", { text: "취소", onclick: () => renderChat() }),
      /*
       * ★ **기본은 언제나 네이티브 분기다.** 잃는 게 없고 토큰도 안 든다.
       *
       * 못 할 게 뻔한 경우에만 **둘로 갈라 묻는다.** 우리가 고르면 안 되는
       * 이유는 손해의 방향이 반대라서다 — 글로 옮기면 토큰이 들고, 백지로
       * 가면 상대가 아무것도 모른다. 어느 쪽이 나은지는 대화 길이와 지갑
       * 사정이 정하는데 **둘 다 우리가 모르는 것**이다.
       */
      ...(lossy
        ? [
            // 둘 다 «진행»이라 왼쪽이 약한 쪽, 오른쪽이 권하는 쪽이다
            el("button", {
              text: "기록만 두고 분기",
              title: "화면에는 남지만 에이전트는 위 대화를 모릅니다",
              onclick: () => go("fresh"),
            }),
            el("button", {
              class: "primary",
              text: "대화 넘겨서 분기",
              title: "지금까지의 대화를 글로 옮겨 보냅니다 — 토큰이 듭니다",
              onclick: () => go("refeed"),
            }),
          ]
        : [el("button", { class: "primary", text: "분기하기", onclick: () => go() })]),
    ),
  );

  S.chat?.list.append(node);
  if (S.chat?.list) scrollInside(S.chat.list, node, "end");
  title.focus();
}

/**
 * 물려받은 메시지가 끝나는 자리의 **인라인 마커** (D2).
 *
 * 메신저의 «여기서부터 안 읽음» 구분선과 같은 패턴이다. 상단 배너를 쓰지
 * 않는 이유도 같다 — 분기 방은 평범한 방이고, 시간이 지나면 이 선은 위로
 * 밀려 사라진다. 그게 맞다. 식별은 목록의 계보 배지가 계속 해준다(D3).
 */
export function forkLine(r: Room): HTMLElement {
  const parent = S.metas.find((m) => m.id === r.forkedFromRoomId);
  const node = el(
    "div",
    { class: parent ? "fork-line linked" : "fork-line" },
    el("span", { text: parent ? `↳ ${parent.title}에서 분기` : "↳ 삭제된 방에서 분기" }),
  );
  if (parent) {
    node.title = "원본의 분기 지점으로";
    node.addEventListener("click", () => jumpToOrigin(r));
  }
  return node;
}

/**
 * 말풍선에서 코드 펜스만 걷어낸다.
 *
 * 붙여넣으려는 것은 설명이 아니라 **코드**다. 펜스가 여럿이면 빈 줄로 잇는다 —
 * 어느 것 하나를 고르게 하면 «둘째 거였나»를 다시 열어봐야 한다.
 */
function codeOf(text: string): string {
  const parts = text.split("```");
  const blocks: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const part = parts[i]!;
    const nl = part.indexOf("\n");
    blocks.push((nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, ""));
  }
  return blocks.join("\n\n");
}

/** 복사하고 **복사했다고 말해준다** — 클립보드는 눈에 안 보이는 곳이라 확인이 필요하다 */
function copyThen(text: string, btn: HTMLElement, close: () => void): void {
  void navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = "복사했습니다";
      setTimeout(close, 600);
    },
    () => {
      btn.textContent = "복사하지 못했습니다";
      setTimeout(close, 1200);
    },
  );
}

/**
 * 말풍선 메뉴 — **그 메시지에 대한 것만** 둔다.
 *
 * 🔴 한때 여기에 압축·중단·참여자 서랍까지 달았다가 걷어냈다. 전부 **봇에 대한
 * 것**이라 서랍이 제자리이고, 헤더에 이미 버튼이 있는 것을 여기 또 두면 «어디서
 * 하는 게 맞지»만 남는다. 메뉴는 짧을수록 고르기 쉽다.
 *
 * 남긴 분기는 다르다 — 헤더의 것은 **대화 끝에서** 갈라지고, 여기 것은 **이
 * 지점에서** 갈라진다. 중간부터 다시 가보는 길은 여기에만 있으므로, 이름에
 * «이 메시지에서»를 넣어 차이를 드러낸다.
 */
export function openMessageMenu(e: MouseEvent, m: Message): void {
  const r = S.room;
  if (!r) return;
  e.preventDefault();
  screens.chat.querySelector(".menu")?.remove();

  const close = () => screens.chat.querySelector(".menu")?.remove();
  const kids: Kids = [];

  // ── 복사 — 코딩 대화에서 제일 자주 하는 일
  if (m.text.trim()) {
    const copy = el("button", { text: "복사" });
    copy.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyThen(m.text, copy, close);
    });
    kids.push(copy);

    const code = codeOf(m.text);
    if (code) {
      const only = el("button", { text: "코드만 복사" });
      only.addEventListener("click", (ev) => {
        ev.stopPropagation();
        copyThen(code, only, close);
      });
      kids.push(only);
    }
  }

  /*
   * ── ★ **이 말에 얽힌 봇의 뷰로** (v2.1)
   *
   * 🔴 입구가 **참여자 서랍 하나뿐**이었다. 서랍은 «봇을 관리하는 곳»이라
   * 대화를 읽다가 *"얘랑 한 얘기만 몰아 보고 싶다"* 가 될 때 **손이 거기로
   * 안 간다** — 지금 보고 있는 말풍선이 바로 그 봇 것인데도.
   *
   * 여기가 제자리인 이유: 말풍선은 **누구 이야기인지 이미 알고 있다.** 고를
   * 것이 없으니 «이 봇과의 것만»이 한 번에 된다.
   */
  const linked = m.role === "agent"
    ? (m.authorBotId ? [m.authorBotId] : [])
    // 보낸 말은 **받은 봇들**이 얽힌 봇이다. 못 간 곳도 그 봇 이야기다(§5)
    : [...new Set([...m.deliveredTo, ...(m.notSentTo ?? [])])];
  const jumps = linked
    .filter((id) => id !== S.viewBotId)
    .map((id) => r.participants.find((b) => b.id === id))
    .filter((b): b is BotInstance => b !== undefined);

  if (hasManyBots(r) && jumps.length > 0) {
    if (kids.length > 0) kids.push(el("hr"));
    for (const b of jumps) {
      kids.push(el("button", {
        text: `${b.name}와(과)의 1:1 뷰`,
        title: `${b.name}와(과) 주고받은 것만 모아 봅니다`,
        onclick: () => { close(); openBotView(b.id); },
      }));
    }
  }

  // ── 분기 — 헤더 버튼이 못 하는 것: **이 지점에서**
  if (kids.length > 0) kids.push(el("hr"));
  kids.push(
    el("button", {
      text: "이 메시지에서 분기",
      title: "여기까지를 물려받은 새 방을 만듭니다",
      onclick: () => {
        close();
        // 뷰 안에서 고른 지점이면 **그 봇만** 가른다 — 자리가 뜻을 말한다 (v2.1)
        askFork(r, m.id, S.viewBotId ?? undefined);
      },
    }),
  );

  const menu = el("div", { class: "menu at" }, ...kids);

  const box = screens.chat.getBoundingClientRect();
  menu.style.top = `${e.clientY - box.top}px`;
  menu.style.left = `${Math.min(e.clientX - box.left, box.width - 190)}px`;
  menu.style.right = "auto";
  screens.chat.append(menu);
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

/** 지금 이 방이 일하는 중인가 — 진행 중에는 분기를 막는다 (D4) */
function isBusyHere(r: Room): boolean {
  const s = statuses.get(r.id) ?? "idle";
  return s !== "idle" && s !== "error";
}

/**
 * **봇을 나눠도 기억은 나뉘지 않는다** — 다중 봇 방의 공지.
 *
 * 에이전트의 기억은 `~/.claude/projects/<cwd 슬러그>/memory/` 에 쌓인다(§13.2 실측).
 * **열쇠가 cwd**라서, 방을 나눠도 봇을 나눠도 폴더가 같으면 같은 기억을 읽는다.
 * 설정 디렉터리를 가르는 길은 인증이 죽어 닫혔고(자격증명을 복사하는 것은 §0 P3 위반),
 * 남는 길은 cwd를 가르는 것뿐이다.
 *
 * 그러니 **막을 수 없는 것은 말이라도 해준다**(§0). «리뷰어»와 «구현자»를
 * 한 방에 넣고 각자에게 다른 걸 시킨 사람은, 한 쪽에게 시킨 «기억해»가 다른 쪽에게
 * 넘어간 것을 **알 길이 없다** — 대화는 갈라져 보이니까.
 */
export function sharedMemoryRow(r: Room): HTMLElement | null {
  if (!hasManyBots(r)) return null;
  return el(
    "div",
    { class: "warn-row" },
    icon("warning"),
    " 에이전트의 기억은 봇마다 나뉘지 않습니다 — 같은 폴더를 보는 봇은 한 쪽에게 "
      + "«기억해»라고 시킨 것을 같이 읽습니다. 대화 내용 자체는 봇마다 따로입니다.",
  );
}

/**
 * 방 정보의 분기 줄 (D1·D3).
 *
 * 인라인 마커는 대화가 길어지면 위로 밀려 사라진다 — 그게 맞지만(D2), 그러면
 * **«파일은 공유된다»를 다시 볼 자리가 없어진다.** 방 정보는 그 자리다:
 * 늘 있지만 길을 막지는 않는다.
 */
export function forkInfoRows(r: Room): Kids {
  const parent = S.metas.find((m) => m.id === r.forkedFromRoomId);
  const value = el("span", {
    class: parent ? "link-ish" : "",
    text: parent ? parent.title : "삭제된 방",
  });
  if (parent) {
    value.title = "원본의 분기 지점으로";
    value.addEventListener("click", () => jumpToOrigin(r));
  }
  return [
    el("div", { class: "info-row" }, el("span", { class: "dim", text: "분기 원본" }), value),
    el(
      "div",
      { class: "warn-row" },
      icon("warning"),
      " 파일과 에이전트의 기억은 분기되지 않습니다 — 원본 방과 같은 폴더를 봅니다. "
        + "대화 내용은 갈라집니다.",
    ),
  ];
}
