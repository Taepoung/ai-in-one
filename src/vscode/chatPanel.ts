import { createHash } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import {
  authPlan, authStatus, cmdPath, dirFor, dropOptions, freeInstall, holdInstall, install,
  landingFor, realNpm, remove, stateOf,
} from "../core/install/agentInstaller.js";
import type * as acp from "@agentclientprotocol/sdk";
import type { RoomManager } from "../core/roomManager.js";
import type { RoomStore } from "../core/store.js";
import { baseName, sendsContent, underCwd } from "../core/types.js";
import type {
  AgentDef,
  Attachment,
  PermissionDecision,
  PermissionRequest,
  Room,
} from "../core/types.js";
import { BlobDocuments } from "./blobDocuments.js";
import type { AskTarget } from "./vscodeHost.js";
import type {
  AgentBrief,
  AskAnswer,
  AskCard,
  AuthRow,
  Boot,
  ConfigOptionBrief,
  FromWebview,
  ToWebview,
} from "../protocol.js";
import { roomListHtml } from "../protocol.js";
import { errorFields, popupDue, readableError } from "./errorText.js";

/**
 * 채팅 앱 하나.
 *
 * **패널은 항상 하나다** (F8). 아이콘을 두 번 눌러도 앱이 두 개 뜨지 않도록
 * 이미 있으면 `reveal`만 한다.
 */
/**
 * 확인 화면에 사람을 앉혀둘 **최대 시간** (2026-10-13).
 *
 * 실측이 claude 0.3~0.4초 · codex 0.1초라 **열 배 넘는 여유**다. 넘겼다는
 * 것은 그 자체로 «뭔가 잘못됐다» 는 신호고, 그때는 조용히 넘어가지 않고
 * **사람에게 묻는다.** `authStatus` 의 20초를 그대로 쓰면 확인 화면에
 * 20초를 앉아 있게 된다 — 그건 창을 막는 것과 다를 바 없다.
 */
const AUTH_WAIT_MS = 5_000;

export class ChatPanel implements AskTarget {
  private static current: ChatPanel | undefined;

  /**
   * 떠 있으면 에이전트 목록을 다시 보낸다. 안 떠 있으면 할 일이 없다 —
   * 다음에 열 때 어차피 보낸다.
   *
   * 밖에서 `current` 를 들여다보게 하지 않으려고 둔 자리다.
   */
  static repaintAgents(): void {
    ChatPanel.current?.sendAgents();
  }

  private readonly disposables: vscode.Disposable[] = [];
  /**
   * ★ **떠 있는 카드들 — 패널이 아니라 «확장»에 둔다** (2026-10-13).
   *
   * id → 어느 방의 것인지 · 카드 본문 · 답을 넣는 손.
   *
   * 🔴 **방을 같이 적는다** (v3.0 1-D). 전체 중지가 «이 방의» 카드만 거두려면
   * 그게 있어야 한다 — 옆 방에서 떠 있던 카드까지 거두면 **멈추라고 누른 적
   * 없는 방이 멈춘다.**
   *
   * 🔴 **여기가 패널에 붙어 있었다.** 탭을 닫으면 카드가 같이 죽는데, 저쪽
   * `request_permission` 은 **답이 올 때까지 안 돌아온다.** 그래서 닫을 때
   * 전부 **취소**로 풀어줬다 — 안 그러면 답할 사람이 없어 봇이 영영 멈추니까.
   *
   * 그런데 사용자: *"이건 그냥 기다리라고 해. 일은 계속 되어야지."* 맞는
   * 말이다 — 탭을 닫은 것은 **보기를 그만둔 것**이지 그 일을 무르겠다는 뜻이
   * 아니다. 확장에 두면 닫아도 살아 있고, **다시 열 때 그 카드가 돌아온다.**
   *
   * ★ 오늘 `busy` 에 적은 줄이 그대로 맞는다 — **살아 있어야 할 것은 「일」과
   * 같은 수명**이어야 한다. 보는 창이 아니라.
   *
   * ⚠️ 창을 다시 불러오면(Ctrl+R) 확장이 통째로 새로 뜨므로 거기까진 못
   * 지킨다 — 그때는 저쪽 프로세스도 같이 죽는다.
   */
  private static readonly pending = new Map<
    string,
    { roomId: string; botId?: string; card: AskCard; settle: (answer: AskAnswer) => void }
  >();

  /** 지금 떠 있는 창에 보낸다 — 이 카드를 띄운 창은 닫혔을 수 있다 */
  private static tell(msg: ToWebview): void {
    ChatPanel.current?.post(msg);
  }
  private openRoomId: string | null = null;
  private seq = 0;

  static show(
    ctx: vscode.ExtensionContext,
    rooms: RoomManager,
    store: RoomStore,
    agents: () => AgentDef[],
    onTarget: (t: AskTarget | null) => void,
    /** 받기·지우기 뒤에 부른다 — `command`·`args` 가 바뀌므로 다시 읽혀야 한다 */
    refreshAgents: () => void,
    screen?: "new",
  ): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(undefined, true);
      if (screen) ChatPanel.current.post({ t: "nav", screen });
      return ChatPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "aiInOne.chat",
      "AI in One",
      // **에디터 오른쪽에 연다.** 사이드바를 쓰지 않으므로 파일 탐색기가 가려지지 않는다.
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // 방을 오갈 때마다 웹뷰를 새로 만들면 메신저가 아니라 웹페이지처럼 느껴진다.
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(ctx.extensionUri, "dist"),
          vscode.Uri.joinPath(ctx.extensionUri, "media"),
        ],
      },
    );

    // 첫 화면은 HTML에 실어 보낸다 — `nav`는 아직 받을 사람이 없다.
    ChatPanel.current = new ChatPanel(
      ctx, panel, rooms, store, agents, refreshAgents, onTarget, screen ?? "list");
    /*
     * ★ **창이 뜨면 로그인부터 확인한다** (2026-10-13).
     *
     * 🔴 **알던 값으로 그냥 들어가지 않는다.** 우리 짐작은 «자격 파일이
     * 있나» 뿐이라 **만료 · 다른 데서 로그아웃 · 철회**를 하나도 못 본다.
     * 그걸 모른 채 들어가면 긴 글을 다 쓰고 보낼 때 막히고, 그때 뜨는 것은
     * CLI 원문이다.
     *
     * 확인하는 동안은 **확인 화면**이 서 있고, 기한을 넘기면 사람에게 묻는다.
     */
    /*
     * ★ **닫혀 있는 동안 떠 있던 카드를 돌려준다** (2026-10-13).
     *
     * 안 돌려주면 봇은 기다리는데 **물어본 자국이 어디에도 없다** — 사용자
     * 눈엔 그냥 멈춰 있는 방이다.
     */
    for (const { card } of ChatPanel.pending.values()) {
      ChatPanel.current.post({ t: "ask", card });
    }
    ChatPanel.current.askAuth();
    /*
     * 확인 화면을 **안 세웠으면** 그쪽에서 보낼 일이 없다 — 여기서 본다.
     * 🔴 웹뷰가 아직 안 떴을 수 있으므로 `ready` 가 와도 한 번 더 본다.
     */
    if (!ChatPanel.current.authShown) ChatPanel.current.navIfStale();
    /*
     * 🔴 **열자마자 지금 상태를 보낸다** (2026-10-02).
     *
     * `boot` 은 HTML 에 한 번 실려 나가고 그 뒤로 안 바뀐다. 그래서 받아두고도
     * 로봇 화면을 열어야 목록이 갱신되는 꼴이었다 — 그 사이에 방을 열면
     * **받았는데도 «아직 안 받았다»** 로 보였다.
     */
    ChatPanel.current.sendAgents();
    // 🔴 **열자마자 지금 칸을 보낸다** — 이벤트는 바뀔 때만 온다
    ChatPanel.current.post({ t: "mcp", state: rooms.mcpState() });
    return ChatPanel.current;
  }

  static get active(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly rooms: RoomManager,
    private readonly store: RoomStore,
    private readonly agents: () => AgentDef[],
    private readonly refreshAgents: () => void,
    private readonly onTarget: (t: AskTarget | null) => void,
    screen: "list" | "new" = "list",
  ) {
    panel.iconPath = new vscode.ThemeIcon("comment-discussion");
    /*
     * 🔴 **첫 그림이 곧 확인 화면이어야 한다.** 스크립트가 돈 다음에 덮으면
     * 방 목록이 한 번 번쩍한다 — 사용자 눈엔 버벅인 것이다.
     */
    this.authRows = this.authSeed();
    this.authAfter = screen;
    /*
     * 🔴 **물어볼 것이 하나라도 있을 때만 세운다.** 파일로 이미 결판난
     * 줄(Antigravity)만 있으면 **기다릴 것이 없다** — 그런데도 화면을
     * 세우면 한 프레임 번쩍했다 사라진다. «뭔가 지나갔는데 못 읽었다» 는
     * 아무것도 안 보여준 것보다 나쁘다.
     */
    this.authShown = this.authRows.some((r) => r.at === "asking");
    this.authDone = !this.authShown;
    panel.webview.html = this.html(this.authShown ? "auth" : screen);
    onTarget(this);

    /*
     * **이 칸을 잠근다.**
     *
     * 🔴 웹뷰 패널은 «에디터»라서, 우리 패널이 있는 그룹이 활성 상태면 **사용자가
     * 여는 파일이 그 칸으로 들어온다.** 채팅 옆에 코드가 겹쳐 쌓여서 둘 다 못 쓰게
     * 된다 — 대화를 보려고 연 자리인데.
     *
     * 그룹을 잠그면 새 에디터는 **다른 칸으로 간다.** 사용자가 직접 풀 수 있으므로
     * 가두는 것도 아니다. 만들 때 한 번만 하고 다시 걸지 않는다.
     */
    void vscode.commands
      .executeCommand("workbench.action.lockEditorGroup")
      .then(undefined, () => undefined);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m)),
      panel.onDidDispose(() => this.dispose()),
      // **패널이 안 보이면 어느 방도 보고 있지 않다.** 미읽음이 쌓여야 맞다 (F6).
      panel.onDidChangeViewState(() => void this.syncActive()),
    );

    const on = <K extends Parameters<RoomManager["on"]>[0]>(
      event: K,
      fn: (...args: never[]) => void,
    ) => {
      this.rooms.on(event, fn as never);
      this.disposables.push({ dispose: () => this.rooms.off(event, fn as never) });
    };

    on("metas", (() => this.post({ t: "metas", rooms: this.rooms.listMetas() })) as never);
    on("room", ((room: Room) => this.postRoom(room)) as never);
    // 스트리밍은 여기로 나간다 — 대화 길이와 무관하게 한 개만 보낸다.
    on("message", ((roomId: string, message: never) => {
      // 사용량은 숫자 몇 개라 같이 실어도 페이로드가 사실상 느지 않는다
      const usage = this.rooms.usageOf(roomId);
      this.post({ t: "msg", roomId, message, ...(usage ? { usage } : {}) });
    }) as never);
    on("status", ((roomId: string, status: never, bots: never) =>
      this.post({ t: "status", roomId, status, bots })) as never);
    on("reviews", ((roomId: string, list: never) =>
      this.post({ t: "reviews", roomId, list })) as never);
    on("waiting", ((roomId: string, list: never) =>
      this.post({ t: "waiting", roomId, list })) as never);
    on("mcp", ((state: never) => this.post({ t: "mcp", state })) as never);
    on("joinFail", ((roomId: string, botId: string, kind: never, why: string) =>
      this.post({ t: "joinFail", roomId, botId, kind, why })) as never);
    on("joinDone", ((roomId: string) => this.post({ t: "joinDone", roomId })) as never);
    on("joinStep", ((roomId: string, botId: string, step: never) =>
      this.post({ t: "joinStep", roomId, botId, step })) as never);
    on("clashes", ((roomId: string, list: never) =>
      this.post({ t: "clashes", roomId, list })) as never);
    on("roomError", ((roomId: string, message: string) =>
      this.post({ t: "roomError", roomId, message })) as never);
    on("notice", ((roomId: string, message: string) =>
      this.post({ t: "notice", roomId, message })) as never);

    this.warmConfigs();
  }

  /**
   * 앱을 켤 때 **에이전트 설정을 미리 받아 둔다.**
   *
   * 모드 목록은 CLI를 한 번 띄워야 알 수 있어서 처음엔 몇 초가 걸린다. 필요할
   * 때 부르면 그 몇 초가 **하필 권한 시트를 연 순간**에 온다 — 화면에는 아무것도
   * 없고, 사용자는 기능이 없다고 판단한다. 앱을 여는 순간은 어차피 기다리는
   * 시간이라 여기서 치르는 게 싸다.
   *
   * **한꺼번에 던지고 오는 대로 보낸다.** 느린 에이전트 하나가 나머지를 붙잡지
   * 않는다. 실패해도 `sendConfig`가 이유를 실어 보내므로 조용히 사라지지 않는다.
   */
  private warmConfigs(): void {
    for (const a of this.agents()) void this.sendConfig(a.id);
  }

  // ── 물어보기 (D1·D4) ──────────────────────────────────────────────────

  permission(req: PermissionRequest): Promise<PermissionDecision> {
    /* **누구 것인지 적어둔다** — 그 봇이 죽으면 이 카드만 거둬야 한다 */
    return this.ask({ kind: "permission", req }, (answer) =>
      answer.kind === "permission" && answer.optionId
        ? { outcome: "selected", optionId: answer.optionId }
        : { outcome: "cancelled" },
    req.askerBotId);
  }

  /**
   * ★ **떠 있는 승인 카드를 거둔다** (v3.0 1-D — 전체 중지).
   *
   * 🔴 `requestPermission` 은 **답이 올 때까지 안 돌아온다.** 중지가 턴만
   * 끊고 이걸 두면 **누를 수 없는 카드가 남고** 에이전트는 영영 기다린다 —
   * 멈추라고 눌렀는데 멈춘 게 아니다.
   *
   * 거두면 그 기다림이 `cancelled` 로 풀리고, 에이전트에게 답이 가는 것도
   * **저절로** 따라온다 — 답하는 길이 애초에 이 하나뿐이기 때문이다.
   */
  cancelPermissions(roomId: string, botId?: string): void {
    for (const [id, waiting] of [...ChatPanel.pending]) {
      if (waiting.roomId !== roomId) continue;
      /*
       * **봇을 집었으면 그 봇 것만** (2026-10-14). CLI 가 죽어 거두는 길은
       * 봇 하나짜리다 — 단체방에서 남의 카드까지 걷으면 멈추라고 한 적 없는
       * 일이 멈춘다. 전체 중지는 봇을 안 집어 보내 방 전체를 거둔다.
       */
      if (botId && waiting.botId !== botId) continue;
      ChatPanel.pending.delete(id);
      // 답이 없는 답 — `decide` 가 `cancelled` 로 읽는다
      waiting.settle({ kind: "permission" });
    }
  }


  /**
   * 카드를 띄우고 답을 기다린다.
   *
   * **어느 방인지 붙여 보낸다** — 사용자가 다른 방을 보고 있을 때 카드가 뜨면
   * 무엇에 대한 승인인지 알 수 없다.
   */
  private ask<T>(
    card: Omit<AskCard, "id" | "roomId">,
    decide: (answer: AskAnswer) => T,
    botId?: string,
  ): Promise<T> {
    const id = `ask-${++this.seq}`;
    const full = { ...card, id, roomId: this.openRoomId ?? "" } as AskCard;
    this.panel.reveal(undefined, true);
    this.post({ t: "ask", card: full });

    return new Promise<T>((resolve) => {
      ChatPanel.pending.set(id, {
        roomId: full.roomId,
        ...(botId ? { botId } : {}),
        // **본문을 들고 있는다** — 새 창이 뜨면 이걸 그대로 다시 보낸다
        card: full,
        settle: (answer) => {
          ChatPanel.pending.delete(id);
          /*
           * **카드를 치우라고 알린다.** 사용자가 직접 누른 경우엔 화면이 이미
           * 치웠지만, 전체 중지처럼 다른 이유로 끝난 경우에는 이게 없으면
           * **답할 수 없는 카드가 영영 남는다.**
           *
           * 🔴 **지금 떠 있는 창에** 보낸다 — 이 카드를 띄운 창은 이미 닫혔을
           * 수 있고, 그러면 죽은 웹뷰에 대고 말하는 꼴이 된다.
           */
          ChatPanel.tell({ t: "askResolved", id });
          resolve(decide(answer));
        },
      });
    });
  }

  // ── 웹뷰에서 오는 것 ───────────────────────────────────────────────────

  private async handle(m: FromWebview): Promise<void> {
    try {
      switch (m.t) {
        case "open": {
          /*
           * ★ **자리를 먼저 잡는다** (v3.0 2-G).
           *
           * 🔴 남이 쓰는 중이면 **안 연다.** `ensureSession` 이 「세션이
           * 사라졌다」와 「남이 쓰는 중이다」를 안 가려서, 열어버리면 먼저
           * 쓰던 창의 세션이 고아가 된다 — 그쪽 화면은 멀쩡해 보이는데
           * 다음 말이 엉뚱한 세션으로 간다.
           *
           * 빠져나갈 단추는 안 둔다. **껐다 켜면 저절로 풀린다.**
           */
          const got = await this.rooms.enterRoom(m.roomId);
          if (!got.ok) {
            this.post({ t: "notice", roomId: m.roomId, message: got.why });
            this.post({ t: "nav", screen: "list" });
            break;
          }
          this.openRoomId = m.roomId;
          // **방을 여는 것과 읽는 것은 다르다.** 먼저 구분선 위치를 잡고 나서 읽음 처리한다.
          this.postRoom(got.room);
          await this.rooms.setActiveRoom(m.roomId);
          break;
        }
        case "back": {
          const leaving = this.openRoomId;
          this.openRoomId = null;
          await this.rooms.setActiveRoom(null);
          // 조용하면 자리를 놓는다 — 도는 중이면 끝날 때 저쪽에서 놓는다
          if (leaving) this.rooms.releaseRoom(leaving);
          // 아무것도 안 쓰고 나왔으면 목록에 남기지 않는다
          if (leaving) await this.rooms.discardIfUntouched(leaving);
          break;
        }
        case "createRoom": {
          const room = await this.rooms.createRoom({
            agentId: m.agentId,
            ...(m.bots?.length ? { bots: m.bots } : {}),
            ...(m.title ? { title: m.title } : {}),
            ...(m.cwd ? { cwd: m.cwd } : {}),
            ...(m.rolePrompt ? { rolePrompt: m.rolePrompt } : {}),
            ...(m.configValues ? { configValues: m.configValues } : {}),
            ...(m.agentMode ? { agentMode: m.agentMode } : {}),
            ...(m.answerPolicy ? { answerPolicy: m.answerPolicy } : {}),
          });
          this.openRoomId = room.id;
          this.postRoom(room);
          await this.rooms.setActiveRoom(room.id);
          break;
        }
        case "send":
          await this.rooms.send(m.roomId, m.text, m.attachments);
          break;
        case "attach":
          await this.storeAttachments(
            m.roomId,
            m.items.map((it) => ({
              name: it.name,
              mimeType: it.mimeType,
              data: Buffer.from(it.base64, "base64"),
            })),
          );
          break;
        case "attachPaths":
          await this.attachFromDisk(m.roomId, m.paths);
          break;
        case "pickAttachment": {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "첨부",
          });
          if (picked?.length) {
            await this.attachFromDisk(m.roomId, picked.map((u) => u.fsPath));
          }
          break;
        }
        case "needBlob": {
          // 내용을 실어 보낸 것은 blob에 있다.
          const buf = await this.store.getBlob(m.sha256);
          if (buf) {
            const mime = this.mimeOf.get(m.sha256) ?? "application/octet-stream";
            this.post({
              t: "blobData",
              sha256: m.sha256,
              dataUri: `data:${mime};base64,${buf.toString("base64")}`,
            });
            break;
          }

          // **경로만 보낸 것은 blob이 없다.** 지금 파일을 읽어서 보여준다 —
          // 에이전트도 프롬프트 시점의 파일을 읽으므로 이쪽이 실제와 맞는다.
          if (!m.path) break;
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
            this.post({
              t: "blobData",
              sha256: m.sha256,
              dataUri: `data:text/plain;base64,${Buffer.from(doc.getText(), "utf8").toString("base64")}`,
            });
          } catch {
            // 파일이 사라졌거나 텍스트가 아니다. 미리보기가 없을 뿐이다.
          }
          break;
        }
        case "search": {
          const hits = await this.rooms.search(m.query);
          this.post({ t: "searchResults", query: m.query, hits });
          break;
        }
        case "needCaps": {
          const caps = this.rooms.promptCapabilities(m.agentId);
          this.post({
            t: "caps",
            agentId: m.agentId,
            ...caps,
            fork: this.rooms.forkSupport(m.agentId),
          });
          break;
        }
        case "stopAll":
          await this.rooms.stopAll(m.roomId);
          break;
        case "stage":
          /*
           * 🔴 **못 올렸으면 말해준다.** 칸이 하나뿐이라 거절될 수 있는데,
           * 조용히 삼키면 «눌렀는데 아무 일도 안 일어난다»가 된다.
           */
          if (!(await this.rooms.stage(m.roomId, m.tokens, m.attachments))) {
            this.post({
              t: "notice",
              roomId: m.roomId,
              message: "올려둔 글이 이미 하나 있습니다 — 그것을 보내거나 내린 뒤에 해주세요.",
            });
          }
          break;
        case "unstage":
          await this.rooms.unstage(m.roomId);
          break;
        case "editStaged": {
          const was = await this.rooms.takeStaged(m.roomId);
          if (was) {
            this.post({
              t: "stagedBack",
              roomId: m.roomId,
              tokens: was.tokens,
              ...(was.attachments ? { attachments: was.attachments } : {}),
            });
          }
          break;
        }
        case "retry":
          await this.rooms.retry(m.roomId, m.messageId);
          break;
        case "takeOverReview":
          this.rooms.takeOverReview(m.reviewId);
          break;
        case "dropWaiting":
          this.rooms.dropWaiting(m.roomId, m.botId, m.id);
          break;
        case "answerWaiting":
          this.rooms.answerWaiting(m.roomId, m.botId, m.id, m.allow);
          break;
        case "retryMcp":
          await this.rooms.startMcp();
          break;
        case "rename":
          await this.rooms.renameRoom(m.roomId, m.title);
          break;
        case "setRole":
          await this.rooms.setRole(m.roomId, m.rolePrompt, m.botId);
          break;
        case "setBlurb":
          await this.rooms.setBlurb(m.roomId, m.blurb, m.botId);
          break;
        case "setRelay":
          await this.rooms.setRelay(m.roomId, m.relay);
          break;
        case "setRelayDepth":
          await this.rooms.setRelayDepth(m.roomId, m.depth);
          break;
        case "setLoopCap":
          await this.rooms.setLoopCap(m.roomId, m.cap);
          break;
        case "sendCompose":
          await this.rooms.sendCompose(
            m.roomId,
            m.tokens,
            m.attachments?.length ? m.attachments : undefined,
          );
          break;
        case "addBot":
          await this.rooms.addBot(m.roomId, {
            agentId: m.agentId,
            ...(m.name ? { name: m.name } : {}),
            ...(m.color ? { color: m.color } : {}),
            ...(m.ink ? { ink: m.ink } : {}),
            ...(m.rolePrompt ? { rolePrompt: m.rolePrompt } : {}),
            ...(m.configValues ? { configValues: m.configValues } : {}),
          });
          break;
        case "removeBot":
          try {
            await this.rooms.removeBot(m.roomId, m.botId);
          } catch (err) {
            this.post({ t: "notice", roomId: m.roomId, message: describeErr(err) });
          }
          break;
        case "retryFork": {
          const got = await this.rooms.retryFork(m.roomId);
          // 안 됐으면 **왜 안 됐는지**를 말해준다 — 조용히 실패하면 또 누른다
          if (!got.ok && got.reason) this.post({ t: "notice", roomId: m.roomId, message: got.reason });
          break;
        }
        case "renameBot":
          await this.rooms.renameBot(m.roomId, m.botId, m.name);
          break;
        case "setBotColor":
          await this.rooms.setBotColor(m.roomId, m.botId, m.color, m.ink);
          break;
        case "setAgent":
          await this.rooms.setAgent(m.roomId, m.botId, m.agentId, {
            ...(m.model ? { model: m.model } : {}),
            ...(m.refeed !== undefined ? { refeed: m.refeed } : {}),
            ...(m.refeedKind ? { refeedKind: m.refeedKind } : {}),
          });
          break;
        case "fork": {
          /*
           * **분기하면 그 방으로 들어간다.**
           *
           * 목록으로 돌려보내면 방금 만든 갈래를 다시 찾아 눌러야 한다 —
           * 방을 만들 때(`createRoom`)와 같은 흐름으로 맞춘다.
           */
          const room = await this.rooms.forkRoom(m.roomId, {
            ...(m.atMessageId ? { atMessageId: m.atMessageId } : {}),
            ...(m.botId ? { botId: m.botId } : {}),
            ...(m.title ? { title: m.title } : {}),
            ...(m.fallback ? { fallback: m.fallback } : {}),
          });
          this.openRoomId = room.id;
          this.postRoom(room);
          await this.rooms.setActiveRoom(room.id);
          break;
        }
        case "leave":
          if (this.openRoomId === m.roomId) this.openRoomId = null;
          await this.rooms.leaveRoom(m.roomId);
          this.post({ t: "metas", rooms: this.rooms.listMetas() });
          break;
        case "draft":
          this.rooms.setDraft(m.roomId, m.text);
          break;
        case "needConfig":
          await this.sendConfig(m.agentId, m.roomId, m.botId);
          break;
        case "agentsAsk":
          this.sendAgents();
          break;
        /*
         * ★ **구독 잔량** (사용자, 2026-10-19).
         *
         * 🔴 **그 방의 에이전트만** 묻는다. 잔량은 계정에 붙는 값이지만,
         * 단추가 방 머리에 있으므로 **지금 보는 방이 쓰는 것**을 묻는 게
         * 맞다 — 안 쓰는 에이전트까지 깨우면 세션 셋이 괜히 뜬다.
         *
         * ⚠️ 한 번에 20초(Antigravity)까지 걸린다. 화면은 먼저 팝업을
         * 띄우고 **빈 자리에 «받는 중»** 을 세운다.
         */
        case "quotaAsk": {
          const here = await this.rooms.openRoom(m.roomId);
          const ids = m.agentId ? [m.agentId] : here.participants.map((b) => b.agentId);
          this.post({
            t: "quota", list: await this.rooms.quotaOf(ids),
            ...(m.agentId ? { only: m.agentId } : {}),
          });
          break;
        }
        // **못 물어본 것만** 다시 — 이미 답한 줄을 또 묻지 않는다
        case "ready":
          this.onReady();
          break;
        case "retryJoin":
          await this.rooms.retryJoin(m.roomId, m.botId);
          break;
        case "freshSession":
          await this.rooms.freshSession(m.roomId, m.botId, m.carry);
          break;
        case "peek":
          // **붙이지 않고** 연다 — `setActiveRoom` 이 붙이는 자리다
          this.postRoom(await this.rooms.openRoom(m.roomId));
          break;
        case "authRetry":
          this.askAuth();
          break;
        case "authSkip":
          this.authFinish();
          break;
        case "agentDo":
          await this.agentDo(m.agentId, m.what);
          break;
        case "refeed":
          await this.rooms.decideRefeed(m.roomId, m.accept, m.kind);
          break;
        case "retryResume":
          await this.rooms.retryResume(m.roomId);
          this.postRoom(await this.rooms.openRoom(m.roomId));
          break;
        case "answer": {
          const waiting = ChatPanel.pending.get(m.id);
          ChatPanel.pending.delete(m.id);
          waiting?.settle(m.answer);
          break;
        }
        case "setPolicy": {
          // 승인 주체를 빠뜨리면 화면에서 고른 값이 조용히 사라진다
          const patch = {
            ...(m.answerPolicy ? { answerPolicy: m.answerPolicy } : {}),
            ...(m.approver ? { approver: m.approver } : {}),
          };
          await this.rooms.setPolicy(m.roomId, patch, m.botId);
          this.postRoom(await this.rooms.openRoom(m.roomId));
          break;
        }
        case "setConfig": {
          const updated = await this.rooms.setConfig(m.roomId, m.configId, m.value, m.botId);
          // 하나를 바꾸면 다른 선택지가 함께 바뀔 수 있다 — 응답에 온 전체를 다시 내려준다.
          /*
           * 🔴 **바꾼 봇의 에이전트여야 한다.** 언제나 `participants[0]` 을
           * 썼으므로, 단체방에서 Codex의 모델을 바꾸면 **Claude 캐시에 Codex의
           * 선택지가 들어갔다** — 두 봇의 칸이 한꺼번에 엉킨다.
           */
          const here = await this.rooms.openRoom(m.roomId);
          const who = m.botId
            ? here.participants.find((b) => b.id === m.botId)
            : here.participants[0];
          if (who) {
            this.post({
              t: "config", agentId: who.agentId, roomId: m.roomId, botId: who.id,
              options: updated.map(brief),
            });
          }
          break;
        }
        case "compact":
          await this.rooms.compact(m.roomId, m.botId);
          break;
        case "pickCwd": {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "작업 디렉터리로 선택",
          });
          if (picked?.[0]) this.post({ t: "cwdPicked", path: picked[0].fsPath });
          break;
        }
        case "diffFile": {
          const room = await this.rooms.openRoom(m.roomId);
          const msg = room.messages.find((x) => x.id === m.messageId);
          const change = msg?.files?.find((f) => f.path === m.path);
          if (!change) break;

          const name = baseName(m.path);
          await vscode.commands.executeCommand(
            "vscode.diff",
            BlobDocuments.uri(change.oldSha256, m.path, "이전"),
            BlobDocuments.uri(change.newSha256, m.path, "이후"),
            `${name} — ${room.participants[0]?.name ?? "에이전트"}의 변경`,
            { viewColumn: vscode.ViewColumn.One },
          );
          break;
        }
        case "roomFileAsk":
          this.post({ t: "roomFile", roomId: m.roomId, path: this.rooms.roomFile(m.roomId) });
          break;
        case "revealRoomFile":
          // **열지 않고 선택만** — 열린 방의 기록을 손으로 고치면 깨지거나 덮인다
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.rooms.roomFile(m.roomId)));
          break;
        case "openFile": {
          // 상대 경로로 온 것은 워크스페이스 기준이다 (E9 — 판정은 `isAbsPath`)
          const cwd = this.rooms.listMetas().find((r) => r.id === this.openRoomId)?.cwd ?? "";
          const abs = underCwd(cwd, m.path);
          const editor = await vscode.window.showTextDocument(vscode.Uri.file(abs), {
            viewColumn: vscode.ViewColumn.One,
          });
          if (m.line !== undefined) {
            const at = new vscode.Position(Math.max(0, m.line - 1), 0);
            editor.selection = new vscode.Selection(at, at);
            editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
          }
          break;
        }
      }
    } catch (err) {
      const message = readableError(err);
      /*
       * ★ **무엇을 하다 났는지 출력 창에 남긴다** (사용자, 2026-11-18: *"AI in One: Unknown
       * system error -122: Unknown system error -122, write"*).
       *
       * 🔴 그 한 줄로는 **어느 일이 어느 파일에 쓰다** 났는지 알 길이 없었다 — 팝업만 뜨고
       * 어디에도 안 남았다. 화면에서 온 요청 이름과 오류의 칸(code · syscall · path)과
       * 스택을 적는다.
       */
      this.rooms.log(`[${m.t}${"agentId" in m ? ` ${String(m.agentId)}` : ""}] 실패 — ${message}${errorFields(err)}`);
      if (err instanceof Error && err.stack) this.rooms.log(err.stack);
      // 방 만들기 실패는 화면이 다르다 — 방이 없으니 roomError로 보낼 수 없다.
      if (m.t === "createRoom") this.post({ t: "createFailed", message });
      // `roomId`가 선택인 메시지도 있다 — 없으면 어느 방 오류인지 말할 수 없다
      else if ("roomId" in m && typeof m.roomId === "string") {
        this.post({ t: "roomError", roomId: m.roomId, message });
      }
      else if (popupDue(ChatPanel.popped, message, Date.now())) {
        void vscode.window.showErrorMessage(`AI in One: ${message} — 자세한 것은 출력 창(AI in One)에`);
      }
    }
  }

  /**
   * 고른 범위만 보낸다 (E8).
   *
   * 선택은 디스크에 없는 조각이므로 경로가 아니라 **내용을** 싫는다.
   * 어느 파일 몇 줄인지를 이름에 담아야 나중에 알아볼 수 있다.
   */
  async attachSelection(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty || !this.openRoomId) return false;

    const text = editor.document.getText(editor.selection);
    const name = baseName(editor.document.uri.fsPath) || "selection";
    const from = editor.selection.start.line + 1;
    const to = editor.selection.end.line + 1;

    await this.storeAttachments(this.openRoomId, [
      {
        name: `${name}:${from}-${to}`,
        mimeType: "text/plain",
        data: Buffer.from(text, "utf8"),
      },
    ]);
    return true;
  }

  // ── 첨부 (I) ──────────────────────────────────────────────────────────

  /**
   * 첨부 하나의 상한 (I7).
   *
   * 이미지는 웹뷰가 캔버스로 이미 줄여서 보낸다. 이건 **텍스트·바이너리까지 포함한
   * 마지막 방어선**이다 — 10MB 로그를 그대로 실으면 토큰이 폭발하고, 애초에
   * 에이전트가 받지도 못한다.
   */
  private static readonly MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

  /** sha256 → mimeType. 썸네일을 돌려줄 때 data: URI를 만들려면 필요하다 */
  private readonly mimeOf = new Map<string, string>();

  private async attachFromDisk(roomId: string, paths: string[]): Promise<void> {
    const items: Array<{ name: string; mimeType: string; data: Buffer; path: string }> = [];
    const rejected: string[] = [];

    for (const p of paths) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
        items.push({
          name: baseName(p),
          mimeType: mimeFromPath(p),
          data: Buffer.from(bytes),
          path: p,
        });
      } catch {
        rejected.push(`${baseName(p)} — 읽을 수 없습니다`);
      }
    }
    await this.storeAttachments(roomId, items, rejected);
  }

  private async storeAttachments(
    roomId: string,
    items: Array<{ name: string; mimeType: string; data: Buffer; path?: string }>,
    rejected: string[] = [],
  ): Promise<void> {
    const attachments: Attachment[] = [];
    const cwd = this.rooms.listMetas().find((r) => r.id === roomId)?.cwd ?? "";

    for (const it of items) {
      if (it.data.byteLength > ChatPanel.MAX_ATTACHMENT_BYTES) {
        rejected.push(`${it.name} — 너무 큽니다 (${(it.data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
        continue;
      }

      // **blob은 «무엇을 보냈나»의 기록이다.** 경로만 보내는 파일의 전문을 담아두면
      // 기록이 거짓말을 한다 — 에이전트는 프롬프트 시점의 파일을 읽는데 우리는
      // 첨부 시점 스냅샷을 들고 있게 된다. 해시는 계산하되 저장하지 않는다.
      const willSend = sendsContent(it, cwd);
      const sha256 = willSend
        ? await this.store.putBlob(it.data)
        : createHash("sha256").update(it.data).digest("hex");

      if (willSend) this.mimeOf.set(sha256, it.mimeType);
      attachments.push({
        sha256,
        mimeType: it.mimeType,
        name: it.name,
        byteSize: it.data.byteLength,
        ...(it.path ? { path: it.path } : {}),
      });
    }

    this.post({
      t: "attached",
      roomId,
      attachments,
      ...(rejected.length ? { rejected } : {}),
    });
  }

  /**
   * `roomId`를 주면 **그 방의 세션이 들고 있는 값**을, 없으면 에이전트 기본값을
   * 보낸다 (만들기 화면에는 아직 방이 없다).
   */
  /**
   * ★ **지금 쓸 수 있는 에이전트인가** (2026-10-01).
   *
   * 받지 않았으면 아니다. **로그인은 안 륌다** — 그건 붙을 때
   * 저쪽이 알려주고, 미리 막으면 «자격 파일은 있는데 만료된» 같은
   * 어림짐작 한 가지로 방을 통째로 막게 된다.
   *
   * `pkg` 가 없는 것은 항상 쓸 수 있다 — 사용자가 적은 것이다.
   */
  private isAvailable(a: AgentDef): boolean {
    if (!a.pkg) return true;
    return stateOf(a, this.ctx.globalStorageUri.fsPath, os.homedir()).state !== "none";
  }

  /**
   * ★ **CLI 가 말해준 로그인 상태** (2026-10-02).
   *
   * 파일이 있나는 어림짐작이라 CLI 에 직접 묻는다. 다만 그건
   * 프로세스를 띄우는 일이라 **그릴 때마다 물을 수는 없다** — 받는 중엔
   * npm 이 한 줄 뇴을 때마다 다시 그리므로 초당 여러 번이 된다.
   *
   * 그래서 **알던 값을 먼저 주고 뒤에서 갱신한다.** 갱신이 끝나면 목록을
   * 한 번 더 보낸다 — 화면은 잠깐 사이에 저절로 바뀜다.
   *
   * 🔴 **이제 진짜로 뒤에서 한다** (2026-10-13). 여기는 `setTimeout(…, 0)`
   * 안에서 `spawnSync` 를 돌리고 있었다 — 주석만 «뒤에서» 였지 콜백이 돌
   * 때 **확장 호스트의 한 가닥이 통째로 멈췄다.** 적어놓은 것과 하는 일이
   * 달라서 읽는 사람은 **이미 고쳐진 줄** 알았다.
   */
  private readonly authAt = new Map<string, { at: number; loggedIn: boolean }>();
  private authBusy = new Set<string>();

  /*
   * ★ **창을 열 때 한 번, 무조건 묻는다** (2026-10-13) — 아래 `askAuth`.
   *
   * 기한을 두는 까닭은 **꼬리** 다. `AUTH_MS`(20초) 를 그대로 쓰면 CLI 가
   * 멎었을 때 확인 화면에 20초를 앉아 있게 된다. 실측이 claude 0.3~0.4초 ·
   * codex 0.1초 라 **5초면 열 배 넘게 여유**고, 넘겼다는 것은 그 자체로
   * «뭔가 잘못됐다» 는 신호다 — 그때는 조용히 넘어가지 않고 **사람에게 묻는다.**
   */
  private authRows: AuthRow[] = [];
  private authAfter: "list" | "new" = "list";
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private authDone = false;
  /** 기한을 넘긴 채로 서 있나 — 웹뷰가 늦게 떴을 때 그대로 다시 보낸다 */
  private authStuck = false;
  /** 확인 화면을 **세웠나.** 안 세웠으면 보낼 것도 되돌릴 것도 없다 */
  private authShown = false;

  /**
   * ★ **낡은 것이 있으면 로봇 화면으로 보낸다** (2026-10-13).
   *
   * 🔴 여태 낡았다는 것을 **그 화면 안에서만** 말했다 — 띠도 뱃지도 알림도
   * 없다. 안 열어보면 영영 모르고, 그동안 **옛 어댑터가 멀쩡히 돈다.** 핀을
   * 올리는 까닭은 **새 모델**인데 사용자는 옛 모델에 묶인 채 알아챌 방법이
   * 없다(`docs/PIN.md` — «핀이 곧 모델 판»).
   *
   * ★ **막지는 않는다.** 모델이 없어진 것(`fix`)과 달리 **앱은 멀쩡히 돈다** —
   * 급한 사람에게 398MB 받기를 강요할 일이 아니다. 단추는 그 화면에 이미
   * 있으니 **띄워주는 것까지**만 하고, 뒤로 가면 그만이다.
   *
   * 보는 것은 파일뿐이라(`stateOf`) **CLI 를 안 띄운다.**
   */
  /** 확인이 끝났을 때 **어디로 보낼까** — 규칙은 코어에 있다(`landingFor`) */
  private landing(): "list" | "new" | "agents" {
    return landingFor(
      this.agents(), this.ctx.globalStorageUri.fsPath, os.homedir(), this.authAfter,
    );
  }

  /** 확인할 줄 — **에이전트 목록에서 저절로** 나온다 (`authPlan`) */
  private authSeed(): AuthRow[] {
    return authPlan(this.agents(), this.ctx.globalStorageUri.fsPath, os.homedir()).map(
      (p): AuthRow =>
        p.how === "ask"
          ? { id: p.id, label: p.label, at: "asking" }
          : { id: p.id, label: p.label, at: p.guess ? "yes" : "no", guessed: true },
    );
  }

  /**
   * ★ **물어본다 — 못 물어본 것만 다시** (2026-10-13).
   *
   * 🔴 **나란히 묻는다.** 차례로 물으면 에이전트가 늘수록 기한에 가까워진다.
   */
  askAuth(): void {
    if (this.authDone || this.authRows.length === 0) return;
    clearTimeout(this.authTimer);
    const todo = this.authRows.filter((r) => r.at === "asking" || r.at === "failed");
    if (todo.length === 0) { this.authFinish(); return; }
    for (const r of todo) r.at = "asking";
    this.postAuth(false);

    const root = this.ctx.globalStorageUri.fsPath;
    for (const row of todo) {
      const cmd = this.agents().find((a) => a.id === row.id)?.pkg?.auth?.status;
      if (!cmd) { row.at = "failed"; continue; }
      void authStatus(dirFor(root, row.id), cmd)
        .catch(() => undefined)
        .then((got) => {
          if (this.authDone) return;
          row.at = got ? (got.loggedIn ? "yes" : "no") : "failed";
          // 받은 답은 **캐시에도 넣는다** — 곧 그릴 목록이 다시 묻지 않게
          if (got) this.authAt.set(row.id, { at: Date.now(), loggedIn: got.loggedIn });
          if (this.authRows.every((r) => r.at !== "asking")) this.authFinish();
          else this.postAuth(false);
        });
    }
    // 아직 물어볼 것이 남았으면 기한을 건다
    if (this.authRows.some((r) => r.at === "asking")) {
      this.authTimer = setTimeout(() => {
        if (this.authDone) return;
        // **조용히 안 넘어간다** — 다시 해볼지 들어갈지는 사람이 고른다
        this.postAuth(true);
      }, AUTH_WAIT_MS);
    } else {
      this.authFinish();
    }
  }

  /** 확인이 끝났다 — **진짜 값으로** 목록을 보내고 원래 가려던 화면으로 */
  private authFinish(): void {
    if (this.authDone) return;
    this.authDone = true;
    clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.postAuth(false);
    this.sendAgents();
    this.post({ t: "nav", screen: this.landing() });
  }

  private postAuth(stuck: boolean): void {
    this.authStuck = stuck;
    this.post({ t: "auth", list: this.authRows.map((r) => ({ ...r })), stuck });
  }

  /**
   * ★ **웹뷰가 떴다 — 들고 있던 것을 다시 준다** (2026-10-13).
   *
   * 🔴 확인이 **0.1초에 끝날 수도** 있다. 그러면 `auth` 와 `nav` 가 웹뷰
   * 스크립트보다 먼저 나가고 **그냥 사라진다** — 사용자는 확인 화면에
   * 영영 갇힌다. 첫 그림(`Boot`)이 `screen` 을 싣는 것과 같은 구멍이고,
   * 이쪽은 **끝나는 시각이 경주**라 첫 그림으로는 못 막는다.
   */
  /** 확인 화면이 없을 때의 길 — 낡았으면 로봇 화면으로 */
  navIfStale(): void {
    if (this.landing() === "agents") this.post({ t: "nav", screen: "agents" });
  }

  private onReady(): void {
    // 🔴 **안 세웠으면 `authAfter` 로 안 되돌린다** — 여기서 그걸 보내면
    // «새 대화방» 으로 연 사람의 만들기 화면이 **다시 열리면서 적던 것이
    // 날아간다.** 낡음 안내는 얹는 것이라(`push`) 적던 것을 안 건드린다.
    if (!this.authShown) { this.navIfStale(); return; }
    if (this.authDone) this.post({ t: "nav", screen: this.landing() });
    else this.postAuth(this.authStuck);
  }

  private authOf(a: AgentDef): { loggedIn: boolean } | undefined {
    const cmd = a.pkg?.auth?.status;
    if (!cmd) return undefined;
    const got = this.authAt.get(a.id);
    const stale = !got || Date.now() - got.at > 15000;
    if (stale && !this.authBusy.has(a.id)) {
      this.authBusy.add(a.id);
      const dir = dirFor(this.ctx.globalStorageUri.fsPath, a.id);
      // 🔴 **`catch` 를 앞에 둔다** — 여기서 새면 `authBusy` 가 영영 안 풀려
      // 로그인 표시가 **그 창이 닫힐 때까지** 굳는다
      void authStatus(dir, cmd)
        .catch(() => undefined)
        .then((r) => {
          this.authBusy.delete(a.id);
          if (!r) return;
          const was = this.authAt.get(a.id);
          this.authAt.set(a.id, { at: Date.now(), ...r });
          if (!was || was.loggedIn !== r.loggedIn) this.sendAgents();
        });
    }
    return got ? { loggedIn: got.loggedIn } : undefined;
  }

  /**
   * ★ **받기·지우기·로그인이 도는 중인 에이전트와 그 마지막 줄** —
   * 패널이 아니라 **확장에** 둔다 (2026-10-13).
   *
   * 🔴 여기가 패널 객체에 붙어 있었다. 그런데 **탭을 닫아도 npm 은 계속
   * 돈다** — 아무도 안 멈추니까. 다시 열면 새 패널의 이 칸이 **비어 있어서**:
   *
   * ```
   * 실제   npm 이 돌고 있다
   * 화면   「설치하기」 단추      ← 아직 안 깔렸으니까
   * ```
   *
   * 그리고 그걸 누르면 **두 번 받는다.** 중복을 막는 빗장이 바로 이 칸인데
   * (`busy.has`) 새 패널에선 안 걸린다 — 같은 자리에 `npm install` 이 둘
   * 돌면 `node_modules` 가 깨진다.
   *
   * **살아 있어야 할 것은 「일」과 같은 수명**이어야 한다. 보는 창이 아니라.
   *
   * ⚠️ 창을 다시 불러오면(Ctrl+R) 확장이 통째로 새로 뜨므로 거기까진 못
   * 지킨다 — 그건 따로 볼 문제다.
   */
  private static readonly busy = new Map<string, string>();
  /** 같은 오류 팝업을 언제 띄웠나 — 줄지어 쌓이지 않게 (`popupDue`) */
  private static readonly popped = new Map<string, number>();

  /**
   * ★ **에이전트마다 지금 어느 칸에 있나** (2026-10-01).
   *
   * 계산은 전부 `agentInstaller.stateOf` 가 한다 — 여기서 다시 판단하지
   * 않는다. 두 자리에서 같은 규칙을 써놓으면 언젠가 갈라진다.
   */
  sendAgents(): void {
    const root = this.ctx.globalStorageUri.fsPath;
    const home = os.homedir();
    this.post({
      t: "agents",
      list: this.agents().map((a) => {
        const st = stateOf(a, root, home);
        const busy = ChatPanel.busy.get(a.id);
        /* CLI 가 말해주면 그걸 쓴다 — 파일 존재보다 참말이다 */
        const auth = st.state === "none" ? undefined : this.authOf(a);
        const loggedIn = auth ? auth.loggedIn : st.loggedIn;
        return {
          id: a.id,
          label: a.label,
          managed: a.pkg !== undefined,
          available: this.isAvailable(a),
          state: st.state === "needLogin" || st.state === "ready"
            ? (loggedIn ? "ready" : "needLogin")
            : st.state,
          ...(st.version ? { version: st.version } : {}),
          ...(st.wanted ? { wanted: st.wanted } : {}),
          size: st.size,
          loggedIn,
          canLogout: a.pkg?.auth?.logout !== undefined || a.pkg?.auth?.acp === true,
          viaAcp: a.pkg?.auth?.acp === true,
          ...(busy ? { busy } : {}),
        };
      }),
    });
  }

  /**
   * 받기·지우기·로그인·로그아웃.
   *
   * ① **끝날 때마다 목록을 다시 보낸다.** 단추가 상태에서 나오므로 화면이
   *    제손으로 상태를 짐작하지 않게 한다.
   * ② **로그인은 터미널로 띄운다.** 브라우저가 열리고 코드를 붙여넣는
   *    흐름이라 우리 창 안에서 할 수 없다. Codex 는 ACP 가 `chat-gpt` 를
   *    광고하므로 나중엔 앱 안에서도 된다(백로그).
   */
  private async agentDo(
    agentId: string,
    what: "install" | "remove" | "login" | "logout",
  ): Promise<void> {
    const agent = this.agents().find((a) => a.id === agentId);
    if (!agent?.pkg) return;
    const root = this.ctx.globalStorageUri.fsPath;
    const dir = dirFor(root, agent.id);

    if (what === "install") {
      if (ChatPanel.busy.has(agent.id)) return;
      /*
       * 🔴 **창 안의 빗장만으로는 모자란다** (2026-10-14). `ChatPanel.busy` 는
       * 이 창의 것이고 받아두는 자리는 **창끼리 공유**다(globalStorage) —
       * 두 창에서 같이 누르면 같은 폴더에 둘이 쓴다. 디스크에 적는 빗장으로
       * 막는다(죽은 창의 자리는 빼앗으므로 껐다 켜면 풀린다).
       */
      const mine = holdInstall(
        dir,
        vscode.workspace.workspaceFolders?.[0]?.name ?? "다른 창",
        (m) => this.rooms.log(m),
      );
      if (!mine.ok) {
        void vscode.window.showWarningMessage(
          `${agent.label}을(를) 「${mine.held.window}」 창에서 받는 중입니다.`);
        return;
      }
      ChatPanel.busy.set(agent.id, "준비하는 중…");
      ChatPanel.repaintAgents();
      try {
        const r = await install(dir, agent.pkg, realNpm, (line: string) => {
          ChatPanel.busy.set(agent.id, line.slice(0, 120));
          ChatPanel.repaintAgents();
          // ★ 출력 창에도 남긴다 (2026-10-23) — 화면 표시로만 흘러가면 멈췄을 때 까닭을 볼 길이 없다
          this.rooms.log(`[${agent.id}] 받기: ${line}`);
        });
        this.rooms.log(`[${agent.id}] 받기 ${r.ok ? "끝" : "실패"} — ${r.say.split("\n").filter(Boolean).at(-1) ?? ""}`);
        if (!r.ok) {
          void vscode.window.showErrorMessage(
            `${agent.label}을(를) 받지 못했습니다: ${r.say.slice(-300)}`);
        }
      } finally {
        // **성공이든 실패든 푼다** — 안 풀면 그 창이 살아 있는 동안 아무도 못 받는다
        freeInstall(dir);
        ChatPanel.busy.delete(agent.id);
        this.refreshAgents();
        ChatPanel.repaintAgents();
      }
      return;
    }

    if (what === "remove") {
      /*
       * 🔴 **돌던 CLI 를 먼저 내린다** (2026-10-06).
       *
       * 윈도우에선 떠 있는 실행파일을 못 지운다 — Antigravity 를
       * 받아 띄우고 바로 지우려 했더니 `EPERM: operation not permitted,
       * unlink …agy_acp_server.exe` 가 났다(probe 에서 드러났다).
       *
       * 로그아웃과 같은 이유다 — 지우는 것과 도는 것은 같이 못 있는다.
       */
      if (ChatPanel.busy.has(agent.id)) return;
      /*
       * ★ **지우는 동안에도 보여준다** (2026-10-06).
       *
       * 사용자: *"에이전트 제거중에 뭔가 표시가 있으면 좋겠어
       * 지워지고 있는건지 모르겠네"*.
       *
       * Antigravity 는 398MB 라 지우는 데도 시간이 걸리고, 떠 있으면
       * 몇 번 기다렸다 다시 해본다. 그 사이 화면이 아무 말도 안 하면
       * **누른 것이 먹혔나** 싶어 또 누르게 된다 — 들어오자마자 막는다.
       */
      /* 받는 중인 폴더를 지우면 **반쯤 받은 것**이 남는다 — 같은 빗장을 건다 */
      const held = holdInstall(
        dir,
        vscode.workspace.workspaceFolders?.[0]?.name ?? "다른 창",
        (m) => this.rooms.log(m),
      );
      if (!held.ok) {
        void vscode.window.showWarningMessage(
          `${agent.label}을(를) 「${held.held.window}」 창에서 받는 중입니다.`);
        return;
      }
      ChatPanel.busy.set(agent.id, "지우는 중…");
      ChatPanel.repaintAgents();
      this.rooms.dropConnection(agent.id);
      try {
        await remove(dir);
      } catch (err) {
        /* 반만 지운 걸 «지웠다» 고 하면 다음에 잎어 읽는다 — 말해준다 */
        void vscode.window.showErrorMessage(
          `${agent.label}을(를) ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        freeInstall(dir);
        ChatPanel.busy.delete(agent.id);
        this.refreshAgents();
        ChatPanel.repaintAgents();
      }
      return;
    }

    /*
     * ★ **로그인이 바뀌면 적어둔 모델 목록을 버린다** (2026-10-13).
     *
     * 🔴 목록이 **계정에 따라 다를 수 있다** — 안 쟀다. 판만 열쇠로 쓰면
     * 계정을 바꿨을 때 낡은 목록이 남는다. 자격 파일의 시각은 **토큰이
     * 갱신될 때마다 바뀌어서**(실측) 열쇠로 못 쓰고, 계정 이름은 Codex 가
     * 안 준다. 그러니 **우리가 아는 사건**에 묶는다 — 여기가 그 자리다.
     *
     * 터미널에서 몰래 바꾸는 것은 못 잡지만, 그때도 방 세션이 진짜 목록을
     * 주고(`noteRoomConfig`) 없는 모델을 골랐으면 `fix` 가 막아선다.
     */
    void dropOptions(dir);

    /* 터미널로 띄울 게 아니라 **저쪽에게 시키는** 에이전트가 있다 */
    if (agent.pkg.auth?.acp) { await this.authViaAcp(agent, what); return; }

    const cmd = what === "login" ? agent.pkg.auth?.login : agent.pkg.auth?.logout;
    if (!cmd) return;
    const found = cmdPath(dir, cmd);
    if (!found) {
      void vscode.window.showErrorMessage(
        `${agent.label}의 명령을 찾지 못했습니다. 먼저 받아주세요.`);
      return;
    }
    /*
     * 🔴 **셌에 글을 불러주지 않는다 — 그 명령 자체를 터미널로 띄운다**
     * (2026-10-06).
     *
     * 예전엔 터미널을 열고 `"경로" 인자` 를 글로 보냈다. 그러면
     * **어느 셌이냐에 따라 문법이 달라진다.** 사용자가 PowerShell 에서 받은 글:
     *
     * ```
     * 식 또는 문에서 예기치 않은 'logout' 토큰입니다.
     * ```
     *
     * PowerShell 은 따옴표로 시작하는 줄을 **글자열로** 읽어서, 부르려면
     * `&` 가 앞에 붙어야 한다. 그런데 cmd.exe 에선 `&` 가 명령 구분자라
     * 거꾸로 깨진다 — **어느 쪽을 골라도 나머지가 깨진다.**
     *
     * `shellPath` 로 주면 VSCode 가 **그 프로세스를 터미널로 직접 띄운다.**
     * 셌이 없으니 문법도 없고, 공백 든 경로도 따옴표 없이 그대로 간다.
     * 더거다 로그인은 **진짜 pty** 가 필요한 일인데 이쪽이 더 가깝다.
     */
    const term = vscode.window.createTerminal({
      name: `${agent.label} ${what}`,
      cwd: dir,
      shellPath: found.exe,
      shellArgs: found.args,
    });
    term.show();
    /* 띄우는 것만으로 안 끝나는 CLI 가 있다 — 무엇을 더 해야 하는지 말해준다 */
    if (cmd.say) void vscode.window.showInformationMessage(`${agent.label}: ${cmd.say}`);
    /*
     * ★ **터미널이 닫히면 바로 다시 본다** (2026-10-02).
     *
     * 예전엔 20초 뒤 한 번이 전부였다 — 브라우저 로그인이 그보다 오래
     * 걸리면 화면이 낡은 채로 남았다.
     */
    const done = vscode.window.onDidCloseTerminal((t) => {
      if (t !== term) return;
      done.dispose();
      this.authAt.delete(agent.id);
      ChatPanel.repaintAgents();
    });
    /*
     * 끝난 줄 모르므로 잠시 뒤에 한 번 더 본다. 자격 파일이 생기면 단추가
     * 알아서 바뀐다 — 사용자가 화면을 다시 열지 않아도 된다.
     */
    /* 닫지 않고 내버려두는 사람도 있다 — 한 번은 스스로 다시 본다 */
    setTimeout(() => { this.authAt.delete(agent.id); ChatPanel.repaintAgents(); }, 20000);
  }

  /**
   * ★ **ACP 로 들어가고 나온다** (2026-10-07).
   *
   * 터미널 길과 다른 점은 **끄는 순간을 우리가 안다**는 것이다 —
   * `authenticate` 가 돌아오면 된 것이다. 그래서 끝나자마자 단추를
   * 다시 그린다.
   *
   * ⚠️ **주소도 같이 보여준다.** 저쪽이 브라우저를 열긴 하는데
   * 원격·컨테이너처럼 **안 열리는 자리가 있다.** 그때 주소가
   * stderr 에만 있으면 사람은 «멈켔4다» 고만 본다.
   */
  private async authViaAcp(agent: AgentDef, what: "login" | "logout"): Promise<void> {
    if (ChatPanel.busy.has(agent.id)) return;
    try {
      if (what === "logout") {
        ChatPanel.busy.set(agent.id, "로그아웃하는 중…");
        ChatPanel.repaintAgents();
        const did = await this.rooms.logOutOf(agent.id);
        if (!did) {
          void vscode.window.showWarningMessage(
            `${agent.label}은(는) 로그아웃을 지원하지 않습니다.`);
          return;
        }
        /* 돌던 것을 내린다 — 그대로 두면 옆 계정으로 계속 돌아간다 */
        this.rooms.dropConnection(agent.id);
        return;
      }

      /*
       * 🔴 **누르자마자 말해준다** (2026-10-07).
       *
       * 예전엔 길을 고른 뒤에야 `busy` 를 세웠다. 그런데 그 앞에
       * **ACP 서버를 띄우는 몇 초**가 있다(Antigravity 는 파이썬이라
       * 더 걸린다). 그 사이 화면은 아무 말도 안 했다 — 사용자:
       * *"창이 뜨기까지 시간이 걸리는데 되고있는건지 잘 모르겠네"*.
       */
      ChatPanel.busy.set(agent.id, "로그인 길을 물어보는 중…");
      ChatPanel.repaintAgents();
      const ways = await this.rooms.authOptionsOf(agent.id);
      if (ways.length === 0) {
        void vscode.window.showErrorMessage(
          `${agent.label}이(가) 로그인 길을 알려주지 않습니다.`);
        return;
      }
      let way = ways[0]!;
      if (ways.length > 1) {
        /* 넷을 내놓는 에이전트도 있다 — 골라야 한다 */
        const chosen = await vscode.window.showQuickPick(
          ways.map((m) => ({ label: m.name, detail: m.description, id: m.id })),
          { title: `${agent.label} 로그인`, placeHolder: "어느 길로 들어갈까요" },
        );
        if (!chosen) return;
        way = ways.find((m) => m.id === chosen.id)!;
      }

      ChatPanel.busy.set(agent.id, `${way.name} — 브라우저를 기다리는 중…`);
      ChatPanel.repaintAgents();
      await this.rooms.authenticateAs(agent.id, way.id, (line) => {
        const at = /https?:\/\/\S+/.exec(line);
        if (!at) return;
        const url = at[0];
        void (async () => {
          const p = await vscode.window.showInformationMessage(
            `${agent.label}: 브라우저가 안 열렸다면 이 주소로 들어가세요.`,
            "열기", "복사",
          );
          if (p === "열기") await vscode.env.openExternal(vscode.Uri.parse(url));
          else if (p === "복사") await vscode.env.clipboard.writeText(url);
        })();
      });
      void vscode.window.showInformationMessage(`${agent.label} 로그인을 마쳤습니다.`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `${agent.label} ${what === "login" ? "로그인" : "로그아웃"}에 실패했습니다 — ` +
          `${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ChatPanel.busy.delete(agent.id);
      this.authAt.delete(agent.id);
      ChatPanel.repaintAgents();
    }
  }

  private async sendConfig(agentId: string, roomId?: string, botId?: string): Promise<void> {
    try {
      /*
       * 🔴 **`agentId` 를 버리고 있었다.** `roomId` 만 있으면 무조건
       * `roomConfigOptions(roomId)` 를 불렀는데, 그건 방의 **첫 봇**을 보므로
       * — 단체방에서 Codex의 설정을 물어도 **Claude 것이 Codex 이름표를 달고**
       * 돌아왔다. 아직 방에 없는 에이전트를 미리 볼 때도 마찬가지였다.
       *
       * 봇을 지목했을 때만 방 안을 보고, 아니면 **에이전트 기본값**을 준다.
       */
      const options = roomId && botId
        ? await this.rooms.roomConfigOptions(roomId, botId)
        : await this.rooms.configOptions(agentId);
      this.post({
        t: "config",
        agentId,
        ...(roomId && botId ? { roomId, botId } : {}),
        options: options.map(brief),
      });
    } catch (err) {
      // 에러 문구만 보여주면 뭐를 해야 하는지 모른다 (A8)
      /*
       * ★ **안 받은 에이전트엔 설치 안내를 붙이지 않는다** (2026-10-02).
       *
       * 그 안내는 **로그인**에 대한 말이다(«Node 20+ · 한 번 로그인해
       * 두세요»). 그런데 안 받은 상태의 오류는 이미 «로봇 아이콘에서
       * 받으세요» 라고 말하므로, 둘을 같이 보여주면 **두 가지를 시키는
       * 셌이 된다** — 사용자는 무엇부터 해야 하는지 알 수 없다.
       *
       * 받고 나면 로그인 차례고, 그때는 이 안내가 맞는 말이 된다.
       */
      const reason = err instanceof Error ? err.message : String(err);
      this.post({
        t: "config",
        agentId,
        ...(roomId && botId ? { roomId, botId } : {}),
        options: [],
        error: reason,
      });
    }
  }

  /** 패널이 안 보이면 활성 방을 놓는다 — 그래야 미읽음이 쌓인다 */
  private async syncActive(): Promise<void> {
    const looking = this.panel.visible ? this.openRoomId : null;
    await this.rooms.setActiveRoom(looking);
  }

  // ── 웹뷰로 보내는 것 ───────────────────────────────────────────────────

  private postRoom(room: Room): void {
    this.post({
      t: "room",
      room,
      ...(() => {
        const id = this.rooms.firstUnreadId(room);
        return id ? { firstUnreadId: id } : {};
      })(),
      compactable: this.rooms.compactCommand(room.id) !== undefined,
      compactableBots: this.rooms.compactableBots(room.id),
    });
    this.post({ t: "reviews", roomId: room.id, list: this.rooms.reviewsIn(room.id) });
    this.post({ t: "waiting", roomId: room.id, list: this.rooms.waitingIn(room.id) });
    this.post({ t: "clashes", roomId: room.id, list: this.rooms.clashesIn(room.id) });
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  // ── HTML ──────────────────────────────────────────────────────────────

  /**
   * **목록을 HTML에 박아서 내보낸다** (F8).
   *
   * 웹뷰가 뜬 뒤에 `postMessage`로 목록을 요청하면 그 왕복 동안 빈 화면이
   * 한 프레임 보인다. `rooms.json`은 이미 메모리에 있으므로 기다릴 이유가 없다.
   */
  private html(screen: "list" | "new" | "auth"): string {
    const w = this.panel.webview;
    const asset = (...parts: string[]) =>
      w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...parts));

    const boot: Boot = {
      rooms: this.rooms.listMetas(),
      ...(screen === "auth" ? { auth: this.authRows.map((r) => ({ ...r })) } : {}),
      agents: this.agents().map(
        (a): AgentBrief => ({
          id: a.id,
          label: a.label,
          ...(a.description ? { description: a.description } : {}),
          available: this.isAvailable(a),
        }),
      ),
      reducedMotion: false,
      screen,
      cwd: this.rooms.defaultCwd(),
      hasWorkspace: this.rooms.hasWorkspace(),
    };

    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} data:`,
      `style-src ${w.cspSource}`,
      `font-src ${w.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("media", "codicon.css")}">
<link rel="stylesheet" href="${asset("dist", "webview.css")}">
<title>AI in One</title>
</head>
<body>
<div id="app">
  <section class="screen" id="screen-list"${screen === "auth" ? "" : " data-active"}>
    <header class="bar">
      <h1>AI in One</h1>
      <button class="icon" id="btn-agents" title="에이전트 설정"><i class="codicon codicon-robot"></i></button>
      <button class="icon" id="btn-new" title="새 대화방"><i class="codicon codicon-add"></i></button>
    </header>
    <div class="filter"><i class="codicon codicon-search"></i><input type="text" id="filter" placeholder="방 이름·대화 내용 찾기" spellcheck="false"><button class="icon" id="only-here" title="이 프로젝트의 방만 보기" aria-pressed="false"><i class="codicon codicon-filter"></i></button></div>
    <div class="rooms" id="rooms">${roomListHtml(boot)}</div>
  </section>

  <section class="screen" id="screen-new"></section>
  <section class="screen" id="screen-chat"></section>
  <section class="screen" id="screen-fix"></section>
  <section class="screen" id="screen-agents"></section>
  <!-- 🔴 **첫 그림이 곧 확인 화면**이어야 한다 — 스크립트가 돈 뒤에 덮으면 번쩍인다 -->
  <section class="screen" id="screen-auth"${screen === "auth" ? " data-active" : ""}></section>
</div>
<script type="application/json" id="boot" nonce="${nonce}">${jsonForHtml(boot)}</script>
<script nonce="${nonce}" src="${asset("dist", "webview.js")}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    // 창이 닫힌 뒤에 깨어나 죽은 웹뷰에 쓰면 안 된다
    clearTimeout(this.authTimer);
    this.authDone = true;
    this.onTarget(null);

    /*
     * 🔴 **카드를 안 거둔다** (2026-10-13).
     *
     * 여기서 전부 취소로 풀어주고 있었다. 카드가 패널에 붙어 있어서, 안
     * 풀면 답할 사람이 사라져 봇이 영영 멈추기 때문이었다.
     *
     * 이제 카드는 **확장**에 있다(`ChatPanel.pending`). 탭을 닫은 것은
     * **보기를 그만둔 것**이지 그 일을 무르겠다는 뜻이 아니므로, 그대로
     * 기다리게 두고 **다시 열 때 돌려준다**(`show` 의 되살리기).
     */

    void this.rooms.setActiveRoom(null);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function brief(o: acp.SessionConfigOption): ConfigOptionBrief {
  const values =
    o.type === "select"
      ? o.options.flatMap((entry) =>
          // 선택지는 평평할 수도, 그룹으로 묶여 올 수도 있다. 화면에서는 한 목록으로 편다.
          "group" in entry
            ? entry.options.map((v) => ({
                id: v.value,
                name: `${entry.name} · ${v.name}`,
                ...(v.description ? { description: v.description } : {}),
              }))
            : [
                {
                  id: entry.value,
                  name: entry.name,
                  ...(entry.description ? { description: entry.description } : {}),
                },
              ],
        )
      : undefined;

  return {
    configId: o.id,
    name: o.name,
    ...(o.category ? { category: o.category } : {}),
    ...(o.currentValue !== undefined ? { current: o.currentValue } : {}),
    ...(values ? { values } : {}),
  };
}


/** `</script>`가 방 제목에 들어 있으면 스크립트 태그가 일찍 닫힌다 */
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** 확장자로 대충 고른다. 정확한 판별은 필요 없다 — 이미지/텍스트만 갈리면 된다 */
function mimeFromPath(p: string): string {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  const image: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  };
  if (image[ext]) return image[ext]!;
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return `audio/${ext}`;
  if (ext === "pdf") return "application/pdf";
  return "text/plain";
}

/** 부르는 쪽에게 보여줄 한 줄 */
function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

