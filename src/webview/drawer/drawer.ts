/**
 * ★ **참여자 서랍** — 봇 줄 · 이름 · 모델 · 에이전트 바꾸기.
 */
import { hasManyBots, type BotInstance, type Room } from "../../core/types.js";
import { openBotView } from "../chat/chat.js";
import { sharedMemoryRow } from "../chat/fork.js";
import { blurbRow, roleEditor, sessionRow } from "../chat/menu.js";
import { colorPick, el, icon, type Kids } from "../common/dom.js";
import { back, push, screens } from "../common/screens.js";
import { S, agentAvail, agentById, optionsFor, post } from "../common/state.js";
import { inviteRow } from "./invite.js";
import { waitGo } from "./wait.js";
import { labelOf } from "../new/new.js";

// ── 참여자 서랍 ────────────────────────────────────────────────────────

/**
 * 참여자 서랍 — **봇에 관한 것이 전부 모이는 자리** (§4.2.1).
 *
 * v2.0 설계를 앞당겨 1:1에서도 연다. 봇이 하나뿐이어도 «이 봇이 무슨 모델로
 * 얼마나 차 있고 뭘 할 수 있나»를 볼 자리는 필요하고, 단체방이 되면 **줄이
 * 늘어날 뿐** 화면이 새로 생기지 않는다.
 *
 * 🔴 **입력창 옆 권한 버튼을 없애지 않는다.** 권한은 «켜둔 걸 잊으면 안 되는
 * 종류»라 보낼 때마다 눈에 들어와야 한다(D2). 서랍에도 두는 건 *"이 봇에 대해
 * 뭘 할 수 있지"* 로 찾아온 사람을 위한 것이지, 그 자리를 대신하려는 게 아니다.
 * 둘은 같은 시트를 연다 — 구현이 하나라 어긋날 수가 없다.
 */
export function toggleDrawer(r: Room): void {
  if (S.stack[S.stack.length - 1] === "bots") { back(); return; }
  paintDrawer(r);
  push("bots");
}

/** 권한 화면과 같다 — 돌아가기만 한다 */
export function closeDrawer(): void {
  if (S.stack[S.stack.length - 1] === "bots") back();
}

/**
 * 서랍을 그린다 — 시트와 같이 **제자리에서 갈아 끼운다**.
 *
 * 설정(모델 목록)은 CLI를 한 번 띄워야 오므로 서랍보다 늦게 도착한다. 처음
 * 한 번만 그리면 그 늦은 응답이 갈 곳이 없어 «모델을 알려주지 않습니다»에
 * 영원히 머문다 — 권한 시트에서 실제로 겪은 일이다.
 */
export function paintDrawer(r: Room): void {
  // 봇마다다 — 같은 에이전트로 봇이 둘이면 **고른 값도 둘**이다 (B1)
  for (const b of r.participants) {
    if (!optionsFor(b.agentId, r.id, b.id)) {
      post({ t: "needConfig", agentId: b.agentId, roomId: r.id, botId: b.id });
    }
  }

  // 화면이 된 뒤로 «떠 있나» 가 아니라 «이미 그려 뒀나» 를 본다
  const was = screens.bots.firstElementChild ? screens.bots : null;

  /*
   * 🔴 **글을 쓰는 중이면 건드리지 않는다.**
   *
   * 이 함수는 상태·메시지가 올 때마다 도는데(`paintChat`), 갈아끼우면
   * **역할 입력과 이름 고치기가 통째로 날아간다.** 방 제목을 고치는 중에
   * 헤더를 안 건드리는 것과 같은 이유다.
   */
  /*
   * 🔴 **색 고르개는 예외다** (2026-09-28).
   *
   * 이 규칙은 «치던 글자가 날아간다»를 막으려는 것인데, `input[type=color]` 에는
   * **칠 글자가 없다.** 그런데 색을 고르고 나면 포커스가 거기 남아, 갱신이
   * 막혀서 **방금 고른 색이 서랍에 안 나타났다** — 말풍선만 바뀌고 고르개는
   * 그대로라 «안 먹었나» 싶어진다. 이름 바꾸기가 겪었던 그 문제와 같다.
   */
  const focus = document.activeElement;
  const typing = focus instanceof HTMLElement
    && /^(INPUT|TEXTAREA)$/.test(focus.tagName)
    && (focus as HTMLInputElement).type !== "color";
  if (was && focus && was.contains(focus) && typing) return;

  /*
   * ★ **화면이라 «열 때만 밀려 들어온다» 가 없어졌다** (2026-09-30).
   *
   * 🔴 서랍일 때는 `animation` 이 `.drawer` 에 붙어 있어서, 갱신마다 새
   * 엘리먼트로 갈아끼우느라 **상태가 한 번 바뀔 때마다 오른쪽에서 다시
   * 슬라이드됐다.** 보고 있는 중에 화면이 계속 새로 나타나는 꼴이었다.
   * `.opening` 을 붙였다 뗐다 하며 피해 다녔는데, 화면이 되면서 **그 문제
   * 자체가 없어졌다** — 뜨고 지는 것은 스택이 한다.
   *
   * 스크롤은 여전히 지킨다. 설정이 늦게 와서 다시 그릴 때마다 맨 위로
   * 튀면 보던 자리를 잃는다.
   */
  const keep = screens.bots.scrollTop;
  screens.bots.replaceChildren(
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "돌아가기", onclick: () => closeDrawer() }, icon("arrow-left")),
      el("h1", {}, icon("organization"), ` 참여자 ${r.participants.length}`),
    ),
    ...r.participants.map((bot) => drawerBot(r, bot)),
    ...[sharedMemoryRow(r), inviteRow(r)].filter((n): n is HTMLElement => n !== null),
  );
  screens.bots.scrollTop = keep;
}

/**
 * 봇 한 줄.
 *
 * **이름 옆이 사용량 자리다.** 컨텍스트는 세션마다 차고 세션은 봇 단위라(B1),
 * 방에 하나로 걸어두면 봇이 둘일 때 누구 숫자인지 알 수 없다 — 실제로 나중에
 * 온 봇이 앞 봇의 숫자를 덮어쓰고 있었다.
 */
/**
 * ★ **이 봇이 무엇까지 할 수 있나 — 한 줄로** (§4.2.2).
 *
 * 권한은 봇마다 다르다(D2). 그런데 여태 그걸 보려면 **봇마다 시트를 열어**
 * 세 칸을 읽어야 했다 — 봇이 넷이면 네 번이다. 「리뷰어는 읽기만, 구현 봇은
 * 편집까지」가 이 기능의 요점인데, **그 대비가 한눈에 안 보이면 요점이 없다.**
 *
 * 세 가지를 순서대로 잇는다: **모드**(무엇까지 자동) · **주체**(막히면 누가
 * 답하나) · **질문**(갈림길에서). 「봇 : 범위 : 대상」(D2)이 그대로다.
 */
function policyLine(r: Room, bot: BotInstance): string {
  const options = optionsFor(bot.agentId, r.id, bot.id);
  const mode = options?.find((o) => o.category === "mode");
  const bits: string[] = [];

  if (mode?.values?.length) {
    const now = bot.configValues?.[mode.configId] ?? mode.current;
    bits.push(mode.values.find((v) => v.id === now)?.name ?? String(now));
  } else if (options === undefined) {
    // 🔴 «아직 안 왔다»와 «없다»는 다른 화면이어야 한다 — 하나로 뭉치면
    // CLI가 안 뜬 걸 «이 에이전트는 권한 모드가 없다»로 읽게 된다
    bits.push("모드 불러오는 중…");
  }

  /*
   * 🔴 **봇 이름에 «이/가»를 붙이지 않는다.** 이름은 사용자가 짓는 말이라
   * 받침을 미리 알 수 없다 — «베타이 승인»이 된다. 분기 안내문에서 이미 한 번
   * 깨졌던 자리다. «에게»는 받침과 무관하다.
   */
  bits.push(
    bot.approver.kind === "user"
      ? "승인은 사용자에게"
      : `승인은 ${r.participants.find((b) => b.id === (bot.approver as { botId?: string }).botId)?.name ?? "다른 봇"}에게`,
  );
  // 루프모드는 **켰을 때만** 적는다 — 꺼진 것이 평소다 (2026-10-20 · 예전 «질문은 물어봄/알아서»)
  if (bot.answerPolicy === "auto") bits.push("루프모드");
  return bits.join(" · ");
}

/**
 * **이름을 제자리에서 고친다** (§4.2.1).
 *
 * 🔴 **이름은 라우팅이다.** 멘션 칩은 `botId`를 들고 있어서 이름을 바꿔도
 * 가리키는 대상이 안 바뀌지만, 사람이 `@`를 눌러 고를 때 보는 것은 이름이다.
 * 「Claude」와 「Claude 2」로는 누가 리뷰어인지 알 수 없다.
 */
function renameBotInline(r: Room, bot: BotInstance, host: HTMLElement): void {
  const input = el("input", { type: "text", value: bot.name }) as HTMLInputElement;

  /*
   * 🔴 **포커스를 먼저 놓아야 다시 그려진다.**
   *
   * `paintDrawer` 에는 «입력 중이면 건드리지 않는다»는 규칙이 있다 — 안 그러면
   * 상태가 올 때마다 **치던 글자가 통째로 날아가기** 때문이다. 그런데 이
   * 입력창이 포커스를 쥔 채로 부르면 **그 규칙에 우리가 걸린다**: 서랍이
   * 안 그려지고, 이어서 방 갱신이 와도 또 안 그려져서 **엔터를 쳐도 아무 일도
   * 안 일어난 것처럼 보인다.** (이름은 실제로 바뀌어 있었다.)
   *
   * `done` 으로 한 번만 돌게 막는다 — `blur()` 가 blur 처리기를 다시 부른다.
   */
  let done = false;
  const finish = (send: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.blur();
    paintDrawer(r);
    if (send && name !== "" && name !== bot.name) {
      post({ t: "renameBot", roomId: r.id, botId: bot.id, name });
    }
  };

  input.addEventListener("keydown", (e) => {
    // `isComposing` — 한글은 조합 중에도 Enter 가 온다. 그때 끝내면 글자가 깨진다
    if (e.key === "Enter" && !e.isComposing) finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  host.replaceChildren(input);
  input.focus();
  input.select();
}

/*
 * 🔴 **«서랍에서 누르면 멘션 삽입»은 뺐다** (v2.1 · 2026-09-22).
 *
 * *"v2.1의 «봇별 1:1 뷰»가 들어오기 전까지의 자리"* 라고 적어둔 임시 동작이었고,
 * 그 화면이 생겼으므로 **이름을 누르면 그 봇의 뷰로 간다.**
 *
 * 아쉽지 않은 이유: **뷰 안에서 친 말은 자동으로 그 봇에게 간다**(§5). 칩을
 * 꽂을 이유 자체가 사라진다. 방 전체에서 지목하려면 입력창에서 `@` 를 친다.
 */

/**
 * ★ **에이전트를 바꾸면 무엇을 잃나** — 고른 자리 바로 아래에 편다 (§4.2.1).
 *
 * 🔴 이건 «설정 바꾸기»가 아니라 **세션을 버리는 일**이다. 세션은 그 CLI의
 * 것이라 이어받을 수 없고, 되돌릴 수 없는 것이 여럿 사라진다 —
 * **누르고 나서 알게 되면 늦는다.**
 *
 * 🔴 그리고 **폴백이라는 것을 미리 말한다.** 바꾸고 나면 F7 배너가 «대화
 * 넘겨서 시작»을 권하는데, 그건 **글자만** 옮긴다 — 계획과 읽은 파일 기억은
 * 안 따라온다. 분기 폴백과 같은 길이고 같은 한계다. **알고 고르는 것과
 * 모르고 겪는 것은 다르다.**
 *
 * 목록은 `setAgent` 가 실제로 하는 그대로다 — 지어내면 안 되는 자리다.
 */
function swapWarning(r: Room, bot: BotInstance, nextId: string): Kids {
  const at = S.botStatus[bot.id] ?? "idle";
  const busy = at !== "idle" && at !== "error";
  const next = agentById.get(nextId)?.label ?? nextId;

  /*
   * ★ **«대화를 넘길지»를 여기서 같이 정한다** (F7과 같은 세 갈래).
   *
   * 🔴 처음에는 «바꾸기» 하나였다. 그러면 바꾼 **뒤에** 배너가 떠서 한 번 더
   * 묻는다 — 사용자에게는 **한 번의 결정**인데(«Codex로, 대화는 넘겨서»)
   * 두 번 물어보는 꼴이었다. 게다가 **무엇을 잃는지 방금 읽은 자리**에서
   * 정하는 것이 가장 정확하다.
   *
   * 되먹임은 **글자만** 옮긴다 — 위 경고에 적어뒀다. 그래서 두 갈래다.
   */
  const mk = (label: string, title: string, carry: "log" | "summary" | "none") => {
    const refeed = carry !== "none";
    const b = el("button", {
      class: refeed ? "primary" : "",
      text: label,
      title,
      onclick: () => {
        const model = swapModel.get(bot.id);
        const opt = optionsFor(nextId)?.find((o) => o.category === "model");
        swapping.delete(bot.id);
        swapModel.delete(bot.id);
        post({
          t: "setAgent", roomId: r.id, botId: bot.id, agentId: nextId, refeed,
          ...(refeed ? { refeedKind: carry } : {}),
          ...(model && opt ? { model: { configId: opt.configId, value: model } } : {}),
        });
      },
    }) as HTMLButtonElement;
    b.disabled = busy;
    return b;
  };
  /*
   * ★ **세 갈래 — 막음 화면과 같은 것** (2026-10-02).
   *
   * 사용자: *"에이전트가 없어져서 다른 에이전트로 바�때도 똑같이
   * 해줄래? (통일성)"*. 두 자리가 **같은 일**을 하는데 골라지는 것이
   * 다르면, 사용자는 어느 문으로 들어왔느냐에 따라 다른 선택을 하게 된다.
   */
  const goFeed = mk("대화 넘겨서 바꾸기", "지난 대화를 다음 메시지에 함께 보냅니다. 글자만 갑니다.", "log");
  const goSum = mk("요약만 넘겨서 바꾸기", "압축 요약과 최근 대화만 보냅니다. 짧지만 예전 이야기는 빠집니다.", "summary");
  const goBare = mk("기록만 두고 바꾸기", "대화는 화면에만 남고, 새 에이전트는 백지에서 시작합니다.", "none");

  return [
    el("div", { class: "swap-what" },
      el("div", { class: "gone" },
        el("b", { text: "사라지는 것" }),
        el("div", { text: "이 봇의 세션 — 세운 계획과 읽은 파일 기억" }),
        el("div", { text: "모델 · 권한 모드 · 설정값 · 사용량" })),
      el("div", { class: "kept" },
        el("b", { text: "남는 것" }),
        el("div", { text: "지금까지의 대화 — 말풍선은 하나도 안 지운다" }),
        el("div", { text: "이전 세션 — 그 CLI에 그대로 있어 --resume 으로 열 수 있다" })),
    ),
    el("p", { class: "warn", text:
      `${next}은(는) 위 대화를 모릅니다. 바꾸면 «대화 넘겨서 시작»을 권하는데, ` +
      "그건 글자만 옮깁니다 — 계획과 읽은 파일 기억은 따라오지 않습니다." }),
    busy
      ? el("p", { class: "warn", text: "답하는 중에는 바꿀 수 없습니다. 끝나거나 중단한 뒤에 하세요." })
      : null,
    el("div", { class: "acts" },
      goFeed,
      goSum,
      goBare,
      el("button", {
        class: "ghost",
        text: "그대로 두기",
        // 고른 것을 **되돌린다** — 안 바꿨는데 칸만 바뀌어 있으면 거짓말이다
        onclick: () => (swapping.delete(bot.id), swapModel.delete(bot.id), paintDrawer(r)),
      }),
    ),
  ];
}

function drawerBot(r: Room, bot: BotInstance): HTMLElement {
  const status = S.botStatus[bot.id] ?? "idle";
  const busy = status !== "idle" && status !== "error";

  /*
   * ★ **갈아탈 에이전트를 고르는 중인가.**
   *
   * 고르기만 하고 아직 확인은 안 한 상태다. 이 동안 **모델 칸도 그쪽 것을
   * 보여준다** — 안 그러면 Codex를 골라둔 채로 모델 칸엔 `Opus` 가 남아
   * **없는 조합을 화면이 주장하게** 된다.
   */
  const pending = swapping.get(bot.id);
  const showAgent = pending ?? bot.agentId;
  /*
   * 갈아타는 중이면 **아직 이 방에 없는 에이전트**다 — 방 안이 아니라
   * **에이전트 기본값**을 본다. 붙은 뒤에는 그 봇의 세션 값을 본다.
   */
  const options = (pending ? optionsFor(pending) : optionsFor(bot.agentId, r.id, bot.id)) ?? [];
  const model = options.find((o) => o.category === "model");

  // ── 첫 줄: 이름 · 작업 중 · 사용량
  //
  // 🔴 색 점을 뺐다. 에이전트를 **칸으로 직접 고르게 된 뒤로** 색은 같은 것을
  // 한 번 더 말하는 것이 됐고, 이름이 작아 보이게만 했다.
  /*
   * ⏪ **이름을 단추로 쓰던 것을 물렀다** (2026-09-30).
   *
   * v2.1 에서 봇별 뷰를 만들면서 **이름 자체를 입구**로 삼았다. 눌러지는 티가
   * 안 난다고 밑줄을 긋고 `›` 를 붙이며 애썼는데, 🔴 **이름은 읽는 것이지
   * 누르는 것이 아니다** — 무엇을 꾸며도 «이름인가 단추인가» 가 남는다.
   *
   * 입구를 아래 «1:1로 보기» 단추로 옮겼다. 압축·내보내기와 나란히 서면
   * «이 봇에 할 수 있는 일» 중 하나로 곧장 읽힌다.
   */
  const nameCell = el("span", { class: "name" }, el("span", { text: bot.name }));

  const head = el(
    "div",
    { class: "who" },
    nameCell,
    el("button", {
      class: "icon tiny",
      title: "이름 바꾸기",
      onclick: () => renameBotInline(r, bot, nameCell),
    }, icon("edit")),
    // 이름을 고치는 그 자리에서 색도 (2026-09-28)
    colorPick(bot.color, bot.ink, (css, pickedInk) =>
      post({ t: "setBotColor", roomId: r.id, botId: bot.id, color: css,
             ...(pickedInk ? { ink: pickedInk } : {}) })),
    busy ? el("span", { class: "typing" }, el("i"), el("i"), el("i")) : null,
    usageChip(bot),
    waitGo(r, bot),
  );

  /*
   * ── 권한을 한 줄로 (§4.2.2)
   *
   * 🔴 «모델 · 에이전트» 줄은 뺐다. 바로 아래 칸 둘이 **같은 것을 고를 수
   * 있게** 보여주므로, 읽기 전용으로 한 번 더 적는 것은 줄만 늘린다.
   */
  const perm = el("div", { class: "sub perm" }, el("span", {
    text: policyLine(r, bot),
    title: "권한 모드 · 막혔을 때 누가 답하나 · 갈림길에서 물어보나",
  }));

  const rows: Kids = [head, perm];

  /*
   * ── 에이전트 — **모델 바로 위** (§4.2.1)
   *
   * 에이전트와 모델은 «이 봇이 무엇으로 도는가»로 같은 종류다. 다만 바꾸는
   * 것 자체는 **세션을 버리는 일**이라 바로 안 바꾼다 — 고르면 **모델 칸
   * 아래에** 무엇을 잃는지 펴고 거기서 확인받는다.
   */
  /*
   * 🔴 **안 받은 에이전트는 여기서도 뺀다** (2026-10-02).
   *
   * 사용자가 짚었다 — *"참여자 서랄에서 에이전트가 없는데 나오는
   * 경우도 있음"*. 방 만들기만 걸러두고 여길 놓쳐서, **고르면 그제서야
   * 막히는** 꼴이었다.
   *
   * 다만 지금 붙어 있는 것은 받지 않았어도 남긴다 — 고르개가 제 값을
   * 안 담고 있으면 **엉뙡한 것이 고른 것처럼 보인다.**
   */
  const choosable = [...agentById.values()].filter(
    (a) => agentAvail.has(a.id) || a.id === bot.agentId,
  );
  if (choosable.length > 1) {
    const pick = el("select") as HTMLSelectElement;
    for (const a of choosable) {
      pick.append(el("option", { value: a.id, text: a.label, selected: a.id === showAgent }));
    }
    pick.addEventListener("change", () => {
      swapModel.delete(bot.id);   // 다른 에이전트의 모델 값은 여기서 뜻이 없다
      if (pick.value === bot.agentId) swapping.delete(bot.id);
      else {
        swapping.set(bot.id, pick.value);
        // 그 에이전트의 모델 목록이 없으면 지금 물어본다 — 오면 다시 그린다
        // 방에 없는 에이전트라 **방을 빼고** 묻는다 — 기본값이면 충분하다
        if (!optionsFor(pick.value)) post({ t: "needConfig", agentId: pick.value });
      }
      paintDrawer(r);
    });
    rows.push(el("div", { class: "field" }, el("label", { text: "에이전트" }), pick));
  }

  // ── 모델 — 그 에이전트가 목록을 줄 때만
  if (model?.values?.length) {
    const select = el("select") as HTMLSelectElement;
    /*
     * 🔴 **봇이 실제로 든 값이 먼저다.** `model.current` 는 방 단위 캐시라
     * 봇이 둘이면 둘 다 같은 값을 보여주고, 설정이 늦게 오면 낡은 값이 남는다.
     *
     * 갈아타는 중이면 그 값은 **이 에이전트의 것이 아니므로** 안 쓴다.
     */
    const now = pending
      ? (swapModel.get(bot.id) ?? model.current)
      : (bot.model ?? model.current);
    for (const v of model.values) {
      select.append(el("option", { value: v.id, text: v.name, selected: v.id === now }));
    }
    /*
     * ★ **갈아타는 중에도 고를 수 있다.**
     *
     * 🔴 처음에는 잠갔다 — «버릴 세션의 모델을 고치는 건 뜻이 없다»고 봐서다.
     * 그런데 **고르는 건 버릴 세션의 모델이 아니라 새 에이전트의 모델**이다.
     * 잠가두면 갈아탄 뒤에 서랍을 다시 열어 또 골라야 했다.
     *
     * 지금 고른 값은 **확정할 때 같이 걸린다**(`setAgent` 의 `model`).
     */
    select.addEventListener("change", () => {
      if (pending) { swapModel.set(bot.id, select.value); return; }
      drawerModel.set(bot.id, select.value);
      paintDrawer(r);
    });
    const staged = drawerModel.get(bot.id);
    if (!pending && staged !== undefined && staged !== String(model.current ?? "")) {
      select.value = staged;
    }
    const field = el("div", { class: "field" }, el("label", { text: labelOf(model) }), select);
    /*
     * «적용» 은 **고른 것이 지금것과 다를 때만** 나타난다. 항상 두면
     * 누를 일이 없는 단추가 줄마다 서 있게 된다.
     */
    if (!pending && staged !== undefined && staged !== String(model.current ?? "")) {
      field.append(el("button", {
        class: "primary", type: "button", text: "적용",
        onclick: () => {
          drawerModel.delete(bot.id);
          post({ t: "setConfig", roomId: r.id, configId: model.configId, value: staged, botId: bot.id });
        },
      }));
    }
    rows.push(field);
  } else if (pending) {
    rows.push(el("div", { class: "sub", text: `${agentById.get(pending)?.label ?? pending}의 모델을 불러오는 중…` }));
  }

  // ── 갈아타면 무엇을 잃나 — **모델 칸 아래**
  if (pending) rows.push(el("div", { class: "swap-ask" }, ...swapWarning(r, bot, pending)));

  /*
   * ── 이 봇에 할 수 있는 것 + 역할
   *
   * 🔴 한 줄로 합쳤다. **역할 저장이 맨 오른쪽**이고 나머지는 왼쪽에 붙는다 —
   * 역할은 «지금 쓴 것을 확정»하는 것이라 입력 바로 다음이고, 압축·내보내기는
   * 그 봇에 대한 다른 일이다.
   *
   * 🔴 «권한 설정»은 뺐다. 입력창 옆 방패 버튼이 같은 화면을 여는데, 여기서
   * 한 번 더 열면 **같은 곳으로 가는 문이 둘**이 된다. 권한이 어떤지는 위의
   * 한 줄이 이미 말한다.
   */
  const acts: Kids = [];
  if (S.compactableBots.includes(bot.id)) {
    acts.push(
      el("button", {
        class: "ghost",
        text: "대화 압축",
        title: "지금까지를 요약으로 바꿔 컨텍스트를 비웁니다. 이 봇만.",
        onclick: () => (closeDrawer(), post({ t: "compact", roomId: r.id, botId: bot.id })),
      }),
    );
  }

  /*
   * ★ **1:1 뷰로 가는 단추 — 압축과 내보내기 사이** (2026-09-30).
   *
   * 🔴 여태 **봇 이름 자체가 단추**였다(`.name-go`). 이름에 밑줄을 긋고 «들어갈
   * 수 있다는 티» 를 내려고 애썼는데, 그래도 **이름인지 단추인지 모호했다** —
   * 이름은 읽는 것이지 누르는 것이 아니다.
   *
   * 여기 있는 것들과 나란히 두면 «이 봇에 할 수 있는 일» 중 하나로 읽힌다.
   * 자리는 압축과 내보내기 사이다 — 내보내기는 **되돌릴 수 없는 것**이라 늘
   * 맨 끝에 있어야 하고, 그 앞이 평범한 동작들의 자리다.
   */
  if (hasManyBots(r)) {
    acts.push(
      el("button", {
        class: "ghost",
        text: "1:1로 보기",
        title: `${bot.name}와(과) 주고받은 것만 봅니다`,
        onclick: () => openBotView(bot.id),
      }),
    );
  }
  // 마지막 한 명은 코어가 막지만, 누르고 거절당하게 두지 않는다 — 애초에 안 보인다
  if (hasManyBots(r)) {
    acts.push(
      el("button", {
        // 🔴 **되돌릴 수 없다.** 세션이 끝나므로 색으로도 말한다
        class: "ghost danger",
        text: "내보내기",
        title: "이 봇과의 세션을 끝냅니다. 지금까지의 대화는 그대로 남습니다.",
        onclick: () => {
          closeDrawer();
          post({ t: "removeBot", roomId: r.id, botId: bot.id });
        },
      }),
    );
  }

  /*
   * ★ **«하는 일»이 역할 바로 위** (v3.0 4-K).
   *
   * 🔴 **둘은 다른 물건이고, 그 차이가 눈에 보여야 한다:**
   *
   * ```
   * 하는 일   남에게 보이는 소개  — 다른 봇의 명단 표에 그대로 적힌다
   * 역할      이 봇에게 주는 지시  — 남은 못 본다
   * ```
   *
   * 역할 글을 소개로 끌어다 쓰지 않는 이유가 여기 있다 — *"코드를 쓴 뒤 반드시
   * 리뷰어를 호출해라"* 의 첫 줄은 설명이 아니다. **우리가 넘겨짚는 것**이다.
   */
  rows.push(blurbRow(r, bot));
  rows.push(el("div", { class: "info-row" }, el("span", { class: "dim", text: "역할" })));
  rows.push(roleEditor(r, bot, acts));

  // 세션 id는 **그 봇의 것**이다 — 방이 아니라 여기가 제자리다
  const sess = sessionRow(bot);
  if (sess) rows.push(sess);

  return el("div", { class: "drawer-bot" }, ...rows);
}

/** 갈아탈 에이전트를 고르는 중인 봇들 — `botId` → 고른 `agentId` */
const swapping = new Map<string, string>();

/** 그때 **같이 고른 모델** — `botId` → 새 에이전트의 모델 값 */
const swapModel = new Map<string, string>();

/**
 * ★ **서랄에서 고른 모델 — «적용» 전까지** (2026-10-02).
 *
 * 사용자: *"채팅창 안에서 봇 모델 바꿀때도 적용 버튼을 추가하자.
 * 지금 선택하자마자 적용돼서 좀 그럴 수 있어"*.
 *
 * 모델을 바꾸는 것은 세션을 버리진 않지만 **다음 턴부터 다른 모델이
 * 답한다.** 고르개를 스치다 바뀜는 일이 아니다.
 */
const drawerModel = new Map<string, string>();

/**
 * 컨텍스트가 몇 퍼센트 찼나 — 모르면 `-1`.
 *
 * 말풍선 캐시 서명에 들어가므로 **거친 값이어야 한다.** 토큰 하나마다
 * 바뀌는 숫자를 넣으면 스트리밍 중에 말풍선을 계속 다시 만들게 된다.
 */
export function usagePct(bot: BotInstance | undefined): number {
  const u = bot?.usage;
  return u?.contextUsed && u.contextSize ? Math.round((u.contextUsed / u.contextSize) * 100) : -1;
}

/**
 * 컨텍스트가 얼마나 찼나 — **이름 바로 옆**.
 *
 * 에이전트가 안 알려주면 **자리를 비운다.** 우리가 글자 수로 짐작하지 않는다 —
 * 토크나이저가 에이전트마다 다르고, 틀린 숫자는 없는 것보다 나쁘다(§0).
 */
export function usageChip(bot: BotInstance | undefined): HTMLElement | null {
  const u = bot?.usage;
  if (!u?.contextUsed || !u.contextSize) return null;
  const pct = Math.round((u.contextUsed / u.contextSize) * 100);
  const tokens = `${u.contextUsed.toLocaleString()} / ${u.contextSize.toLocaleString()} 토큰`;
  // 바는 뺀다 — 숫자가 이미 정확한데 그림은 같은 말을 더 흐릿하게 할 뿐이다
  return el("span", {
    class: pct >= 90 ? "usage full" : "usage",
    title: `컨텍스트 ${tokens}`,
    text: `${pct}%`,
  });
}
