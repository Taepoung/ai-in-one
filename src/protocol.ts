import type {
  AnswerPolicy,
  RelayMode,
  ReviewWait,
  WaitItem,
  Clash,
  Approver,
  Attachment,
  SearchHit,
  ForkFallback,
  JoinFail,
  JoinStep,
  Message,
  PermissionRequest,
  Room,
  RoomMeta,
  RoomStatus,
  RoomUsage,
  AgentQuota,
} from "./core/types.js";
import type { ComposeToken } from "./core/mentions.js";
import type { McpState } from "./core/mcpServer.js";

/** 방 만들기 화면에 필요한 만큼만 추린 에이전트 정보. `command`·`env`는 보내지 않는다 */
export interface AgentBrief {
  id: string;
  label: string;
  description?: string;
  /**
   * ★ **받아두었나** (2026-10-01) — `docs/INSTALL.md`.
   *
   * 안 받은 에이전트는 **방 만들기 목록에 안 뜨고**, 이미 그걸 쓰던
   * 방은 모델이 없어졌을 때처럼 **막고 고르게 한다.**
   *
   * 없으면 있는 것으로 본다 — 사용자가 `aiInOne.agents` 로 적은 것은
   * 우리가 받는 게 아니므로 «안 받았다» 고 말하면 거짓말이 된다.
   */
  available?: boolean;
}

export interface ConfigOptionBrief {
  configId: string;
  name: string;
  category?: string;
  current?: string | boolean;
  values?: Array<{ id: string; name: string; description?: string }>;
}

/**
 * HTML에 박아서 내보내는 초기 상태 (F8).
 *
 * 웹뷰가 뜬 **뒤에** 목록을 요청하면 한 프레임이 빈 화면으로 깜빡인다.
 * 앱을 여는 시점에 `rooms.json`은 이미 메모리에 있으므로 기다릴 이유가 없다.
 */
export interface Boot {
  rooms: RoomMeta[];
  agents: AgentBrief[];
  /**
   * 여는 순간 보여줄 화면.
   *
   * `nav` 메시지로는 부족하다 — 패널이 꺼져 있다가 «새 대화방»으로
   * 열릴 때는 웹뷰 스크립트가 뜨기 전이라 **보낸 메시지가 그냥 사라진다.**
   */
  screen: "list" | "new" | "auth";
  /**
   * ★ **로그인 확인 — 창이 뜨는 첫 화면** (2026-10-13).
   *
   * 🔴 **첫 그림에 실어 보낸다.** 스크립트가 돌고 나서 그리면 목록이
   * 한 번 번쩍했다가 확인 화면으로 덮인다 — 사용자 눈엔 **버벅인 것**이다.
   */
  auth?: AuthRow[];
  /** 현재 워크스페이스 루트. 다른 프로젝트의 방을 구별하는 데 쓴다 (B5) */
  cwd: string;
  /**
   * 폴더가 열려 있는가 (B9).
   *
   * **`cwd`는 언제나 값이 있다** — 워크스페이스가 없으면 홈으로 떨어진다.
   * 그래서 `cwd`만 봐서는 «여기서 작업하라고 정한 폴더»인지 «어쩔 수 없이
   * 고른 기본값»인지 구별할 수 없다. 둘을 같게 다루면 **에이전트를 홈
   * 디렉터리에 풀어놓게 된다** — 거기서는 워크스페이스 안/밖 구분(I4)도
   * 무의미해진다.
   */
  hasWorkspace: boolean;
  /** 애니메이션을 줄이라는 사용자 설정. 웹뷰에서도 미디어 쿼리로 보지만 여기서도 준다 */
  reducedMotion: boolean;
}

/**
 * ★ **로그인 확인 한 줄** (2026-10-13).
 *
 * ```
 * asking  CLI 에게 묻는 중
 * yes/no  답을 받았다
 * failed  **못 물어봤다** — 시간 안에 답이 없었다
 * ```
 *
 * 🔴 `guessed` 는 «물어본 게 아니라 **파일만 봤다**» 는 뜻이다. 확신의 급이
 * 다르므로 화면도 다르게 적어야 한다 — 같이 그리면 «확인했다» 는 거짓말이
 * 된다. Antigravity 가 그렇다(로그인 상태를 알려주는 명령이 없다).
 */
export interface AuthRow {
  id: string;
  label: string;
  at: "asking" | "yes" | "no" | "failed";
  guessed?: boolean;
}

/** 답을 기다리는 카드 하나 (D1·D4). 둘이 UI 인프라를 공유한다 */
export type AskCard =
  | { id: string; kind: "permission"; roomId: string; req: PermissionRequest }
  ;

export type AskAnswer =
  | { kind: "permission"; optionId?: string }
  ;

export type ToWebview =
  /**
   * 로그인 확인이 어디까지 왔나 (2026-10-13).
   *
   * `stuck` 은 **기한을 넘겼다** 는 뜻이다 — 그때는 화면이 사람에게 묻는다
   * (다시 해볼까, 그냥 들어갈까). 조용히 넘어가면 «왜 로그인하라 그러지»
   * 가 나중에 터지고, 그때는 왜인지 알 길이 없다.
   */
  | { t: "auth"; list: AuthRow[]; stuck: boolean }
  /**
   * ★ **에이전트마다 지금 어느 칸에 있나** (2026-10-01).
   *
   * 단추는 `state` 가 정한다(`docs/INSTALL.md`). `loggedIn` 을 따로 주는 것은
   * `stale` 일 때도 로그인 상태를 같이 보여주기 위해서다 — 낡음이 앞서질
   * 뿐 다른 걸 못 보게 될 이유는 없다.
   */
  /** 받아온 잔량 — 어댑터가 준 **글 그대로**다 (`AgentQuota`) */
  | { t: "quota"; list: AgentQuota[] }
  | {
      t: "agents";
      list: {
        id: string;
        label: string;
        /** 없으면 우리가 받는 에이전트가 아니다 (사용자 설정) */
        managed: boolean;
        /** 방 만들기 목록에 뜨나 — 안 받았으면 안 뜨고, 쓰던 방은 막힌다 */
        available: boolean;
        state: "none" | "stale" | "needLogin" | "ready";
        version?: string;
        wanted?: string;
        /** 바이트. 0 이면 안 받은 것 */
        size: number;
        loggedIn: boolean;
        /**
         * 🔴 **로그아웃할 길이 있나** (2026-10-07).
         *
         * 없는 CLI 가 있다 — `agy` 에는 `login`·`logout` 자체가 없다.
         * 그런데도 단추를 띄우고 있어서 **눌러도 아무 일도 안 생겼다.**
         * 사용자가 봉착했다 — *"로그아웃도 안먹네"*.
         */
        canLogout: boolean;
        /**
         * 🔴 **터미널이 뜨는 에이전트가 있고 아닌 게 있다** (2026-10-07).
         *
         * 화면은 «터미널이 열립니다» 를 무조건 적고 있었는데, ACP 로
         * 로그인하는 쪽은 **터미널이 안 뜨고 브라우저가 뜨다.** 사용자가
         * 짚었다 — *"이거 이제 없으니까 지워야겠다"*.
         */
        viaAcp: boolean;
        /** 지금 받는 중이면 마지막 줄 */
        busy?: string;
      }[];
    }
  | { t: "metas"; rooms: RoomMeta[] }
  | {
      t: "room";
      room: Room;
      firstUnreadId?: string;
      /** 방에 압축할 수 있는 봇이 하나라도 있나 */
      compactable: boolean;
      /**
       * 그 중 **어느 봇**이 되나 — 압축은 세션마다이고 세션은 봇 단위다(B1).
       *
       * 에이전트가 섞인 방에서는 **한 쪽만 압축을 아는** 게 보통이라,
       * 봇마다 버튼을 보일지 말지를 이걸로 정한다.
       */
      compactableBots?: string[];
    }
  /**
   * 메시지 하나만 바뀜다 — 스트리밍의 기본 경로.
   *
   * 방 전체를 보내면 페이로드가 **대화 길이에 비례해** 커진다.
   * 실측: 메시지 6000개에서 초당 47MB · 확장 호스트 CPU 17%.
   * 이 경로는 대화가 아무리 길어도 ~1KB로 고정이다.
   */
  | { t: "msg"; roomId: string; message: Message; usage?: RoomUsage }
  /**
   * 응답 대기 표시 (C10).
   *
   * `status`는 **봇들을 합친 값**이고, `bots`가 각자의 상태다.
   * 단체방에서 «Claude는 답하는 중, Codex는 끝»을 말하려면 둘 다 필요하다.
   */
  | { t: "status"; roomId: string; status: RoomStatus; bots?: Record<string, RoomStatus> }
  /**
   * ★ **그 봇이 방에 못 붙었다** (2026-10-13).
   *
   * 🔴 여태 이것을 **말풍선으로** 남겼다 — 「세션을 열지 못했습니다」 가
   * **대화 기록의 일부**가 됐다. 세션이 붙고 말고는 **우리 사정**이지
   * 대화가 아니다. 그래서 붙는 화면에만 뜨고 기록엔 안 남는다.
   *
   * `kind` 로 **달 단추가 갈린다** — 로그인 / 고치기 / 다시 시도.
   */
  /** 그 봇이 **어느 칸**에 있나 — 띄우는 중인지 세션을 여는 중인지 */
  | { t: "joinStep"; roomId: string; botId: string; step: JoinStep }
  | { t: "joinFail"; roomId: string; botId: string; kind: JoinFail; why: string }
  /**
   * 붙이는 일이 끝났다 — 못 붙은 봇이 있어도 온다.
   *
   * 🔴 **「다 붙었다」를 화면이 추론하면 안 된다.** 봇별 상태만 보면 **아직
   * 한 줄도 안 온 때**와 **다 끝난 때**가 똑같아 보인다.
   */
  | { t: "joinDone"; roomId: string }
  /**
   * ★ **예약을 풀어 글을 돌려준다** — «수정» 을 눌렀을 때 (v3.0 1-E).
   *
   * ⏪ 여기 있던 `queued` 는 **줄 서 있는 메시지 id 들**이었다. 큐를 없앴으니
   * 줄도 없다 — 올려둔 한 칸은 방 스냅샷(`Room.staged`)에 실려 가므로 따로
   * 알릴 것이 없고, 대신 **돌려받는 길**만 필요하다.
   *
   * 화면이 이걸 받아 입력창에 꽂는다. 쓰던 글이 있으면 깊이 1 로 밀어둔다.
   */
  | {
      t: "stagedBack";
      roomId: string;
      tokens: ComposeToken[];
      attachments?: Attachment[];
    }
  /**
   * **줄 서 있는 심사들** (§4.2.2).
   *
   * 심사 봇의 세션은 하나라 직렬이다(B1). 기다리는 동안 **요청한 봇의 턴은
   * 얼어 있으므로**, 무엇이 누구를 기다리는지 보이고 **가로챌 수 있어야** 한다.
   */
  | { t: "reviews"; roomId: string; list: ReviewWait[] }
  /**
   * **봇마다 들고 있는 대기** (§5-M).
   *
   * 방 하나치를 통째로 보낸다 — 봇별로 쪼개 보내면 «이 봇은 0 이 됐다» 를
   * **안 보내는 실수**가 생기고, 그러면 수가 영영 안 줄어든 채로 남는다.
   */
  | { t: "waiting"; roomId: string; list: WaitItem[] }
  /**
   * ★ **봇끼리 부르는 길이 서 있나** (v3.0 2-F).
   *
   * 그 길은 MCP 서버 위에 서 있는데, **루프백이 막힌 기계가 있다.** 그때
   * 조용히 안 되면 사용자는 «왜 안 부르지»를 영영 못 푼다 — 그래서
   * **왜 안 되는지를 같이** 보낸다.
   *
   * 자동으로 다시 시도하지 않는다 — 「몇 초마다」 라는 숫자가 하나 생기고,
   * 그 숫자는 아무도 고를 수 없다. 사람이 누르면 그때 한다.
   */
  | { t: "mcp"; state: McpState }
  | { t: "clashes"; roomId: string; list: Clash[] }
  | { t: "roomError"; roomId: string; message: string }
  | { t: "notice"; roomId: string; message: string }
  | {
      t: "config";
      agentId: string;
      /** 어느 봇의 것인가. 없으면 **방과 무관한** 에이전트 기본값이다 */
      botId?: string;
      /** 방의 세션에서 온 값이면 그 방. 없으면 에이전트 기본값(만들기 화면) */
      roomId?: string;
      options: ConfigOptionBrief[];
      error?: string;
    }
  | { t: "ask"; card: AskCard }
  | { t: "askResolved"; id: string }
  /**
   * `agents` 는 **낡은 에이전트가 있을 때** 창을 열면서 간다 (2026-10-13).
   *
   * 🔴 여태 낡았다는 것을 **로봇 화면 안에서만** 말했다. 안 열어보면 영영
   * 모르고, 그동안 **옛 어댑터가 계속 돈다** — 핀을 올린 까닭이 새 모델인데
   * 사용자는 옛 모델에 묶인 채 **알아챌 방법이 없다**(`docs/PIN.md`).
   *
   * 강제는 아니다. 단추가 이미 거기 있으니 **화면을 띄워주는 것까지**만 한다.
   */
  | { t: "nav"; screen: "list" | "new" | "agents" }
  | { t: "cwdPicked"; path: string }
  /** 첨부가 저장되어 보낼 준비가 됐다. `rejected`는 크기·종류로 거리된 것 */
  | { t: "attached"; roomId: string; attachments: Attachment[]; rejected?: string[] }
  /** 썸네일 지연 로딩 — 방을 열 때 모든 이미지를 실어 보내면 페이로드가 터진다 */
  | { t: "blobData"; sha256: string; dataUri: string }
  /** 에이전트가 받아주는 첨부 종류 (I5) */
  | {
      t: "caps";
      agentId: string;
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
      /** 세션 분기 (v1.1). `unknown`이면 **경고하지 않는다** — 모르는 걸 단정하지 않는다 */
      fork: "yes" | "no" | "unknown";
    }
  | { t: "searchResults"; query: string; hits: SearchHit[] }
  | { t: "createFailed"; message: string };

export type FromWebview =
  /** 못 붙은 봇을 **다시 붙여본다** — 자동으로 되풀이하지 않는다 */
  | { t: "retryJoin"; roomId: string; botId: string }
  /**
   * ★ **기록만 읽는다** (2026-10-13).
   *
   * 세션을 안 붙이고 방을 연다. 「잠깐 뭐라고 했더라」 보러 들어온 사람에게
   * **Antigravity 17초**를 물릴 이유가 없다 — 기록은 우리 것이라 CLI 가
   * 없어도 읽힌다.
   */
  | { t: "peek"; roomId: string }
  /**
   * ★ **웹뷰가 떴다** (2026-10-13).
   *
   * 🔴 **스크립트가 돌기 전에 보낸 것은 사라진다.** `Boot.screen` 이 있는
   * 까닭이 그거다(*"«새 대화방»으로 열릴 때는 … 보낸 메시지가 그냥
   * 사라진다"*). 로그인 확인은 **0.1초에 끝날 수도** 있어서 `auth` 와
   * `nav` 가 통째로 그 구멍에 빠질 수 있다 — 그러면 사용자는 **확인
   * 화면에 영영 갇힌다.**
   *
   * 그래서 **받을 사람이 생겼다고 말하고, 호스트가 그때 다시 보낸다.**
   */
  | { t: "ready" }
  /** 확인 화면에서 [다시 시도] — **못 물어본 것만** 다시 묻는다 */
  | { t: "authRetry" }
  /** 확인 화면에서 [그냥 들어가기] — 파일 짐작으로 간다 */
  | { t: "authSkip" }
  | { t: "open"; roomId: string }
  | { t: "back" }
  | {
      t: "createRoom";
      /** 1:1의 에이전트. `bots`를 주면 무시된다 */
      agentId: string;
      /** 단체방 (v2.0) — 봇마다 에이전트·모델·역할을 따로 고른다 */
      bots?: Array<{
        agentId: string;
        /** 부를 이름. 비우면 에이전트 이름 (v2.2 앞당김) */
        name?: string;
        /** 말풍선 색. 비우면 테마가 주는 평소 말풍선 (2026-09-28) */
        color?: string;
        /** 그 위의 글자색 — 검정/하양 택1 */
        ink?: "black" | "white";
        rolePrompt?: string;
        configValues?: Record<string, string | boolean>;
      }>;
      title: string;
      cwd?: string;
      rolePrompt?: string;
      configValues?: Record<string, string | boolean>;
      /** 봇의 권한 모드 — 에이전트가 준 값 그대로 (D2) */
      agentMode?: string;
      answerPolicy?: AnswerPolicy;
    }
  | { t: "send"; roomId: string; text: string; attachments?: Attachment[] }
  /**
   * 단체방 전송 (v2.0) — **칩과 글자를 늘어놓은 것**을 그대로 보낸다.
   *
   * 화면은 규칙을 모른다 — «줄 맨 앞인가»«연속인가»는 코어가 정한다(§4.1.2).
   */
  | { t: "sendCompose"; roomId: string; tokens: ComposeToken[]; attachments?: Attachment[] }
  /**
   * ★ **올려둔다** — 바쁜 봇이 끝나면 보낼 글 한 칸 (v3.0 1-E).
   *
   * ⏪ 예전에는 **저절로** 줄에 섰다. 그게 엇갈림을 만들었다 — 10분짜리 일이
   * 끝난 뒤에 «그거 말고 이거»가 나가서 이미 끝난 일에 대한 정정이 날아갔다.
   * 이제는 **사용자가 눌러서** 올린다. 그래야 엇갈려도 납득이 된다.
   */
  | { t: "stage"; roomId: string; tokens: ComposeToken[]; attachments?: Attachment[] }
  /** **내린다** — 글까지 버린다. 아무도 못 봤으니 흔적이 없다 (§0) */
  | { t: "unstage"; roomId: string }
  /** **수정한다** — 예약을 풀고 글을 입력창으로 돌려받는다 (`stagedBack`) */
  | { t: "editStaged"; roomId: string }
  /** 붙여넣기·드롭으로 들어온 바이트. 셀이 blob으로 저장해 `attached`로 돌려준다 */
  | { t: "attach"; roomId: string; items: Array<{ name: string; mimeType: string; base64: string }> }
  /** 파일 탐색기에서 끌어다 놓았거나 첨부 버튼을 눌렀다 */
  | { t: "attachPaths"; roomId: string; paths: string[] }
  | { t: "pickAttachment"; roomId: string }
  /**
   * 썸네일·미리보기용 내용을 달라고 한다.
   *
   * 경로만 보낸 첨부는 blob이 없어 `path`로 지금 읽어야 한다 (I4).
   */
  | { t: "needBlob"; sha256: string; path?: string }
  | { t: "needCaps"; agentId: string }
  /** 전문 검색 (H2). 목록 필터(H1)와 방 안 찾기(H4)는 웹뷰에서 끝난다 */
  | { t: "search"; query: string }
  /**
   * ★ **전체 중지 — 중지는 이것 하나다** (v3.0 1-D · C6).
   *
   * ⏪ 한때 넷이었다: 방 전체 중단 · 봇 하나만 중단 · 끼어들기 · 줄에서 빼기.
   * 넷을 다 두면 **각각이 MCP 큐·권한 대기·심사 줄과 어떤 관계인지 따로
   * 정의해야 한다** — v3.0 에서 그게 열여섯 가지 조합이 된다.
   *
   * 봇을 안 지목한다 — **방이 통째로** 멈춘다.
   */
  | { t: "stopAll"; roomId: string }
  | { t: "retry"; roomId: string; messageId?: string }
  /** **이 심사는 내가 답한다** — 줄에서 빼고 승인 카드를 띄운다 (§4.2.2) */
  | { t: "takeOverReview"; roomId: string; reviewId: string }
  /**
   * **이건 안 볼래** — 그 봇의 큐에서 메시지 하나를 버린다 (§5-M).
   *
   * 권한에는 안 쓴다 — 낸 봇이 얼어 있어서 버리면 영영 기다린다. 그쪽은
   * `takeOverReview` 로 사람이 받는다.
   */
  | { t: "dropWaiting"; roomId: string; botId: string; id: string }
  /**
   * **그 자리에서 답한다** — 대기 줄의 승인 하나 (§5-M).
   *
   * 「이번 한 번만」이다. «항상» 은 카드를 펴서 고를 때만 있다.
   */
  | { t: "answerWaiting"; roomId: string; botId: string; id: string; allow: boolean }
  /** **봇끼리 부르는 길을 다시 세워본다** (v3.0 2-F) */
  | { t: "retryMcp" }
  | { t: "rename"; roomId: string; title: string }
  | { t: "setRole"; roomId: string; rolePrompt: string; botId?: string }
  /**
   * ★ **한 줄 소개를 고친다** (v3.0 4-K).
   *
   * 역할과 **다른 물건**이다 — 역할은 그 봇에게 주는 지시고, 이건 **남에게
   * 보이는 소개**다. 봇 명단 표에 그대로 적히므로 고치면 그 방 전원의 다음
   * 프리앰블이 달라진다.
   */
  | { t: "setBlurb"; roomId: string; blurb: string; botId?: string }
  /**
   * ★ **봇끼리 부르기 — 방 단위** (v3.0 4-L). 권한 시트 맨 위.
   *
   * 봇별 권한(D2)보다 **층이 하나 위**다 — 이게 꺼져 있으면 아래 줄들이
   * 다 무의미하다.
   */
  | { t: "setRelay"; roomId: string; relay: RelayMode }
  /**
   * ★ **사용자에게서 몇 다리까지 번져도 되나** (v3.0 4-L).
   * «무조건 허용»에서만 쓰인다.
   *
   * 깊이 0 이 사용자 메시지, 1 이 거기 반응해 거는 말, 2 가 그 말에 반응해
   * 거는 말이다 — **답도 반응이라 한 다리 는다.**
   */
  | { t: "setRelayDepth"; roomId: string; depth: number }
  /**
   * 봇 이름 바꾸기 (v2.2 준비).
   *
   * 이름이 곧 멘션 이름이라 방 안에서 유일해야 한다 — 겹치면 코어가 뒤에
   * 수를 붙여 돌려준다. **아직 화면은 없다**(배선만).
   */
  /** 분기를 한 번 더 — 되면 계획·파일 기억까지 돌아온다 (v1.1 보완) */
  | { t: "retryFork"; roomId: string }
  /** 방에 봇을 부른다 (v2.0). 1:1을 단체방으로 올리는 길이기도 하다 */
  | {
      t: "addBot";
      roomId: string;
      agentId: string;
      /** 부를 이름. 비우면 에이전트 이름 (v2.2 앞당김) */
      name?: string;
      /** 말풍선 색. 비우면 테마가 주는 평소 말풍선 (2026-09-28) */
      color?: string;
      /** 그 위의 글자색 — 검정/하양 택1 */
      ink?: "black" | "white";
      rolePrompt?: string;
      /** 모델·추론 강도 — 부를 때 정한다 (B15) */
      configValues?: Record<string, string | boolean>;
    }
  | { t: "removeBot"; roomId: string; botId: string }
  | { t: "renameBot"; roomId: string; botId: string; name: string }
  /**
   * **봇 색을 바꾼다** (2026-09-28). 빈 문자열이면 에이전트 색으로 되돌린다.
   */
  | {
      t: "setBotColor";
      roomId: string;
      botId: string;
      color: string;
      /** 그 위의 글자색 — 검정/하양 택1. 색과 **한 쌍**으로 보낸다 */
      ink?: "black" | "white";
    }
  /**
   * 봇의 에이전트 바꾸기 (§8.1(b) 준비).
   *
   * 🔴 **세션을 버리는 일이다.** 세션은 그 CLI의 것이라 새 에이전트가 이어받을
   * 수 없고, 바꾸면 «위 대화를 모르는» 상태가 된다(`contextLost`). 그래서
   * «바꿨더니 다 잊었다»가 되지 않게 묻는 흐름이 필요한데, 그건 컨텍스트
   * 이동(§8.1)과 함께 설계한다. **아직 화면은 없다**(배선만).
   */
  /**
   * 에이전트를 갈아탄다 — **모델과 되먹임까지 한 번에** (§4.2.1).
   *
   * 사용자에게는 한 번의 결정이다: «Codex의 GPT-5로, 대화는 넘겨서».
   * 따로 보내면 순서가 안 지켜진다(`post` 는 기다리지 않는다).
   */
  | {
      t: "setAgent";
      roomId: string;
      botId: string;
      agentId: string;
      model?: { configId: string; value: string };
      refeed?: boolean;
      /** 넘기면 원문까지인가 요약만인가 (2026-10-01) */
      refeedKind?: "log" | "summary";
    }
  | { t: "leave"; roomId: string }
  /**
   * 대화를 그 지점에서 갈라 새 방을 만든다 (v1.1).
   *
   * `atMessageId`가 없으면 **지금까지 전부**를 물려받는다.
   */
  | {
      t: "fork";
      roomId: string;
      atMessageId?: string;
      title?: string;
      /**
       * **이 봇만 가른다** (v2.1 · §5) — 봇별 뷰에서 분기할 때.
       *
       * 비우면 방 전체다. 뷰가 곧 «그 봇이 아는 전부»라 그걸 그대로 가르면
       * 정확히 그 맥락의 1:1 방이 나온다.
       */
      botId?: string;
      /**
       * 네이티브 분기가 **안 될 때**만 쓰인다 (v1.1).
       *
       * 화면이 미리 알 수 있는 경우(과거 지점·능력 없음)에만 실려 온다.
       * 비어 있으면 코어가 `refeed`로 둔다 — 되돌릴 수 있으므로.
       */
      fallback?: ForkFallback;
    }
  | { t: "draft"; roomId: string; text: string }
  /**
   * 설정을 달라 — **봇까지 지목한다**.
   *
   * 🔴 `agentId` 만 보냈더니 방 안에서 **봇을 구별할 수 없었다.** 설정은
   * 세션에 걸리고 세션은 봇 단위다(B1). `botId` 가 없으면 **방과 무관한**
   * 에이전트 기본값을 묻는 것이다 — 방 만들기 화면과, 아직 방에 없는
   * 에이전트(갈아타기 미리보기)가 그 길을 쓴다.
   */
  | { t: "needConfig"; agentId: string; roomId?: string; botId?: string }
  /**
   * ★ **에이전트 설정 화면** (2026-10-01) — `docs/INSTALL.md`.
   *
   * 지금 상태를 달라는 요청. 받기·지우기 뒤에도 이걸 다시 보낸다.
   */
  | { t: "agentsAsk" }
  /**
   * ★ **구독 잔량을 물어온다** (사용자, 2026-10-19).
   *
   * 🔴 **방을 거치지 않는다.** 조회용 세션을 따로 열어 `/usage` 를 한 번
   * 묻는다 — `send` 로 보내면 읽던 대화에 말풍선이 둘 남는다. 모델은 그
   * 턴을 기억하지 않으므로(`docs/SLASH.md`) 맥락은 안 먹는다.
   *
   * 방 id 를 주는 것은 **누구에게 물을지**를 정하기 위해서다 — 그 방의
   * 참여자가 쓰는 에이전트만 깨운다.
   */
  | { t: "quotaAsk"; roomId: string }
  /**
   * 그 에이전트에 무언가를 한다.
   *
   * `install` 과 `update` 는 속이 같다 — 가르는 것은 **부르는 쪽이 아니라
   * 지금 상태**다(`none` 인가 `stale` 인가). 단추 글자만 다르게 보여준다.
   */
  | { t: "agentDo"; agentId: string; what: "install" | "remove" | "login" | "logout" }
  /** 끊긴 맥락을 되먹일지 (F7). `accept`면 다음 메시지에 실어 보낸다 */
  | {
      t: "refeed";
      roomId: string;
      accept: boolean;
      /** 넘기면 원문까지인가 요약+최근만인가 (2026-10-02) */
      kind?: "log" | "summary";
    }
  /** 못 이어받은 세션에 다시 붙어본다 (F7) */
  | { t: "retryResume"; roomId: string }
  | { t: "answer"; id: string; answer: AskAnswer }
  /**
   * 봇의 질문 정책을 바꿜다 (D5). 권한은 `setConfig`로 간다.
   *
   * `botId`를 생략하면 **1:1 방의 그 봇**이다. 단체방에서는 지목해야 한다.
   */
  | {
      t: "setPolicy";
      roomId: string;
      botId?: string;
      answerPolicy?: AnswerPolicy;
      /** 승인을 누가 답할지 (D2). v1.0은 사용자뿐 */
      approver?: Approver;
    }
  /** 대화 중에 모델·추론 강도를 바꾼다 (B12·B15) */
  /** 🔴 `botId` 는 필수다 — 없으면 단체방에서 **첫 봇이 바뀐다** (B1) */
  | { t: "setConfig"; roomId: string; configId: string; value: string | boolean; botId?: string }
  | { t: "compact"; roomId: string; botId?: string }
  | { t: "pickCwd" }
  | { t: "openFile"; path: string; line?: number }
  /**
   * 변경 전/후를 네이티브 diff로 열다 (E3).
   *
   * blob에 전문이 남아 있으므로 **디스크를 건드리지 않고** 가상 문서로 띄운다 —
   * 그 뒤로 파일이 더 바뀜어도 당시의 변경을 그대로 볼 수 있다.
   */
  | { t: "diffFile"; roomId: string; messageId: string; path: string };

/**
 * 방 목록의 순서 (B10·B11).
 *
 * **셸과 웹뷰가 같은 함수를 쓴다.** 첫 페인트는 셸이 HTML로 그리고 그 뒤는
 * 웹뷰가 그리는데, 규칙이 다르면 **뜨자마자 목록이 한 번 튄다** (F8).
 *
 * 1. 현재 워크스페이스의 방이 위로 — 지금 하는 일이 먼저다
 * 2. 그 안에서 최근 활동순
 *
 * 안정 정렬에 기대지 않고 2순위를 명시한다 — 들어온 순서가 달라도 결과가 같아야 한다.
 */
export function orderRooms(metas: RoomMeta[], cwd: string): RoomMeta[] {
  return [...metas].sort((a, b) => {
    const here = Number(b.cwd === cwd) - Number(a.cwd === cwd);
    return here !== 0 ? here : b.lastActivityAt - a.lastActivityAt;
  });
}

/**
 * 첫 페인트에 들어갈 방 목록 (F8).
 *
 * `app.js`가 그리는 것과 **같은 구조여야 한다** — 다르면 스크립트가 붙는 순간
 * 화면이 한 번 튄다.
 */
/**
 * 계보 배지의 글 — `↳ 리팩터링 논의에서 분기` (D3).
 *
 * **셸과 웹뷰가 같은 함수를 쓴다** — 첫 페인트와 스크립트가 다른 글을 내면
 * 목록이 한 번 튀다 (F8).
 *
 * 원본 방이 없어졌으면 그렇다고 적는다. 분기는 **유지**되므로(D4) 배지만
 * 바뀌는 것이고, 여기서 «분기»를 지워버리면 이 방이 왜 있는지가 사라진다.
 */
export function forkLabel(m: RoomMeta, all: RoomMeta[]): string | null {
  if (!m.forkedFromRoomId) return null;
  const parent = all.find((x) => x.id === m.forkedFromRoomId);
  return parent ? `↳ ${parent.title}에서 분기` : "↳ 삭제된 방에서 분기";
}

export function roomListHtml(boot: Boot): string {
  if (boot.rooms.length === 0) {
    return `<div class="empty"><p>아직 대화가 없습니다.</p><p class="dim">오른쪽 위 <i class="codicon codicon-add"></i> 로 시작하세요.</p></div>`;
  }

  // 웹뷰와 **같은 순서**여야 한다. 다르면 스크립트가 붙는 순간 목록이 튀다 (F8).
  return orderRooms(boot.rooms, boot.cwd)
    .map((r) => {
      const left = r.draftPreview
        ? `<span class="draft">초안:</span> ${esc(r.draftPreview)}`
        : esc(whoText(r, boot.agents));
      const here = !boot.cwd || r.cwd === boot.cwd;
      const lineage = forkLabel(r, boot.rooms);
      return `<button class="room" data-id="${esc(r.id)}">
  <span class="room-icon"><i class="codicon codicon-${kindIcon(r.kind)}"></i></span>
  <span class="room-main">
    <span class="room-top"><span class="room-title">${esc(r.title)}</span><span class="room-time">${when(r.lastActivityAt)}</span></span>
    <span class="room-sub"><span class="room-who" title="${esc(whoTitle(r, boot.agents))}">${left}</span><span class="${here ? "room-cwd" : "room-cwd elsewhere"}" title="${esc(r.cwd)}">${esc(shortenPath(r.cwd))}</span></span>
    ${lineage ? `<span class="room-fork" title="원본으로 가기">${esc(lineage)}</span>` : ""}
  </span>
  ${r.unread > 0 ? `<span class="badge">${r.unread}</span>` : ""}
  <span class="room-more" title="더 보기"><i class="codicon codicon-kebab-vertical"></i></span>
</button>`;
    })
    .join("");
}

/**
 * 첫 페인트와 스크립트가 **같은 글자를 내야 한다** (F8).
 *
 * 예전에는 여기만 `~/...`로 줄이고 웹뷰는 `…/뒤2칸`으로 줄여서, 스크립트가
 * 붙는 순간 경로가 바뀌며 목록이 한 번 튀었다. 웹뷰 쪽에 맞춘다.
 */
function shortenPath(p: string): string {
  const cut = p.replace(/\\/g, "/").split("/");
  return cut.length > 3 ? `…/${cut.slice(-2).join("/")}` : p;
}

/**
 * 「구현, 리뷰어」 — **부를 이름만** (B5). `main.ts`의 같은 이름 함수와 결과가 같아야 한다.
 *
 * 🔴 모델까지 적었더니 줄이 길어져 **정작 이름이 안 읽혔다.** 모델·에이전트는
 * 툴팁으로 접는다 — 버리는 게 아니다(§0).
 */
function whoText(r: RoomMeta, agents: AgentBrief[]): string {
  return r.agentIds
    .map((id, i) => r.names?.[i] || (agents.find((a) => a.id === id)?.label ?? id))
    .join(", ");
}

/** 줄에서 뺀 것 — 모델과 에이전트는 툴팁에 남는다 */
function whoTitle(r: RoomMeta, agents: AgentBrief[]): string {
  return r.agentIds
    .map((id, i) => {
      const agent = agents.find((a) => a.id === id)?.label ?? id;
      const model = r.models?.[i];
      const sub = model ? `${agent} · ${model}` : agent;
      const name = r.names?.[i];
      return name && name !== agent ? `${name} (${sub})` : sub;
    })
    .join(", ");
}

/** 방 유형 아이콘 (B5) */
function kindIcon(kind: RoomMeta["kind"]): string {
  return kind === "group" ? "organization" : kind === "shared" ? "sync" : "comment";
}

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
