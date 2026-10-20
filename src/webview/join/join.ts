/**
 * ★ **붙는 화면 · 고치기 화면** — 방에 붙는 중 · 못 붙었을 때 · 모델이 없어졌을 때.
 */
import { botColor, type BotInstance, type JoinFail, type Room } from "../../core/types.js";
import { el, icon } from "../common/dom.js";
import { go, paintScreens, screens, type ScreenName } from "../common/screens.js";
import {
  S,
  agentAvail,
  agentById,
  agentGone,
  boot,
  configs,
  optionsFor,
  post,
} from "../common/state.js";

/* ── 모델이 없어졌다 — 고르기 전에는 못 쓴다 ─────────────────────────── */

/** 이 방을 지금 못 쓰게 만드는 봇들. 비어 있으면 평소 방이다 */
export function needsModel(r: Room): BotInstance[] {
  /*
   * ★ **네 가지를 같은 문으로 받는다** (2026-10-01 둘, 2026-10-13 둘).
   *
   * «고른 모델이 없어졌다» 와 «그 에이전트를 안 받았다» 는 사용자
   * 입장에서 같다 — **이 방은 지금 못 쓴다.** 고치는 길도 같다:
   * 다른 걸 고르거나 봇을 내보낸다. 그래서 한 화면에서 처리한다.
   *
   * ★ **붙다가 걸린 것도 여기로 온다** (2026-10-13). 로그인이 풀렸거나
   * 아예 못 열렸거나 — 사용자 입장에서 **똑같이 이 방을 못 쓴다.** 단추를
   * 붙는 화면에도 달면 **단추가 두 화면에 흩어진다.** 붙는 화면은
   * **기다리는 자리**, 여기가 **결정하는 자리**로 나눈다.
   */
  return r.participants.filter((b) => b.modelGone || agentGone(b) || S.joinFails.has(b.id));
}

/**
 * **붙다가만** 걸린 봇 — 고르개가 아니라 다른 줄이 필요하다.
 *
 * 모델·에이전트가 같이 비어 있으면 그쪽이 먼저다. 고르개가 곧 답이고,
 * 고르고 나면 붙는 것도 다시 하게 된다 — 「다시 시도」를 따로 누를 일이 없다.
 */
function joinStuck(b: BotInstance): { kind: JoinFail; why: string } | undefined {
  if (b.modelGone || agentGone(b)) return undefined;
  return S.joinFails.get(b.id);
}

/**
 * 카드에서 로그인을 **띄워준** 에이전트들.
 *
 * 호스트는 로그인에 `busy` 를 안 단다 — 일이 **우리 밖**(터미널·브라우저)에서
 * 일어나서 언제 끝나는지 모르기 때문이다. 그래서 「띄웠다」만 우리가 적어두고,
 * 목록이 «이제 로그인됨» 으로 바뀌면 지운다.
 */
export const loginAsked = new Set<string>();

/** 붙는 화면을 지나왔나 — 한 번 들어간 방은 다시 안 세운다 */
export const joined = new Set<string>();

/**
 * ★ **방에 붙는 화면** (2026-10-13).
 *
 * 봇마다 한 칸이고 **서로 독립**이다 — 코어도 그렇게 다룬다(«한 봇이 안
 * 열려도 나머지는 산다»). 끝난 봇은 **사라지지 않고 체크로 줄어든다**:
 * 사라지면 «몇 명이었더라» 가 된다.
 *
 * ★ **여기는 기다리는 자리다** (2026-10-13). 걸린 줄에 다는 단추는
 * **[다시 시도] 하나**뿐이다 — 그 자리에서 바로 다시 해보는 것.
 *
 * 🔴 한때 까닭마다 단추가 달랐다([로그인]·[고치기]). 그러면 **단추가 두
 * 화면에 흩어진다** — 아직 붙는 중인 봇 옆에서 결정을 내리게 되고, 돌아와
 * 보면 그 사이에 다른 봇도 걸려 있다. 다 끝난 뒤에 `fix` 에서 한 번에
 * 정한다(`joinDone`).
 */
/**
 * ★ **방이 아직 없을 때의 붙는 화면** (사용자, 2026-10-15).
 *
 * 만들기를 누른 순간에는 **방이 없다** — 그런데도 화면은 옮겨야 한다.
 * 제목만 들고 같은 자리에 선다 — 방이 오면 `renderJoining` 이 그 위에 다시
 * 그린다(봇 줄까지). 두 화면이 아니라 **한 화면의 이른 모습**이다.
 */
export function renderOpening(title: string): void {
  const host = screens.joining;
  host.replaceChildren(
    el("header", { class: "bar" },
      el("button", { class: "icon", title: "뒤로", onclick: () => { go("list"); } }, icon("arrow-left")),
      el("h1", { text: title || "새 대화방" }),
    ),
    el("div", { class: "auth-box" },
      el("p", { class: "auth-head", text: "방을 여는 중입니다…" }),
    ),
  );
}

export function renderJoining(r: Room): void {
  const host = screens.joining;
  host.replaceChildren();
  host.append(
    el("header", { class: "bar" },
      el("button", { class: "icon", title: "뒤로", onclick: () => { go("list"); } }, icon("arrow-left")),
      el("h1", { text: r.title }),
    ),
  );

  const box = el("div", { class: "auth-box" });
  const bots = S.botStatus;
  const left = r.participants.filter(
    (b) => !S.joinFails.has(b.id) && (bots[b.id] ?? "connecting") === "connecting",
  );
  box.append(el("p", { class: "auth-head",
    text: left.length > 0 ? "방을 여는 중입니다…" : "방을 열지 못한 봇이 있습니다" }));

  /* ★ 끝난 것은 **한 줄로 줄여서** 같이 보여준다 — 사라지면 셈이 안 맞는다 */
  const done = r.participants.filter(
    (b) => !S.joinFails.has(b.id) && (bots[b.id] ?? "connecting") !== "connecting",
  );
  if (done.length > 0) {
    box.append(el("div", { class: "join-done" },
      ...done.map((b) => el("span", { class: "join-chip" },
        el("span", { class: "auth-mark", text: "✓" }),
        el("span", { text: b.name }),
      )),
    ));
  }

  for (const bot of r.participants) {
    if (done.includes(bot)) continue;
    const bad = S.joinFails.get(bot.id);
    const row = el("div", { class: `auth-row ${bad ? "failed" : "asking"}` },
      el("span", { class: "auth-mark", text: bad ? "!" : "…" }),
      el("span", { class: "auth-name", text: bot.name }),
      el("span", { class: bad ? "auth-say bad" : "auth-say dim",
        /*
         * ★ **어느 칸인지 말한다** (2026-10-13). 「여는 중…」 한 줄이면
         * Antigravity 의 17.5초가 **통째로 한 덩어리**로 보인다 — 12.5초는
         * 띄우는 데 쓰고 5초는 세션에 쓰는데, 그걸 모르면 멈춘 것 같다.
         */
        text: bad
          ? bad.why
          : S.joinSteps.get(bot.id) === "start"
            ? `${agentById.get(bot.agentId)?.label ?? bot.agentId} 를 띄우는 중…`
            : "세션을 여는 중…" }),
    );
    if (bad) {
      row.append(el("div", { class: "auth-acts" },
        el("button", {
          class: "agent-go", text: "다시 시도",
          onclick: () => {
            S.joinFails.delete(bot.id);
            post({ t: "retryJoin", roomId: r.id, botId: bot.id });
            renderJoining(r);
          },
        }),
      ));
    }
    box.append(row);
  }

  /*
   * 🔴 **「그냥 들어가기」를 안 둔다** (2026-10-13).
   *
   * 반쯤 깨진 봇을 달고 들어가면 **상태가 헷갈린다** — 멘션은 되는데 답이
   * 안 오고, 그 까닭이 어디에도 안 적혀 있다. 답은 둘뿐이다: **고치거나,
   * 내보내거나.** 둘 다 `fix` 화면에 있다(거기 「내보내기」가 이미 있다).
   */
  host.append(box);
}

/**
 * ★ **막음 화면에서 고르는 것들 — 누르기 전까지는 안 간다** (2026-10-01).
 *
 * 사용자: *"선택하자마자 없어지는게 아니라, 내보내기 옆에 적용 버튼이
 * 있어야지"*.
 *
 * 예전엔 고르개를 건드리는 순간 `setAgent` 가 날아갔다. 🔴 **되돌릴 수 없는
 * 일을 고르개 한 번으로 치른 것**이다 — 세션이 버려지고 맥락이 끊긴다.
 * 게다가 에이전트와 모델을 **따로** 보내게 되어 순서도 안 지켜졌다.
 *
 * 그래서 고른 것을 여기 모아두고 «적용» 에서 **한 번에** 보낸다.
 */
const fixPick = new Map<string, { agentId?: string; model?: string; carry: "log" | "summary" | "none" }>();

/** 「이전 것」 → [고르개] 한 줄 */
function swapRow(was: string, pick: HTMLElement): HTMLElement {
  return el("div", { class: "fix-swap" },
    el("span", { class: "gone", text: was }),
    el("span", { class: "dim", text: "→" }),
    pick,
  );
}

/**
 * ★ **방 화면 셋 중 어디인지를 한 자리에서 정한다** (2026-10-13).
 *
 * 채팅·붙는 중·고치기는 **같은 자리의 세 얼굴**이다. 셋을 `go`·`push` 로
 * 따로 밀면 스택이 엉킨다 — 비워둔 `fix` 가 아래 깔려 있다가 **빈 화면**으로
 * 돌아오거나, 보던 채팅이 스택에서 **지워진다**(`go` 는 늘 갈아끼운다).
 *
 * 두 가지를 지킨다:
 *
 * ```
 * 보던 채팅은 아래에 남긴다   뒤로 누르면 거기로 돌아간다
 * 위에 얹힌 것은 그대로 둔다   🔴 로봇 화면에서 **끌어내지 않는다** —
 *                             로그인·받기는 거기서 하는 일이라 갈아끼우면
 *                             하던 일이 날아간다. 뒤로 가면 맞는 화면이 있다
 * ```
 */
export function roomGo(to: "chat" | "joining" | "fix"): void {
  const faces = new Set<ScreenName>(["chat", "joining", "fix"]);
  const next: ScreenName[] = ["list"];
  if (to !== "chat" && S.stack.includes("chat")) next.push("chat");
  next.push(to);
  // 위에 얹혀 있던 것들(로봇·권한·참여자…)은 순서대로 그대로
  for (const s of S.stack) if (s !== "list" && !faces.has(s)) next.push(s);
  S.stack = next;
  paintScreens();
}

/** 막을 것이 생겼나 없어졌나에 맞춰 화면을 돌린다 — 한 자리에서 가른다 */
export function repaintBlock(r: Room): void {
  const top = S.stack[S.stack.length - 1];
  /* 아직 붙는 중이면 그 화면을 지킨다 — 끝나면 `joinDone` 이 가른다 */
  const waiting = top === "joining" && !joined.has(r.id);
  if (waiting) return;
  if (needsModel(r).length > 0) {
    renderFix(r);
    roomGo("fix");
  } else {
    /*
     * 막을 것이 없으면 **비워둔다.** 화면이 안 보인다고 남겨두면, 다음에
     * 다른 방이 걸렸을 때 **앞 방의 봇 이름이 한 순간 스친다** — 설정이
     * 늦게 와서 다시 그리기 전까지.
     */
    screens.fix.replaceChildren();
    if (S.stack.includes("fix") || S.stack.includes("joining")) roomGo("chat");
  }
}

/**
 * ★ **로그인을 마치면 저절로 다시 붙는다** (4.5-U, 2026-10-13).
 *
 * 새 메시지가 필요 없다. 로그인이 끝나면 호스트가 **에이전트 목록을 다시
 * 내려보내고**(터미널이 닫히면 즉시, 안 닫으면 20초 뒤 한 번 더), 거기에
 * 「이제 로그인됨」(`state: "ready"`) 이 실려 온다. 그걸 보고 움직인다.
 *
 * **그 에이전트로 막힌 봇 전부**를 다시 붙인다 — 한 에이전트에 봇이 여럿일 수
 * 있고, 로그인은 그 봇들에게 한꺼번에 통한다. 다른 까닭(`other`)으로 막힌
 * 봇은 안 건드린다. 로그인과 무관하다.
 *
 * ★ [다시 확인] 은 그래도 남긴다 — 저쪽이 늦게 끝나거나 우리가 못 알아챘을
 * 때의 보험이다. 하나는 알아서, 하나는 손으로.
 */
export function retryAfterLogin(r: Room): boolean {
  let any = false;
  for (const [botId, bad] of [...S.joinFails]) {
    if (bad.kind !== "auth") continue;
    const bot = r.participants.find((b) => b.id === botId);
    if (!bot || S.agentRows.find((a) => a.id === bot.agentId)?.state !== "ready") continue;
    fireRetry(r, botId);
    any = true;
  }
  return any;
}

/** 다시 붙여달라고만 한다 — 화면은 부르는 쪽이 정한다 */
function fireRetry(r: Room, botId: string): void {
  const bot = r.participants.find((b) => b.id === botId);
  if (bot) loginAsked.delete(bot.agentId);
  S.joinFails.delete(botId);
  post({ t: "retryJoin", roomId: r.id, botId });
}

/**
 * 다시 붙여본다 — **기다리는 자리로 데려가면서.**
 *
 * 🔴 그 자리에 세워두면 **아무 일도 안 일어난 것처럼 보인다.** 다시 붙는 데는
 * 길면 수십 초가 걸리는데(Antigravity 12.5초 + 5초), 칸이 어디까지 갔는지
 * 보여주는 화면은 붙는 화면뿐이다. 끝나면 거기서 알아서 갈린다 —
 * 되면 채팅, 또 걸리면 여기로 돌아온다(`room` 이 올 때 한 군데서 가른다).
 */
function retryJoin(r: Room, botId: string): void {
  fireRetry(r, botId);
  renderJoining(r);
  roomGo("joining");
}

/**
 * ★ **붙다가 걸린 봇의 카드** (2026-10-13) — `fix` 화면.
 *
 * 줄이 **까닭마다 갈린다**:
 *
 * ```
 * auth   [로그인] [다시 확인]   로그인이 풀렸다
 * other  [다시 시도]            망·시간 초과. 대개 이걸로 풀린다
 * gone   ─                      여기 안 온다 (고르개 카드가 받는다)
 * ```
 *
 * 어느 쪽이든 **[내보내기]가 같이 있다** — 사용자: *"그냥 들어가기는 없어,
 * 봇 제거는 있어도"*. 반쯤 깨진 봇을 달고 들어가면 멘션은 되는데 답이 안 오고
 * 그 까닭이 어디에도 없다. 답은 둘뿐이다: **고치거나, 내보내거나.**
 *
 * ★ **[로그인] 은 그 자리에서 쏜다** (2026-10-13).
 *
 * 🔴 처음엔 로봇 화면으로 **보냈다.** 그러면 거기서 같은 단추를 **한 번 더**
 * 눌러야 했는데, 그 사이에 로봇 화면이 보여주는 것이 없다 — 진짜 로그인은
 * 어차피 **우리 창 밖**(터미널·브라우저)에서 일어나고 포커스도 그리로 간다.
 * 사용자: *"그자리에서 로그인 되면서 에이전트 화면에도 업데이트 되면 좋겠는데"*.
 * 로봇 화면은 `agents` 가 올 때마다 **안 보여도 다시 그려지므로**(`renderAgents`)
 * 거기 가 보면 이미 맞춰져 있다.
 */
function stuckCard(r: Room, bot: BotInstance, bad: { kind: JoinFail; why: string }): HTMLElement {
  const who = agentById.get(bot.agentId);
  const row = S.agentRows.find((a) => a.id === bot.agentId);
  /** 호스트가 무언가 하는 중이면(받기·지우기) 로그인을 겹쳐 쏘지 않는다 */
  const busy = row?.busy;
  const asked = loginAsked.has(bot.agentId);
  const acts = el("div", { class: "fix-acts" });

  if (bad.kind === "auth") {
    const open = el("button", {
      class: "agent-go", type: "button", text: "로그인",
      title: `${who?.label ?? bot.agentId} 로그인을 띄웁니다`,
      onclick: () => {
        loginAsked.add(bot.agentId);
        post({ t: "agentDo", agentId: bot.agentId, what: "login" });
        renderFix(r);
      },
    }) as HTMLButtonElement;
    open.disabled = asked || busy !== undefined;
    acts.append(open);
  }
  acts.append(el("button", {
    /* 로그인 쪽은 **[로그인]이 먼저**다 — 두 개를 다 강조하면 어느 쪽이 답인지 흐려진다 */
    class: bad.kind === "auth" ? "agent-btn" : "agent-go", type: "button",
    text: bad.kind === "auth" ? "다시 확인" : "다시 시도",
    onclick: () => { retryJoin(r, bot.id); },
  }));
  /*
   * ★ **«쓰고 있음» 이면 새 세션으로 시작하는 길도 연다** (사용자, 2026-10-20:
   * *"[다시 시도] · [내보내기] + 새로운 세션으로 시작하는 옵션들"*).
   *
   * 권하는 쪽은 여전히 [다시 시도] 다 — 저쪽만 닫으면 **이 세션 그대로** 이어진다.
   * 새로 시작하는 셋은 갈아타기와 같은 말이고(무엇을 실어 보내나가 곧 단추),
   * 저쪽 세션은 **안 지운다** — 지금 남이 쓰고 있다. 요약은 방에 압축 요약이 있을 때만
   * 세운다 — 없는데 띄우면 빈 것을 보내고 나서야 안다.
   */
  if (bad.kind === "inUse") {
    const fresh = (carry: "log" | "summary" | "none", text: string, title: string) =>
      el("button", {
        class: "agent-btn", type: "button", text, title,
        onclick: () => { post({ t: "freshSession", roomId: r.id, botId: bot.id, carry }); },
      });
    acts.append(fresh("log", "대화 넘겨서 새로 시작",
      "새 세션을 열고 지난 대화를 다음 말에 실어 보냅니다. 세운 계획과 읽은 파일 기억은 안 갑니다."));
    if (r.messages.some((m) => m.summary)) {
      acts.append(fresh("summary", "요약만 넘겨서 새로 시작",
        "새 세션을 열고 압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다."));
    }
    acts.append(fresh("none", "기록만 두고 새로 시작",
      "새 세션이 백지에서 시작합니다. 지난 대화는 화면에만 남습니다."));
  }
  acts.append(el("button", {
    class: "ghost danger", type: "button", text: "내보내기",
    onclick: () => { fixPick.delete(bot.id); post({ t: "removeBot", roomId: r.id, botId: bot.id }); },
  }));

  /*
   * **띄운 뒤엔 무슨 일이 일어나는지 적는다.** 터미널이 뜨면서 포커스가
   * 그리로 가므로, 돌아왔을 때 이 카드가 아무 말도 안 하면 «눌린 건가» 가
   * 된다. 끝나면 저절로 다시 붙는다는 것도 여기서만 말할 수 있다.
   */
  const say = busy ?? (asked
    ? "로그인 창을 띄웠습니다. 마치면 저절로 다시 붙습니다."
    : bad.kind === "inUse"
      ? "저쪽(앱 · CLI · 다른 창)을 닫고 [다시 시도] 하면 이 세션 그대로 이어집니다. " +
        "새로 시작해도 저쪽 세션은 지우지 않습니다."
      : undefined);

  return el("div", { class: "fix-bot" },
    el("div", { class: "fix-name" },
      el("span", { class: "dot", style: { background: botColor(bot) } }),
      el("strong", { text: bot.name }),
      el("span", { class: "dim", text: who?.label ?? bot.agentId }),
    ),
    el("p", { class: "fix-stuck", text: bad.why }),
    say !== undefined && el("p", { class: "agent-busy dim", text: say }),
    acts,
  );
}

export function renderFix(r: Room): void {
  const hit = needsModel(r);
  /** 한 봇이라도 «에이전트가 없다» 면 글이 달라진다 — 모델 이야기만 하면 틀린 말이 된다 */
  const anyAgent = hit.some((b) => agentGone(b));
  const host = screens.fix;
  host.replaceChildren();
  if (hit.length === 0) return;

  /*
   * **왜 막는지**를 적는다. 안 적으면 «그냥 쓰면 되지 왜 막아» 가 된다.
   *
   * ★ **까닭마다 한 줄씩 쌓는다** (2026-10-13). 예전엔 «에이전트가 없다»
   * 아니면 «모델이 없다» 둘 중 하나만 골라 적었는데, 이제 한 방에 **네 가지가
   * 섞여 올 수 있다.** 하나만 적으면 **나머지 봇의 까닭이 어디에도 없다.**
   */
  const says: string[] = [];
  if (anyAgent) {
    says.push("받지 않은 에이전트는 부를 수 없습니다. 로봇 아이콘에서 받아두거나, " +
      "여기서 다른 에이전트로 바꾸거나 봇을 내보내면 됩니다.");
  }
  if (hit.some((b) => b.modelGone)) {
    // 핵심은 «비슷한 걸로 바꿔놨다» 가 아니라 **성격이 다를 수 있다** 이다
    says.push("대신 들어간 모델은 성격이 다를 수 있습니다 — 빠른 모델이 균형 모델로 " +
      "바꿔도 합니다. 모르고 쓰면 답이 왜 달라졌는지 나중에 알 수 없습니다.");
  }
  const anyStuck = hit.some((b) => joinStuck(b));
  if (anyStuck) {
    says.push("붙지 못한 봇은 불러도 답이 오지 않습니다. 다시 해보거나, 봇을 내보내면 됩니다.");
  }

  host.append(
    el(
      "header",
      { class: "bar" },
      el("button", {
        class: "icon", title: "목록으로",
        // **가둬두지 않는다.** 이 방을 지금 안 쓰겠다는 것도 답이다
        onclick: () => { S.room = null; S.chat = null; go("list"); },
      }, icon("arrow-left")),
      el("h1", { text: anyAgent || anyStuck ? "이 방을 쓰려면 정리가 필요합니다" : "모델을 다시 골라 주세요" }),
    ),
    el("div", { class: "fix-why" },
      el("p", {
        text:
          `${r.title}의 ${hit.length > 1 ? `봇 ${hit.length}개` : hit[0]!.name}가 ` +
          `지금 돌 수 없어 이 방을 쓸 수 없습니다. 하나씩 정리하면 돌아갑니다.`,
      }),
      ...says.map((text) => el("p", { class: "dim", text })),
    ),
  );

  for (const bot of hit) {
    /*
     * ★ **붙다가 걸린 봇은 다른 카드다** (2026-10-13). 고르개를 띄우면
     * «모델을 바꾸라는 건가» 가 된다 — 모델은 멀쩡하다. 여기서 할 일은
     * **다시 해보거나 내보내거나** 뿐이다.
     */
    const stuck = joinStuck(bot);
    if (stuck) { host.append(stuckCard(r, bot, stuck)); continue; }

    const who = agentById.get(bot.agentId);
    const gone = agentGone(bot);
    const got = fixPick.get(bot.id) ?? { carry: "log" as const };
    if (!fixPick.has(bot.id)) fixPick.set(bot.id, got);

    /**
     * 바꾼 뒤에 돌 에이전트.
     *
     * 안 고른 상태의 기본값이 다르다 — **없어진 에이전트는 기본값이 없다.**
     * 멀쩡하면 지금 것이 기본이라 «그대로 두고 모델만» 이 자연스럽게 된다.
     */
    const nextAgent = got.agentId ?? (gone ? "" : bot.agentId);
    const swapping = Boolean(nextAgent) && nextAgent !== bot.agentId;
    const mine = nextAgent === bot.agentId;
    const modelOpt = nextAgent
      ? optionsFor(nextAgent, mine ? r.id : undefined, mine ? bot.id : undefined)
          ?.find((o) => o.category === "model")
      : undefined;

    const card = el("div", { class: "fix-bot" },
      el("div", { class: "fix-name" },
        el("span", { class: "dot", style: { background: botColor(bot) } }),
        el("strong", { text: bot.name }),
        el("span", { class: "dim", text: who?.label ?? bot.agentId }),
      ),
    );

    /*
     * ── 에이전트 줄 ────────────────────────────────────────────
     *
     * ★ **모델만 없어졌을 때도 띄운다** (2026-10-02).
     *
     * 사용자: *"에이전트 줄도 선택하게 하자"*. 판이 올라가며 모델이 바뀐 김에
     * **아예 다른 에이전트로 가겠다**는 것도 답이다. 그 길이 서랍에만 있으면
     * 막혀 있는 사람은 거기까지 갈 수가 없다 — 방이 잠겨 있으니까.
     */
    const others = boot.agents.filter((x) => agentAvail.has(x.id));
    if (gone && others.length === 0) {
      card.append(el("p", { class: "dim",
        text: `「${who?.label ?? bot.agentId}」 을(를) 아직 받지 않았고, 바꿔 달 다른 에이전트도 없습니다. ` +
          "위의 로봇 아이콘에서 먼저 받아주세요.",
      }));
    } else {
      const swap = el("select", { class: "regone" }) as HTMLSelectElement;
      if (gone) swap.append(el("option", { value: "", text: "고르세요…", selected: !got.agentId }));
      for (const x of others) {
        swap.append(el("option", { value: x.id, text: x.label, selected: nextAgent === x.id }));
      }
      swap.addEventListener("change", () => {
        got.agentId = swap.value || undefined;
        /* 에이전트가 바뀌면 모델도 다시 골라야 한다 — 남겨두면 없는 id 를 보낸다 */
        got.model = undefined;
        if (swap.value && !configs.has(swap.value)) post({ t: "needConfig", agentId: swap.value });
        renderFix(r);
      });
      card.append(swapRow(who?.label ?? bot.agentId, swap));
    }

    /*
     * ── 모델 줄 ──────────────────────────────────────────────
     *
     * ★ **에이전트를 안 골랐어도 줄은 있다** (2026-10-02).
     *
     * 사용자: *"이전 에이전트, 모델 나와있고 에이전트 골랐을때 모델 선택이
     * 활성화되는걸로"*.
     *
     * 🔴 예전엔 에이전트를 고르기 전까지 이 줄이 **아예 없었다.** 그러면
     * 화면이 **고르는 동안 자라나서** 무엇을 더 정해야 하는지 미리 알 수
     * 없었고, 「이전 모델」 이 무엇이었는지도 그때까진 안 보였다.
     * 처음부터 둘 다 보여주고 **꺼둔 채로** 기다리는 쪽이 맞다.
     */
    {
      const was = bot.modelGone?.label ?? bot.modelLabel ?? bot.model ?? "모델";
      const pick = el("select", { class: "regone" }) as HTMLSelectElement;
      if (!nextAgent) {
        pick.append(el("option", { value: "", text: "에이전트를 먼저 고르세요", selected: true }));
        pick.disabled = true;
      } else if (modelOpt?.values?.length) {
        pick.append(el("option", { value: "", text: "고르세요…", selected: !got.model }));
        for (const v of modelOpt.values) {
          pick.append(el("option", { value: v.id, text: v.name, selected: got.model === v.id }));
        }
        pick.addEventListener("change", () => {
          got.model = pick.value || undefined;
          renderFix(r);
        });
      } else {
        /*
         * 🔴 **기다리는 동안에도 「여기서」 는 보여준다** — 한 번 줄을 통째로
         * 뺐다가 **없어진 모델 이름이 같이 사라졌다.** 설정은 방에 들어온 뒤에
         * 오므로 처음 몇 순간은 늘 이 꼴인데, 하필 그때 제일 알고 싶은 것이다.
         */
        pick.append(el("option", { value: "", text: "불러오는 중…", selected: true }));
        pick.disabled = true;
      }
      card.append(swapRow(was, pick));
    }

    /* ── 단추 줄 ──────────────────────────────────────────────── */
    const ready = Boolean(nextAgent && got.model);
    const acts = el("div", { class: "fix-acts" });

    const drop = () => el("button", {
      class: "ghost danger", type: "button", text: "내보내기",
      onclick: () => { fixPick.delete(bot.id); post({ t: "removeBot", roomId: r.id, botId: bot.id }); },
    });

    if (swapping) {
      /*
       * ★ **에이전트가 바뀌면 «무엇을 넘길까» 가 곧 «적용» 이다** (2026-10-02).
       *
       * 사용자: *"에이전트가 다를 경우는 [기록 넘기기] [요약 넘기기]
       * [안 넘기기] [내보내기]"*.
       *
       * 🔴 갈아타기는 **세션을 버리는 일**이라 맥락이 끊긴다. 그래서 «적용»
       * 하나로 두면 **무엇을 잃는지 모르고 누르게** 된다. 단추가 곧 답이면
       * 고르는 순간이 곧 아는 순간이다 — 서랍의 갈아타기도 같은 꼴이다.
       *
       * 🔴 **요약은 있을 때만.** 요약은 우리가 만든 게 아니라 에이전트가
       * 압축하며 준 것이라, 압축한 적 없는 방엔 하나도 없다. 띄워두면
       * **빈 것을 보내고 나서** 알게 된다.
       */
      const go = (carry: "log" | "summary" | "none", label: string, title: string) => {
        const b = el("button", {
          class: carry === "log" ? "agent-go" : "agent-btn", type: "button", text: label, title,
          onclick: () => {
            if (!got.agentId) return;
            post({
              t: "setAgent", roomId: r.id, botId: bot.id, agentId: got.agentId,
              refeed: carry !== "none",
              ...(carry !== "none" ? { refeedKind: carry } : {}),
              ...(got.model && modelOpt ? { model: { configId: modelOpt.configId, value: got.model } } : {}),
            });
            fixPick.delete(bot.id);
          },
        }) as HTMLButtonElement;
        b.disabled = !ready;
        acts.append(b);
      };
      go("log", "대화 넘겨서 바꾸기", "지난 대화를 통째로 실어 보냅니다. 세운 계획과 읽은 파일 기억은 안 갑니다.");
      go("summary", "요약만 넘겨서 바꾸기",
         "압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다.");
      go("none", "기록만 두고 바꾸기", "새 에이전트가 백지에서 시작합니다. 대화는 화면에만 남습니다.");
    } else {
      const apply = el("button", {
        class: "agent-go", type: "button", text: "적용",
        onclick: () => {
          if (!got.model || !modelOpt) return;
          post({ t: "setConfig", roomId: r.id, configId: modelOpt.configId, value: got.model, botId: bot.id });
          fixPick.delete(bot.id);
        },
      }) as HTMLButtonElement;
      apply.disabled = !ready;
      acts.append(apply);
    }

    acts.append(drop());
    card.append(acts);
    host.append(card);
  }
}
