/**
 * ★ **방 만들기 화면**.
 */
import { BOT_COLORS, uniqueBotName } from "../../core/types.js";
import type { ConfigOptionBrief } from "../../protocol.js";
import { colorPick, el, icon, replace, type Kids } from "../common/dom.js";
import { back, go, push, screens } from "../common/screens.js";
import {
  S,
  agentAvail,
  askConfig,
  boot,
  configErrors,
  configKey,
  configs,
  post,
} from "../common/state.js";
import { renderOpening } from "../join/join.js";
import { renderAgents } from "../setup/agents.js";

// ── 방 만들기 ───────────────────────────────────────────────────────────

/**
 * 만들려는 방의 봇들 (v2.0).
 *
 * 1:1은 **봇이 하나인 단체방**이다 — 타입을 따로 고르게 하지 않는다.
 * 라디오 버튼은 거듭때기다: 봇을 하나 더 넣으면 그게 곧 단체방이고,
 * 아이콘도 `roomKind()`가 참여자 수로 알아서 바꾼다.
 */
export interface DraftBot {
  agentId: string;
  /** 모델·추론 강도 — 봇마다 따로 고른다 */
  picks: Map<string, string | boolean>;
  role: string;
  /** 부를 이름. 비우면 에이전트 이름이 된다 */
  name: string;
  /** 말풍선 색. 비우면 테마가 주는 평소 말풍선 (2026-09-28) */
  color: string;
  /** 그 위의 글자색 — 검정/하양 택1 */
  ink?: "black" | "white";
}

let draftBots: DraftBot[] = [newDraftBot()];

/**
 * ★ **안 고르면 파랑** (2026-09-30).
 *
 * 🔴 여태 기본이 «테마가 주는 평소 말풍선»(`--bubble-bot-bg`)이었다. 그 값은
 * 편집기 배경을 글자색 쪽으로 8% 민 것이라 **거의 회색**이고, 말풍선이 배경에
 * 겨우 떠 있는 정도다. 색을 고를 수 있게 만들어 놓고 **아무도 안 고르면 아무
 * 방에도 색이 없는** 상태가 기본이었다.
 *
 * 파랑을 기본으로 둔다. 고르개에 «파랑이 골라져 있는» 것으로 보이므로,
 * 마음에 안 들면 그 자리에서 바꾸면 된다 — 숨은 기본값이 아니다.
 *
 * **봇을 더하면 다음 색으로 간다.** 둘 다 파랑이면 색을 준 보람이 없다 —
 * v2.2 가 겨냥한 «같은 에이전트로 봇 여럿» 이 정확히 그 경우다.
 */
/**
 * 안 고르면 이 색이다 — **내 말풍선과 같은 파랑**이다.
 *
 * ⏪ 한때 **이미 쓴 색을 피해 다음 색**으로 넘겼다 — 봇 둘이 같은 파랑이면
 * 색을 준 보람이 없다고 봐서다. 사용자가 «봇끼리 색 겹쳐도 됨» 으로 정리했고,
 * 그 편이 맞다: 겹치는 것이 싫으면 **고르면 된다.** 안 겹치게 해주려다
 * «내가 파랑을 골랐는데 왜 자홍이지» 가 생기는 쪽이 더 나쁘다.
 *
 * 그리고 피하기를 걷으면서 딸려 있던 것들이 같이 없어졌다 — `draftBots` 를
 * 읽던 TDZ 방어, 새로 열 때 먼저 비우던 줄.
 */
function defaultBotColor(): string {
  return (BOT_COLORS.find((c) => c.id === "default") ?? BOT_COLORS[0]!).css;
}

export function newDraftBot(): DraftBot {
  return {
    /*
     * 🔴 **받아둔 것 중에서 고른다** (2026-10-02).
     *
     * 예전엔 무조건 `boot.agents[0]` 였다. 그러면 첫째를 안 받은 사람은
     * **고르개에 없는 값이 박힌 채** 방을 만들게 된다 — 고르개는 받은
     * 것만 보여주는데 속값은 Claude 에 고정돼 있어서, 눈에 보이는 것과
     * 실제로 붙는 것이 어긋난다.
     */
    agentId: (boot.agents.find((a) => agentAvail.has(a.id)) ?? boot.agents[0])?.id ?? "",
    picks: new Map(), role: "", name: "",
    color: defaultBotColor(),
  };
}

/**
 * ★ **실제로 붙을 이름을 미리 계산한다** — 코어와 **같은 순서, 같은 규칙**으로.
 *
 * 이름은 방 안에서 유일해야 해서 겹치면 뒤에 수가 붙는다(`uniqueBotName`).
 * 그걸 만들고 나서야 알게 되면 **«내가 친 것과 다른 이름»** 을 방에 들어가서
 * 발견하게 된다. 미리 보여주면 고칠 기회가 있다.
 */
function draftNames(): string[] {
  const taken = new Set<string>();
  return draftBots.map((b) => {
    const label = boot.agents.find((a) => a.id === b.agentId)?.label ?? b.agentId;
    const name = uniqueBotName(b.name.trim() || label, taken);
    taken.add(name);
    return name;
  });
}

/** 방금 손대던 봇 — 빼기를 누른 뒤 범위를 안전하게 유지하려고 둔다 */
let draftAt = 0;

export function openNewRoom(): void {
  S.draftCwd = "";
  /*
   * 🔴 **초안을 들고 있지 않는다.**
   *
   * 봇을 셋 넣어 방을 만든 뒤에 다시 «새 대화방»을 열면 그 셋이 그대로
   * 남아 있었다 — 방을 만드는 것은 **매번 새로 정하는 일**이지 직전을 이어가는
   * 일이 아니다. 제목·역할은 매번 비워 주면서 봇 수만 남겨두면 더 이상하다.
   */
  draftBots = [newDraftBot()];
  draftAt = 0;
  renderNew();
  go("new");
  /*
   * ⏪ **여기서 무조건 졸랐다** (2026-10-07).
   *
   * 써놓고 보면 괜찮아 보인다 — 코어가 캤시를 들고 있으니 답은 바로
   * 온다. 그런데 답을 주면서 **뒤로 새로 재기도 한다**(`refreshConfigOptions`).
   * 그게 Antigravity 에선 **세션을 하나 더 만드는 일**이고 19.5초가 걸린다 —
   * 방 만들기를 여루 번 열면 그만큼 쌓인다.
   *
   * `renderNew` 가 이미 `askConfig` 로 «없거나 틀어졌으면» 조른다.
   */
  setTimeout(() => screens.new.querySelector<HTMLInputElement>("#new-title")?.focus(), 240);
}

export function renderNew(error?: string): void {
  // 화면을 다시 만들므로 «이렇게 됩니다» 줄도 새로 모은다 — 옛 노드를 들고
  // 있으면 화면에 없는 것을 계속 고치게 된다
  draftBent.length = 0;

  /*
   * 🔴 **하나도 안 받았으면 만들기 형식을 안 보여준다** (2026-10-02).
   *
   * 고르개가 **텀 빈 채** 형식을 띄우면 사용자는 이름까지 정하고 «만들기» 를
   * 누른 뒤에야 «안 받았다» 를 알게 된다. 막히는 데가 늦을수록 나쁘다.
   */
  if (boot.agents.length > 0 && agentAvail.size === 0) {
    replace(
      screens.new,
      el(
        "header",
        { class: "bar" },
        el("button", { class: "icon", title: "뒤로", onclick: () => back() }, icon("arrow-left")),
        el("h1", { text: "새 대화방" }),
      ),
      el("div", { class: "empty" },
        el("p", { text: "아직 받아둔 에이전트가 없습니다." }),
        el("p", { class: "dim" }, "목록 화면 위의 ", icon("robot"), " 에서 하나 받으면 바로 만들 수 있습니다."),
        el("button", {
          class: "primary", type: "button", text: "에이전트 받으러 가기",
          onclick: () => { post({ t: "agentsAsk" }); renderAgents(); push("agents"); },
        }),
      ),
    );
    return;
  }

  /* 화면에 들어올 때도 한 번 확인한다 — 미리 밀어준 것이 틀어졌을 수 있다 */
  for (const b of draftBots) askConfig(b.agentId);

  const title = el("input", { type: "text", id: "new-title", placeholder: "비우면 «새 대화»" });
  const cwdInput = el("input", {
    type: "text",
    id: "new-cwd",
    value: S.draftCwd,
    // 워크스페이스 루트여도 없애지 않고 «현재 워크스페이스»라고 말해준다
    placeholder: "현재 워크스페이스",
  });

  const create = el("button", { class: "primary", text: "만들기" }) as HTMLButtonElement;

  /**
   * 🔴 **폴더가 없으면 고르게 한다** (B9).
   *
   * `cwd`는 워크스페이스가 없어도 홈으로 채워지므로 그대로 만들면 **에이전트가
   * 홈 디렉터리에서 돈다** — 거기서는 «워크스페이스 안/밖»(I4) 구분도 무의미해져
   * 무엇을 건드릴지 가늠할 수 없다. cwd는 어차피 방마다 정하는 값이니(CLI도
   * 세션마다 받는다) **막을 게 아니라 물어보면 된다.**
   */
  const needsFolder = () => !boot.hasWorkspace && cwdInput.value.trim() === "";
  const syncCreate = () => {
    create.disabled = needsFolder();
    create.title = needsFolder() ? "작업할 폴더를 먼저 고르세요" : "";
  };
  cwdInput.addEventListener("input", syncCreate);
  syncCreate();
  // 다 그린 뒤 한 번 — 처음부터 겹쳐 있을 수 있다 (같은 에이전트를 둘 고른 채로)
  queueMicrotask(syncDraftNames);

  create.addEventListener("click", () => {
    if (needsFolder()) return;
    create.disabled = true;
    create.textContent = "여는 중…";
    /*
     * ★ **누르는 순간 붙는 화면으로** (사용자, 2026-10-15):
     * *"새 대화방 만들기 -> 열기 누를 때 로딩창으로 이동 -> 방으로
     * 들어가짐 이 흐름으로 / 1대1 만들때는 만드는 창에서 좀 대기하는"*.
     *
     * 🔴 방이 **돌아와야** 화면이 움직였다 — 그사이 만들기 창에 그대로
     * 서 있으니 **누른 것이 먹혔나** 싶어진다. 기다리는 것은 같아도
     * «어디서 기다리나» 는 다르다 — 붙는 화면은 그 기다림이 **제 일**이다.
     */
    renderOpening(title.value.trim());
    go("joining");
    post({
      t: "createRoom",
      agentId: draftBots[0]?.agentId ?? "",
      title: title.value.trim(),
      ...(cwdInput.value.trim() ? { cwd: cwdInput.value.trim() } : {}),
      bots: draftBots.map((b) => ({
        agentId: b.agentId,
        ...(b.name.trim() ? { name: b.name.trim() } : {}),
        ...(b.color.trim() ? { color: b.color.trim() } : {}),
        ...(b.ink ? { ink: b.ink } : {}),
        ...(b.role.trim() ? { rolePrompt: b.role.trim() } : {}),
        ...(b.picks.size > 0 ? { configValues: Object.fromEntries(b.picks) } : {}),
      })),
    });
  });

  replace(
    screens.new,
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "뒤로", onclick: () => back() }, icon("arrow-left")),
      el("h1", { text: "새 대화방" }),
    ),
    el(
      "div",
      { class: "form" },
      el("div", { class: "field" }, el("label", { text: "방 제목" }), title),
      ...draftBots.map((b, n) => botFieldset(b, n)),
      // 봇을 하나 더 넣으면 그게 곧 단체방이다 — 타입을 따로 고르게 하지 않는다
      el("div", { class: "row" },
        el("button", {
          class: "ghost",
          text: "+ 봇 추가",
          onclick: () => {
            draftBots.push(newDraftBot());
            draftAt = draftBots.length - 1;
            renderNew();
          },
        }),
        /*
         * ⏪ **«혼자 쓰면 1:1 방입니다» 를 뺐다** (2026-09-30).
         *
         * 봇이 하나인 것은 **화면에 이미 보인다** — 봇 칸이 하나뿐이다. 보이는
         * 것을 글로 한 번 더 말하면 «내가 뭘 잘못했나» 하고 읽게 된다.
         * 여럿일 때만 적는다 — 그건 **처음 만들기 화면에서 안 보이던 것**
         * (단체방이 된다는 결과)이라 말해줄 값이 있다.
         */
        draftBots.length > 1
          ? el("span", { class: "dim", text: `봇 ${draftBots.length}개 — 단체방으로 만들어집니다` })
          : null,
      ),
      el(
        "div",
        { class: "field" },
        el("label", { text: "작업 디렉터리" }),
        el(
          "div",
          { class: "cwd" },
          cwdInput,
          el(
            "button",
            { class: "ghost", onclick: () => post({ t: "pickCwd" }) },
            icon("folder-opened"),
          ),
        ),
        boot.hasWorkspace
          ? null
          : el("span", {
              // 고유 이름 — 이 화면에는 «흐린 글씨»가 여럿이라 그것만으론 못 고른다
              class: "dim cwd-why",
              text: "열린 폴더가 없습니다. 에이전트가 일할 폴더를 고르세요.",
            }),
      ),
      error ? el("p", { class: "error", text: error }) : null,
      el(
        "div",
        { class: "actions" },
        el("button", { class: "ghost", text: "취소", onclick: () => back() }),
        create,
      ),
    ),
  );
}

/**
 * 봇 하나를 고르는 칸 (v2.0).
 *
 * 1:1이든 단체방이든 **같은 블록이 반복될 뿐**이다 — 모델·역할이
 * 전부 봇에 붙는 값이라(D2·B3) 봇마다 따로 받아야 한다.
 */
function botFieldset(b: DraftBot, n: number): HTMLElement {
  const name = el("input", {
    type: "text",
    value: b.name,
    /*
     * ★ **빈 칸에 «실제로 붙을 이름»을 보여준다** (2026-09-30).
     *
     * 🔴 에이전트 이름(`Claude`)만 보여주고, 겹치면 아래에 ««Claude»은(는)
     * 이미 있어서 «Claude 2»이(가) 됩니다» 라는 줄을 따로 띄웠다. 그런데
     * **빈 칸에 이미 답이 들어갈 자리가 있었다** — 거기에 `Claude 2` 를
     * 적으면 설명할 것이 없어진다. 글로 알려주는 대신 **그대로 보여준다.**
     */
    placeholder: draftNames()[n] ?? "",
  }) as HTMLInputElement;
  name.addEventListener("input", () => {
    b.name = name.value;
    // 앞 봇의 이름이 바뀌면 **뒤 봇에 붙을 이름도 바뀐다** — 전부 다시 본다
    syncDraftNames();
  });
  draftBent.push({ b, hint: name });

  const role = el("textarea", {
    placeholder: "예) 너는 코드 리뷰어다. 구현하지 말고 지적만 해라.",
    ...(n === 0 ? { id: "new-role" } : {}),
  }) as HTMLTextAreaElement;
  role.value = b.role;
  role.addEventListener("input", () => (b.role = role.value));

  return el(
    "fieldset",
    { class: "bot" },
    el("legend", { text: draftBots.length > 1 ? `봇 ${n + 1}` : "봇" }),
    draftBots.length > 1
      ? el(
          "button",
          {
            /*
             * ★ **빨강으로** (2026-09-30). 되돌릴 수 없는 것은 색으로도 말한다 —
             * 서랍의 «내보내기»와 같은 규칙이다(`.ghost.danger`).
             */
            class: "link danger bot-drop",
            onclick: () => {
              draftBots.splice(n, 1);
              draftAt = Math.min(draftAt, draftBots.length - 1);
              renderNew();
            },
          },
          // 큐의 «빼기»와 **같은 말**이다 — 모양도 같아야 한다
          icon("close"),
          "빼기",
        )
      : null,
    /*
     * ★ **이름이 먼저, 그다음 에이전트** (2026-09-30).
     *
     * 🔴 에이전트를 먼저 물었다. 기본 이름이 에이전트 이름이라 «고른 다음에야
     * 이름이 정해진다» 고 봤기 때문이다. 그런데 **빈 칸에 붙을 이름을 그대로
     * 보여주게 되면서** 그 이유가 없어졌다 — 에이전트를 바꾸면 빈 칸의 글자도
     * 따라 바뀐다.
     *
     * 사람이 정하는 순서는 «이 봇을 뭐라고 부를까 → 무엇으로 돌릴까» 다.
     * 이름이 이 칸의 주인공이므로 맨 위가 맞다.
     *
     * ★ **색은 이름 «옆»에** (2026-09-28). 칸을 따로 만들면 화면이 길어지는데,
     * 이름을 정하는 그 순간이 «이 봇을 무엇으로 부를까»를 정하는 때이고 색도
     * 같은 질문이다.
     */
    el("div", { class: "field" },
      el("label", { text: "이름 (선택)" }),
      el("div", { class: "named" },
        name,
        colorPick(b.color || undefined, b.ink,
          (css, pickedInk) => {
            b.color = css;
            b.ink = pickedInk;
            renderNew();
          }))),
    el(
      "div",
      { class: "field" },
      el("label", { text: "에이전트" }),
      agentSelect(b, () => { draftAt = n; renderNew(); }),
    ),
    /*
     * 에이전트를 고른 뒤에 채워진다. 미리 받아두어 기다림이 없다 (B15).
     *
     * ⚠️ **못 물어본 것과 저쪽이 안 알려준 것은 다르다.** 틀어졌으면
     * 까닭을 보여주고, 빈 목록으로 둔갑시키지 않는다.
     */
    ...(configErrors.has(configKey(b.agentId))
      ? [el("p", { class: "error", text: configErrors.get(configKey(b.agentId))! })]
      : configFields(configs.get(b.agentId), b.picks)),
    el("div", { class: "field" }, el("label", { text: "역할 (선택)" }), role),
  );
}

/** 빈 칸 글씨를 다시 맞출 이름 입력칸들 — 앞 봇이 바뀌면 뒤 봇도 바뀐다 */
const draftBent: Array<{ b: DraftBot; hint: HTMLElement }> = [];

/**
 * ⏪ **«이미 있어서 …이(가) 됩니다» 를 뺐다** (2026-09-30).
 *
 * 🔴 겹치는 이름에 «이렇게 바뀝니다» 를 글로 알려줬다. 그런데 **빈 칸에 이미
 * 그 답이 들어갈 자리가 있었다** — 거기에 `Claude 2` 를 적으면 설명할 것이
 * 없어진다. 글로 알려주는 대신 **그대로 보여준다.**
 *
 * 그래서 이 함수가 하는 일은 이제 «빈 칸 글씨를 다시 맞추는 것» 하나다 —
 * 앞 봇의 이름이 바뀌면 뒤 봇에 붙을 이름도 바뀌기 때문이다.
 */
function syncDraftNames(): void {
  const names = draftNames();
  for (const [n, { hint }] of draftBent.entries()) {
    (hint as HTMLInputElement).placeholder = names[n] ?? "";
  }
}

/**
 * ★ **에이전트는 드롭다운으로** (2026-09-30).
 *
 * 🔴 카드 단추를 줄줄이 세웠다. 둘일 때는 «골라 보세요» 가 잘 읽혔는데,
 * 사용자가 `aiInOne.agents` 로 더할 수 있으므로 **몇 개가 될지 우리가 모른다.**
 * 게다가 이 화면에는 이미 같은 일을 하는 칸이 여럿이다 — 모델·강도·권한 모드.
 * **방 안에서 에이전트를 갈아탈 때도 드롭다운**을 쓴다(서랍). 만들 때와 바꿀
 * 때가 다른 모양이면 «다른 일인가» 로 읽힌다.
 *
 * 설명(`a.description`)은 고른 것 아래 한 줄로 남긴다 — 드롭다운 안에서는
 * 안 보이고, 그렇다고 버리면 «Codex 가 뭐지» 에 답할 데가 없어진다.
 */
export function agentSelect(
  b: { agentId: string; picks: Map<string, string | boolean> },
  after: () => void,
): HTMLElement {
  const pick = el("select", { class: "agent-pick" }) as HTMLSelectElement;
  /* 받지 않은 것은 안 띄운다 — 고르게 해두고 나중에 막으면 더 나쁘다 */
  for (const a of boot.agents.filter((x) => agentAvail.has(x.id))) {
    pick.append(el("option", { value: a.id, text: a.label, selected: a.id === b.agentId }));
  }
  pick.addEventListener("change", () => {
    if (pick.value === b.agentId) return;
    b.agentId = pick.value;
    // 모델은 에이전트마다 다르다 — 골랐던 것을 그대로 두면 없는 id 를 보낸다
    b.picks.clear();
    askConfig(pick.value);
    after();
  });

  const who = boot.agents.find((a) => a.id === b.agentId);
  return el(
    "div",
    { class: "agent-row" },
    pick,
    who?.description ? el("span", { class: "dim agent-desc", text: who.description }) : null,
  );
}

/** 모델·추론 강도 등. 에이전트가 주는 대로 그린다 — 종류를 우리가 정하지 않는다 */
/**
 * 범주별 표시 순서 (B15).
 *
 * **에이전트가 주는 순서를 그대로 쓰면 안 된다.** 실측:
 *
 * ```
 * Claude Code   Model · Effort · Fast mode
 * Codex         Mode · Collaboration mode · Model · Reasoning effort
 * ```
 *
 * 에이전트를 바꿀 때마다 같은 자리에 다른 게 있으면 매번 다시 읽어야 한다.
 */
const CATEGORY_ORDER = ["model", "thought_level", "model_config"];

/**
 * 우리 이름으로 통일한다.
 *
 * 같은 걸 Claude는 `Effort`, Codex는 `Reasoning effort`라 부른다.
 * **의미가 또렷한 범주만** 바꾼다 — `model_config`는 잡다한 묶음이라
 * 에이전트가 붙인 이름(`Fast mode`)이 더 정확하다.
 */
const CATEGORY_LABEL: Record<string, string> = {
  model: "모델",
  thought_level: "사고 강도",
};

/**
 * 세션 설정을 그린다 (B15).
 *
 * **모델만 밖에 두고 나머지는 접는다.** 에이전트가 주는 걸 전부 펼치면
 * 방 하나 만드는 데 드롭다운 네 개를 지나야 한다 — 대부분은 기본값이면 된다.
 */
export function configFields(
  options: ConfigOptionBrief[] | undefined,
  picks: Map<string, string | boolean>,
): Kids {
  if (!options) return [el("p", { class: "dim", text: "모델 목록을 불러오는 중…" })];

  // **권한 모드는 여기 없다** (D2). 방을 만들 때 정해봐야 쓰면서 바꾸게 되므로
  // **입력창 옆 권한 설정**에서 한 자리로 다룬다. 여기서는 에이전트 기본값으로 시작한다.
  const usable = options.filter(
    (o) => o.category !== "mode" && o.values && o.values.length > 0,
  );
  if (usable.length === 0) {
    return [
      el("p", {
        class: "dim",
        text: "이 에이전트는 고를 수 있는 모델을 알려주지 않습니다. 그대로 만들어도 됩니다.",
      }),
    ];
  }

  // 현재 값을 미리 담아둔다 — 손대지 않은 항목도 세션에 그대로 적용되도록
  for (const o of usable) {
    if (o.current !== undefined) picks.set(o.configId, o.current);
  }

  const rank = (o: ConfigOptionBrief) => {
    const at = CATEGORY_ORDER.indexOf(o.category ?? "");
    return at < 0 ? CATEGORY_ORDER.length : at;
  };
  const sorted = usable
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)
    .map((x) => x.o);

  const model = sorted.filter((o) => o.category === "model");
  const rest = sorted.filter((o) => o.category !== "model");
  const out: Kids = model.map((o) => configRow(o, picks));

  if (rest.length > 0) {
    out.push(
      el(
        "details",
        { class: "advanced" },
        el("summary", {}, icon("chevron-right"), " 고급 설정"),
        el("div", { class: "advanced-body" }, ...rest.map((o) => configRow(o, picks))),
      ),
    );
  }
  return out;
}

function configRow(o: ConfigOptionBrief, picks: Map<string, string | boolean>): HTMLElement {
  const select = el("select") as HTMLSelectElement;
  for (const v of o.values!) {
    select.append(el("option", { value: v.id, text: v.name, selected: v.id === o.current }));
  }
  // **설명은 에이전트가 준 걸 그대로 보여준다.** 우리가 다시 쓰면
  // 에이전트가 바뀔 때 틀린 말이 남는다.
  const hint = el("span", { class: "dim" });
  const paint = () => {
    hint.textContent = o.values!.find((v) => v.id === select.value)?.description ?? "";
    hint.hidden = hint.textContent === "";
  };
  select.addEventListener("change", () => {
    picks.set(o.configId, select.value);
    paint();
  });
  paint();

  return el("div", { class: "field" }, el("label", { text: labelOf(o) }), select, hint);
}

/** 에이전트가 뭐라 부르든 화면에서는 같은 이름이어야 한다 */
export function labelOf(o: ConfigOptionBrief): string {
  return CATEGORY_LABEL[o.category ?? ""] ?? o.name;
}
