import type {
  AnswerPolicy,
  Approver,
  Attachment,
  ElicitationRequest,
  SearchHit,
  ForkFallback,
  Message,
  PermissionRequest,
  Room,
  RoomMeta,
  RoomStatus,
  RoomUsage,
} from "./core/types.js";

/** 방 만들기 화면에 필요한 만큼만 추린 에이전트 정보. `command`·`env`는 보내지 않는다 */
export interface AgentBrief {
  id: string;
  label: string;
  description?: string;
  color: string;
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
  screen: "list" | "new";
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

/** 답을 기다리는 카드 하나 (D1·D4). 둘이 UI 인프라를 공유한다 */
export type AskCard =
  | { id: string; kind: "permission"; roomId: string; req: PermissionRequest }
  | { id: string; kind: "elicitation"; roomId: string; req: ElicitationRequest };

export type AskAnswer =
  | { kind: "permission"; optionId?: string }
  | { kind: "elicitation"; outcome: "accepted"; values: Record<string, unknown> }
  | { kind: "elicitation"; outcome: "declined" | "cancelled" };

export type ToWebview =
  | { t: "metas"; rooms: RoomMeta[] }
  | { t: "room"; room: Room; firstUnreadId?: string; compactable: boolean }
  /**
   * 메시지 하나만 바뀜다 — 스트리밍의 기본 경로.
   *
   * 방 전체를 보내면 페이로드가 **대화 길이에 비례해** 커진다.
   * 실측: 메시지 6000개에서 초당 47MB · 확장 호스트 CPU 17%.
   * 이 경로는 대화가 아무리 길어도 ~1KB로 고정이다.
   */
  | { t: "msg"; roomId: string; message: Message; usage?: RoomUsage }
  | { t: "status"; roomId: string; status: RoomStatus }
  | { t: "roomError"; roomId: string; message: string }
  | { t: "notice"; roomId: string; message: string }
  | {
      t: "config";
      agentId: string;
      /** 방의 세션에서 온 값이면 그 방. 없으면 에이전트 기본값(만들기 화면) */
      roomId?: string;
      options: ConfigOptionBrief[];
      error?: string;
    }
  | { t: "ask"; card: AskCard }
  | { t: "askResolved"; id: string }
  | { t: "nav"; screen: "list" | "new" }
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
  | { t: "open"; roomId: string }
  | { t: "back" }
  | {
      t: "createRoom";
      agentId: string;
      title: string;
      cwd?: string;
      rolePrompt?: string;
      configValues?: Record<string, string | boolean>;
      /** 봇의 권한 모드 — 에이전트가 준 값 그대로 (D2) */
      agentMode?: string;
      answerPolicy?: AnswerPolicy;
    }
  | { t: "send"; roomId: string; text: string; attachments?: Attachment[] }
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
  | { t: "cancel"; roomId: string }
  | { t: "retry"; roomId: string; messageId?: string }
  | { t: "rename"; roomId: string; title: string }
  | { t: "setRole"; roomId: string; rolePrompt: string }
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
       * 네이티브 분기가 **안 될 때**만 쓰인다 (v1.1).
       *
       * 화면이 미리 알 수 있는 경우(과거 지점·능력 없음)에만 실려 온다.
       * 비어 있으면 코어가 `refeed`로 둔다 — 되돌릴 수 있으므로.
       */
      fallback?: ForkFallback;
    }
  | { t: "draft"; roomId: string; text: string }
  | { t: "needConfig"; agentId: string; roomId?: string }
  /** 끊긴 맥락을 되먹일지 (F7). `accept`면 다음 메시지에 실어 보낸다 */
  | { t: "refeed"; roomId: string; accept: boolean }
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
  | { t: "setConfig"; roomId: string; configId: string; value: string | boolean }
  | { t: "compact"; roomId: string }
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
    <span class="room-sub"><span class="room-who">${left}</span><span class="${here ? "room-cwd" : "room-cwd elsewhere"}" title="${esc(r.cwd)}">${esc(shortenPath(r.cwd))}</span></span>
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

/** 「Claude · Opus 5」 (B5). `main.ts`의 같은 이름 함수와 결과가 같아야 한다 */
function whoText(r: RoomMeta, agents: AgentBrief[]): string {
  return r.agentIds
    .map((id, i) => {
      const label = agents.find((a) => a.id === id)?.label ?? id;
      const model = r.models?.[i];
      return model ? `${label} · ${model}` : label;
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
