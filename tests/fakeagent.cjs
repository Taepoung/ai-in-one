/**
 * ACP를 말하는 최소 에이전트.
 *
 * 진짜 CLI 없이 **«방을 만들며 모델을 고르는»** 경로를 끝까지 돌려보기 위한 것.
 * 모델 기본값은 opus, 고르면 그 값으로 바뀐다 — 화면이 고른 값을 보여주는지
 * 확인하는 게 목적이다.
 *
 * 상태를 `AIO_FAKE_STATE` 파일에 남겨 테스트가 들여다본다.
 */
const fs = require("node:fs");
const NL = String.fromCharCode(10);

const STATE = process.env.AIO_FAKE_STATE;
const MODELS = [
  { value: "opus", name: "Opus 5" },
  { value: "sonnet", name: "Sonnet 5" },
  // **같은 모델인데 id 만 다르다.** 어댑터 0.81.2 → 0.84.0 에서
  // `opus[1m]` 이 `opus` 가 되면서 실제로 이 모양이 됐다 — 둘 다 「Opus 5.5」.
  //
  // `AIO_FAKE_ALIAS` 는 `값` 또는 `값|이름` 이다. 이름을 따로 줄 수 있어야
  // **딴 이름을 단 쌍둥이**(「Fable 5.1」이 `claude-fable-5-1` 에서 `fable`
  // 로 옮겨간 자리, 0.90.0)를 흉내낼 수 있다. 안 주면 예전처럼 「Opus 5」다.
  ...(process.env.AIO_FAKE_ALIAS
    ? process.env.AIO_FAKE_ALIAS.split(",").map((spec) => {
        const at = spec.indexOf("|");
        return at < 0
          ? { value: spec, name: "Opus 5" }
          : { value: spec.slice(0, at), name: spec.slice(at + 1) };
      })
    : []),
];
const MODES = [
  { value: "default", name: "Manual" },
  { value: "plan", name: "Plan" },
];

/** sessionId -> { model, mode } */
const EFFORT = [
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

const GEMINI = Boolean(process.env.AIO_FAKE_GEMINI);
/** 응답을 아예 안 보낸다는 표시 — 죽는 상황을 흉내낼 때 */
const NO_REPLY = Symbol("no-reply");
let limited = false;
let turns = 0;
/** 루프모드가 다시 물은 횟수 — AIO_FAKE_LOOP_DONE_AT 이 본다 */
let loopAsked = 0;
/*
 * **CLI의 디스크**를 흉내낸다 (`AIO_FAKE_DISK=<파일>`).
 *
 * 안 주면 예전처럼 메모리뿐이라 프로세스를 새로 띄우면 다 잊는다. 그러면
 * **«껐다 켜도 세션이 이어지나»를 진짜로 잴 수가 없다** — 언제나 실패하니까.
 *
 * 진짜 에이전트처럼 **성공한 첫 프롬프트를 받은 세션만** 남긴다(§13.1).
 */
const DISK = process.env.AIO_FAKE_DISK;
const sessions = new Map();
/**
 * **도는 중인 턴** — sessionId → { resolve, timer }.
 *
 * 🔴 `session/cancel` 처리기가 없어서 **취소가 아무 일도 안 했다.** hold 가
 * 끝날 때까지 그냥 돌았으므로, 테스트는 «취소됐다»와 «그냥 끝났다»를 구별하지
 * 못했다 — 「전부 중단」(C6)만 테스트가 없던 이유다.
 */
const running = new Map();

function loadDisk() {
  if (!DISK) return;
  try {
    for (const [id, s] of Object.entries(JSON.parse(fs.readFileSync(DISK, "utf8")))) {
      sessions.set(id, { ...s, attached: false });   // 디스크에 있을 뿐 아직 안 붙었다
    }
  } catch { /* 없으면 없는 대로 */ }
}

function saveDisk() {
  if (!DISK) return;
  const keep = {};
  for (const [id, s] of sessions) if (s.prompted) keep[id] = s;
  fs.writeFileSync(DISK, JSON.stringify(keep));
}

loadDisk();
/*
 * 세션 id는 **프로세스마다 달라야 한다.**
 *
 * 진짜 에이전트는 UUID를 준다. 예전에는 여기서 0부터 세서 창을 꺼다 켜면
 * **잃어버린 세션과 새 세션이 같은 id**를 가졌고, 그랬서 «기록이 가리키는
 * 것»과 «지금 붙은 것»이 어긋난 상황을 테스트가 재현할 수 없었다.
 */
const RUN = Math.random().toString(36).slice(2, 6);
let seq = 0;

function note(event) {
  if (!STATE) return;
  fs.appendFileSync(STATE, JSON.stringify(event) + "\n");
}

/** `session/update` 알림 하나를 흘린다 */
function emit(sessionId, update) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", method: "session/update", params: { sessionId, update },
  }) + "\n");
}

/**
 * ★ **받은 `mcpServers` 를 되돌려 적는다** (2026-10-09).
 *
 * 🔴 우리는 `new`·`fork` 에만 싣고 `resume`·`load` 에는 **아예 안 싣는다** —
 * 그래서 **모든 방이 껐다 켜는 순간 도구를 잃는다**(V3 2.4). 그런데 그걸
 * **검사가 볼 자리가 없었다**: 가짜 에이전트가 받은 것을 아무 데도 안 적어서
 * «실었나»를 물을 수가 없었다. 고쳐놓고도 조용히 통과했을 자리다.
 *
 * 이름과 주소만 적는다 — 헤더에는 비밀이 실린다.
 */
function mcpNote(params) {
  const list = params?.mcpServers;
  if (!Array.isArray(list)) return { mcp: null };   // null = **안 실렸다** (빈 배열과 다르다)
  return { mcp: list.map((s) => ({ name: s?.name, url: s?.url, type: s?.type })) };
}

function optionsOf(s) {
  return [
    {
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: s.model,
      // 목록에서 사라진 모델을 흉낸다 — CLI 버전이 바뀌면 실제로 일어난다
      //
      // `AIO_FAKE_BUMP` 는 **별명은 그대로 두고 이름만** 올린다
      // (`sonnet` → 「Sonnet 6」). 진짜 어댑터가 주는 id 가 전부 별명이라
      // 판이 올라가면 이 모양으로 온다 — id 는 안 움직인다.
      options: MODELS.filter((m) => m.value !== process.env.AIO_FAKE_DROP_MODEL)
        .map((m) => ({
          ...m,
          ...(process.env.AIO_FAKE_BUMP === m.value
            ? { name: m.name.replace(/(\d+)$/, (n) => String(Number(n) + 1)) }
            : {}),
          description: `${m.name} 설명`,
        })),
    },
    {
      id: "mode", name: "Mode", category: "mode", type: "select",
      currentValue: s.mode,
      options: MODES.map((m) => ({ ...m, description: `${m.name} 설명` })),
    },
    {
      id: "effort", name: "Effort", category: "thought_level", type: "select",
      currentValue: s.effort,
      options: EFFORT,
    },
  ];
}

/** initialize 응답을 늦춘다 (테스트용). 경주 창을 넓히기 위한 것 */
const SLOW_INIT = Number(process.env.AIO_FAKE_SLOW_INIT ?? 0);

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      /*
       * ★ **첫 띄우기만 실패한다** (2026-10-23) — `AIO_FAKE_INIT_FAIL_ONCE=<파일>`.
       * 그 파일이 없으면 만들고 실패한다. 다음에 뜬 프로세스는 파일을 보고 붙는다.
       * 처음 까는 환경에서 첫 띄우기가 실패한 뒤 로그인이 막히던 것을 재려고.
       */
      const failOnceInit = process.env.AIO_FAKE_INIT_FAIL_ONCE;
      if (failOnceInit && !fs.existsSync(failOnceInit)) {
        fs.writeFileSync(failOnceInit, "failed");
        throw new Error("처음엔 실패한다");
      }
    }
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          // Gemini는 sessionCapabilities가 **통째로 비어 있다** — loadSession 하나뿐 (§13.2)
          sessionCapabilities: GEMINI ? {} : {
            resume: {}, delete: {}, close: {}, list: {},
            // 분기를 안 하는 에이전트도 통과해야 한다 — 폴백 경로
            ...(process.env.AIO_FAKE_NO_FORK ? {} : { fork: {} }),
          },
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          /*
           * ★ **http MCP 를 받는다고 광고한다** — 진짜 셋이 다 그렇다(BUMP ⑩).
           * 리팩토링 ⑦-2 부터 이걸 안 광고하는 에이전트에게는 심사를 안 넘긴다.
           * 끄면 «우리 도구를 못 받는 에이전트» 가 된다.
           */
          mcpCapabilities: process.env.AIO_FAKE_NO_MCP_HTTP ? {} : { http: true },
          /* 로그아웃을 광고하는 에이전트가 있다 — Antigravity 가 그렇다 */
          ...(process.env.AIO_FAKE_ACP_AUTH ? { auth: { logout: {} } } : {}),
        },
        /*
         * 터미널로 띄울 CLI 가 없어 **저쪽이 제 손으로 로그인시키는**
         * 꼴. 여럿이면 골라 물어야 한다.
         */
        authMethods: process.env.AIO_FAKE_ACP_AUTH
          ? [
              { id: "oauth-personal", name: "구글로 들어가기", description: "개인 계정" },
              { id: "api-key", name: "API 키" },
            ]
          : [],
      };
    /*
     * 🔴 **브라우저로 보내는 주소는 답이 아니라 stderr 로 나온다.**
     *
     * 진짜 Antigravity 가 그렇게 한다 — *"Open the following link to
     * authenticate the ACP server: https://…"*. 답만 기다리는 쌍으로
     * 만들면 **브라우저가 안 뜨는 기계에서 주소를 잃는다.**
     */
    case "authenticate": {
      note({ t: "authenticate", methodId: params.methodId });
      process.stderr.write(
        `Open the following link to authenticate: https://example.invalid/go?m=${params.methodId}\n`,
      );
      if (process.env.AIO_FAKE_AUTH_FAIL) throw new Error("들여보내주지 않았습니다");
      return {};
    }
    case "logout": {
      note({ t: "logout" });
      return {};
    }
    case "session/new": {
      // 로그인 안 된 CLI 흉내 — 실제로 여기서 auth_required가 떨어진다
      if (process.env.AIO_FAKE_AUTH) throw new Error("auth_required: please log in");

      const sessionId = `s-${RUN}-${++seq}`;
      /*
       * `AIO_FAKE_MODEL` — **세션이 이미 그 모델로 도는** 상태를 만든다.
       *
       * `AIO_FAKE_DROP_MODEL` 과 같이 쓰면 **지금 값과 같은데 목록에서는
       * 빠진** 꼴이 된다 — Codex 가 `visibility` 를 `hide` 로 바꿔놓았을 때
       * 사용자가 실제로 밟은 자리다(2026-10-06).
       */
      const s = { model: process.env.AIO_FAKE_MODEL || "opus", mode: "default", effort: "medium", attached: true, prompted: false, said: [] };
      sessions.set(sessionId, s);
      note({ t: "new", sessionId, cwd: params.cwd, ...mcpNote(params) });
      // 설치는 됐는데 로그인이 안 돼 응답 없이 멈춰 있는 CLI를 평낸다.
      // «기다림에 끝을 둔다»는 약속을 재려면 **정말 안 답하는** 상대가 있어야 한다.
      if (process.env.AIO_FAKE_HANG_NEW) return NO_REPLY;
      // **응답보다 먼저** 명령 목록을 흘린다 — 실제 CLI가 이렇게 한다
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "compact", description: "압축" },
              // 잔량 조회를 흉낼 때만 — `AIO_FAKE_SLASH` (아래 session/prompt)
              ...(process.env.AIO_FAKE_SLASH ? [{ name: "usage", description: "잔량" }] : []),
            ],
          },
        },
      }) + "\n");
      return { sessionId, configOptions: optionsOf(s) };
    }
    case "session/list":
      // NO_RESUME면 «디스크에 없는» 상태를 흉내낸다 — 목록에도 안 나온다
      return {
        sessions: process.env.AIO_FAKE_NO_RESUME
          ? []
          : [...sessions.keys()].map((sessionId) => ({ sessionId, cwd: params.cwd })),
      };
    case "session/resume":
    case "session/load": {
      // **시도 자체를 먼저 남긴다** — 실패한 복구도 일어난 일이다
      note({ t: "resume-try", sessionId: params.sessionId, method, ...mcpNote(params) });
      if (process.env.AIO_FAKE_NO_RESUME) throw new Error("no such session");
      /*
       * **한 번만** 복구를 실패시킨다 — 일시적인 실패를 흉내낸다.
       * 에이전트가 늦게 떴거나 잠깐 바빴던 경우가 실제로 있다(F7).
       */
      const failOnce = process.env.AIO_FAKE_RESUME_FAIL_ONCE;
      if (failOnce && !fs.existsSync(failOnce)) {
        fs.writeFileSync(failOnce, "failed");
        throw new Error("temporarily unavailable");
      }
      /*
       * ★ **다른 클라이언트가 그 세션을 쥐고 있다** — Codex 가 실제로 보낸 글 그대로
       * (2026-10-20). 그 파일이 **있는 동안만** 막힌다 — 지우면 «저쪽을 닫았다» 가 된다.
       */
      const busy = process.env.AIO_FAKE_RESUME_BUSY;
      if (busy && fs.existsSync(busy)) {
        throw new Error("Invalid request: This Codex session is in use by another Codex client " +
          "(the Codex app, the CLI or an IDE extension). Close the session there or quit that " +
          `client, then try again. — thread ${params.sessionId} already has an active writer`);
      }
      // Gemini 흉내: resume이 없어 load만 온다
      if (GEMINI && method === "session/resume") throw new Error("Method not found");
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error("no such session");
      /*
       * ★ **성공한 프롬프트가 있어야 디스크에 남는다** (§13.1 실측).
       * 한도로 막혔거나 말을 안 건 세션은 되살릴 것이 없다.
       */
      if (!s.prompted) throw new Error("Session " + params.sessionId + " not found in any project directory");
      // 어댑터가 설정까지는 못 살렸을 수도 있다 — 그럴 때 우리가 되돌리는지 본다
      if (process.env.AIO_FAKE_RESET_ON_RESUME) { s.model = "opus"; s.mode = "default"; }
      // ★ 분기된 세션은 **여기서야** 프로세스에 붙는다 (실제 어댑터가 그렇다)
      s.attached = true;
      note({ t: "resume", sessionId: params.sessionId, method, ...mcpNote(params) });
      /*
       * ★ `session/load`는 **대화를 통째로 다시 흘려보낸다.**
       * 스펙: "streaming the entire conversation via session/update".
       * resume이 이걸 안 하는 것과 정확히 갈리는 지점이다.
       */
      if (GEMINI) {
        for (const past of s.said) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", method: "session/update",
            params: { sessionId: params.sessionId, update: {
              sessionUpdate: "user_message_chunk", content: { type: "text", text: past } } },
          }) + "\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", method: "session/update",
            params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "알겠습니다" } } },
          }) + "\n");
        }
      }
      return { configOptions: optionsOf(s) };
    }
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error("no such session");
      if (params.configId === "model") s.model = params.value;
      if (params.configId === "mode") s.mode = params.value;
      if (params.configId === "effort") s.effort = params.value;
      saveDisk();
      note({ t: "set", sessionId: params.sessionId, configId: params.configId, value: params.value });
      return { configOptions: optionsOf(s) };
    }
    case "session/fork": {
      if (process.env.AIO_FAKE_NO_FORK) throw new Error("Method not found");
      const parent = sessions.get(params.sessionId);
      if (!parent) throw new Error("no such session");
      const sessionId = `s-${RUN}-${++seq}`;
      /*
       * 실제 Claude 어댑터를 그대로 흉내낸다 (§13.2 실측):
       *   • 응답은 `{ sessionId }` **하나뿐**이다 — configOptions가 안 온다
       *   • 분기된 세션은 **붙어 있지 않다** — resume 전에 prompt하면 죽는다
       * 이 두 가지를 흉내내야 «resume을 빼먹으면 테스트가 깨진다»가 된다.
       */
      sessions.set(sessionId, { ...parent, attached: false, said: [...parent.said] });
      saveDisk();   // 분기는 말 걸기 전에도 남는다 (§13.2 실측)
      note({ t: "fork", from: params.sessionId, sessionId, ...mcpNote(params) });
      return { sessionId };
    }
    case "session/prompt": {
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error("no such session");
      if (!s.attached) throw new Error("Session not found");
      /*
       * ★ **`/usage` 를 흉낸다** (2026-10-20) — 잔량 팝업이 «빈손» 이 되는 자리를 재려고.
       *
       *   AIO_FAKE_SLASH=ok      글을 흘리고 답한다
       *   AIO_FAKE_SLASH=late    **먼저 답하고 글은 나중에** — 응답과 글 조각의 도착 순서는
       *                          보장되지 않는다(A11). 응답만 보고 닫으면 이걸 놓친다
       *   AIO_FAKE_SLASH=empty   글 없이 답한다
       */
      const slash = process.env.AIO_FAKE_SLASH;
      const asked = (params.prompt ?? []).map((b) => b.text ?? "").join("").trim();
      if (slash && asked === "/usage") {
        const said = "**5-hour limit** — **7%** · Resets Oct 21, 1:40 AM GMT+9";
        const chunk = () => process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } } },
        }) + "\n");
        if (slash === "ok") chunk();
        if (slash === "late") setTimeout(chunk, 400);
        return { stopReason: "end_turn" };
      }
      // ★ 사용량 한도 — **실제 Codex가 보낸 것 그대로** (2026-09 실측)
      /*
       * 한도를 흉낸다.
       *   AIO_FAKE_USAGE_LIMIT=1      항상 막는다
       *   AIO_FAKE_USAGE_LIMIT=once   첫 턴만
       *   AIO_FAKE_USAGE_LIMIT_AT=2   **N번째 턴만** — 대화하다 막히는 경우
       */
      turns += 1;
      /*
       * 서버·CLI가 죽는 상황 — 응답도 오류도 없이 **그냥 끊긴다**.
       * `AIO_FAKE_DIE_ONCE=<파일>` 는 **프로세스를 넘어서 한 번만** 죽는다 —
       * 안 그러면 다시 뜸 CLI도 같은 자리에서 죽어 복구를 못 재본다.
       */
      // ★ **말을 흘린 뒤** 죽는다 — 이미 일이 일어난 턴을 흉내낸다
      const dieAfter = process.env.AIO_FAKE_DIE_AFTER_CHUNK;
      if (dieAfter && !fs.existsSync(dieAfter)) {
        fs.writeFileSync(dieAfter, "died");
        // **받았다는 것은 남긴다** — 안 그러면 테스트가 «두 번 보냈나»를 셀 수 없다
        note({ t: "prompt", sessionId: params.sessionId, text: "(도중 사망)" });
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "파일을 고치는 중" } } },
        }) + "\n");
        setTimeout(() => process.exit(1), 150);
        // **응답을 안 보낸다.** Promise를 돌려주면 그게 `result`로 직렬화돼
        // `{}`가 나가버리고, 그러면 클라이언트는 **성공으로** 읽는다.
        return NO_REPLY;
      }
      const dieOnce = process.env.AIO_FAKE_DIE_ONCE;
      if (dieOnce && !fs.existsSync(dieOnce)) {
        fs.writeFileSync(dieOnce, "died");
        process.exit(1);
      }
      if (Number(process.env.AIO_FAKE_DIE_AT ?? 0) === turns) process.exit(1);
      const at = Number(process.env.AIO_FAKE_USAGE_LIMIT_AT ?? 0);
      const blocked = at > 0
        ? turns === at
        : Boolean(process.env.AIO_FAKE_USAGE_LIMIT) &&
          !(process.env.AIO_FAKE_USAGE_LIMIT === "once" && limited);
      if (blocked) {
        limited = true;
        const e = new Error("Internal error");
        e.data = {
          message: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Sep 21st, 2026 2:30 AM.",
          codexErrorInfo: "usageLimitExceeded",
        };
        throw e;
      }
      // 느린 응답을 흉낸다 — «답하는 중에 보내기»를 재려면 필요하다
      const slow = Number(process.env.AIO_FAKE_SLOW_PROMPT ?? 0);
      const text = (params.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      s.said.push(text);
      s.prompted = true;   // 이제는 디스크에 남는다
      saveDisk();
      note({ t: "prompt", sessionId: params.sessionId, text });

      /*
       * ★ **턴이 끝난 뒤에 스스로 말한다** — `[[wake:밀리초]]` (2026-09-28).
       *
       * 진짜 CLI 가 이걸 한다는 것을 쟀다(`probes/selfwake.cjs`): 백그라운드로
       * 띄운 일이 끝나면, **우리가 아무것도 안 보냈는데** 25초 뒤에 결과를
       * 말해 왔다. 턴은 이미 `end_turn` 으로 닫힌 뒤였다.
       *
       * 그러니 우리 쪽이 그걸 **받아서 화면에 얹는지**도 검사할 수 있어야 한다.
       * 가짜로 흉내 내지 않으면 이 길은 영영 자동 검사 밖에 남는다.
       */
      /*
       * ★ **백그라운드로 띄운 척한다** — `[[bg:작업id]]` (2026-09-28).
       *
       * 진짜는 도구 결과에 출력 파일이 적혀 온다(실측 `probes/waketrigger2.cjs`):
       *
       *   "Command running in background with ID: bxgzrpssp.
       *    Output is being written to: …\\tasks\\bxgzrpssp.output"
       *
       * 그리고 깨어나면 **그 파일을 읽는다.** 양쪽에 같은 조각이 있다는 것이
       * «이 활동이 저 말을 깨웠다»를 짚는 유일한 실이므로, 흉내도 **양쪽 다**
       * 내야 한다 — 한쪽만 내면 잇는 코드가 도는지 알 수 없다.
       */
      const bg = /\[\[bg:([A-Za-z0-9]+)\]\]/.exec(text);
      if (bg) {
        const task = bg[1];
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: "bg-" + task, status: "completed",
            title: "Terminal", kind: "execute",
            content: [{ type: "content", content: { type: "text", text:
              `Command running in background with ID: ${task}. Output is being ` +
              `written to: C:\\tmp\\tasks\\${task}.output. You will be notified.` } }],
          } },
        }) + "\n");
      }

      const wake = /\[\[wake:(\d+)\]\]/.exec(text);
      if (wake) {
        const delay = Number(wake[1]);
        setTimeout(() => {
          // 깨어나면 **제일 먼저 결과 파일을 읽는다** — 진짜가 그렇게 한다
          if (bg) {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", method: "session/update",
              params: { sessionId: params.sessionId, update: {
                sessionUpdate: "tool_call", toolCallId: "rd-" + bg[1], status: "completed",
                title: `Read C:\\tmp\\tasks\\${bg[1]}.output`, kind: "read",
                locations: [{ path: `C:\\tmp\\tasks\\${bg[1]}.output` }],
              } },
            }) + "\n");
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "백그라운드 일이 끝났어" },
              },
            },
          }) + "\n");
        }, delay);
      }
      /*
       * ★ **루프모드의 다시 묻기에 답한다** (2026-10-20).
       *   AIO_FAKE_LOOP_DONE_AT=N   N 번째로 물을 때 «종료», 그 전엔 «할 일을 하나 더 했습니다»
       *   (안 주면 끝내 «종료» 를 안 한다 — 상한을 재려고)
       */
      let said = process.env.AIO_FAKE_ECHO ? ("답:" + text.slice(0, 24)) : (process.env.AIO_FAKE_SAY || "알겠습니다");
      if (text.includes("[ai-in-one 루프]")) {
        loopAsked += 1;
        const at = Number(process.env.AIO_FAKE_LOOP_DONE_AT ?? 0);
        said = at > 0 && loopAsked >= at ? "종료" : "할 일을 하나 더 했습니다";
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } } },
      }) + "\n");
      // 사용량을 **세션마다 다르게** 내보낸다 — 봇끼리 섞이는지 재려면 달라야 한다.
      // 큰 수는 이 프로세스가 아니라 **세션 id의 길이**에서 나오게 해서,
      // 한 방에 세션이 여럿이어도 각자 다른 값이 간다.
      if (process.env.AIO_FAKE_USAGE) {
        const seed = [...String(params.sessionId)].reduce((a, c) => a + c.charCodeAt(0), 0);
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: {
            sessionUpdate: "usage_update", used: 1000 + (seed % 9000), size: 100000 } },
        }) + "\n");
      }
      /*
       * **파일을 고친 척한다** — 프롬프트에 `[[diff:경로]]` 가 있으면.
       *
       * 두 봇이 같은 파일을 동시에 고치는 상황(§4.3)을 재려면 **진짜 diff
       * 이벤트**가 있어야 한다. 경로는 부르는 쪽이 정한다.
       */
      for (const hit of text.matchAll(/\[\[diff:([^\]]+)\]\]/g)) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: "t" + (++diffs), status: "completed",
            title: "파일 고치기", kind: "edit",
            content: [{ type: "diff", path: hit[1], oldText: "before", newText: "after" }],
          } },
        }) + "\n");
      }
      /*
       * **막힌 수정을 흉낸다** — `[[fail:경로]]`.
       *
       * 진짜 Claude Code 로 재보니(2026-09-22) 읽은 뒤 바뀐 파일을 고치려 하면
       * `tool_call` 이 **`status: "failed"`** 로 돌아오고, 사유가 실려 온다:
       * *File has been modified since read…* — **diff 는 안 온다**(아무것도
       * 안 썼으므로). 그래서 이 경우는 diff 로는 영영 못 본다.
       */
      for (const hit of text.matchAll(/\[\[fail:([^\]]+)\]\]/g)) {
        const id = "f" + (++diffs);
        // 진짜는 **먼저 알리고** 나중에 실패로 갱신한다 — 합쳐지는지도 같이 잰다
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call", toolCallId: id, status: "pending",
            title: "Edit", kind: "edit",
            locations: [{ path: hit[1] }],
            // Claude 어댑터처럼 이름은 따로 (0.90 은 title 에 미리보기를 싣는다)
            _meta: { claudeCode: { toolName: "Edit" } },
          } },
        }) + "\n");
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "session/update",
          params: { sessionId: params.sessionId, update: {
            sessionUpdate: "tool_call_update", toolCallId: id, status: "failed",
            content: [{ type: "content", content: { type: "text", text:
              "<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>" } }],
          } },
        }) + "\n");
      }
      /*
       * ★ **계획을 보낸다** — `[[plan]]` · `[[planmd]]` · `[[planrm]]` (2026-10-09).
       *
       * 🔴 `translate()` 가 열다섯 종류 중 여덟만 다루고 나머지는
       * `default: return []` 로 **조용히 버린다**. 계획은 선언·소비·렌더가 다
       * 있는데 **중간만 비어** 있었다 — 그런데 **가짜 에이전트가 계획을 한 번도
       * 안 보내서** 검사 64개 중 어느 것도 그 자리를 안 건드렸다.
       *
       *   [[plan]]    안정판 `plan` — planId 가 **없다**. entries 뿐이다
       *   [[planmd]]  UNSTABLE `plan_update` — markdown 꼴
       *   [[planrm]]  `plan_removed` — 계획이 턴을 넘겨 산다는 증거
       */
      if (text.includes("[[plan]]")) {
        emit(params.sessionId, {
          sessionUpdate: "plan",
          entries: [
            { content: "먼저 읽는다", priority: "high", status: "completed" },
            { content: "고친다", priority: "medium", status: "in_progress" },
            { content: "검사한다", priority: "low", status: "pending" },
          ],
        });
      }
      if (text.includes("[[planmd]]")) {
        emit(params.sessionId, {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", planId: "pl1", content: "## 할 일" + NL + NL + "- 하나" + NL + "- 둘" },
        });
      }
      if (text.includes("[[planitems]]")) {
        emit(params.sessionId, {
          sessionUpdate: "plan_update",
          plan: { type: "items", planId: "pl1", entries: [
            { content: "항목형 갱신", priority: "high", status: "in_progress" },
          ] },
        });
      }
      /* 계획을 **파일로** 준다 — 우리가 못 읽는 꼴이다. 버리는지 알리는지 본다 */
      if (text.includes("[[planfile]]")) {
        emit(params.sessionId, {
          sessionUpdate: "plan_update",
          plan: { type: "file", planId: "pl1", uri: "file:///tmp/plan.md" },
        });
      }
      if (text.includes("[[planrm]]")) {
        emit(params.sessionId, { sessionUpdate: "plan_removed", planId: "pl1" });
      }
      /*
       * ★ **우리가 모르는 종류** — `[[weird]]`.
       *
       * 🔴 §0 P5 는 *"조용히 `return []` 하지 않는다 — 로그에 남겨"* 인데
       * 코드가 정확히 그걸 하고 있었다. **모르는 것이 와도 아무 자국이 없으면
       * 새 종류가 늘어난 것을 영영 모른다** — 실제로 그래서 일곱을 놓쳤다.
       */
      if (text.includes("[[weird]]")) {
        emit(params.sessionId, { sessionUpdate: "nonsense_update", whatever: 1 });
      }
      /*
       * ★ **«지금 상태»가 바뀌었다는 소식** — `[[mode:…]]` · `[[cfg:…]]` · `[[info:…]]`.
       *
       * 셋 다 우리가 안 시킨 변경이 온다. 받아서 안 반영하면 **화면이 틀어진
       * 채로 남는다** — 사용자는 Plan 모드인 줄 아는데 에이전트는 아니다.
       * `session_info_update` 는 **Codex 가 실제로 보낸다**.
       */
      const wantMode = /\[\[mode:([^\]]+)\]\]/.exec(text);
      if (wantMode) {
        s.mode = wantMode[1];
        emit(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: wantMode[1] });
      }
      const wantCfg = /\[\[cfg:([^\]]+)\]\]/.exec(text);
      if (wantCfg) {
        s.model = wantCfg[1];
        emit(params.sessionId, { sessionUpdate: "config_option_update", configOptions: optionsOf(s) });
      }
      const wantInfo = /\[\[info:([^\]]+)\]\]/.exec(text);
      if (wantInfo) {
        emit(params.sessionId, {
          sessionUpdate: "session_info_update",
          title: wantInfo[1], updatedAt: new Date().toISOString(),
        });
      }

      /*
       * 느린 응답을 흉낸다.
       *
       * 🔴 **바쁜 대기는 프로세스를 통째로 막는다** — 같은 프로세스 안의 다른
       * 세션까지 멎어서 «두 봇이 동시에»를 잴 수가 없다. `AIO_FAKE_HOLD`는
       * 대신 **응답만 늦춘다** — 그동안 다른 세션은 계속 돈다.
       */
      /*
       * **턴 중간에 승인을 묻는다** — `[[ask:제목]]`.
       *
       * 이걸로 «승인을 기다리는 동안 말풍선이 어떤 꼴인가»를 잴 수 있다.
       * 답이 올 때까지 이 턴은 **정말로 멈춘다** — 진짜 에이전트와 같다.
       */
      const wantAsk = /\[\[ask:([^\]]+)\]\]/.exec(text);
      if (wantAsk) {
        return askPermission(params.sessionId, wantAsk[1]).then((res) => {
          const picked = res?.outcome?.optionId ?? res?.optionId ?? "?";
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", method: "session/update",
            params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: " …답은 " + picked } } },
          }) + "\n");
          return { stopReason: "end_turn" };
        });
      }

      const hold = Number(process.env.AIO_FAKE_HOLD ?? 0);
      if (hold > 0) {
        // **끊을 수 있게 붙든다** — 진짜 에이전트가 그렇듯 취소하면 즉시 돌려준다
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            running.delete(params.sessionId);
            resolve({ stopReason: "end_turn" });
          }, hold);
          running.set(params.sessionId, { resolve, timer });
        });
      }
      if (slow > 0) {
        const at = Date.now();
        while (Date.now() - at < slow) { /* 일부러 붙든다 */ }
      }
      return { stopReason: "end_turn" };
    }
    case "session/cancel": {
      /*
       * ACP 에서 `session/cancel` 은 **알림**이다 — 답을 안 준다. 대신 **도는
       * 프롬프트를 `cancelled` 로 끝내는 것**이 그 응답 노릇을 한다.
       */
      const live = running.get(params.sessionId);
      if (live) {
        clearTimeout(live.timer);
        running.delete(params.sessionId);
        live.resolve({ stopReason: "cancelled" });
      }
      return NO_REPLY;
    }
    case "session/close":
    case "session/delete":
      // ★ 어느 세션을 놓았는지 적어둔다 — «방 나가기»가 모두 놀아주는지 재려면 필요하다
      note({ t: method === "session/delete" ? "delete" : "close", sessionId: params.sessionId });
      sessions.delete(params.sessionId);
      saveDisk();
      return {};
    default:
      return {};
  }
}

let diffs = 0;
/** 우리가 먼저 보낸 요청들 — id → resolve */
const pending = new Map();
let outId = 90000;

/** 클라이언트에게 승인을 묻고 답을 기다린다 */
/**
 * ★ **MCP 도구의 신원을 어디에 실는가** (2026-10-09).
 *
 * 🔴 자리가 **에이전트마다 다르다**. 하나만 흔내면 나머지 둘에서
 * 우리 도구가 **사용자에게 물어진다** — 봇이 한 마디 할 때마다 승인 카드가
 * 뜨는 꼴이다. 세 꼴을 다 흔낼 수 있어야 검사가 그걸 잡는다.
 *
 *   AIO_FAKE_MCP_WHERE = name | meta | raw | (없음 = 신원 없음)
 */
function mcpBits(server, tool) {
  switch (process.env.AIO_FAKE_MCP_WHERE) {
    case "name":   return { name: `mcp__${server}__${tool}` };          // Claude
    case "meta":   return { _meta: { mcp: { server, tool } } };          // Antigravity
    case "raw":    return { rawInput: { server, tool, arg: 1 } };        // Codex
    default:       return {};                                            // 못 알아보는 꼴
  }
}

function askPermission(sessionId, title) {
  const id = ++outId;
  /*
   * MCP 도구 호출인 척 한다 — `[[mcpask:서버/도구]]` 가 정한다.
   * 진짜 에이전트도 MCP 도구를 쓰기 전에 **같은 길로** 묻는다.
   */
  const want = /^([^/]+)\/(.+)$/.exec(process.env.AIO_FAKE_MCP_CALL || "");
  const bits = want ? mcpBits(want[1], want[2]) : {};
  /*
   * 🔴 **활동을 먼저 알린다.** 진짜 에이전트는 `tool_call` 을 보낸 뒤 그
   * `toolCallId` 로 승인을 요청한다 — 그래야 클라이언트가 «무엇에 대한
   * 승인인지»를 이미 알고 있는 활동에 이어 붙일 수 있다(D3).
   * 이게 없으면 승인 기록이 붙을 자리가 없어 폴백으로만 떨어진다.
   */
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "p" + id, status: "pending",
      title, kind: "edit",
    } },
  }) + "\n");
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id, method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "p" + id, title, kind: "edit", ...bits },
      options: [
        { optionId: "y", name: "이번만 허용", kind: "allow_once" },
        { optionId: "n", name: "이번만 거절", kind: "reject_once" },
      ],
    },
  }) + "\n");
  return new Promise((r) => pending.set(id, r));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    /*
     * 🔴 예전에는 응답을 통째로 버렸다. 우리가 **먼저 묻는 일이 없었기**
     * 때문인데, `[[ask:…]]` 로 턴 중간에 승인을 요청하게 되면서 필요해졌다.
     */
    if (msg.method === undefined) {
      const wait = pending.get(msg.id);
      if (wait) { pending.delete(msg.id); wait(msg.result); }
      continue;
    }
    if (msg.id === undefined) {
      /*
       * 🔴 **알림을 통째로 버리고 있었다.** `session/cancel` 이 알림이라
       * 여기서 끊기면 **취소가 에이전트에 영영 안 닿는다** — 「전부 중단」(C6)을
       * 잴 수가 없던 진짜 이유다. 답은 안 하되 **처리는 한다.**
       */
      try { handle(msg); } catch { /* 알림은 실패해도 답할 곳이 없다 */ }
      continue;
    }
    let out;
    try {
      const result = handle(msg);
      if (result === NO_REPLY) continue;   // 응답 없이 끊긴다
      /*
       * 🔴 `handle` 이 Promise 를 돌려줄 수 있다 (`AIO_FAKE_HOLD`).
       * 그걸 그대로 `result` 에 넣으면 **JSON 으로는 `{}`** 가 되어 즉시
       * 답해버린다 — 붙들라고 만든 것이 하나도 안 붙들고 있었다.
       */
      if (result && typeof result.then === "function") {
        const id = msg.id;
        result.then((r) => {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: r }) + "\n");
        });
        continue;
      }
      out = { jsonrpc: "2.0", id: msg.id, result };
    } catch (err) {
      out = { jsonrpc: "2.0", id: msg.id, error: {
        code: err.data ? -32603 : -32000,
        message: String(err.message),
        ...(err.data ? { data: err.data } : {}),
      } };
    }
    const send = () => process.stdout.write(JSON.stringify(out) + "\n");
    if (msg.method === "initialize" && SLOW_INIT > 0) setTimeout(send, SLOW_INIT);
    else send();
  }
});
process.stdin.resume();
