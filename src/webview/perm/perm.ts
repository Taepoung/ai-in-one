/**
 * ★ **권한 시트** — 봇마다 모드 · 대상 · 릴레이.
 */
import { botColor, DEFAULT_LOOP_CAP, type BotInstance, type Room } from "../../core/types.js";
import { sharedMemoryRow } from "../chat/fork.js";
import { el, icon, type Kids } from "../common/dom.js";
import { back, push, screens } from "../common/screens.js";
import { S, configErrors, configKey, configs, optionsFor, post } from "../common/state.js";

/**
 * 권한 설정 시트 (D2).
 *
 * **「봇 : 권한 모드 : 승인 주체」가 여기 한 자리에 있다.** 방 만들 때 정하고
 * 끝나는 게 아니라 대화 중에 바꾼다 — 리뷰만 시키다가 고치게 하는 일이 흔하다.
 *
 * 입력창 옆에 둔 이유는 자율 모드와 같다 — **켜둔 걸 잊으면 안 되는 종류**라
 * `⋮` 안에 숨기지 않는다.
 */
export function togglePermissionSheet(r: Room): void {
  if (S.stack[S.stack.length - 1] === "perm") { back(); return; }
  paintPermissionSheet(r);
  push("perm");
}

/** 화면이므로 **돌아가기만** 하면 된다 — 그린 것은 남겨둔다(다시 열 때 깜빡임 없게) */
function closeSheet(): void {
  if (S.stack[S.stack.length - 1] === "perm") back();
}

/**
 * 시트를 그린다 — 열려 있으면 **제자리에서 갈아 끼운다**.
 *
 * 설정은 CLI를 한 번 띄워야 오기 때문에 시트보다 늦게 도착하는 게 보통이다.
 * 처음 한 번만 그리면 그 늦은 응답이 갈 곳이 없어 시트가 *"권한 모드를 알려주지
 * 않습니다"* 에 영원히 머문다 — 실제로 Claude에서 그렇게 보였다.
 */
export function paintPermissionSheet(r: Room): void {
  // 열어 보는 것 자체가 «필요하다»는 신호다. 캐시가 있으면 바로 돌아온다.
  // 봇마다다 — 같은 에이전트로 봇이 둘이면 **고른 값도 둘**이다 (B1)
  for (const b of r.participants) {
    if (!optionsFor(b.agentId, r.id, b.id)) {
      post({ t: "needConfig", agentId: b.agentId, roomId: r.id, botId: b.id });
    }
  }

  /*
   * ★ **화면이라 제자리에 갈아끼운다** (2026-09-30).
   *
   * 🔴 시트일 때는 «덮개를 깔고 올리기» 와 «갈아끼우기» 를 갈라야 했다 —
   * 갱신마다 다시 올라오면 보는 중에 화면이 계속 새로 나타났기 때문이다.
   * 화면이 되면서 그 갈래가 통째로 없어졌다. 뜨고 지는 것은 스택이 한다.
   *
   * **스크롤은 지킨다.** 설정이 늦게 와서 다시 그릴 때마다 맨 위로 튀면
   * 읽던 자리를 잃는다 — 시트 시절에 겪은 그대로다.
   */
  const host = screens.perm;
  const keep = host.scrollTop;
  host.replaceChildren(
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "돌아가기", onclick: () => closeSheet() }, icon("arrow-left")),
      el("h1", {}, icon("shield"), " 권한 설정"),
    ),
    relayRow(r),
    ...r.participants.map((bot) => botPolicyBlock(r, bot)),
    loopRow(r),
    // `replaceChildren` 는 `el()` 과 달리 `null` 을 안 걸러준다
    ...[sharedMemoryRow(r)].filter((n): n is HTMLElement => n !== null),
  );
  host.scrollTop = keep;
}

/**
 * ★ **봇끼리 부르기 — 권한 설정 맨 위** (v3.0 2-F).
 *
 * 🔴 **그것도 권한이다.** 봇이 다른 봇을 부르는 것은 «누가 무엇을 할 수
 * 있나»의 한 줄이고, 봇별 권한보다 **위에** 있는 결정이다 — 이게 꺼져
 * 있으면 아래 줄들이 다 무의미하다.
 *
 * 지금은 **길이 서 있나**만 말한다. 켜고 끄는 것과 상한은 §4 에서 이 줄에
 * 붙는다.
 *
 * 🔴 **왜 안 되는지를 같이 적는다.** 루프백이 막힌 기계가 있는데, 조용히
 * 안 되면 «왜 안 부르지»를 영영 못 푼다. 그리고 **자동으로 다시 안 한다** —
 * 「몇 초마다」라는 숫자가 하나 생기고 그 숫자는 아무도 고를 수 없다.
 */
function relayRow(r: Room): HTMLElement {
  // 아래 봇 칸들과 **같은 상자**를 쓴다 — 같은 화면의 같은 종류의 결정이다
  const box = el("div", { class: "sheet-bot relay" });
  box.append(el("div", { class: "who" }, el("span", { class: "name", text: "봇끼리 부르기" })));

  if (S.mcpAt.at === "ready") {
    box.append(relayPick(r), capRow(r));
    return box;
  }

  box.append(
    el(
      "div",
      { class: "policy" },
      el("span", {
        class: "bad",
        text: S.mcpAt.at === "failed"
          ? `쓸 수 없습니다 — ${S.mcpAt.why}`
          : "아직 서지 않았습니다.",
      }),
      el(
        "button",
        {
          class: "link",
          title: "봇끼리 부르는 길을 다시 세워봅니다.",
          onclick: () => post({ t: "retryMcp" }),
        },
        icon("refresh"),
        "다시 시도",
      ),
    ),
  );
  return box;
}

/**
 * ★ **세 칸** (v3.0 4-L).
 *
 * ```
 * 끔         say 가 와도 «이 방은 안 됩니다» 로 돌려보낸다
 * 물어봄      호출마다 승인 카드          ← 기본
 * 무조건 허용  안 묻는다. 상한만 건다
 * ```
 *
 * 🔴 **켜둔 걸 잊으면 안 되는 종류**라 입력창 옆이다. «무조건 허용»은
 * **사람이 스스로에게 주는 권한**이라 §4.2.2 의 «`*_always` 는 봇에게 안
 * 준다»와 어긋나지 않는다.
 */
function relayPick(r: Room): HTMLElement {
  const now = r.relay ?? "ask";
  const pick = (mode: "off" | "ask" | "always", text: string, why: string) =>
    el("button", {
      class: now === mode ? "pill on" : "pill",
      text,
      title: why,
      onclick: () => {
        if (now === mode) return;
        post({ t: "setRelay", roomId: r.id, relay: mode });
      },
    });
  return el(
    "div",
    { class: "policy relay-pick" },
    pick("off", "끔", "say 가 와도 돌려보냅니다."),
    pick("ask", "물어봄", "봇이 다른 봇을 부를 때마다 승인 카드가 뜹니다."),
    pick("always", "무조건 허용", "안 묻습니다. 아래 상한만 겁니다."),
  );
}

/**
 * ★ **깊이 상한 — «사용자에게서 몇 다리까지»** (v3.0 4-L).
 *
 * ```
 * 0  사용자 메시지
 * 1  거기 반응해서 봇이 거는 말
 * 2  그 말에 반응해서 거는 말 — **답도 반응이다**
 * ```
 *
 * 🔴 **«무조건 허용» 일 때만 걸린다.** 「물어봄」은 **답까지 전부** 사람이
 * 누르므로 상한이 할 일이 없다. 그래서 다른 칸일 때는 **흐리게** 둔다 —
 * 숨기면 «언제 쓰이는 값이지»가 되고, 그냥 두면 «지금도 걸리나»가 된다.
 */
function capRow(r: Room): HTMLElement {
  const live = (r.relay ?? "ask") === "always";
  const box = el("input", {
    type: "number",
    class: "cap",
    min: "0",
    max: "999",
    value: String(r.depthCap ?? 12),
    title:
      "사용자 말이 깊이 0 입니다. 거기 반응해 거는 말이 1, 그 말에 반응해 거는 " +
      "말이 2 — **답도 반응이라 한 칸 늘어납니다.** 이만큼을 넘으면 say 가 " +
      "거절됩니다. 0 이면 제한 없음.",
  }) as HTMLInputElement;
  if (!live) box.disabled = true;
  const commit = () => {
    const n = Number(box.value);
    if (!Number.isFinite(n)) { box.value = String(r.depthCap ?? 12); return; }
    post({ t: "setRelayDepth", roomId: r.id, depth: n });
  };
  box.addEventListener("change", commit);
  return el(
    "div",
    { class: live ? "policy cap-row" : "policy cap-row off" },
    /*
     * ⏪ «사용자에게서 N 다리까지» 였다. **「다리」는 우리끼리 쓰던 말**이고
     * 화면 어디에도 풀어둔 데가 없었다 — 숫자를 고치는 사람이 **무엇을 고치는지
     * 모른다.** 설계가 내내 부르던 이름(«깊이»)을 그대로 쓴다.
     */
    el("span", { class: "dim", text: "봇끼리 이어지는 깊이" }),
    box,
    el("span", {
      class: "dim",
      // **0 이 무슨 뜻인지 그 자리에 적는다** — 숫자만 두면 «0 = 아예 못 한다» 로 읽는다
      text: !live
        ? "까지 — «무조건 허용» 에서만 걸립니다."
        : (r.depthCap ?? 12) === 0
          ? "— 제한 없음."
          : "까지. 넘으면 그 호출이 거절됩니다.",
    }),
  );
}

/**
 * ★ **루프모드 — 방 단위 상한** (사용자, 2026-10-20: *"안전장치 -> 사용자가 정할 수
 * 있게 하자"*).
 *
 * 한 봇에게 다시 묻는 횟수의 끝이다. 할 일을 끝없이 지어내는 봇이 구독 잔량을
 * 녹이지 않게 한다. 사용자가 새로 말을 걸면 처음부터 센다. 깊이 상한과 같은 꼴 —
 * 루프 봇이 없으면 **흐리게** 둔다(숨기면 «언제 쓰이는 값이지» 가 된다).
 */
function loopRow(r: Room): HTMLElement {
  const on = r.participants.filter((b) => b.answerPolicy === "auto");
  const cap = r.loopCap ?? DEFAULT_LOOP_CAP;
  const box = el("input", {
    type: "number", class: "cap", min: "0", max: "999", value: String(cap),
    title: "루프모드가 한 봇에게 다시 묻는 횟수의 끝입니다. 사용자가 새로 말을 걸면 처음부터 셉니다. " +
      "0 이면 제한 없음.",
  }) as HTMLInputElement;
  if (on.length === 0) box.disabled = true;
  box.addEventListener("change", () => {
    const n = Number(box.value);
    if (!Number.isFinite(n) || n < 0) { box.value = String(cap); return; }
    post({ t: "setLoopCap", roomId: r.id, cap: n });
  });
  const wrap = el("div", { class: "sheet-room loop" });
  wrap.append(
    el("div", { class: "who" }, el("span", { class: "name", text: "루프모드" })),
    el("div", { class: on.length > 0 ? "policy cap-row" : "policy cap-row off" },
      el("span", { class: "dim", text: "한 봇에게 다시 묻기" }),
      box,
      el("span", {
        class: "dim",
        // **0 이 무슨 뜻인지 그 자리에 적는다** — 깊이 상한과 같다
        text: on.length === 0
          ? "번까지 — 루프모드를 켠 봇이 없습니다."
          : cap === 0
            ? `— 제한 없음 · ${on.map((b) => b.name).join(" · ")}`
            : `번까지 — ${on.map((b) => b.name).join(" · ")}`,
      })),
  );
  return wrap;
}

/** 봇 하나의 설정 — 권한 모드 · 승인 주체 · 루프모드 */
function botPolicyBlock(r: Room, bot: BotInstance): HTMLElement {
  const options = optionsFor(bot.agentId, r.id, bot.id) ?? [];
  const mode = options.find((o) => o.category === "mode");

  const rows: Kids = [];

  // ── 권한 모드 — 에이전트가 주는 목록 그대로
  if (mode?.values?.length) {
    const select = el("select") as HTMLSelectElement;
    for (const v of mode.values) {
      select.append(el("option", { value: v.id, text: v.name, selected: v.id === mode.current }));
    }
    const hint = el("span", { class: "dim" });
    const paint = () => {
      hint.textContent = mode.values!.find((v) => v.id === select.value)?.description ?? "";
      // 가로로 누운 뒤로는 한 줄로 잘린다 — **전문은 여기 남긴다**
      hint.title = hint.textContent;
      hint.hidden = hint.textContent === "";
    };
    select.addEventListener("change", () => {
      paint();
      // 🔴 **봇을 실어야 한다** — 없으면 단체방에서 첫 봇의 모드가 바뀐다
      post({ t: "setConfig", roomId: r.id, configId: mode.configId, value: select.value, botId: bot.id });
    });
    paint();
    rows.push(el("div", { class: "field" }, el("label", { text: "권한 모드" }), select, hint));
  } else {
    const err = configErrors.get(configKey(bot.agentId, r.id, bot.id));
    rows.push(
      el("p", {
        class: err ? "warn" : "dim",
        text: err
          ? err
          : optionsFor(bot.agentId, r.id, bot.id) !== undefined
            ? "이 에이전트는 권한 모드를 알려주지 않습니다."
            : "권한 모드를 불러오는 중…",
      }),
    );
    // 못 불러온 건 대개 **고치고 나면 되는** 것이다 — 방을 닫았다 열게 하지 않는다
    if (err) {
      rows.push(
        el("button", {
          class: "link",
          text: "다시 시도",
          onclick: () => {
            configs.delete(configKey(bot.agentId, r.id, bot.id));
            configErrors.delete(configKey(bot.agentId, r.id, bot.id));
            // 다시 그리면서 «불러오는 중»으로 바뀌고, 그 김에 요청도 나간다
            paintPermissionSheet(r);
          },
        }),
      );
    }
  }

  /*
   * ── 승인 주체 — 물어봐야 할 때 누구에게
   *
   * ★ **방에 있는 다른 봇이 그대로 선택지가 된다** (v3.0 3-P).
   *
   * ⏪ 여기는 오래 «사용자» 한 칸이었고 *"다른 봇에게 맡기는 것은 v3.0에서"*
   * 라고 적혀 있었다. **지금이 v3.0이다.** 심사(§4.2.2)는 큐·`verdict`·
   * 가로채기·기록까지 다 서 있고 검사도 붙어 있었다 — **켤 길만 없었다.**
   * 코어가 다 돌아가는데 화면이 안 닿는 것은 «아직»이 아니라 **구멍**이다.
   *
   * 🔴 **목록을 손으로 관리하지 않는다.** 방의 참여자가 곧 목록이라 봇을
   * 부르면 그 자리에서 선택지가 되고 내보내면 사라진다. 따로 적어두면
   * 「추가」 버튼이 하나 생기고, 그 목록은 **방과 어긋나기 시작한다.**
   *
   * 🔴 **자기 자신은 뺀다.** 같은 맥락에 있는 쪽이 «해도 된다»고 답하는 것은
   * 심사가 아니라 메아리다 — 코어도 같은 이유로 막는다(`askBotApprover`).
   *
   * 🔴 **길이 안 서면 새로 고르지 못하게 한다.** 심사는 심사 봇의 **큐**로
   * 가고 큐를 읽는 길은 MCP 서버다. 서버가 없으면 고를 수는 있는데 매 요청이
   * 조용히 사용자에게 되돌아온다 — **고른 적 없는 설정이 켜진 것처럼** 보인다.
   *
   * 🔴 **그런데 「봇끼리 부르기」가 꺼진 것과는 다르다.** 「끔」은 `say` 만
   * 막는다 — `relay` 를 보는 곳은 `relaySay` 하나뿐이고, `check_queue` 도
   * `verdict` 도 깨우기도 그대로 돈다. **말을 걸 수 있느냐와 권한을 누가
   * 보느냐는 다른 축**이고, 둘이 같이 묶이는 것은 **MCP 서버 하나**다.
   * 그래서 여기서 보는 것도 `mcpAt` 이지 `r.relay` 가 아니다 — 문구도
   * 저 토글의 이름(«봇끼리 부르기»)을 빌려 쓰면 안 된다.
   */
  const mates = r.participants.filter((b) => b.id !== bot.id);
  const mcpUp = S.mcpAt.at === "ready";
  const picked = bot.approver?.kind === "bot" ? bot.approver.botId : "user";

  const who = el("select") as HTMLSelectElement;
  who.append(el("option", { value: "user", text: "사용자", selected: picked === "user" }));
  for (const mate of mates) {
    who.append(
      el("option", {
        value: mate.id,
        text: mate.name,
        selected: picked === mate.id,
        // **이미 골라둔 것은 안 막는다** — 막으면 화면이 «사용자»라고 거짓말한다
        disabled: !mcpUp && picked !== mate.id,
      }),
    );
  }
  who.addEventListener("change", () =>
    post({
      t: "setPolicy",
      roomId: r.id,
      botId: bot.id,
      approver: who.value === "user" ? { kind: "user" } : { kind: "bot", botId: who.value },
    }),
  );

  /** 고른 것에 따라 **무슨 일이 벌어지는지**를 적는다 — 규칙이 아니라 결과를 */
  const judge = mates.find((b) => b.id === picked);
  const whyWho = mates.length === 0
    ? "물어봐야 할 때 누가 답하나. 이 방엔 다른 봇이 없습니다."
    : !mcpUp
      ? "봇이 큐를 읽을 길이 아직 안 서서, 지금은 사용자에게만 물어볼 수 있습니다."
      : judge
        ? `${judge.name}의 큐로 갑니다. 넘기는 것은 «이번만»뿐이고 «항상»은 사용자 몫입니다.`
        : "물어봐야 할 때 누가 답하나. 봇에게 맡기면 그 봇의 큐로 갑니다.";
  rows.push(
    el(
      "div",
      { class: "field" },
      el("label", { text: "승인 주체" }),
      who,
      el("span", {
        class: !mcpUp && mates.length > 0 ? "bad" : "dim",
        text: whyWho,
        // 🔴 툴팁은 **보이는 글을 품어야** 한다 — 한 줄로 잘리기 때문이다
        title: whyWho,
      }),
    ),
  );

  /*
   * ── 루프모드 (2026-10-20 · 예전 «질문: 알아서 판단») ─────────────────
   *
   * 값은 그대로 `answerPolicy` 의 `ask`/`auto` 다 — 저장된 방이 그대로 읽힌다.
   * 뜻만 바뀌었다: 켜면 방이 조용해질 때마다 다시 물어 할 일을 이어 가게 한다
   * (`core/turn/loop.ts`). 상한은 아래 «루프모드» 상자에서 정한다.
   */
  const loop = el("select") as HTMLSelectElement;
  loop.append(el("option", { value: "ask", text: "끔", selected: bot.answerPolicy !== "auto" }));
  loop.append(el("option", { value: "auto", text: "켬", selected: bot.answerPolicy === "auto" }));
  loop.addEventListener("change", () =>
    post({
      t: "setPolicy",
      roomId: r.id,
      botId: bot.id,
      answerPolicy: loop.value === "auto" ? "auto" : "ask",
    }),
  );
  const loopWhy = "켜면 모두 멈춘 뒤 다시 물어, 할 일이 있으면 이어 하고 없으면 «종료» 로 끝냅니다.";
  rows.push(
    el(
      "div",
      { class: "field" },
      el("label", { text: "루프모드" }),
      loop,
      el("span", { class: "dim", text: loopWhy, title: loopWhy }),
    ),
  );

  return el(
    "div",
    /*
     * ⏪ **칸 가장자리에 색을 긋던 것을 뺐다** (2026-09-30).
     *
     * 점이 작아 안 잡힌다고 왼쪽 테두리를 그 색으로 굵게 그었다. 🔴 그런데
     * 바로 앞에서 **칸을 상자로 묶어둔 참**이었다 — 상자가 이미 «여기서
     * 저기까지가 이 봇» 을 말하고 있으므로, 색줄은 **같은 말을 두 번** 하는
     * 것이 됐다. 구분은 상자가, 누구인지는 점이 맡는다.
     */
    { class: "sheet-bot" },
    el(
      "div",
      { class: "who" },
      // 이름은 이 칸의 주인공이다 — 참여자 화면과 같은 크기로 (`.who .name`)
      el("span", { class: "name", text: bot.name }),
      /*
       * ★ **점은 이름 «오른쪽»에** (2026-09-30).
       *
       * 🔴 왼쪽에 뒀더니 **이름이 뒤로 밀렸다.** 칸마다 첫 글자가 안 맞아
       * 이름을 훑기가 어렵다 — 이 화면에서 제일 먼저 찾는 것이 이름인데.
       * 오른쪽에 두면 이름들이 **같은 자리에서 시작**하고, 색은 그 옆에서
       * 따라온다.
       *
       * 🔴 그리고 색은 **에이전트 것이 아니라 봇 것**이어야 한다. 에이전트
       * 색을 쓰면 같은 에이전트로 봇을 둘 두었을 때 점이 똑같아진다 — 정작
       * 봇을 가려야 하는 화면에서 구별을 못 해준다.
       */
      el("span", { class: "dot", style: { background: botColor(bot) } }),
    ),
    /*
     * ★ **세 칸을 가로로 누인다** (v2.0).
     *
     * 봇마다 위아래로 쌓으면 봇이 셋일 때 아홉 줄이 된다 — 시트가
     * 화면을 다 먹고 **정작 비교해야 할 두 봇을 나란히 못 본다.**
     * 가로로 두면 봇 하나가 한 줄이라 «누가 무엇까지 할 수 있나»가 한눈에 들어온다.
     *
     * 좁아지면 알아서 접힌다(`flex-wrap`) — 폭을 재서 가르지 않는다.
     */
    el("div", { class: "policy" }, ...rows),
  );
}

/** 무슨 종류의 승인인지 한눈에 (D1) */
export function permIcon(kind: string | undefined): string {
  switch (kind) {
    case "edit":
      return "edit";
    case "delete":
      return "trash";
    case "execute":
      return "terminal";
    case "fetch":
      return "globe";
    case "read":
    case "search":
      return "search";
    default:
      return "shield";
  }
}
