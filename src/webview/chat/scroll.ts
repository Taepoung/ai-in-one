/**
 * ★ **채팅 화면 — 스크롤** · 쪽 넘기기 · 바닥 붙기.
 */
import { nodeCache } from "./paint.js";
import { el, icon, replace } from "../common/dom.js";
import { S } from "../common/state.js";

/**
 * 방을 열 때는 **안 읽은 지점**, 없으면 맨 아래 (F6).
 *
 * 스트리밍 중에는 사용자가 위로 올려 읽고 있으면 따라가지 않는다.
 */
/**
 * **대화 목록 안에서만** 스크롤한다.
 *
 * 🔴 `scrollIntoView()`를 쓰면 안 된다. 그건 **조상 컨테이너까지 전부** 스크롤하는데,
 * `html`·`body`·`#app`이 `overflow: hidden`이라 스크롤바가 없을 뿐 **스크립트로는
 * 밀린다.** 목록에서 방으로 들어가는 슬라이드가 도는 동안 부르면, 화면이 아직
 * 오른쪽에 있으므로 브라우저가 **`body`를 옆으로 밀어** 대상을 보이게 만든다.
 * 전환이 끝나도 그 스크롤은 남아서 **화면이 어긋난 채 멈춘 것처럼** 보인다.
 *
 * 실제로 목록의 계보 배지(«…에서 분기»)를 눌렀을 때 그렇게 깨졌다.
 *
 * 그래서 **`list.scrollTop`만 건드린다.** 위치는 두 사각형의 차이로 잡는데,
 * 전환 중이어도 **둘 다 같은 만큼 밀려 있으므로 차이는 정확하다.**
 */
export function scrollInside(list: HTMLElement, node: HTMLElement, place: "center" | "end"): void {
  const a = node.getBoundingClientRect();
  const b = list.getBoundingClientRect();
  const delta =
    place === "center"
      ? a.top - b.top - (list.clientHeight - a.height) / 2
      : a.bottom - b.bottom;
  list.scrollTop += delta;
}

/**
 * ★ **그 말풍선으로 간다** (2026-09-23).
 *
 * 🔴 **이미 보이면 화면을 안 움직인다.** 눌렀더니 읽던 자리가 사라졌는데 정작
 * 목적지는 원래 보이던 것 — 그게 제일 나쁘다. **깜빡임이 본체고 스크롤은
 * 필요할 때만** 따라붙는다.
 *
 * `wantBack` 은 **방 안에서 뛸 때만** 참이다. 검색 결과로 방을 **열면서**
 * 뛰는 길(H3)에는 «읽던 자리»가 없다 — 막 들어온 참이라 돌아갈 데가 없다.
 */
export function jumpTo(id: string, wantBack: boolean): void {
  const c = S.chat;
  const target = nodeCache.get(id)?.node;
  if (!c || !target?.isConnected) return;

  // 앞서 깜빡이던 것이 남아 있으면 «어느 쪽이지»가 된다 — 하나만 켠다
  c.list.querySelectorAll(".msg.jumped").forEach((old) => old.classList.remove("jumped"));

  const a = target.getBoundingClientRect();
  const b = c.list.getBoundingClientRect();
  if (a.top < b.top || a.bottom > b.bottom) {
    if (wantBack) {
      S.backTo = c.list.scrollTop;
      // **띠를 먼저 띄운다** — 띄우면 목록이 그만큼 짧아지므로, 자리는 그 뒤에 재야 맞다
      paintBack(true);
    }
    scrollInside(c.list, target, "center");
  }

  target.classList.add("jumped");
  setTimeout(() => target.classList.remove("jumped"), 1600);
}

/** «읽던 자리로» 띠를 켜고 끈다 */
export function paintBack(on: boolean): void {
  const c = S.chat;
  if (!c) return;
  if (on) {
    replace(
      c.back,
      el(
        "button",
        { class: "link", onclick: () => {
          const now = S.chat;
          if (now && S.backTo !== undefined) now.list.scrollTop = S.backTo;
          paintBack(false);
        } },
        icon("arrow-down"),
        "읽던 자리로",
      ),
    );
  } else {
    S.backTo = undefined;
  }
  c.back.hidden = !on;
}

/**
 * ★ **«맨 아래로» 를 켜고 끈다** (사용자, 2026-10-15).
 *
 * 🔴 긴 대화를 위로 훑다 보면 **바닥으로 돌아갈 길이 손가락뿐**이다 — 봇이
 * 답하는 중이면 그 사이에도 내용이 자라서 끝이 멀어진다. «읽던 자리로»와
 * 같은 자리에 같은 모양으로 둔다.
 */
export function paintDown(on: boolean): void {
  const c = S.chat;
  if (!c) return;
  /* 🔴 **«읽던 자리로»가 떠 있으면 비킨다** — 돌아갈 곳이 둘이면 안 된다 */
  const show = on && S.backTo === undefined;
  if (show && c.down.childElementCount === 0) {
    replace(
      c.down,
      el(
        "button",
        {
          class: "link",
          onclick: () => {
            const now = S.chat;
            if (!now) return;
            now.list.scrollTop = now.list.scrollHeight;
            S.stick = true;
            paintDown(false);
          },
        },
        icon("arrow-down"),
        "맨 아래로",
      ),
    );
  }
  c.down.hidden = !show;
}

export function scrollIntoPlace(list: HTMLElement): void {
  const line = list.querySelector<HTMLElement>(".unread-line");
  if (line) {
    scrollInside(list, line, "center");
    return;
  }
  if (S.stick) {
    list.scrollTop = list.scrollHeight;
    paintDown(false);
  }
}
