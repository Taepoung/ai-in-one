/**
 * ★ **대기 화면** — 그 봇 앞에 서 있는 것들 (§5-M).
 */
import type { BotInstance, Room, WaitItem } from "../../core/types.js";
import { el, icon, type Kids } from "../common/dom.js";
import { back, push, screens } from "../common/screens.js";
import { S, post } from "../common/state.js";
import { shortenPath } from "../common/text.js";

/**
 * ★ **«대기 N ›» — 서랍 줄 오른쪽 끝** (§5-M, 2026-10-14).
 *
 * 🔴 **0 이면 아예 없다.** «대기 0» 을 띄우면 **아무 일도 없다는 것을 말하려고
 * 모든 줄에 자리를 하나씩 내주게** 된다 — 단체방이면 그 빈 단추가 참여자 수만큼
 * 선다. 있는 것만 보이면 **단추가 곧 알림**이다.
 */
export function waitGo(r: Room, bot: BotInstance): HTMLElement | null {
  const mine = S.waiting.filter((w) => w.botId === bot.id);
  if (mine.length === 0) return null;
  const perms = mine.filter((w) => w.kind === "permission").length;
  return el(
    "button",
    {
      class: "ghost wait-go",
      title: perms > 0
        ? `${bot.name} 앞에 ${mine.length} 개 — 그중 ${perms} 개는 승인 요청입니다`
        : `${bot.name} 앞에 ${mine.length} 개가 서 있습니다`,
      onclick: () => openWaiting(r, bot.id),
    },
    icon("inbox"),
    ` 대기 ${mine.length} `,
    icon("chevron-right"),
  );
}

/** 서랍 «위에» 얹는다 — 뒤로가기 하나로 서랍으로 돌아온다 */
function openWaiting(r: Room, botId: string): void {
  S.waitBotId = botId;
  paintWaiting(r, botId);
  push("wait");
}

/**
 * ★ **그 봇 앞에 서 있는 것들** (§5-M).
 *
 * 두 종류가 한 줄 간격으로 선다. 🔴 **할 수 있는 일이 서로 다르다:**
 *
 * ```
 * 권한    낸 봇이 **얼어 있다**  → 「유저 승인으로」 — 내 큐로 옮기고 따라간다
 * 메시지  아무도 안 기다린다     → 「버리기」 — 그 봇은 영영 안 본다
 * ```
 *
 * 권한에 「버리기」를 안 주는 이유가 그것이다 — 버리면 **낸 봇이 영영
 * 기다린다.** 둘을 같은 단추로 묶으면 그 차이가 지워진다.
 */
export function paintWaiting(r: Room, botId: string): void {
  const bot = r.participants.find((b) => b.id === botId);
  const mine = S.waiting.filter((w) => w.botId === botId);
  const keep = screens.wait.scrollTop;
  screens.wait.replaceChildren(
    el(
      "header",
      { class: "bar" },
      el("button", { class: "icon", title: "돌아가기", onclick: () => back() }, icon("arrow-left")),
      el("h1", {}, icon("inbox"), ` ${bot?.name ?? "봇"} — 대기 ${mine.length}`),
    ),
    /*
     * 🔴 **비면 화면을 닫지 않는다.** 마지막 하나를 처리한 순간 화면이 사라지면
     * «내가 뭘 한 거지» 가 된다 — 돌아가는 것은 사용자가 한다.
     */
    ...(mine.length === 0
      ? [el("div", { class: "empty", text: "대기가 없습니다." })]
      : mine.map((w) => waitRow(r, w))),
  );
  screens.wait.scrollTop = keep;
}

/** 대기 한 줄 — 누가 · 무엇을 · 내가 할 수 있는 것 */
/** 펼쳐 둔 대기 줄 — 큐가 바뀔 때마다 다시 그리므로 **기억해 둬야 산다** */
const waitOpen = new Set<string>();

function waitRow(r: Room, w: WaitItem): HTMLElement {
  const perm = w.kind === "permission";
  const box = el("details", { class: "card wait-item", open: waitOpen.has(w.id) });
  /* `append` 는 `null` 을 안 받는다 — `el` 과 달리 여기서 걸러낸다 */
  const kids: Kids = [
    el(
      "summary",
      {
        class: "card-title",
        onclick: () => {
          if (box.open) waitOpen.delete(w.id);
          else waitOpen.add(w.id);
        },
      },
      icon("chevron-right"),
      icon(perm ? "shield" : "comment"),
      ` ${w.from}의 ${perm ? "승인 요청" : "말"}`,
      el("span", { class: "wait-head", text: w.text }),
    ),
    el("div", { class: "wait-text", text: w.text }),
    // **무엇을 하려는지 그대로** — 제목만 보면 `rm -rf /` 와 `ls` 가 같다 (D1)
    w.command ? el("pre", { class: "wait-cmd" }, el("code", { text: w.command })) : null,
    ...(w.paths ?? []).map((p) =>
      el("button", {
        class: "file", text: shortenPath(p), title: "에디터에서 열기",
        onclick: () => post({ t: "openFile", path: p }),
      })),
    w.diff ? el("pre", { class: "preview" }, el("code", { text: w.diff.newText })) : null,
    el(
      "div",
      { class: "card-actions" },
      perm
        ? el("button", {
            class: "ok",
            text: "허용",
            title: "이번 한 번만 허용합니다 — 이 봇을 기다리지 않고 내가 답합니다",
            /*
             * ★ **그 자리에서 답한다** (사용자, 2026-10-14).
             *
             * ⏪ 여기 있던 것은 「유저 승인으로」 **하나**였다 — 가져오기만
             * 하고 답은 다른 자리에서. 사용자: *"펼쳐볼 수 있고 바로 승인,
             * 거절 할 수 있는게 더나을듯"*. 가져오는 것은 **우리 사정**이지
             * 사용자가 원하는 일이 아니었다.
             *
             * 🔴 **그래서 줄을 펼칠 수 있게 했다.** 안 보고 누르면 심사가
             * 아니라 도장 찍기다(D1) — 펼치면 명령·바뀌는 파일·미리보기가
             * 카드와 **같은 것**으로 나온다.
             *
             * ⚠️ 「항상 허용」은 여기 없다. 여럿을 한 번에 넘기는 자리에
             * «앞으로 전부»를 두지 않는 것과 같은 줄이다(§4.2.2).
             */
            /*
             * ★ **이 하나를 내 큐로 옮긴다** (사용자, 2026-10-14).
             *
             * 🔴 **답하는 것이 아니라 옮기는 것**이다 — 심사가 봇의 큐에서
             * 빠지고 **유저 승인 큐**에 선다. 그래서 이름이 「유저 승인으로」고,
             * 누르면 **그 큐로 따라간다**(카드가 돌아서 오므로 도착할 때).
             *
             * ⚠️ **이 요청 하나만이다.** 봇의 승인 설정은 안 바뀐다 — 다음
             * 요청은 그대로 그 봇에게 간다. 그 말이 단추에 안 들어가므로
             * **툴팁에 적는다.**
             *
             * ⏪ 두 번 돌았다: 채팅으로 내려보냈다가(줄을 비우러 온 화면에서
             * 내려갔다 올라오기를 반복하게 된다), 그 자리에 팝업으로 띄웠다가
             * (같은 물건이 두 모양이 된다). 큐에는 **큐의 자리**가 맞다.
             *
             * 🔴 [승인][거절] 두 단추로 쪼개지 않는 이유는 그대로다 — 이 줄에는
             * 제목과 명령뿐이고 **diff·바뀌는 파일·「항상 허용」은 카드에만**
             * 있다. 안 보고 누르면 심사가 아니라 도장 찍기다(D1).
             */
            onclick: () =>
              post({ t: "answerWaiting", roomId: r.id, botId: w.botId, id: w.id, allow: true }),
          })
        : el("button", {
            class: "ghost danger",
            text: "버리기",
            title: "이 봇은 이 말을 끝내 안 봅니다. 보낸 쪽 기록에는 그대로 남습니다.",
            onclick: () => post({ t: "dropWaiting", roomId: r.id, botId: w.botId, id: w.id }),
          }),
      perm
        ? el("button", {
            class: "no",
            text: "거절",
            title: "이번 한 번만 거절합니다",
            onclick: () =>
              post({ t: "answerWaiting", roomId: r.id, botId: w.botId, id: w.id, allow: false }),
          })
        : null,
    ),
  ];
  for (const k of kids) if (k) box.append(k);
  return box;
}
