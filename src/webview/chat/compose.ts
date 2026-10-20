/**
 * ★ **채팅 화면 — 입력창** · 멘션 칩 · 고르개 · 예약 (§4.1.2).
 */
import { EVERYONE, parseCompose, type ComposeToken } from "../../core/mentions.js";
import { hasManyBots, type Room } from "../../core/types.js";
import { el, icon } from "../common/dom.js";
import { screens } from "../common/screens.js";
import { S, post } from "../common/state.js";
import { autoGrow } from "../common/text.js";

/**
 * ★ **입력창에 이미 꽂힌 칩의 이름을 고친다** (§4.1.2).
 *
 * 🔴 칩은 `data-bot` 을 들고 있어서 **라우팅은 멀쩡하다** — 이름을 바꿔도
 * 그 봇에게 간다. 그런데 **글자는 만들 때 박아 넣은 옛 이름 그대로**라,
 * 「@구현」이라 적힌 칩을 보내면 화면에는 「@리뷰어」에게 간 것으로 나온다.
 * 보이는 것과 가는 곳이 어긋나면 **어디를 믿어야 할지 알 수 없다.**
 *
 * 글자가 실제로 다를 때만 손댄다 — contenteditable 안이라 건드리면 커서가
 * 튈 수 있고, 이름 바꾸기는 어차피 드물다.
 */
export function refreshMentionChips(r: Room): void {
  const box = S.chat?.box;
  if (!box) return;
  for (const chip of box.querySelectorAll<HTMLElement>(".chip[data-bot]")) {
    const id = chip.getAttribute("data-bot") ?? "";
    const name = id === EVERYONE
      ? "everyone"
      : (r.participants.find((b) => b.id === id)?.name ?? id);
    const want = `@${name}`;
    if (chip.textContent !== want) chip.textContent = want;
  }
}

// ── 멘션 칩 입력창 (§4.1.2) ────────────────────────────────────────────

/**
 * **단체방의 입력창** — 칩으로 지목한다.
 *
 * 1:1에서는 안 쓴다. 봇이 하나인데 `@`를 치게 할 이유가 없다 — 지목이 뜻을 갖는
 * 것은 **고를 상대가 있을 때**부터다.
 *
 * ✅ **한글이 안 깨진다** (2026-09-21 실측, §4.1.2). 조합 이벤트가 `textarea`와
 * 한 글자도 다르지 않았고, 칩은 백스페이스 한 번에 통째로 지워진다. 그래서
 * `contenteditable`을 그대로 쓴다.
 *
 * 🔴 **칩만 멘션이다.** 직접 친 `@gmail.com`은 그냥 글자다. 칩은 `botId`를 들고
 * 있어서 **이름을 바꿔도 라우팅이 유지된다** — 보이는 이름과 가리키는 대상이
 * 따로 놀 수 있다는 뜻이고, 그게 칩을 쓰는 진짜 이유다.
 */
export function makeChipBox(): HTMLElement {
  const box = el("div", {
    class: "box chipbox",
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "true",
    "data-empty": "메시지 입력…  @로 지목",
  });
  return box;
}

/**
 * **보내기 전에 누구에게 가는지 보여준다** (§4.1.2).
 *
 * «보이는데 봇은 모른다»가 이 설계의 유일한 위험이다(§4.1.1). 그런데
 * 그 간극은 **보내기 전에** 줄이는 게 제일 싸다 — 보내고 나서 «안 갔다»는
 * 이미 한 번 틀린 뒤다.
 */
export function paintCompose(r: Room, box: HTMLElement): void {
  const bar = S.chat?.compose;
  if (!bar) return;
  box.dataset.filled = box.textContent?.trim() || box.querySelector(".chip") ? "1" : "";

  const tokens = readTokens(box);
  const parsed = parseCompose(tokens, r.participants);
  if (!box.dataset.filled) { bar.replaceChildren(); bar.hidden = true; return; }

  bar.hidden = false;
  if (parsed.blocked) {
    /*
     * ★ **아직 안 쓴 것은 잘못이 아니다.**
     *
     * 🔴 칩을 꽂자마자 빨간 «보낼 내용이 없습니다»가 떴다. 자동완성으로
     * 고르든 서랍에서 꽂든 **지목이 먼저고 지시가 나중**인데, 그 사이의
     * 한 박자를 오류로 찍은 것이다. 틀린 말은 아니지만 **사용자가 뭘 잘못한
     * 것처럼** 보이고, 매번 뜨면 진짜 경고까지 같이 무시하게 된다.
     *
     * 지목만 있으면 **다음에 할 일을 알려준다.**
     */
    const named = tokens.filter((t) => t.kind === "mention");
    const nothingYet =
      named.length > 0 &&
      tokens.every((t) => t.kind === "mention" || t.text.trim() === "");
    if (nothingYet) {
      const names = named
        .map((t) =>
          t.kind === "mention" && t.botId !== EVERYONE
            ? (r.participants.find((p) => p.id === t.botId)?.name ?? "?")
            : "전원",
        )
        .join("·");
      bar.className = "compose-note";
      bar.replaceChildren(el("span", { text: `${names}에게 — 무엇을 시킬지 적어주세요` }));
      return;
    }
    bar.className = "compose-note bad";
    bar.replaceChildren(el("span", { text: parsed.blocked }));
    return;
  }
  bar.className = "compose-note";

  /*
   * ★ **그룹을 색으로 가른다** (§4.1.2의 «실시간 하이라이트»).
   *
   * 한 번에 쓴 글이 여러 봇에게 **서로 다른 지시**로 갈라지는데, 어디서
   * 갈라지는지가 안 보였다. 요약은 «둘에게 1블록»이라고만 했지 *"어느 글이
   * 누구에게"* 는 말하지 않았다 — 줄이 몇 개만 되어도 못 따라간다.
   *
   * 🔴 **글자에는 손대지 않는다.** 칠하려면 텍스트 노드를 `<span>`으로
   * 감싸야 하는데, `contenteditable` 안에서 그러면 **한글 조합이 그 경계에서
   * 깨진다** — 칩 입력창을 쓰기로 한 근거(조합이 `textarea`와 한 글자도 다르지
   * 않다)를 우리 손으로 무너뜨리는 일이다.
   *
   * 그래서 **칩만 칠하고**(칩은 원래 엘리먼트다) 글은 **요약 줄에 옮겨 적어**
   * 같은 색을 준다. 「어느 칩 — 어떤 글 — 누구에게」가 한 줄로 맞춰진다.
   *
   * 어느 칩이 어느 그룹인지는 **코어가 알려준다**(`mentionAt`) — 화면이 다시
   * 계산하면 규칙이 두 군데 살게 된다.
   */
  const chips = [...box.querySelectorAll<HTMLElement>(".chip")];
  let seen = 0;
  const chipOfToken = new Map<number, HTMLElement>();
  for (const [n, t] of tokens.entries()) {
    if (t.kind !== "mention") continue;
    const node = chips[seen++];
    if (node) chipOfToken.set(n, node);
  }
  for (const c of chips) delete c.dataset.group;

  const rows: HTMLElement[] = [];
  parsed.blocks.forEach((b, at) => {
    const tint = String(at % GROUP_TINTS);
    for (const n of b.mentionAt) chipOfToken.get(n)?.setAttribute("data-group", tint);

    const names = b.botIds
      .map((id) => r.participants.find((p) => p.id === id)?.name ?? id)
      .join("·");
    rows.push(
      el(
        "div",
        { class: "note-row", "data-group": tint },
        el("span", { class: "to", text: names }),
        // **무엇이 갈지 그대로 보여준다** — 「어느 글이 누구에게」가 요점이다
        el("span", { class: "what", text: b.text, title: b.text }),
      ),
    );
  });

  bar.replaceChildren(
    ...rows,
    ...parsed.warnings.map((w) => el("span", { class: "bad", text: w })),
  );
}

/**
 * 그룹을 가르는 색이 몇 가지인가.
 *
 * 다 쓰면 처음으로 돌아간다 — **이웃한 그룹만 달라 보이면 된다.** 그룹이
 * 넷을 넘는 일은 드물고, 색을 무한히 늘리면 서로 구별이 안 되는 색이 나온다.
 */
const GROUP_TINTS = 4;

/**
 * ★ **치워둔 글** — 깊이 1 스택 (v3.0 1-E).
 *
 * 「수정」을 누르면 예약 글이 입력창으로 내려오는데, 그때 **쓰던 글이 있으면**
 * 덮어쓰게 된다. 묻지도 않고 안 잃으려면 어딘가 둬야 한다.
 *
 * 🔴 **이건 «예약»이 아니다.** 예약 칸은 턴이 끝나면 **나가고**, 치워둔 칸은
 * **안 나간다** — 그냥 보관이다. 그래서 «예약은 명시적 행동»이 안 깨진다.
 *
 * 깊이는 **1 이면 충분하다** — 예약이 하나니 밀어둘 것도 하나뿐이다. 그리고
 * **보여준다.** 숨긴 스택이 문제지, 한 줄로 보이면 그냥 «잠깐 치워둔 것»이다.
 */
let stash: { roomId: string; tokens: ComposeToken[] } | null = null;

/** 이 글이 갈 봇들 중 **도는 중인** 이름들 */
export function busyAmong(r: Room, botIds: string[]): string[] {
  return botIds
    .filter((id) => {
      const at = S.botStatus[id];
      return at !== undefined && at !== "idle" && at !== "error";
    })
    .map((id) => r.participants.find((b) => b.id === id)?.name ?? id);
}

/** 토큰을 입력창에 되돌린다 — 칩은 칩으로, 글자는 글자로 */
export function putTokens(r: Room, tokens: ComposeToken[]): void {
  // `chat.box` 는 1:1 이면 textarea, 단체방이면 contenteditable 이다
  const box: HTMLElement | undefined = S.chat?.box;
  if (!box) return;
  if (box instanceof HTMLTextAreaElement) {
    box.value = tokens.map((t) => (t.kind === "text" ? t.text : "")).join("").trim();
    autoGrow(box);
    box.focus();
    return;
  }
  /*
   * 🔴 **글자로 눌러 담지 않는다.** «@구현» 을 글자로 되돌리면 그게 지목인지
   * 글자인지 우리가 다시 해석해야 하고, 사용자가 쓴 것과 달라질 수 있다.
   * 칩은 칩 그대로 돌려놓는다.
   */
  box.replaceChildren(
    ...tokens.map((t) =>
      t.kind === "mention"
        ? mentionChip(t.botId, r.participants.find((b) => b.id === t.botId)?.name ?? "?")
        : box.ownerDocument.createTextNode(t.text),
    ),
  );
  box.focus();
  box.dispatchEvent(new Event("input"));
}

/** 지금 입력창에 든 것 — 둘 중 어느 모양이든 토큰으로 */
function takeTokens(): ComposeToken[] {
  const box: HTMLElement | undefined = S.chat?.box;
  if (!box) return [];
  if (box instanceof HTMLTextAreaElement) {
    const text = box.value.trim();
    box.value = "";
    autoGrow(box);
    return text ? [{ kind: "text", text }] : [];
  }
  const out = readTokens(box);
  box.replaceChildren();
  return out.some((t) => t.kind === "mention" || t.text.trim()) ? out : [];
}

/**
 * ★ **입력창 위 한 줄** — 예약 칸, 또는 치워둔 칸 (v3.0 1-E).
 *
 * **둘이 동시에 안 뜬다.** 「수정」을 누르는 순간 예약이 풀리므로 언제나 한 줄이다.
 *
 * ```
 * 예약만 있을 때   ⏳ 끝나면 보냅니다 — "그거 말고 이거"   [수정] [내리기]
 * 수정 누른 뒤     ↩ 치워둔 글 — "아까 쓰던 거"           [되돌리기]
 * ```
 *
 * 🔴 **접거나 작게 하지 않는다.** 올려두고 잊으면 10분 뒤 뜬금없이 나가서
 * «이게 왜 나가?»가 된다. 입력창 위에 계속 보이는 것이 그 값이다.
 */
export function paintStaged(r: Room): void {
  const host = S.chat?.staged;
  if (!host) return;
  host.replaceChildren();

  if (r.staged) {
    const glance = quoteish(textOf(r, r.staged.tokens));
    host.hidden = false;
    host.append(
      el("span", { class: "what", text: `⏳ 끝나면 보냅니다 — ${glance}` }),
      el(
        "button",
        {
          class: "link",
          title: "예약을 풀고 글을 입력창으로 가져옵니다. 쓰던 글은 잠깐 치워둡니다.",
          onclick: () => {
            // **쓰던 글을 먼저 치운다** — 묻지도 않고 안 잃는다
            const now = takeTokens();
            stash = now.length > 0 ? { roomId: r.id, tokens: now } : null;
            post({ t: "editStaged", roomId: r.id });
          },
        },
        icon("edit"),
        "수정",
      ),
      el(
        "button",
        {
          class: "link",
          // 아무도 못 봤으므로 지울 수 있고, 지우면 자국이 없다 (§0)
          title: "올려둔 글을 버립니다.",
          onclick: () => post({ t: "unstage", roomId: r.id }),
        },
        icon("close"),
        "내리기",
      ),
    );
    return;
  }

  if (stash?.roomId === r.id) {
    const kept = stash.tokens;
    host.hidden = false;
    host.append(
      el("span", { class: "what", text: `↩ 치워둔 글 — ${quoteish(textOf(r, kept))}` }),
      el(
        "button",
        {
          class: "link",
          title: "치워둔 글을 입력창으로 되돌립니다.",
          onclick: () => {
            stash = null;
            putTokens(r, kept);
            paintStaged(r);
          },
        },
        icon("discard"),
        "되돌리기",
      ),
    );
    return;
  }

  host.hidden = true;
}

/** 토큰을 사람이 읽을 한 줄로 */
function textOf(r: Room, tokens: ComposeToken[]): string {
  return tokens
    .map((t) =>
      t.kind === "mention"
        ? `@${r.participants.find((b) => b.id === t.botId)?.name ?? "?"}`
        : t.text,
    )
    .join("");
}

/** 한 줄에 들어갈 만큼만 — 전체는 입력창이나 예약 칸이 들고 있다 */
function quoteish(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `"${one.length > 40 ? `${one.slice(0, 40)}…` : one}"`;
}

/**
 * ★ **바쁘면 단추가 «끝나면 보내기»라고 말한다** (v3.0 1-E).
 *
 * 🔴 누르기 전에 **무슨 일이 일어날지**를 말해야 한다. 같은 아이콘이 어떤
 * 때는 바로 보내고 어떤 때는 올려두면, 올려둔 글이 10분 뒤에 나갈 때
 * «이게 왜 나가?»가 된다 — 올린 기억이 없으니까.
 *
 * 예약이 이미 하나 있으면 **못 올린다**(칸이 하나다). 그것도 미리 말한다 —
 * 눌러보고 나서 알려주면 이미 한 번 헛손질한 뒤다.
 */
export function paintSendButton(r: Room): void {
  const btn = S.chat?.box.parentElement?.querySelector<HTMLButtonElement>("button.send");
  if (!btn) return;
  const targets = S.viewBotId ? [S.viewBotId] : r.participants.map((b) => b.id);
  const held = busyAmong(r, targets);
  const full = r.staged !== undefined;

  /*
   * 🔴 **올려둔 것이 있으면 아무것도 안 나간다** — 받는 이가 누구든.
   *
   * ⏪ 한때 «바쁜 봇에게만» 막았다. 그러면 올려둔 글이 베타를 기다리는 동안
   * **알파에게 친 말이 먼저 나간다** — 입력창 위에는 «끝나면 보냅니다» 가
   * 떠 있는데 나중에 친 말이 먼저 가는 꼴이라, **그 줄이 거짓이 된다.**
   *
   * 예약 칸을 하나로 둔 근거가 «하나뿐이라 순서가 없다» 였는데, 그러면
   * 사실상 «예약 1 + 즉시 전송» 이라 **순서가 둘**이 된다.
   *
   * ★ **끄는 것이 거절보다 낫다.** 거절하려면 일단 보내야 하고, 보내려면
   * 입력창을 비워야 한다 — 그 사이에 **글을 잃는다**(실제로 그랬다).
   * 꺼두면 누를 수가 없으니 비울 일도 없다.
   */
  btn.disabled = full;
  btn.classList.toggle("later", !full && held.length > 0);
  btn.title = full
    ? "올려둔 글이 먼저 나가야 합니다 — 위에서 보내거나 내릴 수 있습니다."
    : held.length > 0
      ? `${held.join("·")}이(가) 답하는 중입니다 — 끝나면 보냅니다.`
      : "보내기";
  btn.replaceChildren(icon(held.length > 0 && !full ? "history" : "send"));
}

/** 칩 하나. `botId`가 진짜 값이고 글자는 보여주기용이다 */
function mentionChip(botId: string, name: string): HTMLElement {
  return el("span", {
    class: "chip",
    contenteditable: "false",
    "data-bot": botId,
    text: `@${name}`,
  });
}

/**
 * 입력창을 **토큰으로 읽는다** — 코어가 규칙을 적용할 수 있게 (§4.1.2).
 *
 * 화면이 하는 일은 여기까지다. «줄 맨 앞인가», «연속인가», «누가 받나»는
 * `parseCompose`가 정한다.
 */
export function readTokens(box: HTMLElement): ComposeToken[] {
  const out: ComposeToken[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  const walk = (node: Node): void => {
    for (const kid of [...node.childNodes]) {
      if (kid.nodeType === Node.TEXT_NODE) {
        push((kid as Text).data.replace(/ /g, " "));
        continue;
      }
      const elm = kid as HTMLElement;
      if (elm.dataset?.bot) {
        out.push({ kind: "mention", botId: elm.dataset.bot });
        continue;
      }
      // 줄바꿈은 브라우저가 <div>·<br>로 만든다 — 글자로 되돌린다
      if (elm.tagName === "BR") { push("\n"); continue; }
      if (elm.tagName === "DIV" || elm.tagName === "P") push("\n");
      walk(elm);
    }
  };
  walk(box);
  return out;
}

/** 지금 커서 앞에 `@검색어`가 열려 있나 — 자동완성을 띄울지 정한다 */
function openQuery(box: HTMLElement): { node: Text; at: number; q: string } | null {
  const sel = box.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !box.contains(node)) return null;

  const text = (node as Text).data.slice(0, sel.anchorOffset);
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  const q = text.slice(at + 1);
  // 공백이 들어가면 더는 이름을 고르는 중이 아니다
  if (/\s/.test(q)) return null;
  return { node: node as Text, at, q };
}

/**
 * **지금 모으고 있는 그룹**의 봇들 (§4.1.2 규칙 3).
 *
 * 🔴 예전엔 **상자 안의 칩을 전부** 뺐다. 그러면 첫 줄에 `@Claude`를 쓴 뒤
 * 아래에 새 그룹을 열면 **Claude가 목록에 안 뜬다** — «다들 이거 보고,
 * Claude는 이것도»가 안 된다. 그건 단체방에서 제일 하고 싶은 일 중 하나다.
 *
 * 빼자고 정한 것은 **그 그룹**이다 — `(@Claude) @`에서 Claude가 또 뜨면 안 된다는
 * 뜻이지, 아래에서 다시 부를 수 없다는 뜻이 아니다.
 *
 * 커서 앞에서 거슬러 올라가며 **공백만 끼고 늘어선 칩**만 모은다. 글자가 끼어
 * 있으면 거기서 그룹이 끝난 것이다.
 */
function groupSoFar(box: HTMLElement, from: Node): Set<string> {
  const ids = new Set<string>();
  let node: Node | null = from;
  while (node && node !== box) {
    const prev: Node | null = node.previousSibling;
    if (!prev) {
      node = node.parentNode;
      continue;
    }
    node = prev;
    if (prev.nodeType === Node.TEXT_NODE) {
      // 공백만이면 아직 같은 그룹이다
      if ((prev as Text).data.trim() !== "") return ids;
      continue;
    }
    const elm = prev as HTMLElement;
    if (elm.dataset?.bot) {
      ids.add(elm.dataset.bot);
      continue;
    }
    if (elm.tagName === "BR") continue;
    return ids;
  }
  return ids;
}

/**
 * 자동완성 목록 (§4.1.2).
 *
 * 맨 위에 **직전 그룹**이 온다 — 같은 상대에게 이어서 말하는 것이 가장 흔한데,
 * 스티키(마지막 대상을 기억)는 «지금 누구에게 말하는지»가 숨은 상태가 되므로
 * 쓰지 않는다. `@`+Tab은 **사용자가 요청할 때만** 채워지므로 명시성을 안 잃는다.
 */
export function paintPicker(r: Room, box: HTMLElement): void {
  closePicker();
  const found = openQuery(box);
  if (!found) return;

  const q = found.q.toLowerCase();
  const already = groupSoFar(box, found.node);
  const hits = r.participants.filter(
    (b) => !already.has(b.id) && b.name.toLowerCase().includes(q),
  );

  type Row = { label: string; ids: string[]; hint?: string };
  const rows: Row[] = [];
  // 글자를 치기 시작하면 직전 그룹은 사라진다 — 특정 봇을 찾는 중이므로
  if (q === "" && S.lastGroup.length > 0 && S.lastGroup.every((id) => !already.has(id))) {
    const names = S.lastGroup
      .map((id) => r.participants.find((b) => b.id === id)?.name)
      .filter((n): n is string => n !== undefined);
    if (names.length > 0) {
      rows.push({ label: names.map((n) => `@${n}`).join(" "), ids: [...S.lastGroup], hint: "직전 그룹" });
    }
  }
  for (const b of hits) rows.push({ label: `@${b.name}`, ids: [b.id] });
  if ("everyone".includes(q) && hasManyBots(r)) {
    rows.push({ label: "@everyone", ids: [EVERYONE], hint: "전원" });
  }
  // 맞는 게 없으면 목록을 닫는다. 친 글자는 그대로 남고 **칩이 아니므로 멘션도 아니다**
  if (rows.length === 0) return;

  S.pickerRows = rows.map((row) => () => {
    // `@검색어`를 지우고 그 자리에 칩을 넣는다
    const text = found.node;
    const rest = text.data.slice(found.at + 1 + found.q.length);
    text.data = text.data.slice(0, found.at);
    let mark: Node = text;
    for (const id of row.ids) {
      const name = id === EVERYONE ? "everyone" : (r.participants.find((b) => b.id === id)?.name ?? id);
      const chip = mentionChip(id, name);
      mark.parentNode?.insertBefore(chip, mark.nextSibling);
      const gap = box.ownerDocument.createTextNode(" ");
      chip.parentNode?.insertBefore(gap, chip.nextSibling);
      mark = gap;
    }
    /*
     * 🔴 **빈 글자 노드를 남기지 않는다** (사용자, 2026-10-15). 뒤에 남은
     * 글이 없는데도 빈 노드를 끼워 넣으면 커서가 **빈 노드 앞**에 서고,
     * 거기서 한글 조합이 첫 글자를 두 번 친다. 앞쪽도 마찬가지라 `@` 앞이
     * 비었으면 그 노드도 걷는다.
     */
    if (rest) {
      mark.parentNode?.insertBefore(box.ownerDocument.createTextNode(rest), mark.nextSibling);
    }
    if (text !== mark && text.data === "") text.remove();
    caretAfter(box, mark);
    closePicker();
    box.dispatchEvent(new Event("input"));
  });

  S.pickerAt = 0;
  const menu = el(
    "div",
    { class: "picker" },
    ...rows.map((row, n) =>
      el(
        "button",
        {
          class: n === 0 ? "on" : "",
          onclick: () => S.pickerRows[n]?.(),
          onmouseenter: () => movePicker(n),
        },
        el("span", { text: row.label }),
        row.hint ? el("span", { class: "dim", text: row.hint }) : null,
      ),
    ),
  );
  screens.chat.append(menu);
}

export function closePicker(): void {
  screens.chat.querySelector(".picker")?.remove();
  S.pickerRows = [];
  S.pickerAt = 0;
}

export function movePicker(to: number): void {
  const menu = screens.chat.querySelector(".picker");
  if (!menu) return;
  const btns = [...menu.querySelectorAll("button")];
  if (btns.length === 0) return;
  S.pickerAt = (to + btns.length) % btns.length;
  btns.forEach((b, n) => b.classList.toggle("on", n === S.pickerAt));
}

/**
 * 커서를 이 노드 뒤로.
 *
 * 🔴 **글자 노드면 «그 안의 끝»에 둔다** (사용자, 2026-10-15): *"칩 작성후
 * 쓰는 첫 글자가 두번써짐"*.
 *
 * 노드와 노드 **사이**에 커서를 두면 한글 조합(IME)이 그 자리에서 **첫 글자를
 * 두 번** 친다 — 조합을 시작할 때 브라우저가 글자 노드를 새로 만들고, 조합이
 * 확정될 때 그 노드와 원래 자리 둘 다에 넣는다. 글자 노드 **안의 자리**(노드 +
 * 오프셋)를 주면 조합이 처음부터 그 노드에서 일어나 겹치지 않는다.
 */
export function caretAfter(box: HTMLElement, node: Node): void {
  const doc = box.ownerDocument;
  const range = doc.createRange();
  if (node.nodeType === 3) range.setStart(node, (node as Text).data.length);
  else range.setStartAfter(node);
  range.collapse(true);
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
