/**
 * ★ **webview 진입점** — 이벤트 연결 · 확장에서 오는 것 · 키보드 · 부팅.
 *
 * 최상위에서 «바로 도는» 문장은 여기만 있다 — 다른 모듈은 선언뿐이라 어떤
 * 차례로 읽혀도 같다. 아래 순서는 옮기기 전 한 파일일 때의 순서 그대로다.
 */
import type { ToWebview } from "../protocol.js";
import { paintClashes } from "./chat/approvals.js";
import {
  attachFiles,
  blobCache,
  blobWaiters,
  capsBy,
  noticeInChat,
  paintChips,
} from "./chat/attach.js";
import { leaveChat, renderChat } from "./chat/chat.js";
import { paintSendButton, paintStaged, putTokens } from "./chat/compose.js";
import { closeFind, openFind } from "./chat/find.js";
import { gotRoomFile, paintQuota } from "./chat/menu.js";
import { applyDelta, paintChat } from "./chat/paint.js";
import { jumpTo, paintBack, paintDown } from "./chat/scroll.js";
import { el } from "./common/dom.js";
import { back, go, paintScreens, push, screens } from "./common/screens.js";
import {
  PAGE,
  S,
  agentAvail,
  boot,
  cards,
  configErrors,
  configKey,
  configs,
  dropCard,
  post,
  statuses,
} from "./common/state.js";
import { paintDrawer } from "./drawer/drawer.js";
import { paintWaiting } from "./drawer/wait.js";
import {
  joined,
  loginAsked,
  needsModel,
  renderFix,
  renderJoining,
  repaintBlock,
  retryAfterLogin,
  roomGo,
} from "./join/join.js";
import { filterEl, onlyHereEl, renameInList, renderList, roomsEl } from "./list/list.js";
import { filteredMetas, onFilterInput } from "./list/search.js";
import { openNewRoom, renderNew } from "./new/new.js";
import { paintPermissionSheet } from "./perm/perm.js";
import { renderAgents, renderAuth } from "./setup/agents.js";

// 첫 페인트는 HTML의 `data-active`가 잡고 있었다. 이제 스택이 이어받는다.
paintScreens();

document.getElementById("btn-new")!.addEventListener("click", () => openNewRoom());

document.getElementById("btn-agents")!.addEventListener("click", () => {
  post({ t: "agentsAsk" });
  /*
   * **답이 오기 전에 한 번 그린다.** 설정을 읽고 자리 크기를 세는 데
   * 잠시 걸리는데, 그동안 **헤더도 없는 빈 화면**이면 뒤로 갈 길조차
   * 안 보인다. 머리말을 먼저 세우고 칸은 답이 오면 채운다.
   */
  renderAgents();
  push("agents");
});

filterEl.addEventListener("input", () => onFilterInput(filterEl.value));

onlyHereEl.addEventListener("click", () => {
  S.onlyHere = !S.onlyHere;
  onlyHereEl.setAttribute("aria-pressed", String(S.onlyHere));
  renderList();
});

filterEl.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  filterEl.value = "";
  onFilterInput("");
});

// 파일 탐색기에서 끌어다 놓기 (I2)
screens.chat.addEventListener("dragover", (e) => {
  e.preventDefault();
  screens.chat.classList.add("dropping");
});

screens.chat.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) screens.chat.classList.remove("dropping");
});

screens.chat.addEventListener("drop", (e) => {
  e.preventDefault();
  screens.chat.classList.remove("dropping");
  if (!S.room) return;

  // VSCode 탐색기에서 끌고 오면 바이트가 아니라 **경로**가 온다.
  // 그대로 셀에 넘겨야 워크스페이스 안 파일로 알아보고 경로만 보낸다 (I4).
  const uris = e.dataTransfer?.getData("text/uri-list") ?? "";
  const paths = uris
    .split(/\r?\n/)
    .filter((line) => line.startsWith("file:"))
    .map((line) => decodeURIComponent(line.replace(/^file:\/\/\/?/, "")));
  if (paths.length > 0) {
    post({ t: "attachPaths", roomId: S.room.id, paths });
    return;
  }

  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length > 0) void attachFiles(S.room.id, files);
});

screens.chat.addEventListener(
  "scroll",
  (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("messages")) return;
    S.stick = t.scrollHeight - t.scrollTop - t.clientHeight < 60;
    // 손으로 바닥까지 내려왔으면 **이미 돌아온 것**이다 — 띠가 남아 있을 이유가 없다
    if (S.stick && S.backTo !== undefined) paintBack(false);
    /*
     * 🔴 **조금 올라간 것으로는 안 띄운다.** 한 줄 읽으려고 손가락을 굴린
     * 자리에 단추가 뜨면 **읽는 것을 가린다.** 한 화면쯤 올라가야 «돌아갈
     * 길»이 뜻이 생긴다.
     */
    paintDown(t.scrollHeight - t.scrollTop - t.clientHeight > t.clientHeight * 0.5);
    /*
     * ★ **위에 닿으면 저절로 백 개 더** (사용자, 2026-10-15) — *"그 100개까지
     * 다다르면 다시 100개 로딩해오는거지?"*.
     *
     * 띠는 그대로 둔다 — **눌러서도** 되는 것이 분명해야 «왜 멈췄지»가 안
     * 생기고, 저절로 이어지는 것은 그 위에 얹힌 편의다.
     *
     * ⚠️ **자리를 지킨다.** 위로 백 개가 끼어들면 읽던 줄이 화면 밖으로
     * 밀려난다 — 바닥에서 잰 거리를 그대로 되돌려 놓는다(띠를 누를 때와
     * 같은 셈법).
     */
    if (t.scrollTop < 40 && S.room && t.querySelector(".more-up")) {
      const keep = t.scrollHeight - t.scrollTop;
      S.shownCount += PAGE;
      paintChat(S.room);
      const now = S.chat;
      if (now) now.list.scrollTop = now.list.scrollHeight - keep;
    }
  },
  true,
);

// ── 확장에서 오는 것 ────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.t) {
    case "metas":
      S.metas = m.rooms;
      renderList();
      break;

    case "room": {
      const switching = S.room?.id !== m.room.id;
      // 🔴 심사 줄은 **방마다**다. 안 비우면 옆 방 것이 여기 붙는다.
      // 치워둔 글도 방을 갈아타면 보여줄 자리가 없다 — 그 방으로 돌아가면 다시 뜬다.
      /* 🔴 **창도 되돌린다** — 안 그러면 옆 방에서 편 만큼 여기서도 펴진다 */
      // 봇 상태도 비운다 — 옆 방 것을 들고 있으면 «답하는 중» 으로 잘못 막는다(바로 뒤에 새 값이 온다)
      if (switching) { S.reviews = []; S.waiting = []; S.waitBotId = null; S.shownCount = PAGE; S.botStatus = {}; }
      S.room = m.room;
      S.usage = m.room.usage;
      S.compactable = m.compactable;
      S.compactableBots = m.compactableBots ?? [];
      // 구분선은 방에 **들어올 때 한 번만** 잡는다. 스트리밍마다 다시 그으면 화면이 튄다.
      if (switching) {
        S.firstUnreadId = m.firstUnreadId;
        S.stick = true;
      }
      renderChat();

      /*
       * ★ **모델이 없어진 봇이 있으면 채팅 대신 고르기 화면으로** (2026-09-30).
       *
       * 방을 여는 순간 갈린다. `renderChat()` 은 위에서 그대로 돌려둔다 —
       * 고르고 나면 바로 그 방으로 들어가야 하므로 뒤에 준비돼 있어야 한다.
       *
       * 고르면 코어가 `modelGone` 을 지우고 방을 다시 내보낸다. 그때 이 자리가
       * **다시 돌아** 남은 봇이 없으면 채팅으로 넘긴다 — 봇이 여럿이면 하나씩
       * 지워지다가 마지막에 열린다.
       */
      /*
       * ★ **붙는 화면을 지나야 채팅이다** (2026-10-13).
       *
       * 🔴 여태 채팅이 먼저 열리고 뒤에서 붙었다. 그래서 **처음 쓰는 방에서
       * 모델이 없어졌으면 보던 채팅에서 끌려갔다** — `modelGone` 은 세션이
       * 열려야 정해지기 때문이다. 붙는 것을 앞에 세우면 판정이 **채팅을
       * 보여주기 전에** 끝난다.
       */
      if (S.stack[S.stack.length - 1] === "joining") {
        /*
         * 붙이는 일이 **이미 끝났다고** 들었으면 그대로 넘어간다.
         *
         * ★ 걸린 봇이 있어도 여기로 온다 (2026-10-13) — 아래 `needsModel` 이
         * 같이 센다. **다시 붙어보는 길이 여기로 돌아온다**: `retryJoin` 은
         * `joinDone` 을 다시 내지 않고(방은 이미 붙은 방이다) 끝에 방만
         * 내보내므로, 되면 채팅 · 또 걸리면 `fix` 를 **이 한 자리가** 가른다.
         */
        if (!joined.has(m.room.id)) { renderJoining(m.room); break; }
      }

      /* 붙는 화면에서도 여기로 빠진다 — 다 붙었고 막을 것도 없으면 채팅이다 */
      repaintBlock(m.room);

      /*
       * **방을 만들었으면 들어간다.** 생성 응답은 방 데이터만 주므로,
       * 화면 전환은 여기서 해야 한다 — 안 하면 만들기 화면에 그대로 선다.
       *
       * ★ **붙는 화면을 거친다** (사용자, 2026-10-15): *"새로운 방 만들때,
       * 방 진입시 로딩화면이 안뜨음, 같은 과정이 되어야될거 같은데"*.
       *
       * 🔴 만든 방도 **세션을 붙이는 것은 마찬가지**다(Antigravity 는 17초가
       * 걸린다). 그동안 빈 대화창에 서 있으면 «다 된 것» 으로 보여 글을 치게
       * 되고, 그 한 마디는 봇이 아직 없어서 **줄에 서 있다가 나중에 간다.**
       * 들어가는 길이 둘인데 모양이 다른 것도 그 자체로 헷갈림이다.
       */
      if (S.stack[S.stack.length - 1] === "new") {
        if (joined.has(m.room.id)) go("chat");
        else { renderJoining(m.room); go("joining"); }
      }
      if (S.jumpToMessageId) {
        // 막 들어온 참이라 «읽던 자리»가 없다 — 띠를 안 띄운다
        jumpTo(S.jumpToMessageId, false);
        S.jumpToMessageId = undefined;
      }
      break;
    }

    case "msg":
      // 다른 방의 응답이면 목록이 `metas`로 따로 갱신된다. 여기서는 무시.
      if (S.room?.id === m.roomId) {
        if (m.usage) S.usage = m.usage;
        applyDelta(m.message);
      }
      break;

    /*
     * ★ **예약을 돌려받았다** — 「수정」의 뒷반쪽 (v3.0 1-E).
     *
     * 쓰던 글은 누를 때 이미 치워뒀다(`stash`). 여기서는 돌려받은 것을
     * 입력창에 꽂기만 한다.
     */
    case "stagedBack":
      if (S.room?.id === m.roomId) {
        /*
         * 🔴 **칸이 비었다는 것을 여기서 바로 반영한다.** 코어도 방을 다시
         * 내보내지만 그건 따로 오는 소식이라, 기다리면 **«예약»과 «치워둔 글»이
         * 한 순간 같이** 보인다 — 둘이 동시에 안 뜬다는 것이 이 줄의 약속이다.
         */
        delete S.room.staged;
        putTokens(S.room, m.tokens);
        paintStaged(S.room);
        paintSendButton(S.room);
      }
      break;

    case "mcp":
      S.mcpAt = m.state;
      // 권한 화면을 보고 있는 중이면 그 자리에서 바뀐다 — [다시 시도] 의 답이다
      if (S.room && S.stack[S.stack.length - 1] === "perm") paintPermissionSheet(S.room);
      break;

    case "reviews":
      if (S.room?.id === m.roomId) {
        S.reviews = m.list;
        renderChat();
      }
      break;

    /*
     * ★ **대기는 두 자리에 떠 있다** (§5-M) — 서랍의 수와, 열어둔 대기 화면.
     *
     * 🔴 **둘 다 다시 그린다.** 서랍만 고치면 화면을 열어둔 채 항목이 닫혔을
     * 때 **이미 답한 것이 그대로 서 있고**, 거기서 「버리기」를 누르면 코어가
     * «그런 건 없다» 로 답한다 — 사용자 눈에는 단추가 먹지 않는 것이 된다.
     */
    case "waiting":
      if (S.room?.id === m.roomId) {
        S.waiting = m.list;
        if (S.stack.includes("bots")) paintDrawer(S.room);
        if (S.stack[S.stack.length - 1] === "wait" && S.waitBotId) paintWaiting(S.room, S.waitBotId);
      }
      break;

    case "clashes":
      if (S.room?.id === m.roomId) {
        S.clashes = m.list;
        // 띠만 다시 그린다 — 대화를 통째로 다시 그릴 이유가 없다
        if (S.chat) paintClashes(S.room);
      }
      break;

    case "status":
      statuses.set(m.roomId, m.status);
      if (S.room?.id === m.roomId) S.botStatus = m.bots ?? {};
      if (S.room?.id === m.roomId) renderChat();
      // 붙는 화면은 **봇별 상태로** 그려진다 — 바뀔 때마다 다시 그린다
      if (S.room?.id === m.roomId && S.stack[S.stack.length - 1] === "joining") {
        renderJoining(S.room);
      }
      renderList();
      break;

    case "roomError":
    case "notice":
      if (S.room?.id === m.roomId) {
        const list = screens.chat.querySelector(".messages");
        if (list) {
          list.append(
            el(
              "div",
              { class: "msg system" },
              el("div", { class: `bubble${m.t === "roomError" ? " error" : ""}`, text: m.message }),
            ),
          );
          if (S.stick) list.scrollTop = list.scrollHeight;
        }
      }
      break;

    /*
     * ★ **구독 잔량** (사용자, 2026-10-19).
     *
     * 팝업이 떠 있을 때만 다시 그린다 — 닫고 나서 늦게 온 답이 화면을
     * 흔들 이유가 없다. 다음에 열면 **마지막에 받은 것**이 먼저 서고,
     * 언제 받은 것인지는 줄마다 적힌다.
     */
    case "roomFile":
      gotRoomFile(m.roomId, m.path);
      break;

    case "quota": {
      if (m.only) {
        // ★ 한 줄만 다시 받은 것 — **그 줄만** 갈아끼우고 다른 줄은 그대로 둔다
        const rest = (S.quota ?? []).filter((q) => q.agentId !== m.only);
        S.quota = [...rest, ...m.list];
        S.quotaBusyFor.delete(m.only);
      } else {
        S.quota = m.list;
        S.quotaBusy = false;
        S.quotaBusyFor.clear();
      }
      if (document.querySelector(".quota-card")) paintQuota();
      break;
    }

    case "agents": {
      S.agentRows = m.list;
      /*
       * 받거나 지우면 방 만들기 목록과 막음이 **같이** 바뀜다.
       * 설정 화면만 고치고 나면 받아놓고도 목록에 안 뜨는 꼴이 된다.
       */
      agentAvail.clear();
      for (const a of m.list) if (a.available) agentAvail.add(a.id);
      /* 로그인이 끝난 에이전트는 **띄웠다는 표시**를 지운다 — 단추가 다시 산다 */
      for (const a of m.list) if (a.state === "ready") loginAsked.delete(a.id);
      renderAgents();
      if (S.stack[S.stack.length - 1] === "new") renderNew();
      if (S.room) {
        /* ★ 로그인이 풀렸던 봇은 **저절로** 다시 붙는다 (4.5-U) */
        if (retryAfterLogin(S.room)) {
          renderJoining(S.room);
          /* 로봇 화면 위에서 눌렀으면 거기 그대로 — 뒤로 누르면 이 화면이다 */
          roomGo("joining");
          break;
        }
        repaintBlock(S.room);
      }
      break;
    }

    case "config": {
      const key = configKey(m.agentId, m.roomId, m.botId);
      configs.set(key, m.options);
      if (m.error) configErrors.set(key, m.error);
      else configErrors.delete(key);
      // 만들기 화면은 방이 없으므로 에이전트 몫만 받는다
      if (!m.roomId && S.stack[S.stack.length - 1] === "new") renderNew(m.error);
      // 서랍도 마찬가지다 — 열어둔 뒤에 온 설정이 갈 곳이 없으면
      // 모델 칸이 영영 비어 있거나 낡은 값을 보여준다
      if (S.room && m.roomId === S.room.id && screens.bots.firstElementChild) {
        paintDrawer(S.room);
      }
      // 열려 있는 권한 시트는 **늦게 온 설정을 받아 다시 그린다**
      if (S.room && m.roomId === S.room.id && screens.perm.firstElementChild) {
        paintPermissionSheet(S.room);
      }
      /*
       * ★ **«모델 다시 고르기» 띠도 늦게 온 설정을 기다린다** (2026-09-30).
       *
       * 🔴 설정은 방에 **들어올 때** 요청하고 답은 나중에 온다. 그런데 여기서
       * 다시 그리는 것은 서랍과 권한 시트뿐이었다 — 본문은 안 그린다. 그래서
       * 띠 안의 고르개가 **«목록을 불러오는 중…» 에서 영영 멈춘다.** 고르라고
       * 띄워놓고 고를 수가 없다.
       *
       * **그 띠가 떠 있을 때만** 다시 그린다. 설정 메시지마다 본문을 그리면
       * 스크롤 자리가 흔들린다.
       */
      /*
       * ★ **방 몴이 아닌 설정도 받는다** (2026-10-01).
       *
       * 갈아타기를 고르면 **아직 방에 없는 에이전트**의 모델을 골라야
       * 하는데, 그 설정은 `roomId` 없이 온다(«미리보기» 길). 방 것만
       * 받으면 에이전트를 골라도 **모델 줄이 영영 안 나타난다.**
       */
      if (S.room && needsModel(S.room).length > 0 && (!m.roomId || m.roomId === S.room.id)) {
        renderFix(S.room);
      }
      break;
    }

    case "ask": {
cards.push(m.card);
      if (S.room) renderChat();
      break;
    }

    // 우리가 답하지 않았는데 끝난 경우 — 패널이 닫혔거나 에이전트가 물러섰다
    case "askResolved":
      if (dropCard(m.id) && S.room) renderChat();
      break;

    case "auth":
      S.authList = m.list;
      S.authStuck = m.stuck;
      renderAuth();
      break;

    case "joinDone": {
      /*
       * 🔴 **방보다 먼저 와도 된다** (2026-10-13).
       *
       * 호스트는 방을 내보내는 것과 붙이는 것을 **따로** 한다 — 어느 쪽이
       * 먼저 닿을지 우리가 못 정한다. 먼저 오면 **적어뒀다가**, 방이 올 때
       * 그걸 보고 넘어간다. 순서에 기대면 그 기대가 틀리는 날 **붙는 화면에
       * 갇힌다** — `ready` 악수에서 이미 한 번 밟은 자리다.
       */
      joined.add(m.roomId);
      if (S.room?.id !== m.roomId) break;
      if (S.stack[S.stack.length - 1] === "joining") {
        /*
         * ★ **못 붙은 봇이 있으면 `fix` 로 간다** (2026-10-13).
         *
         * 🔴 여태 붙는 화면에 **남았다.** 그래서 결정하는 단추가 거기 달려야
         * 했고, 화면 둘이 같은 일을 반씩 했다. 붙는 일이 **다 끝난 뒤**에
         * 한 번만 넘어가면 — 걸린 봇이 한꺼번에 카드로 서고, 그 화면은
         * 기다리기만 하면 된다. `needsModel` 이 이제 걸린 봇도 센다.
         */
        repaintBlock(S.room);
      }
      break;
    }

    case "joinStep": {
      if (S.room?.id !== m.roomId) break;
      S.joinSteps.set(m.botId, m.step);
      if (S.stack[S.stack.length - 1] === "joining") renderJoining(S.room);
      break;
    }

    case "joinFail": {
      if (S.room?.id !== m.roomId) break;
      S.joinFails.set(m.botId, { kind: m.kind, why: m.why });
      const top = S.stack[S.stack.length - 1];
      if (top === "joining") renderJoining(S.room);
      // 카드가 서 있는 동안 **다른 봇이 또 걸릴 수 있다** — 그 자리에 더 그린다
      else if (top === "fix") renderFix(S.room);
      else if (top === "chat") {
        /*
         * ★ **채팅을 보던 중에 끊겨도 보인다** (4.5-V, 2026-10-13).
         *
         * 🔴 한 번 들어간 방은 다시 들어갈 때 **붙는 화면을 안 지난다**
         * (`joined`) — 바로 채팅이다. 그런데 호스트는 그동안 세션을 다시
         * 붙이고 있고, **그게 실패하면 아무 데도 안 보였다.** 잘 되면 상태
         * 줄로 지나가지만 실패는 지나갈 자리가 없다.
         *
         * **얹는다**(push) — 뒤로 누르면 보던 채팅이 그대로 있다.
         */
        renderJoining(S.room);
        roomGo("joining");
      }
      break;
    }

    case "nav":
      if (m.screen === "new") openNewRoom();
      else if (m.screen === "agents") {
        // 로봇 화면은 **목록 위에 얹는다** — 뒤로 하나면 목록으로 돌아간다
        post({ t: "agentsAsk" });
        renderAgents();
        push("agents");
      } else go("list");
      break;

    case "attached":
      if (S.room?.id === m.roomId) {
        S.pending = [...S.pending, ...m.attachments];
        paintChips();
        if (m.rejected?.length) noticeInChat(m.rejected.join("\n"));
      }
      break;

    case "blobData": {
      blobCache.set(m.sha256, m.dataUri);
      const waiting = blobWaiters.get(m.sha256);
      blobWaiters.delete(m.sha256);
      for (const resolve of waiting ?? []) resolve(m.dataUri);
      break;
    }

    case "searchResults":
      // 타이핑이 앞서가 있으면 늦게 도착한 결과는 버린다
      if (m.query === S.filterText) {
        S.hits = m.hits;
        renderList();
      }
      break;

    case "caps":
      capsBy.set(m.agentId, {
        image: m.image, audio: m.audio, embeddedContext: m.embeddedContext, fork: m.fork,
      });
      break;

    case "cwdPicked": {
      S.draftCwd = m.path;
      const input = screens.new.querySelector<HTMLInputElement>("#new-cwd");
      if (input) {
        input.value = m.path;
        // 값만 넣으면 `input` 이벤트가 안 난다 — 폴더를 골랐는데도 «만들기»가
        // 잠긴 채로 남는다
        input.dispatchEvent(new Event("input"));
      }
      break;
    }

    case "createFailed":
      renderNew(m.message);
      break;
  }
});

// ── 키보드 ──────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    if (S.stack[S.stack.length - 1] === "chat") openFind();
    else screens.list.querySelector<HTMLInputElement>(".filter input")?.focus();
    return;
  }
  // 목록에서 F2로 바로 이름 바꾸기 (B4)
  if (e.key === "F2" && S.stack[S.stack.length - 1] === "list") {
    const first = filteredMetas()[0];
    if (first) {
      e.preventDefault();
      renameInList(first);
    }
    return;
  }

  if (e.key !== "Escape") return;
  if (screens.chat.querySelector(".find")) {
    closeFind();
    return;
  }
  const menu = screens.chat.querySelector(".menu") ?? roomsEl.querySelector(".menu");
  if (menu) {
    menu.remove();
    return;
  }

  // **도는 중이면 Esc는 먼저 그걸 멈춘다** (C6).
  // 응답을 받는 중에 방을 나가는 건 대개 의도가 아니다.
  if (S.stack[S.stack.length - 1] === "chat" && S.room) {
    const busy = statuses.get(S.room.id) ?? "idle";
    if (busy === "streaming" || busy === "tool" || busy === "waiting") {
      post({ t: "stopAll", roomId: S.room.id });
      return;
    }
    leaveChat();
    return;
  }
  if (S.stack.length > 1) back();
});

// 첫 페인트는 HTML이 그렸다. 여기서 다시 그리는 건 이벤트를 붙이기 위해서다 —
// 같은 구조로 그리므로 화면은 바뀌지 않는다 (F8).
renderList();

// «새 대화방»으로 열렸으면 바로 만들기 화면으로. 패널이 꺼져 있던 상태에서는 `nav`가
// 이 스크립트보다 먼저 도착해 사라지므로, 부트 상태에서 받는다.
if (boot.screen === "new") openNewRoom();

/*
 * 🔴 **확인 화면은 HTML 이 이미 띄워뒀다** — 여기서는 스택만 맞춰준다.
 * 안 맞추면 `paintScreens` 가 목록을 켜면서 **확인 화면을 덮는다.**
 */
if (boot.screen === "auth") { S.stack = ["auth"]; paintScreens(); renderAuth(); }

/*
 * ★ **다 떴다고 알린다 — 맨 마지막 줄이어야 한다** (2026-10-13).
 *
 * 🔴 이 앞에 보낸 것은 호스트가 **우리가 뜨기 전에** 보냈을 수 있고, 그건
 * 그냥 사라진다. 여기서 한 번 알리면 호스트가 **들고 있던 것을 다시** 준다.
 */
post({ t: "ready" });
