/**
 * ★ **창 공통 — 작은 DOM 헬퍼** · 아이콘 · 색 고르기.
 */
import { BOT_COLORS } from "../../core/types.js";

// ── 작은 DOM 헬퍼 ───────────────────────────────────────────────────────

export type Kids = Array<Node | string | false | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...kids: Kids
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style") setStyle(node, v as Record<string, string>);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) {
    if (kid === false || kid == null) continue;
    node.append(kid);
  }
  return node;
}

/**
 * ★ **커스텀 속성(`--이름`)은 `setProperty` 로만 들어간다** (2026-09-28).
 *
 * 🔴 `Object.assign(node.style, …)` 를 쓰고 있었다. 평범한 속성에는 통하지만
 * **`--bot` 같은 커스텀 속성은 조용히 버려진다** — `style` 객체에 그런 키가
 * 없기 때문이다. 오류도 안 나고 값만 사라진다.
 *
 * 봇 색을 실으려다 걸렸다. 말풍선이 그냥 평소 색이었고 `style` 은 `null` 이었다.
 */
function setStyle(node: HTMLElement, style: Record<string, string>): void {
  for (const [k, v] of Object.entries(style)) {
    if (k.startsWith("--")) node.style.setProperty(k, v);
    else (node.style as unknown as Record<string, string>)[k] = v;
  }
}

export const icon = (name: string) => el("i", { class: `codicon codicon-${name}` });

/**
 * ★ **봇 색 고르기** — 이름 **옆**에 (2026-09-28).
 *
 * 🔴 C9 는 «색은 보조 신호로만»이라고 정했고 그 이유 중 제일 센 것이 «같은
 * 에이전트의 두 봇은 색이 같다» 였다. **봇마다 색을 주면 그 이유가 사라진다.**
 * 나머지 둘(라이트 테마 대비 · 색각 이상)은 남으므로 **이름은 그대로 둔다** —
 * 색은 더해지는 것이지 대신하는 것이 아니다.
 *
 * 자리를 이름 옆으로 둔 이유: 설정 칸이 하나 더 늘면 만들기 화면이 길어진다.
 * 이름을 정하는 그 순간이 «이 봇을 무엇으로 부를까»를 정하는 때이고, 색도
 * 같은 질문이다.
 *
 * 프리셋 값이 **테마 변수**인 것이 핵심이다(`BOT_COLORS`) — 우리가 팔레트를
 * 하드코딩하면 §2.2 G(«자체 테마를 만들지 않는다»)를 바로 어긴다.
 */
/**
 * 🔴 **폴백이 «에이전트 색»이었다** (2026-09-29에 고침).
 *
 * 아무것도 안 골랐을 때 고르개의 점이 브랜드색(`#d97757`)을 보여줬다. 그런데
 * 말풍선은 **테마 기본**이다 — 고르개는 «파랑 골라져 있네»라고 하는데 화면은
 * 회색이다. 사용자가 바로 알아챘다.
 *
 * 고르개는 **실제로 그려질 것**을 보여야 한다. 안 골랐으면 «테마가 주는 평소
 * 말풍선»이므로 그 색을 그대로 보여준다 — 그게 참이다.
 */
const NO_COLOR = "var(--bubble-bot-bg)";

export function colorPick(
  now: string | undefined,
  ink: "black" | "white" | undefined,
  pick: (css: string, ink: "black" | "white" | undefined) => void,
): HTMLElement {
  const fallback = NO_COLOR;
  const dot = el("span", { class: "dot", style: { background: now ?? fallback } });
  const box = el("details", { class: "swatch" });
  const close = () => box.removeAttribute("open");

  /*
   * ★ **판을 나가는 문은 «적용» 하나다** (2026-09-29).
   *
   * 🔴 예전에는 **누르는 족족 들어갔다.** 프리셋도, 글자칸도 한 번 누르면
   * 그대로 적용되고 판이 닫혔다. 그래서 «색 고르고 글자색까지 정하기» 가
   * 아예 불가능했다 — 색을 누르는 순간 판이 닫혀서 글자색을 볼 기회가
   * 없었고, 다시 열어서 또 한 번 눌러야 했다. 두 번 적용되는 셈이다.
   *
   * 이제 판 안의 모든 누름은 **고르는 것**이고, 들어가는 것은 «적용» 뿐이다.
   * 딴 데를 누르면 고르던 것은 버려진다 — 되돌리기를 따로 둘 필요가 없다.
   *
   * 글자색은 **안 건드려도 된다.** 안 건드리면 쓰던 것이 그대로 따라간다.
   */
  let draft = now ?? fallback;
  let draftInk = ink;
  const inks: HTMLElement[] = [];
  const presets: Array<{ css: string; node: HTMLElement }> = [];

  /** 고르던 것을 화면에 비춘다 — 무엇이 «적용» 될지가 보여야 한다 */
  const repaint = (): void => {
    for (const b of inks) {
      b.style.background = draft;
      b.classList.toggle("on", draftInk === (b.dataset["ink"] as "black" | "white"));
    }
    for (const p of presets) p.node.classList.toggle("on", p.css === draft);
  };

  const preset = (css: string, label: string) => {
    const node = el("button", {
      class: "sw", title: label, type: "button",
      style: { background: css },
      // **고르기만 한다.** 판은 열린 채 — 이어서 글자색을 볼 수 있어야 한다
      onclick: () => { draft = css; repaint(); },
    });
    presets.push({ css, node });
    return node;
  };

  /*
   * ★ **글자는 검정이나 하양, 둘뿐이다** (2026-09-28).
   *
   * 배경을 **섞지 않고 그대로** 칠하므로 대비를 우리가 못 잡는다. 그렇다고
   * 계산해서 고를 수도 없다 — 프리셋 값이 `var(--vscode-charts-blue)` 라
   * **테마마다 실제 색이 다르고**, 어느 테마에서 어두울지 우리는 모른다.
   *
   * 그래서 **보고 고르게 한다.** 두 칸을 **지금 배경 위에** 그려두면 어느 쪽이
   * 읽히는지 눈으로 바로 갈린다 — 설명이 필요 없다.
   *
   * ★ 그 «지금 배경» 이 이제 **고르는 중인 색**이다 (2026-09-29). 그리고
   * 누르면 **색과 글자색이 같이** 들어간다 — 색을 고른 뒤 「가」 하나만 더
   * 누르면 끝이라, «적용» 을 따로 찾을 일이 없다.
   */
  const inkBtn = (v: "black" | "white") => {
    const b = el("button", {
      class: `ink${draftInk === v ? " on" : ""}`,
      type: "button",
      "data-ink": v,
      title: v === "black" ? "이 색에 검정 글자" : "이 색에 하양 글자",
      style: { background: draft, color: v === "black" ? "#000" : "#fff" },
      text: "가",
      // 여기도 **고르기만** 한다 — 안 눌러도 되고, 누르면 «적용» 때 같이 간다
      onclick: () => { draftInk = v; repaint(); },
    });
    inks.push(b);
    return b;
  };

  /*
   * 커스텀은 **에디터가 주는 색 고르개**를 쓴다. 우리가 그리면 테마를 또
   * 흉내 내야 하고, 그러면 §2.2 G 를 우회하는 셈이 된다.
   */
  /*
   * ★ **커스텀은 «확정»을 눌러야 들어간다** (2026-09-28).
   *
   * 🔴 `oninput` 으로 바로 넣었더니 **고르는 동안 계속 적용됐다.** 색 고르개를
   * 끌고 다니는 사이에 말풍선이 수십 번 바뀌고, 손을 떼면 **지나가던 색이
   * 남는다.** 프리셋은 «한 번 누르면 그 색»이라 괜찮지만 커스텀은 다르다.
   *
   * 그래서 고르개는 **미리보기**만 하고, 넣는 것은 단추가 한다.
   *
   * ★ **그 미리보기가 이제 글자칸까지 간다** (2026-09-29).
   *
   * 「스포이드 창 안에 «적용» 을 넣을 수 없나」 하는 물음에서 나왔다. OS 가
   * 그리는 창이라 거기엔 못 넣는다 — 대신 **그 창을 닫고 나온 자리**에서
   * 색과 글자색을 한눈에 고르게 한다. 고른 색이 글자칸 두 개의 배경으로
   * 즉시 깔리므로, 「가」를 누르는 것이 곧 «이 색 + 이 글자색» 이 된다.
   */
  const custom = el("input", {
    type: "color",
    class: "sw custom",
    title: "직접 고르기",
    // `var(--vscode-…)` 는 hex 가 아니라 여기 못 넣는다 — 무난한 값에서 시작한다
    value: /^#[0-9a-f]{6}$/i.test(now ?? "") ? now! : "#888888",
    // 스포이드는 **끌면 바로 반영된다** — 고르는 중이니 확인 단계가 하나 더
    // 있으면 거추장스럽다. 들어가는 것은 여전히 «적용» 뿐이다.
    oninput: () => { draft = custom.value; repaint(); },
  });

  /*
   * ★ **«적용»은 강조 단추다** (2026-09-28).
   *
   * 커스텀 칸은 **누르기 전에는 아무 일도 안 일어난다.** 그러면 «다 골랐는데
   * 왜 안 바뀌지»가 되기 쉬우므로, 다음에 할 일이 **눈에 띄어야** 한다.
   * 알약(`link`)은 «행 안의 잔 동작» 자리라 여기서는 약하다(§2.2 G5).
   */
  const apply = el("button", {
    class: "primary apply", type: "button", text: "적용",
    title: "고른 색과 글자색을 적용합니다",
    // **판을 나가는 유일한 문.** 색과 글자색이 한 쌍으로 간다
    onclick: () => { pick(draft, draftInk); close(); },
  });

  const panel = el(
    "div",
    { class: "swatches" },
    ...BOT_COLORS.map((c) => preset(c.css, c.label)),
    /*
     * ★ **스포이드는 프리셋 «오른쪽» 기둥에** (2026-09-29).
     *
     * 🔴 아래에 뒀더니 **저를 누르면 뜨는 창이 판을 덮었다.** `<input
     * type="color">` 의 창은 **에디터가 그리고 에디터가 자리를 정한다** —
     * 우리가 못 옮긴다. 우리가 옮길 수 있는 것은 **창이 매달리는 칸** 뿐이다.
     *
     * 아래에 있으면 창이 그 밑으로 열리면서 글자칸과 단추 줄을 가린다.
     * 하필 이제 글자칸이 **고른 색을 비추는 자리**라, 색을 끌어 고르는
     * 동안 정작 봐야 할 것이 가려져 있었다.
     *
     * 그래서 오른쪽 기둥으로 보낸다 — 프리셋 두 줄 옆에 세로로 선다.
     * 창이 그 옆에서 열리므로 판의 아래쪽이 살아 있다.
     *
     * ⚠️ 그래도 **완전히 우리 손 안은 아니다.** 판이 화면 오른쪽 끝에
     * 붙어 있으면 에디터가 창을 왼쪽으로 접어 열 수 있다. 그때까지 가려면
     * 고르개를 우리가 그려야 하는데, 그건 테마를 통째로 흉내 내는 일이다.
     */
    custom,
    el("div", { class: "inks" }, inkBtn("black"), inkBtn("white")),
    el(
      "div",
      { class: "pick-acts" },
      el("button", { class: "ghost", type: "button", text: "기본값으로",
                     title: "테마가 주는 평소 말풍선으로 되돌립니다",
                     onclick: () => { pick("", undefined); close(); } }),
      apply,
    ),
  );

  /*
   * ★ **창을 넘지 않게 «고정 좌표»로 띄운다** (2026-09-28).
   *
   * 🔴 `position: absolute` 로 두었더니 **서랍 밖으로 밀려났다.** 서랍은
   * `overflow-y: auto` 라 그 안의 절대 배치는 잘리거나 스크롤 밖으로 나간다.
   * 부모가 무엇이든 상관없으려면 `fixed` 여야 한다.
   *
   * 그러면 좌표는 우리가 잡아야 하는데, **화면 안으로 접어 넣는다** — 오른쪽
   * 끝에서 열면 왼쪽으로, 아래가 모자라면 위로. 열 때 한 번만 재고 스크롤하면
   * 닫는다(따라다니게 만들면 그때부터 어긋날 자리가 는다).
   */
  const place = (): void => {
    const at = box.getBoundingClientRect();
    const w = panel.offsetWidth || 200;
    const h = panel.offsetHeight || 60;
    panel.style.left = `${Math.max(8, Math.min(at.right - w, window.innerWidth - w - 8))}px`;
    const below = at.bottom + 6;
    panel.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, at.top - h - 6) : below}px`;
  };
  box.addEventListener("toggle", () => {
    if (!box.open) {
      // 닫혔으면 **고르던 것은 버린다** — 다음에 열 때 지금 쓰는 색에서 시작한다
      draft = now ?? fallback;
      draftInk = ink;
      repaint();
      return;
    }
    place();
    const shut = () => box.removeAttribute("open");
    window.addEventListener("scroll", shut, { once: true, capture: true });
    window.addEventListener("resize", shut, { once: true });
    /*
     * ★ **딴 데를 누르면 닫힌다** (2026-09-29).
     *
     * 🔴 `<details>` 는 저 혼자 안 닫힌다. 예전에는 무엇을 누르든 바로 적용되고
     * 닫혔으니 문제가 안 됐는데, 이제 판이 **고르는 동안 계속 열려 있다.**
     * 나가는 길이 «적용» 뿐이면 «그만둘래» 가 막힌다 — 요약 점을 다시 찾아
     * 눌러야 한다.
     *
     * 딴 데 누르기가 곧 «그만두기» 다. 위에서 고르던 것을 버리므로 되돌리기를
     * 따로 둘 필요가 없다.
     */
    const away = (e: Event) => {
      if (box.contains(e.target as Node)) return;
      box.removeAttribute("open");
      document.removeEventListener("pointerdown", away, true);
    };
    document.addEventListener("pointerdown", away, true);
  });

  box.append(el("summary", { title: "말풍선 색" }, dot), panel);
  return box;
}

export function replace(host: HTMLElement, ...kids: Kids): void {
  host.replaceChildren(...(kids.filter((k) => k != null && k !== false) as Node[]));
}
