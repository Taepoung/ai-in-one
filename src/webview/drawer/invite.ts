/**
 * ★ **초대 화면** — 봇 들이기.
 */
import { type Room, uniqueBotName } from "../../core/types.js";
import { colorPick, el, icon } from "../common/dom.js";
import { back, push, screens } from "../common/screens.js";
import { boot, configs, post } from "../common/state.js";
import { agentSelect, configFields, newDraftBot, type DraftBot } from "../new/new.js";

/**
 * **봇 부르기** — 서랍 바닥 (v2.0).
 *
 * 1:1 방에서 누르면 그 자리에서 단체방이 된다 — 방을 새로 만들 필요가 없다.
 * 역할은 여기서 안 받는다. 부른 뒤 **그 봇의 줄에서** 적으면 된다 — 단추 하나에
 * 폼을 달면 «부르기 전에 다 정해야 한다»가 되고, 그건 사실이 아니다.
 */
export function inviteRow(r: Room): HTMLElement {
  return el(
    "div",
    { class: "invite-row" },
    el("button", {
      class: "ghost",
      text: "+ 봇 부르기",
      onclick: () => askInvite(r),
    }),
  );
}

/**
 * **부를 봇을 고른다** (v2.0).
 *
 * 예전엔 서랍 바닥에 드롭다운 하나만 두었는데, 그러면 **에이전트밖에 못
 * 고른다.** 모델과 역할은 봇에 붙는 값인데(D2·B3) 부르고 나서 따로 찾아가
 * 정하게 하는 것은 «부를 때 정하는» 방 만들기와 엇나간다.
 *
 * 그래서 **방 만들 때와 같은 모양**을 카드로 띄운다 — 새로 배울 게 없다.
 */
function askInvite(r: Room): void {
  const draft: DraftBot = newDraftBot();
  if (!configs.has(draft.agentId)) post({ t: "needConfig", agentId: draft.agentId });

  const paint = (): void => {
    const role = el("textarea", {
      class: "role",
      placeholder: "역할 (선택) — 예) 너는 코드 리뷰어다.",
    }) as HTMLTextAreaElement;
    role.value = draft.role;
    role.addEventListener("input", () => (draft.role = role.value));

    /*
     * ★ **부를 때도 이름을 정한다** — 방 만들기와 같은 자리(에이전트 바로 아래).
     *
     * 🔴 여기서 못 정하면 **부르자마자 서랍을 열어 이름부터 고치게 된다.**
     * 특히 같은 에이전트를 하나 더 부르는 경우가 그런데, 그때가 이름이 제일
     * 필요한 순간이다 — `Claude` 와 `Claude 2` 는 구별이 안 되므로.
     */
    const label = boot.agents.find((a) => a.id === draft.agentId)?.label ?? draft.agentId;
    const taken = new Set(r.participants.map((b) => b.name));
    const name = el("input", {
      type: "text",
      class: "bot-name",
      value: draft.name,
      placeholder: uniqueBotName(label, taken),
    }) as HTMLInputElement;
    const bent = el("span", { class: "dim bot-bent", hidden: true });
    const syncName = () => {
      draft.name = name.value;
      const wanted = name.value.trim();
      if (!wanted) { bent.hidden = true; return; }
      const got = uniqueBotName(wanted, taken);
      bent.hidden = got === wanted;
      bent.textContent = `«${wanted}»은(는) 이미 있어서 «${got}»이(가) 됩니다.`;
    };
    name.addEventListener("input", syncName);
    syncName();

    const card = el(
      "div",
      { class: "card" },
      el("div", { class: "card-title" }, icon("organization"), " 봇 부르기"),
      el(
        "div",
        { class: "card-body" },
        el(
          "div",
          { class: "field" },
          el("label", { text: "에이전트" }),
          /*
           * ⏪ **여기만 단추 줄이었다** (2026-10-07).
           *
           * 바로 위 `agentSelect` 에 *"에이전트는 드롭다운으로"* 라고
           * 적어두고도 **부르기 화면은 빠뜨렸다.** 색 고르기를 빠뜨렸던
           * 것과 같은 자리다(바로 아래 주석).
           *
           * 🔴 **가리는 것도 틀렸다.** `boot.agents` 를 그대로 줄 세워
           * **안 받은 에이전트까지 고를 수 있었다** — 고르게 해두고
           * 부른 뒤에 막는 꼴이다. 드롭다운은 `agentAvail` 로 거른다.
           */
          agentSelect(draft, paint),
        ),
        /*
         * ★ **부를 때도 색을 정한다** (2026-09-29).
         *
         * 🔴 방 만들기에는 넣고 **여기는 빠뜨렸다.** 그런데 색이 제일 필요한
         * 순간이 바로 여기다 — 같은 에이전트를 하나 더 부를 때. 이름과 같은
         * 자리에 둔다.
         */
        el("div", { class: "field" },
          el("label", { text: "이름 (선택)" }),
          el("div", { class: "named" },
            name,
            colorPick(draft.color || undefined, draft.ink, (css, pickedInk) => {
              draft.color = css;
              draft.ink = pickedInk;
              paint();
            })),
          bent),
        ...configFields(configs.get(draft.agentId), draft.picks),
        role,
      ),
      // 부르기 전에 **무엇을 모를지** 알려준다 (§4.1.1)
      r.messages.some((m) => m.role !== "system")
        ? el(
            "div",
            { class: "warn-row" },
            icon("warning"),
            " 새 봇은 **위 대화를 모릅니다** — 화면에는 보이지만 전달되지는 않았습니다. "
              + "필요한 것은 부른 뒤에 다시 알려주세요.",
          )
        : null,
      el(
        "div",
        { class: "card-actions" },
        el("button", { text: "취소", onclick: () => back() }),
        el("button", {
          class: "primary",
          text: "부르기",
          onclick: () => {
            post({
              t: "addBot",
              roomId: r.id,
              agentId: draft.agentId,
              ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
              ...(draft.color?.trim() ? { color: draft.color.trim() } : {}),
              ...(draft.ink ? { ink: draft.ink } : {}),
              ...(draft.role.trim() ? { rolePrompt: draft.role.trim() } : {}),
              ...(draft.picks.size > 0 ? { configValues: Object.fromEntries(draft.picks) } : {}),
            });
            // 참여자 화면으로 돌아간다 — 거기 방금 부른 봇이 늘어 있다
            back();
          },
        }),
      ),
    );

    /*
     * 화면이라 **통째로 갈아끼운다.** 에이전트를 바꾸면 아래 칸들이 다 바뀌므로
     * 어차피 다시 그리는 자리다 — 카드 시절에도 `replaceWith` 였다.
     */
    screens.invite.replaceChildren(
      el(
        "header",
        { class: "bar" },
        el("button", { class: "icon", title: "돌아가기", onclick: () => back() }, icon("arrow-left")),
        el("h1", {}, icon("organization"), " 봇 부르기"),
      ),
      card,
    );
  };
  paint();
  push("invite");
}
