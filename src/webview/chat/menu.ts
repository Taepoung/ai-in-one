/**
 * ★ **채팅 화면 — 머리 메뉴** · 방 정보 · 사용량 · 이름 바꾸기 · 나가기.
 */
import type { BotInstance, QuotaLine, Room } from "../../core/types.js";
import { openRoom, renderChat } from "./chat.js";
import { childrenOf, forkInfoRows } from "./fork.js";
import { scrollInside } from "./scroll.js";
import { el, icon, type Kids } from "../common/dom.js";
import { closeModal, showModal } from "../common/modal.js";
import { back, push, screens } from "../common/screens.js";
import { S, post } from "../common/state.js";
import { paintDrawer } from "../drawer/drawer.js";

// ── 메뉴 ────────────────────────────────────────────────────────────────

/** 방마다 받아 둔 기록 파일 경로 — 방 정보를 다시 열면 먼저 세운다 */
const roomFiles = new Map<string, string>();

/** 호스트가 경로를 답했다 — 떠 있는 방 정보가 그 방이면 채운다 */
export function gotRoomFile(roomId: string, path: string): void {
  roomFiles.set(roomId, path);
  if (S.room?.id !== roomId) return;
  const at = document.querySelector(".room-file");
  if (at) at.textContent = path;
}

export function toggleMenu(e: Event, r: Room): void {
  e.stopPropagation();
  const existing = screens.chat.querySelector(".menu");
  if (existing) {
    existing.remove();
    return;
  }

  const close = () => screens.chat.querySelector(".menu")?.remove();
  const item = (text: string, onclick: () => void, cls = "") =>
    el("button", { class: cls, text, onclick: () => (close(), onclick()) });


  const menu = el(
    "div",
    { class: "menu" },
    // 🔴 **⋮는 마지막 서랍이 아니다.** 한때 모델·압축·분기·계보가 전부 여기
    // 있었는데, 그것들에게 **제 자리가 생기면서** 둘 다 가진 항목이 됐다 — 같은 걸
    // 두 군데 두면 «어디서 하는 게 맞지»만 남는다. 모델·압축은 서랍으로, 분기는
    // 헤더로, 계보는 방 정보로 갔다. 여기 남는 것은 **방에 대한 설정·정보·끝내기**뿐.
    item("이름 바꾸기", () => startRename(r)),
    item("방 정보", () => showRoomInfo(r)),
    el("hr"),
    item("방 나가기 (세션도 삭제)", () => confirmLeave(r), "danger"),
  );

  screens.chat.append(menu);
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

/**
 * 방 정보 (B12).
 *
 * 방을 만들 때 정한 것들은 나중에 잊어버린다 — 어느 디렉터리인지, 역할을 뭐라 줬는지.
 * 역할은 여기서 고칠 수 있어야 한다: 바꾸면 **다음 프롬프트부터** 반영된다.
 */
/**
 * 세션 id 줄 (B12).
 *
 * **왜 보여주나** — 세션이 끊기거나 이상할 때, 이 id가 있어야 사용자가
 * 직접 확인할 수 있다. `claude --resume <id>`로 터미널에서 열어볼 수도 있고,
 * 에이전트가 남긴 기록 파일을 찾을 수도 있다. **우리 말만 믿게 하지 않는다**(§0).
 *
 * 아직 말을 안 건 세션은 **되살릴 수 없다**(첫 프롬프트 때 디스크에 남는다).
 * 그 사실을 같이 적어야 «왜 복구가 안 되지»에서 헤매지 않는다.
 */
export function sessionRow(bot: BotInstance | undefined): HTMLElement | null {
  if (!bot?.sessionId) return null;

  const id = el("span", { class: "session-id", text: bot.sessionId, title: "눌러서 복사" });
  id.addEventListener("click", () => {
    void navigator.clipboard.writeText(bot.sessionId!).then(
      () => {
        const before = id.textContent;
        id.textContent = "복사했습니다";
        setTimeout(() => (id.textContent = before), 1000);
      },
      () => undefined,
    );
  });

  return el(
    "div",
    { class: "info-row" },
    el("span", { class: "dim", text: "세션" }),
    el(
      "span",
      {},
      id,
      bot.sessionPrompted
        ? null
        : el("span", { class: "dim", text: " · 아직 대화 전이라 복구 대상이 아닙니다" }),
    ),
  );
}

/**
 * 방 정보 (B12) — **방에 대한 것만**.
 *
 * 참여자 서랍과 **섞지 않는다.** 한때 서랍 머리에 얹어봤는데, 서랍은 *"이 봇이
 * 뭘 쓰고 얼마나 찼나"* 를 보러 오는 곳이라 그 앞에 방 정보가 쌓이면 **정작
 * 보러 온 봇이 아래로 밀린다.** 찾는 것이 다르면 자리도 달라야 한다.
 *
 * | 여기 | 서랍 |
 * |---|---|
 * | 작업 디렉터리 · 만든 때 · 계보 | 봇 · 모델 · 컨텍스트 · 권한 · 압축 · 역할 · 세션 |
 * | 방을 만들 때 정해진 것 | 지금 이 봇이 어떤 상태인가 |
 */
function showRoomInfo(r: Room): void {
  const row = (label: string, value: string) =>
    el("div", { class: "info-row" }, el("span", { class: "dim", text: label }), el("span", { text: value }));

  // 계보 — 어디서 갈라져 나왔고 무엇이 갈라져 나갔나 (D3)
  const kids = childrenOf(r.id);
  const lineage: Kids = [];
  if (kids.length > 0) {
    const links = el("span", { class: "forks" });
    for (const k of kids) {
      const one = el("span", { class: "link-ish", text: k.title, title: "그 방으로" });
      one.addEventListener("click", () => openRoom(k.id));
      links.append(one);
    }
    lineage.push(
      el("div", { class: "info-row" }, el("span", { class: "dim", text: `분기 ${kids.length}개` }), links),
    );
  }

  /*
   * ★ **저장 위치** (사용자, 2026-10-20). 경로는 호스트만 안다 — 물어서 채운다
   * (`roomFileAsk` → `roomFile`). 받아 둔 것이 있으면 먼저 세운다.
   *
   * 🔴 **열지 않고 «폴더에서 보기»** 다. 방이 열려 있는 동안 우리가 줄을 덧붙이므로
   * 손으로 고치면 깨지거나 덮인다. 그리고 그 파일 하나가 방의 전부가 아니다 —
   * 첨부·변경 원문은 옆의 `blobs` 를 모든 방이 같이 쓴다. 그 둘을 한 줄로 적어 둔다.
   */
  const where = el("span", { class: "room-file", text: roomFiles.get(r.id) ?? "…" });
  post({ t: "roomFileAsk", roomId: r.id });
  const fileRow = el(
    "div",
    { class: "info-row" },
    el("span", { class: "dim", text: "저장 위치" }),
    el("span", {},
      where,
      el("button", {
        class: "link-ish", type: "button", text: " 폴더에서 보기",
        onclick: () => post({ t: "revealRoomFile", roomId: r.id }),
      }),
      el("div", {
        class: "dim room-file-note",
        text: "첨부·변경 원문은 옆의 blobs 폴더에 모든 방이 같이 둡니다. 손으로 고치면 깨질 수 있습니다.",
      }),
    ),
  );

  const card = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title" }, icon("info"), " 방 정보"),
    el(
      "div",
      { class: "card-body info" },
      row("작업 디렉터리", r.cwd),
      fileRow,
      row("만든 때", new Date(r.createdAt).toLocaleString()),
      ...(r.forkedFromRoomId ? forkInfoRows(r) : []),
      ...lineage,
    ),
    el(
      "div",
      { class: "card-actions" },
      el("button", { text: "닫기", onclick: () => closeModal() }),
      // 봇에 대한 것을 찾아 여기까지 온 사람을 **되돌려 보내지 않는다**
      el("button", { text: "참여자 보기", onclick: () => (closeModal(), paintDrawer(r), push("bots")) }),
    ),
  );

  /*
   * ★ **방 정보는 팔업이다** — 대화에 붙이지 않는다.
   *
   * 대화 아래에 붙는 카드들(승인·분기 다이얼로그)는 **답할 때까지 눈에
   * 보여야 하는 것**이라 거기 있는다. 방 정보는 반대다 — 보고 닫는 것이고,
   * 대화에 끼어들면 스크롤에 밀려 사라지고 기록처럼 보이기까지 한다.
   */
  showModal(card);
}

/**
 * ★ **구독 잔량 팝업** (사용자, 2026-10-19).
 *
 * 🔴 **대화를 안 건드린다.** 잔량은 어댑터의 슬래시 명령으로만 알 수 있는데
 * (`docs/SLASH.md`), 그걸 방으로 보내면 읽던 대화에 말풍선이 둘 남는다.
 * 저쪽은 조회용 세션을 따로 열고 닫는다 — 모델도 그 턴을 기억하지 않는다.
 *
 * ⚠️ **열자마자 안 묻는다.** 들고 있는 것이 있으면 그걸 먼저 보여주고,
 * 새로 받는 것은 **새로고침을 눌렀을 때**다. 열 때마다 물으면 팝업을 두 번
 * 여는 것만으로 세션이 둘 뜬다.
 */
export function openQuota(r: Room): void {
  showModal(quotaCard(r));
  if (S.quota === null) askQuota(r);
}

function askQuota(r: Room): void {
  S.quotaBusy = true;
  post({ t: "quotaAsk", roomId: r.id });
  paintQuota();
}

/**
 * ★ **그 에이전트만 다시 받는다** (사용자, 2026-10-20).
 *
 * 하나가 비어 왔다고 멀쩡한 둘까지 다시 깨울 까닭이 없다 — 한 번에 20초씩
 * 들고, 조회용 세션도 그만큼 뜬다. 다른 줄은 받아 둔 그대로 서 있다.
 */
function askQuotaOf(r: Room, agentId: string): void {
  S.quotaBusyFor.add(agentId);
  post({ t: "quotaAsk", roomId: r.id, agentId });
  paintQuota();
}

/** 떠 있는 팝업만 갈아끼운다 — 열려 있지 않으면 아무 일도 안 한다 */
export function paintQuota(): void {
  const old = document.querySelector(".quota-card");
  if (!old || !S.room) return;
  old.replaceWith(quotaCard(S.room));
}

/**
 * 호스트가 뜯어 보낸 한도를 **막대 줄**로 세운다. 빈 배열이면 **아무것도 안
 * 세운다** — 그 자리는 아래 «받은 글» 이 받아준다.
 *
 * ★ **화면은 뜯지 않는다** (리팩토링 ③, 2026-10-20). «쓴 양이냐 남은 양이냐» 는
 * 에이전트마다 반대인데, 그걸 아는 것은 애드온이다 — 화면은 에이전트를 몰라야
 * 한다(`src/agents/README.md`). 그래서 `line.left` 는 **이미 «남은 양»** 이다.
 */
/**
 * 리셋까지 남은 시간을 한 줄로 — `42분 뒤` · `3시간 12분 뒤` · `2일 5시간 뒤`.
 *
 * 하루가 넘으면 분은 버린다 — 주간 한도에서 «6일 23시간 41분» 은 읽히지 않는다.
 * 지났으면 그렇다고 말한다: 받은 뒤 시간이 흘렀다는 뜻이라 다시 받으면 찬 값이 온다.
 */
export function untilRefill(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return "다시 찼을 시각입니다 — 다시 받으면 새 값이 옵니다";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min}분 뒤 다시 찹니다`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return `${h}시간${m ? ` ${m}분` : ""} 뒤 다시 찹니다`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}일${hh ? ` ${hh}시간` : ""} 뒤 다시 찹니다`;
}

function quotaBars(lines: readonly QuotaLine[]): HTMLElement[] {
  return lines.map((line) => {
    const left = line.left;
    return el(
      "div",
      { class: "quota-bar" },
      el(
        "div",
        { class: "quota-bar-head" },
        el("span", { class: "quota-bar-name", text: line.label }),
        el("span", { class: "quota-bar-num", text: `${Math.round(left)}% 남음` }),
      ),
      el(
        "div",
        { class: "quota-track" },
        /*
         * ⚠️ **적게 남았을 때 눈에 띄어야 한다.** 20% 아래를 가른다 —
         * 색만으로 말하지 않으려고 수를 **늘 옆에 적어둔다**(C9).
         */
        el("div", {
          class: `quota-fill${left <= 20 ? " low" : ""}`,
          style: { width: `${left}%` },
        }),
      ),
      /*
       * ★ **«몇 시간 뒤» 로 말한다** (사용자, 2026-11-18): *"언제 다시 차는지가 아니라
       * 몇시간 후 이렇게는 못보여주려나"*. 셈은 **그릴 때** 한다 — 받아둔 것을 나중에
       * 다시 열어도 맞는다. 원문은 툴팁에 남긴다. 애드온이 못 읽은 모양이면 원문 그대로다.
       */
      ...(line.resetsAt !== undefined
        ? [el("div", { class: "quota-at", text: untilRefill(line.resetsAt), title: line.resets ?? "" })]
        : line.resets
          ? [el("div", { class: "quota-at", text: `${line.resets} 에 다시 찹니다` })]
          : []),
    );
  });
}

function quotaCard(r: Room): HTMLElement {
  /** 이 방이 쓰는 에이전트만 — 잔량은 계정에 붙지 방에 붙지 않는다 */
  const mine = [...new Set(r.participants.map((b) => b.agentId))];
  const rows = mine.map((id) => {
    const got = S.quota?.find((q) => q.agentId === id);
    const label = S.agentRows.find((a) => a.id === id)?.label ?? id;
    /** 이 줄만 다시 받는 중인가 — 전체 새로고침 중이면 지난 것을 세워 둔다 */
    const mineBusy = S.quotaBusyFor.has(id);
    /** ★ 줄마다 다시 받기 — 받는 중에는 못 누른다 */
    const retry = el("button", {
      class: "icon quota-retry",
      title: `${label}만 다시 받기`,
      disabled: S.quotaBusy || mineBusy,
      onclick: () => askQuotaOf(r, id),
    }, icon("refresh"));
    if ((S.quotaBusy && !got) || mineBusy) {
      return el("div", { class: "quota-row" },
        el("div", { class: "quota-name" }, label),
        el("div", { class: "quota-why" }, "받는 중…"));
    }
    if (!got) {
      return el("div", { class: "quota-row" },
        el("div", { class: "quota-name" }, label, retry),
        el("div", { class: "quota-why" }, "아직 안 받았습니다"));
    }
    return el("div", { class: "quota-row" },
      el("div", { class: "quota-name" }, label,
        el("span", { class: "sub", text: got.cmd ? ` /${got.cmd}` : "" }), retry),
      /*
       * ★ **뜯은 것은 더하기만 한다** (사용자, 2026-10-19).
       *
       * 🔴 모양은 저쪽 판이 바뀌면 같이 바뀌므로 애드온의 파서는 **언젠가
       * 반드시 틀린다.** 그래서 받은 글을 **버리지 않고 접어서** 들고
       * 있는다 — 막대가 안 서면 한 번 더 눌러 진짜 글을 본다. 잃는 것이
       * «막대» 뿐이면 틀려도 괜찮은 기능이 된다.
       */
      ...quotaBars(got.lines ?? []),
      got.text
        ? el(
            "details",
            { class: "quota-raw" },
            el("summary", { text: "받은 글" }),
            el("pre", { class: "quota-text", text: got.text }),
          )
        // 비었으면 호스트가 까닭을 적어 보낸다(`quotaOf`) — 이 글은 그마저 없을 때뿐이다
        : el("div", { class: "quota-why" }, got.why ?? "받은 글이 없습니다"),
      el("div", { class: "quota-at", text: `${new Date(got.at).toLocaleTimeString()} 기준` }));
  });

  return el(
    "div",
    { class: "card quota-card" },
    el("div", { class: "card-title" }, icon("pulse"), " 사용량"),
    el("div", { class: "card-body" }, ...rows),
    el(
      "div",
      { class: "card-actions" },
      el("button", { text: "닫기", onclick: () => closeModal() }),
      /* 강조는 **권하는 쪽**이 맨 오른쪽 — 여기서는 다시 받아오는 것이다 */
      el("button", {
        class: "primary",
        text: S.quotaBusy ? "받는 중…" : "새로고침",
        disabled: S.quotaBusy,
        onclick: () => askQuota(r),
      }),
    ),
  );
}

/**
 * ★ **한 줄 소개 — «하는 일»** (v3.0 4-K).
 *
 * 다른 봇들이 받는 명단 표의 한 칸이다. 비면 **칸이 빈다** — «(설명 없음)»
 * 같은 글자를 안 쓴다. 표에서는 빈 칸이 «없다»를 이미 말해준다.
 *
 * 🔴 **이름만으로는 «누구에게 넘길까»를 못 고른다.** 「리뷰어」는 우연히 역할을
 * 말해주지만 「알파·베타」로 지었으면 아무것도 안 알려준다.
 *
 * 저장은 **포커스를 뗄 때**다. 한 줄짜리라 단추를 하나 더 두면 그 단추가 글보다
 * 크다 — 역할이 단추를 갖는 것은 **여러 줄이고 길게 고치는 것**이기 때문이다.
 */
export function blurbRow(r: Room, bot: BotInstance): HTMLElement {
  const box = el("input", {
    type: "text",
    class: "blurb",
    value: bot.blurb ?? "",
    placeholder: "예: 코드를 쓰고 고친다 — 다른 봇에게 이렇게 보입니다",
    title: "이 방의 다른 봇들이 받는 명단에 그대로 적힙니다.",
  }) as HTMLInputElement;
  const commit = () => {
    if ((bot.blurb ?? "") === box.value.trim()) return;
    post({ t: "setBlurb", roomId: r.id, blurb: box.value.trim(), botId: bot.id });
  };
  box.addEventListener("blur", commit);
  box.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") box.blur();
  });
  return el(
    "div",
    { class: "info-row blurb-row" },
    el("span", { class: "dim", text: "하는 일" }),
    box,
  );
}

/**
 * 역할 편집기 — **봇마다**.
 *
 * 역할은 첫 프롬프트 앞에 붙는 프리픽스라(B3) 세션에 갇힌다 — 즉 **봇의
 * 것이다.** 실측해보니 같은 폴더의 다른 세션으로 새지 않았다(§13.2).
 * 기억과 달리 역할은 봇마다 나눠 줄 수 있다 — 그래서 여기 놓는다.
 */
export function roleEditor(r: Room, bot: BotInstance, more: Kids = []): HTMLElement {
  const box = el("textarea", {
    class: "role",
    placeholder: "역할 없음. 적으면 다음 프롬프트부터 반영됩니다.",
  }) as HTMLTextAreaElement;
  box.value = bot.rolePrompt ?? "";

  const save = el("button", {
    class: "primary",
    text: "역할 저장",
    onclick: () => {
      post({ t: "setRole", roomId: r.id, rolePrompt: box.value.trim(), botId: bot.id });
      save.textContent = "저장됨";
    },
  });
  /*
   * **역할 저장이 맨 오른쪽**이고 나머지는 왼쪽에 붙는다 — 역할은 «지금 쓴
   * 것을 확정»하는 것이라 입력 바로 다음이고, 나머지는 그 봇에 대한 다른 일이다.
   */
  return el(
    "div",
    { class: "role-edit" },
    box,
    el("div", { class: "card-actions role-acts" }, ...more, el("span", { class: "gap" }), save),
  );
}

function startRename(r: Room): void {
  const h1 = screens.chat.querySelector("h1");
  if (!h1) return;

  const input = el("input", { type: "text", value: r.title }) as HTMLInputElement;
  // 입력을 먼저 걷어내야 한다 — 이게 남아 있으면 `paintChat`이 헤더를 건너뛴다
  const restore = () => {
    input.remove();
    renderChat();
  };
  const commit = () => {
    const title = input.value.trim();
    const changed = title && title !== r.title;
    restore();
    if (changed) post({ t: "rename", roomId: r.id, title });
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) commit();
    if (e.key === "Escape") restore();
  });
  input.addEventListener("blur", commit);
  h1.replaceChildren(input);
  input.focus();
  input.select();
}

function confirmLeave(r: Room): void {
  const node = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title", text: `«${r.title}» 방을 나갈까요?` }),
    el("div", {
      class: "dim",
      text: "대화 기록과 에이전트 쪽 세션이 함께 지워집니다. 되돌릴 수 없습니다.",
    }),
    el(
      "div",
      { class: "card-actions" },
      el("button", { text: "취소", onclick: () => renderChat() }),
      el("button", {
        class: "primary",
        text: "나가기",
        onclick: () => {
          post({ t: "leave", roomId: r.id });
          S.room = null;
          S.chat = null;
          back();
        },
      }),
    ),
  );
  const host = screens.chat.querySelector<HTMLElement>(".messages");
  host?.append(node);
  if (host) scrollInside(host, node, "end");
}
