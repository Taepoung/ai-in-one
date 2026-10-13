/**
 * 확장 번들이 실제로 로드되고 activate가 도는지 본다.
 *
 * VSCode 밖이므로 `vscode` 모듈을 가짜로 끼워 넣는다. 화면은 못 보지만
 * **명령 등록·상태 표시줄·웹뷰 HTML 생성까지**는 여기서 다 확인된다.
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

// 저장소 안에서 스스로 위치를 찾는다 — 절대경로를 박으면 남의 기계에서 안 돈다
const ROOT = require("node:path").resolve(__dirname, "..");
const ok = (c, m) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ok -", m);
};

const registered = new Map();
const providers = new Map();
const executed = [];
const listeners = new Map();
let panelOpts = null;
let panelHtml = "";
const posted = [];
let webviewOnMessage = null;

const noopDisposable = { dispose() {} };
const emitter = () => {
  const fns = [];
  const on = (fn) => (fns.push(fn), noopDisposable);
  on.fire = (...a) => fns.forEach((f) => f(...a));
  return on;
};

const fakeVscode = {
  /*
   * ★ **받는 자리를 감시한다** (2026-10-07).
   *
   * 창이 여럿이어도 같이 움직이게 하려고 `createFileSystemWatcher` 를 건다.
   * 가짜에 없으면 `activate` 가 통째로 터진다 — 실제로 그렇게 깨졌다
   * (`RelativePattern is not a constructor`).
   *
   * 진짜로 감시하지는 않는다. 여기서 재는 것은 **켜지는가** 이고,
   * 감시가 무엇을 하는지는 사람이 F5 로 본다.
   */
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file", toString: () => `file://${p}` }),
    from: (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }),
    joinPath: (base, ...parts) => ({
      fsPath: path.join(base.fsPath, ...parts),
      toString: () => `file://${path.join(base.fsPath, ...parts)}`,
    }),
    parse: (s) => ({ toString: () => s }),
  },
  ViewColumn: { Beside: -2, One: 1 },
  StatusBarAlignment: { Right: 2 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = emitter();
    }
  },
  window: {
    /*
     * 🔴 **진짜 API 에 있는 것을 빠뜨리면 거기서 터진다.** `show` 가 없어서
     * 켜기 실패 안내가 통째로 깨졌다(2026-10-13) — 머리말이 경고한 바로 그
     * 부류다. 쓰는 것만 넣지 말고 **쓸 법한 것**을 넣어둔다.
     */
    createOutputChannel: () => ({
      appendLine: () => {}, append: () => {},
      show: () => {}, hide: () => {}, clear: () => {},
      replace: () => {}, dispose: () => {},
    }),
    createStatusBarItem: () => ({
      show: () => {},
      dispose: () => {},
      set text(v) {
        this._text = v;
      },
      get text() {
        return this._text;
      },
    }),
    createWebviewPanel: (_id, _title, opts, options) => {
      panelOpts = { opts, options };
      return {
        webview: {
          cspSource: "vscode-webview://x",
          asWebviewUri: (u) => ({ toString: () => `https://webview/${path.basename(u.fsPath)}` }),
          set html(v) {
            panelHtml = v;
          },
          get html() {
            return panelHtml;
          },
          onDidReceiveMessage: (fn) => ((webviewOnMessage = fn), noopDisposable),
          postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        },
        onDidDispose: () => noopDisposable,
        onDidChangeViewState: () => noopDisposable,
        reveal: () => {},
        visible: true,
        dispose: () => {},
        set iconPath(v) {},
      };
    },
    showErrorMessage: (m) => (errors.push(String(m)), Promise.resolve(undefined)),
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT } }],
    createFileSystemWatcher: () => ({
      onDidCreate: () => noopDisposable,
      onDidChange: () => noopDisposable,
      onDidDelete: () => noopDisposable,
      dispose: () => {},
    }),
    textDocuments: [],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => noopDisposable,
    fs: {
      readFile: async (u) => new TextEncoder().encode("hello from " + u.fsPath),
      writeFile: async () => {},
    },
    applyEdit: async () => true,
    registerTextDocumentContentProvider: (scheme, provider) => {
      providers.set(scheme, provider);
      return noopDisposable;
    },
  },
  commands: {
    registerCommand: (id, fn) => (registered.set(id, fn), noopDisposable),
    executeCommand: async (...args) => { executed.push(args); },
  },
  env: { openExternal: async () => true },
  Disposable: class {},
  WorkspaceEdit: class {
    replace() {}
  },
  Range: class {},
  Position: class {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return origLoad.call(this, request, parent, isMain);
};

/** 확장이 답을 보낼 때까지 잠깐 기다린다 */
async function waitFor(pick, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const got = pick();
    if (got) return got;
    if (Date.now() > until) throw new Error("FAIL: 응답이 오지 않았습니다");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 켜기가 터졌을 때 사용자에게 간 글 */
const errors = [];

async function main() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "aio-shell-"));
  const ext = require(path.join(ROOT, "dist", "extension.js"));

  console.log("\n[번들이 로드되고 activate가 돈다]");
  ok(typeof ext.activate === "function", "activate를 내보낸다");
  const subs = [];
  await ext.activate({
    globalStorageUri: { fsPath: storage },
    extensionUri: { fsPath: ROOT },
    subscriptions: subs,
  });
  ok(subs.length > 0, "정리 대상이 등록됨");
  ok(registered.has("aiInOne.open"), "aiInOne.open 등록됨");
  ok(registered.has("aiInOne.newRoom"), "aiInOne.newRoom 등록됨");

  console.log("\n[🔴 켜기가 터져도 명령은 있다 — «없는 명령» 으로 끝나지 않는다]");
  {
    /*
     * 🔴 여태 `activate` 의 **맨 끝**에서 명령을 등록했다. 그 앞이 하나라도
     * 터지면 사용자에게 남는 것은 `command 'aiInOne.open' not found` 뿐이고,
     * **왜 안 되는지가 한 글자도 없다.** 실제로 한 번 그랬다(F5, 2026-10-13).
     *
     * 여기서는 **저장 자리에 파일을 놓아** 진짜로 터뜨린다 — 흉내가 아니라
     * 같은 고장이어야 «그래도 명령이 사나» 를 잴 수 있다.
     */
    const bad = path.join(os.tmpdir(), `aio-shell-bad-${Date.now()}`);
    fs.writeFileSync(bad, "나는 폴더가 아니다");
    registered.clear();
    errors.length = 0;
    await ext.activate({
      globalStorageUri: { fsPath: bad },
      extensionUri: { fsPath: ROOT },
      subscriptions: [],
    });
    ok(registered.has("aiInOne.open"),
       "★ **터져도 aiInOne.open 은 있다** — 명령부터 등록하기 때문");
    registered.get("aiInOne.open")();
    ok(errors.some((m) => m.includes("켜지 못했습니다")),
       `★ **왜 안 되는지 말해준다** (${errors[0] ?? "(없음)"})`);
    ok(errors.some((m) => m.includes("Ctrl+R")),
       "★ **무엇을 해보면 되는지도** — 창을 다시 불러오면 대개 풀린다");
    fs.rmSync(bad, { force: true });
  }

  // 그 뒤의 검사들은 **멀쩡히 켜진 판**을 본다 — 다시 켠다
  registered.clear();
  await ext.activate({
    globalStorageUri: { fsPath: storage },
    extensionUri: { fsPath: ROOT },
    subscriptions: subs,
  });

  console.log("\n[채팅을 열면 패널이 하나 뜬다]");
  registered.get("aiInOne.open")();
  ok(panelOpts !== null, "웹뷰 패널 생성됨");
  ok(panelOpts.opts.viewColumn === fakeVscode.ViewColumn.Beside, "에디터 오른쪽에 연다");
  ok(panelOpts.options.retainContextWhenHidden === true, "숨겨도 상태를 지킨다");
  ok(panelOpts.options.enableScripts === true, "스크립트 허용");

  console.log("\n[첫 프레임에 목록이 들어 있다 — F8]");
  ok(panelHtml.includes('id="boot"'), "boot 상태가 HTML에 박혀 있다");
  ok(panelHtml.includes('id="rooms"'), "목록 컨테이너가 있다");
  ok(panelHtml.includes("아직 대화가 없습니다"), "빈 상태가 서버에서 이미 그려져 있다");
  ok(/Content-Security-Policy/.test(panelHtml), "CSP가 있다");
  ok(/script-src 'nonce-[A-Za-z0-9]{32}'/.test(panelHtml), "nonce로 스크립트를 제한한다");
  ok(!panelHtml.includes("unsafe-inline"), "unsafe-inline 없음");

  const bootJson = panelHtml.match(/<script type="application\/json" id="boot"[^>]*>(.*?)<\/script>/s)[1];
  const boot = JSON.parse(bootJson);
  ok(Array.isArray(boot.rooms) && boot.rooms.length === 0, "방 목록이 비어 있다");
  // 🔴 Gemini 는 **기본 목록에서 뺐다** — 구독으로 쓰는 길이 막혀 §0 P3 를
  //    이 에이전트에서만 못 지킨다. 사용자 설정으로는 여전히 넣을 수 있다.
  // ★ Antigravity 를 더했다 (2026-10-06) — npm 이 아니라 **zip 을 받는** 첫 꼴이다.
  ok(boot.agents.length === 3, `기본 에이전트 셋 (${boot.agents.map((a) => a.id).join()})`);
  ok(boot.agents.every((a) => !("command" in a)), "실행 명령은 웹뷰로 보내지 않는다");

  console.log("\n[채팅 칸을 잠그다 — 파일이 채팅 위로 들어오면 둘 다 못 쓴다]");
  ok(executed.some((a) => a[0] === "workbench.action.lockEditorGroup"),
     "**패널 그룹을 잠근다** — 안 그러면 여는 파일이 채팅 칸으로 들어온다");

  console.log("\n[두 번 열어도 앱은 하나다]");
  const before = panelOpts;
  registered.get("aiInOne.open")();
  ok(panelOpts === before, "패널을 새로 만들지 않는다");

  console.log("\n[새 대화방 명령은 만들기 화면으로 보낸다]");
  posted.length = 0;
  registered.get("aiInOne.newRoom")();
  ok(posted.some((m) => m.t === "nav" && m.screen === "new"), "이미 열려 있으면 nav:new를 보낸다");

  console.log("\n[웹뷰가 보내는 것을 받는다]");
  ok(typeof webviewOnMessage === "function", "수신 핸들러가 붙어 있다");

  // 실제 에이전트로 조회하면 npx가 CLI를 받아오느라 수십 초가 걸린다.
  // 여기서 보려는 건 **배선**이므로 CLI를 띄우지 않는 경로로 확인한다.
  posted.length = 0;
  webviewOnMessage({ t: "needConfig", agentId: "없는-에이전트" });
  const reply = await waitFor(() => posted.find((m) => m.t === "config"));
  ok(reply.agentId === "없는-에이전트", "설정 조회에 config로 답한다");
  ok(typeof reply.error === "string" && reply.error.length > 0, "실패 이유를 담아 보낸다");
  ok(Array.isArray(reply.options), "실패해도 목록 자리는 비워서 보낸다");

  console.log("\n[모르는 방을 만지면 그 방의 오류로 돌아온다]");
  posted.length = 0;
  webviewOnMessage({ t: "send", roomId: "없는-방", text: "안녕" });
  const err = await waitFor(() => posted.find((m) => m.t === "roomError"));
  ok(err.roomId === "없는-방", "roomError가 방 id를 달고 온다");

  console.log("\n[첨부는 blob으로 저장되고 칩이 돌아온다]");
  posted.length = 0;
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  webviewOnMessage({ t: "attach", roomId: "r", items: [{ name: "shot.png", mimeType: "image/png", base64: png }] });
  const att = await waitFor(() => posted.find((m) => m.t === "attached"));
  ok(att.attachments.length === 1, "첨부 1개 저장됨");
  ok(/^[0-9a-f]{64}$/.test(att.attachments[0].sha256), "sha256으로 주소된다");
  ok(att.attachments[0].byteSize === 8, "크기가 기록된다");

  console.log("\n[너무 큰 첨부는 이유를 달아 거절한다]");
  posted.length = 0;
  webviewOnMessage({
    t: "attach", roomId: "r",
    items: [{ name: "huge.log", mimeType: "text/plain", base64: Buffer.alloc(3 * 1024 * 1024).toString("base64") }],
  });
  const big = await waitFor(() => posted.find((m) => m.t === "attached"));
  ok(big.attachments.length === 0, "저장하지 않는다");
  ok(big.rejected && big.rejected[0].includes("huge.log"), "거절 사유: " + (big.rejected || [])[0]);

  console.log("\n[썸네일은 요청할 때만 보낸다]");
  posted.length = 0;
  webviewOnMessage({ t: "needBlob", sha256: att.attachments[0].sha256 });
  const blob = await waitFor(() => posted.find((m) => m.t === "blobData"));
  ok(blob.dataUri.startsWith("data:image/png;base64,"), "data: URI로 돌아온다");

  console.log("\n[검색은 방이 없어도 답한다]");
  posted.length = 0;
  webviewOnMessage({ t: "search", query: "없는말" });
  const sr = await waitFor(() => posted.find((m) => m.t === "searchResults"));
  ok(sr.query === "없는말" && Array.isArray(sr.hits), "searchResults로 돌아온다");

  console.log("\n[diff는 가상 문서를 쓴다 — 디스크를 건드리지 않는다]");
  ok(providers.has("ai-in-one-blob"), "가상 문서 제공자가 등록됨");
  const provider = providers.get("ai-in-one-blob");
  const text = await provider.provideTextDocumentContent({ path: "/" + att.attachments[0].sha256 + "/shot.png" });
  ok(text.length === 8, "blob 내용을 돌려준다");
  ok((await provider.provideTextDocumentContent({ path: "/empty/new.ts" })) === "",
     "새 파일의 «이전»은 빈 문서다");

  for (const s of subs) s.dispose?.();
  fs.rmSync(storage, { recursive: true, force: true });
  console.log("\n전부 통과\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
