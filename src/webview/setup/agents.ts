/**
 * ★ **에이전트 설정 화면** — 받기 · 지우기 · 로그인.
 */
import { el, icon } from "../common/dom.js";
import { back, screens } from "../common/screens.js";
import { S, post } from "../common/state.js";

/** 바이트를 사람 글로 */
function mb(n: number): string {
  if (n <= 0) return "";
  const m = n / 1048576;
  return m >= 1024 ? (m / 1024).toFixed(1) + "GB" : m.toFixed(0) + "MB";
}

/**
 * ★ **로그인 확인 화면** (2026-10-13).
 *
 * ```
 * 확인 중…        CLI 에게 물어보는 중
 * 로그인됨 / 안 됨  답을 받았다
 * 파일로만 확인     물어볼 길이 없어 자격 파일만 봤다 (Antigravity)
 * 못 물어봤습니다   기한을 넘겼다
 * ```
 *
 * 🔴 **기한을 넘기면 사람에게 묻는다.** 조용히 넘어가면 «로그인했는데 왜
 * 안 되지» 가 나중에 터지고, 그때는 왜인지 알 길이 없다.
 */
export function renderAuth(): void {
  const host = screens.auth;
  host.replaceChildren();
  host.append(el("header", { class: "bar" }, el("h1", { text: "AI in One" })));

  const box = el("div", { class: "auth-box" });
  const asking = S.authList.some((r) => r.at === "asking");
  box.append(
    el("p", {
      class: "auth-head",
      text: asking ? "로그인을 확인하는 중입니다…" : "로그인 확인",
    }),
  );

  for (const row of S.authList) {
    const say = row.at === "asking"
      ? "확인 중…"
      : row.at === "failed"
        ? "못 물어봤습니다"
        : row.guessed
          ? (row.at === "yes" ? "로그인됨 (파일로만 확인)" : "로그인 안 됨 (파일로만 확인)")
          : (row.at === "yes" ? "로그인됨" : "로그인 안 됨");
    box.append(
      el(
        "div",
        { class: `auth-row ${row.at}` },
        el("span", {
          class: "auth-mark",
          text: row.at === "asking" ? "…" : row.at === "yes" ? "✓" : row.at === "no" ? "·" : "!",
        }),
        el("span", { class: "auth-name", text: row.label }),
        el("span", {
          class: row.at === "failed" ? "auth-say bad" : "auth-say dim",
          text: say,
        }),
      ),
    );
  }

  if (S.authStuck) {
    const stuck = S.authList.filter((r) => r.at === "asking" || r.at === "failed");
    box.append(
      el("p", {
        class: "auth-stuck bad",
        text: `${stuck.map((r) => r.label).join("·")}에서 답이 없습니다.`,
      }),
      el(
        "div",
        { class: "auth-acts" },
        el("button", {
          class: "agent-go", text: "다시 시도", onclick: () => post({ t: "authRetry" }),
        }),
        el("button", {
          class: "agent-btn", text: "그냥 들어가기", onclick: () => post({ t: "authSkip" }),
        }),
      ),
    );
  }

  host.append(box);
}

export function renderAgents(): void {
  const host = screens.agents;
  host.replaceChildren();
  host.append(
    el(
      "header",
      { class: "bar" },
      el("button", {
        class: "icon", title: "뒤로",
        onclick: () => back(),
      }, icon("arrow-left")),
      el("h1", { text: "에이전트" }),
    ),
  );

  for (const a of S.agentRows) {
    const act = (what: "install" | "remove" | "login" | "logout") =>
      post({ t: "agentDo", agentId: a.id, what });

    const head = el("div", { class: "agent-head" },
      el("span", { class: "agent-name", text: a.label }),
    );

    /* 오른쪽 끝에 판과 자리 — 받은 뒤에만 보여줄 것이 있다 */
    const facts: string[] = [];
    if (a.state === "stale") facts.push(`${a.version} → ${a.wanted}`);
    else if (a.version) facts.push(a.version);
    if (a.size > 0) facts.push(mb(a.size));
    if (facts.length) head.append(el("span", { class: "agent-facts dim", text: facts.join(" · ") }));

    const row = el("div", { class: "agent-card" }, head);

    if (!a.managed) {
      /* 사용자가 `aiInOne.agents` 로 적은 것 — 우리가 받는 게 아니다 */
      row.append(el("p", { class: "dim", text: "설정에 직접 적은 에이전트입니다." }));
      host.append(row);
      continue;
    }

    if (a.busy !== undefined) {
      row.append(el("p", { class: "agent-busy dim", text: a.busy }));
      host.append(row);
      continue;
    }

    const bar = el("div", { class: "agent-acts" });
    if (a.state === "none") {
      bar.append(el("button", { class: "agent-go", text: "설치하기", onclick: () => act("install") }));
    } else {
      if (a.state === "stale") {
        bar.append(el("button", { class: "agent-go", text: "업데이트", onclick: () => act("install") }));
      }
      if (a.loggedIn) {
        /* 길이 없으면 단추도 안 달고, 아래에 왜인지 한 줄 적는다 */
        if (a.canLogout) {
          bar.append(el("button", { class: "agent-btn", text: "로그아웃", onclick: () => act("logout") }));
        }
      } else {
        bar.append(el("button", { class: "agent-go", text: "로그인", onclick: () => act("login") }));
      }
      /* 제거는 늘 오른쪽 끝에, 빨간색으로 */
      bar.append(el("button", {
        class: "agent-btn danger", text: "제거", onclick: () => act("remove"),
      }));
    }
    row.append(bar);

    /*
     * 로그아웃할 길이 없으면 **그 사실을 말해준다.** 단추만 지우고 아무
     * 말도 안 하면 «왜 없지» 가 된다 — 안 먹는 단추와 같은 자리다.
     */
    if (a.state === "ready" && !a.canLogout) {
      row.append(el("p", { class: "dim",
        text: `「${a.label}」 의 CLI 에는 로그아웃 명령이 없습니다. `
          + `계정을 바꾸려면 그 CLI 에서 직접 해주세요.`,
      }));
    }

    /* 로그인 안 됐으면 왜 필요한지 한 줄 — 안 적으면 그냥 막힌 것처럼 보인다 */
    if (a.state === "needLogin") {
      row.append(el("p", { class: "dim",
        text: a.viaAcp
          ? "브라우저가 열립니다. 로그인을 마치면 이 화면이 알아서 바뀝니다."
          : "터미널이 열립니다. 로그인을 마치면 이 화면이 알아서 바뀝니다.",
      }));
    }
    host.append(row);
  }

  host.append(renderClean());
}

/**
 * ★ **디스크 정리** (2026-11-19) — 사용자: *"캐시 정리할 수 있는 기능 넣을 수 있나?"*
 *
 * ```
 * 받아둔 에이전트   972MB   쓰는 중 — 위에서 「제거」
 * 같이 받은 Node    107MB   쓰는 중
 * 받다·지우다 남은 것  0MB
 * npm 캐시         3.7GB   다른 프로그램도 씀    [지우기]
 * npx 캐시         6.6GB   다른 프로그램도 씀    [지우기]
 * ```
 *
 * 쓰는 중인 것도 **같이 보여준다** — 어디가 얼마나 먹나를 알아야 무엇을 지울지 고른다.
 * 그건 단추 대신 왜 못 지우는지를 적는다. 재는 것은 **누를 때만**이다(수만 개를 센다).
 */
function renderClean(): HTMLElement {
  const c = S.clean;
  const card = el("div", { class: "clean-card" },
    el("div", { class: "agent-head" }, el("span", { class: "agent-name", text: "디스크 정리" })));

  if (!c.spots) {
    card.append(
      el("p", { class: "dim", text: "에이전트와 npm 이 디스크를 얼마나 쓰는지 재고, 남은 것을 지웁니다." }),
      c.busy
        ? el("p", { class: "agent-busy dim", text: c.busy })
        : el("div", { class: "agent-acts" }, el("button", {
          class: "agent-btn", text: "얼마나 쓰나 보기", onclick: () => post({ t: "cleanAsk" }),
        })),
    );
    if (c.said) card.append(el("p", { class: "clean-said", text: c.said }));
    return card;
  }

  for (const s of c.spots) {
    const why = !s.canClean
      ? (s.id === "agents" ? "쓰는 중 · 지우려면 위에서 「제거」" : "쓰는 중")
      : s.shared ? "다른 프로그램도 씀" : "";
    const line = el("div", { class: `clean-row ${s.id}`, title: s.where },
      el("span", { class: "clean-name", text: s.label }),
      el("span", { class: "clean-size", text: mb(s.bytes) || "0MB" }),
      why ? el("span", { class: "clean-why dim", text: why }) : null,
    );
    if (s.canClean) {
      line.append(el("button", {
        class: "agent-btn", text: "지우기",
        disabled: c.busy !== undefined || s.bytes <= 0,
        onclick: () => post({ t: "cleanDo", id: s.id }),
      }));
    }
    card.append(line);
  }

  card.append(c.busy
    ? el("p", { class: "agent-busy dim", text: c.busy })
    : el("div", { class: "agent-acts" }, el("button", {
      class: "agent-btn", text: "다시 재기", onclick: () => post({ t: "cleanAsk" }),
    })));
  if (c.said) card.append(el("p", { class: "clean-said", text: c.said }));
  return card;
}
