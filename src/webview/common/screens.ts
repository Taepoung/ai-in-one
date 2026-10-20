/**
 * ★ **창 공통 — 화면 전환** (F8). 쌓인 화면(`S.stack`) · `go` · `push` · `back`.
 */
import { S } from "./state.js";

// ── 화면 전환 (F8) ──────────────────────────────────────────────────────

export type ScreenName =
  | "list" | "new" | "chat" | "fix" | "perm" | "bots" | "invite" | "agents"
  /** 그 봇 앞에 서 있는 것들 — 참여자 서랍 «위에» 얹는다 (§5-M) */
  | "wait"
  /** 창이 뜨자마자 로그인을 확인하는 자리 (2026-10-13) */
  | "auth"
  /** 방에 붙는 동안 서는 자리 (2026-10-13) */
  | "joining";

/**
 * 화면 칸을 찾는다. **없으면 만든다.**
 *
 * 🔴 `getElementById(...)!` 로만 두었더니 **화면을 하나 더할 때마다 열여섯 곳이
 * 깨졌다** — 호스트 HTML(`chatPanel.ts`)과 검사마다 들고 있는 셸이 전부 그
 * 목록을 따로 적고 있었기 때문이다. 하나만 빠져도 `null.classList` 로 터진다.
 *
 * **화면 목록은 웹뷰 안 사정이다.** 껍데기가 그걸 미리 알아야 할 이유가 없다.
 */
function screenEl(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const made = document.createElement("section");
  made.className = "screen";
  made.id = id;
  (document.getElementById("app") ?? document.body).append(made);
  return made;
}

export const screens: Record<ScreenName, HTMLElement> = {
  list: screenEl("screen-list"),
  /** 에이전트를 받고·지우고·로그인하는 자리 (`src/core/install/README.md`) */
  agents: screenEl("screen-agents"),
  new: screenEl("screen-new"),
  chat: screenEl("screen-chat"),
  /**
   * ★ **고른 모델이 없어졌을 때 막아서서 고르게 하는 자리** (2026-09-30).
   *
   * 띄로 띄우다가 전체화면으로 옮겼다. 띄는 **지나치기 쉬운데**, 이건
   * 지나치면 안 되는 일이다 — 대체된 모델은 **계열째 다를 수 있고**
   * (luna→terra, sonnet→opus 실측), 모르고 쓰면 답이 왜 달라졌는지를
   * 끝내 모른다.
   */
  fix: screenEl("screen-fix"),
  /**
   * ★ **권한·참여자를 시트·서랍에서 화면으로 뺀다** (2026-09-30).
   *
   * 둘 다 **덮개를 깔고 띄우는** 물건이었다. 그런데 안에 들어 있는 것이
   * «잠깐만 보고 닫는 것» 이 아니다 — 봇마다 권한 모드·승인 주체·모델·
   * 역할·색까지 들어 있어서 **세로로 길고**, 좌우로도 좀다.
   *
   * 화면으로 빼면 넓게 쓰고, 뒤로가기 하나로 나간다.
   */
  perm: screenEl("screen-perm"),
  bots: screenEl("screen-bots"),
  /**
   * ★ **대기는 서랍에서 펼치지 않고 화면으로 뺀다** (§5-M, 2026-10-14).
   *
   * 사용자: *"엄청 쌓이면서는 봇별로 엄청 많아지면 정보보기도 어렵고
   * 지저분해서 좀 힘들듯"*. 🔴 서랍 한 줄은 **봇 하나**인데, 한 봇의 대기가
   * 열 줄이면 **다른 봇이 화면 밖으로 밀린다** — 훑는 자리가 훑을 수 없게
   * 된다. 서랍에 두는 것은 **수 하나**고, 그게 곧 «여기 눌러볼 것이 있다»다.
   */
  wait: screenEl("screen-wait"),
  /**
   * ★ **봇 부르기도 화면** (2026-09-30).
   *
   * 대화 목록 안에 카드로 붙어 있었다. 🔴 **스크롤에 밀린다** — 에이전트·이름·
   * 색·모델·역할을 고르는 동안 새 말이 오면 카드가 위로 떠내려간다.
   *
   * **참여자 화면 «위에» 얹는다.** 부르고 나면 뒤로가기 하나로 참여자로
   * 돌아오고, 거기 새 봇이 늘어 있다 — 온 길과 돌아가는 길이 같다.
   */
  invite: screenEl("screen-invite"),
  /**
   * ★ **로그인 확인 — 창이 뜨는 첫 화면** (2026-10-13).
   *
   * 🔴 우리 짐작은 «자격 파일이 있나» 뿐이라 **만료 · 다른 데서 로그아웃 ·
   * 철회**를 하나도 못 본다. 그걸 모른 채 들어가면 긴 글을 다 쓰고 **보낼
   * 때** 막히고, 그때 뜨는 것은 CLI 원문이다.
   */
  auth: screenEl("screen-auth"),
  /**
   * ★ **방에 붙는 동안** (2026-10-13).
   *
   * 🔴 여태 채팅이 **바로** 열리고 뒤에서 붙었다. 그래서 셋이 어긋났다:
   *
   * ```
   * 쓸 수 있는 것처럼 보인다   아직 세션이 없는데 입력창이 열려 있다
   * 실패가 기록에 박힌다       「세션을 열지 못했습니다」 가 말풍선이 된다
   * 보다가 끌려간다            modelGone 이 붙으면 fix 로 넘어간다
   * ```
   *
   * 붙는 동안을 **따로 세우면** 셋이 한꺼번에 사라진다. 지난 대화를 읽으려고
   * 들어온 사람에게는 **다른 길**이 있다 — 목록에서 우클릭 「기록만 읽기」.
   */
  joining: screenEl("screen-joining"),
};

/**
 * 화면을 민다.
 *
 * 목록은 **뒤에 남아 있다** — 사라졌다 나타나면 앱이 아니라 페이지 이동처럼 보인다.
 */
export function go(name: ScreenName): void {
  if (S.stack[S.stack.length - 1] === name) return;
  S.stack = name === "list" ? ["list"] : ["list", name];
  paintScreens();
}

/**
 * ★ **위에 얹는다 — 뒤로 가면 아래가 나온다** (2026-09-30).
 *
 * `go` 는 늘 `["list", 이름]` 으로 **갈아끼운다.** 화면이 셋뿐일 때는 그걸로
 * 됐다 — 목록에서 방으로, 방에서 목록으로.
 *
 * 🔴 **권한·참여자를 화면으로 빼면서 어긋났다.** 채팅에서 권한을 열고 닫으면
 * 채팅으로 돌아와야 하는데, `go("perm")` 은 스택에서 채팅을 **지워버린다** —
 * 뒤로가기가 목록으로 가고, 돌아올 때도 «앞으로 가는» 것처럼 미끄러진다.
 *
 * 얹으면 `["list", "chat", "perm"]` 이 되고, `back()` 하나로 채팅이 제자리에
 * 돌아온다(`.behind` 였다가 `.active` 로). 애니메이션도 뒤로 가는 모양이 된다.
 */
export function push(name: ScreenName): void {
  if (S.stack[S.stack.length - 1] === name) return;
  // 같은 화면이 스택에 둘이면 «뒤로» 가 어디로 갈지 모호해진다
  S.stack = [...S.stack.filter((s) => s !== name), name];
  paintScreens();
}

export function back(): void {
  if (S.stack.length <= 1) return;
  S.stack = S.stack.slice(0, -1);
  paintScreens();
}

export function paintScreens(): void {
  /*
   * ★ **확인 화면은 돌아갈 자리가 아니다** (2026-10-14).
   *
   * 창이 뜰 때 `stack = ["auth"]` 로 시작한다. 그 위에 로봇 화면을 얹으면
   * `["auth","agents"]` 가 되는데, 🔴 **뒤로가기가 끝난 로딩 화면으로**
   * 돌아간다 — 거기엔 나갈 길이 없다. 그리고 확인 화면이 `behind`(-24%)로
   * 남아 **왼쪽으로 다 안 빠진 것처럼** 보인다(사용자가 짚은 그것).
   *
   * 떠나는 순간 **목록을 바닥으로** 깔아준다. 한 자리에서만 하므로 새 길이
   * 생겨도 빠뜨릴 데가 없다.
   */
  if (S.stack.length > 1 && S.stack.includes("auth")) {
    S.stack = ["list", ...S.stack.filter((s) => s !== "auth" && s !== "list")];
  }
  const top = S.stack[S.stack.length - 1]!;
  for (const [name, el] of Object.entries(screens) as Array<[ScreenName, HTMLElement]>) {
    el.classList.toggle("active", name === top);
    el.classList.toggle("behind", name !== top && S.stack.includes(name));
  }
  // 첫 페인트에 심어둔 표시를 걷어낸다 — 이제 클래스가 위치를 정한다.
  // 🔴 **둘 다 걷는다** — 확인 화면으로 열릴 때는 그쪽에 붙어 있다
  screens.list.removeAttribute("data-active");
  screens.auth.removeAttribute("data-active");
}
