/** 에이전트 한 종류의 실행 방법. 설정으로 덮어쓸 수 있다. */
export interface AgentDef {
  id: string;
  /**
   * 봇의 기본 이름이자 곧 멘션 이름이 된다 — `@Claude`.
   * 길면 멘션이 장황해지므로 짧게 둔다. 상세 설명은 `description`에.
   */
  label: string;
  /** 방 만들기 화면의 부제. 어떤 CLI인지 알려준다 */
  description?: string;
  /** ACP를 stdio로 말하는 실행 파일 */
  command: string;
  args: string[];
  /** 목록/아바타에 쓰는 색. VSCode 테마 변수 또는 hex */
  color: string;
  /**
   * 실패했을 때 보여줄 안내 (A8).
   *
   * 우리가 CLI를 대신 깔아주지 않는다 — 구독으로 쓰려면
   * 사용자가 직접 설치하고 로그인해야 한다 (§0 P3).
   */
  install?: string;
  env?: Record<string, string>;
}

/**
 * 방에 참여한 봇 하나.
 *
 * `AgentDef`(에이전트 종류)와 **의도적으로 분리**한다. v2.2에서 같은 에이전트로
 * 봇을 여러 개 만들고(`@Claude 구현`, `@Claude 리뷰어`) 이름을 따로 주는데,
 * 그때 데이터 마이그레이션이 필요 없도록 처음부터 나눠둔다.
 */
export interface BotInstance {
  id: string;
  agentId: string;
  /**
   * 봇 이름. **표시 이름이 곧 멘션 이름이다** — 보이는 대로 부른다.
   *
   * 칩(토큰) 방식이라 공백·이모지가 들어가도 파싱이 모호해지지 않는다.
   * `@Claude 리뷰어` 같은 이름을 그대로 쓸 수 있다.
   *
   * **방 안에서 유일해야 한다.** v2.2에서 같은 에이전트로 봇을 여럿 만들면
   * `Claude`, `Claude 2`처럼 자동으로 구분한다.
   */
  name: string;
  /** 이 봇의 ACP 세션. 아직 연결 전이면 null */
  sessionId: string | null;
  /**
   * 그 세션이 **프롬프트를 받아본 적이 있는가.**
   *
   * 🔴 에이전트는 **첫 프롬프트를 받아야** 세션을 디스크에 남긴다(§13.1).
   * 그래서 말을 안 건 세션 id는 **되살릴 수 없는 유령**이다. 그걸 기록에
   * 덮어써 버리면 **진짜 세션을 가리키던 포인터를 잃는다** — 실제로
   * 한 번 그랬다: 일시적인 복구 실패로 새 세션을 열었고, 그 유령 id가
   * 기록을 덮었고, 그다음부터는 영영 «사라졌습니다»만 떴다.
   *
   * 그래서 **써본 세션은 써본 세션으로만 밀어낸다.**
   */
  sessionPrompted?: boolean;
  /**
   * 이 봇의 세션에 마지막으로 전달된 메시지.
   *
   * v4.0 완전 공유방의 **증분 주입** 기준점이다. 거기서는 봇이 방의 모든 대화를
   * 보므로, 매번 전체를 보내지 않으려면 이 지점 이후만 주입해야 한다.
   *
   * v1.0(1:1)과 v2.0(멘션된 것만 전달)에서는 쓰이지 않는다. 필드 하나라 미리 둔다.
   */
  lastSeenMessageId?: string;
  /**
   * 봇의 역할 (B3). 봇을 추가할 때 선택으로 입력받는다.
   *
   * **ACP `session/new`에는 시스템 프롬프트 파라미터가 없다.** 그래서 이 값은
   * 세션의 **첫 프롬프트 앞에 프리픽스로** 붙여 보낸다. 별도 턴을 쓰면 어색한
   * 첫 응답이 생기기 때문이다. 컨텍스트 압축(C11) 후에는 요약에 안 남을 수 있어
   * 재주입이 필요하다.
   *
   * v2.2의 역할 프리셋과 v3.0 봇 간 협업의 핸드오프 규칙이 여기 들어간다.
   */
  rolePrompt?: string;
  /**
   * 이 봇의 권한 모드 — **에이전트가 주는 값 그대로** (D2).
   *
   * 우리가 사다리를 따로 만들지 않는다. 에이전트마다 `mode` 선택지와 설명이
   * 다르고, 그걸 우리 이름으로 옮기려면 **이름을 짐작해야** 하는데 ACP가
   * `mode`의 뜻을 정하지 않아(*"UX only"*) 언제든 깨진다.
   *
   * 대신 방 만들 때 **에이전트가 준 목록을 그대로 보여주고**, 고른 값을 여기
   * 담아 세션에 적용한다(`session/set_config_option`). 세션이 봇 단위라(B1)
   * 이게 곧 봇별 권한이다.
   *
   * 비어 있으면 에이전트 기본값을 쓴다 — `mode`를 안 주는 에이전트도 있다.
   */
  agentMode?: string;
  /**
   * 물어봐야 할 때 **누구에게 물을지** (D2).
   *
   * 기본은 사용자다. v2.0 단체방에서 다른 봇을 지정할 수 있다 — 그러면 우리가
   * 요청을 받아 그 봇에게 넘기고, 답을 받아 에이전트에게 돌려준다.
   *
   * **승인 주체가 넘어가는 게 아니다.** `session/request_permission`은 클라이언트
   * 메서드라 응답은 언제나 우리가 만든다(§4.2.2). 대상은 «누구 말을 듣나»일 뿐이고,
   * 그래서 기록(D3)과 제한은 우리 손에 남는다.
   */
  approver: Approver;
  /** 이 봇의 질문 정책 (D5). 같은 이유로 봇에 붙는다 */
  answerPolicy: AnswerPolicy;
  /**
   * 이 봇이 쓰는 모델의 **표시 이름** (B5).
   *
   * 목록에 제목 아래로 보여주므로 id(`opus-5`)가 아니라 사람이 읽는
   * 이름(`Opus 5`)이다. **우리가 짓지 않는다** — 세션이 실제로 들고 있는
   * `category === "model"` 옵션의 현재 값을 그대로 옮긴다. 그래야 사용자가
   * 안 고른 «에이전트 기본값»도 맞게 나온다.
   *
   * 모델을 안 알려주는 에이전트도 있으므로 비어 있을 수 있다.
   */
  modelLabel?: string;
  /**
   * 그 모델의 **값(id)**. 되살리려면 이게 필요하다.
   *
   * 🔴 표시 이름만 들고 있었더니 **다시 적용할 수가 없었다** —
   * 이름으로 역추적하는 건 에이전트가 이름을 바꾸면 깨진다.
   * `agentMode`가 처음부터 id였던 것과 같은 이유다(D2).
   */
  model?: string;
  /**
   * 이 봇의 세션이 마지막으로 들고 있던 **모든 설정값** (`configId` → 값).
   *
   * 🔴 개별 필드로 하나씩 들고 있었더니 **고칠 때마다 하나씩 빠뜨렸다** —
   * 권한 모드를 되살리게 했더니 모델이 안 돌아왔고, 모델을 고쳐도
   * **사고 강도·Fast mode는 여전히 기본값으로 돌아갔다.**
   *
   * 에이전트가 주는 범주를 우리가 미리 알 수 없으므로(ACP는 문자열이다)
   * **모르는 것까지 그대로 담아 그대로 되돌려준다.**
   */
  configValues?: Record<string, string | boolean>;
}

export type MessageRole = "user" | "agent" | "system";

/**
 * 메시지 하나. provider에 무관한 형태로 정규화한다 —
 * 이 정규화가 fork 폴백과 v2.0 단체방 기록 주입의 전제다.
 */
export interface Message {
  id: string;
  role: MessageRole;
  /** 이 메시지를 만든 봇. role이 "user"면 없음 */
  authorBotId?: string;
  text: string;
  /**
   * 이 메시지가 전달된 봇들.
   *
   * v1.0에서는 방의 유일한 봇. v2.1의 "봇별 1:1 뷰"가 이 필드로 필터링한다.
   */
  deliveredTo: string[];
  /**
   * 이 응답이 답하는 사용자 메시지들.
   *
   * **복수인 이유**는 큐잉이다 — 턴이 진행 중일 때 들어온 메시지들은 묶여서
   * 한 번에 전달되므로(§4.3) 응답 하나가 여러 질문에 답한다.
   *
   * v2.0 단체방에서는 여러 봇이 동시에 답하므로 짝을 아는 게 더 중요해진다.
   *
   * UI는 **자명하지 않을 때만** 보여준다 — 바로 앞 메시지 하나에 답하는
   * 1:1 대화에서는 표시하지 않는다.
   */
  replyToIds?: string[];
  /**
   * 한 번에 작성된 메시지 묶음의 id (v2.0).
   *
   * 사용자가 한 메시지 안에서 여러 봇을 멘션하면 대상별로 쪼개 저장하는데,
   * 원래 한 번에 쓴 것이라는 정보를 여기에 남겨 UI에서 붙여 렌더링한다.
   */
  composeGroupId?: string;
  /** 에이전트가 건드린 파일들. UI에서 카드로 보여주고 탭하면 diff를 연다 */
  /**
   * 이 턴에 한 일들 (C3). **기본으로 접힌다.**
   *
   * 승인 기록(D3)에 기대지 않고도 *"무슨 명령이 돌았나"* 를 알 수 있어야 한다.
   */
  tools?: ToolActivity[];
  files?: FileChange[];
  /** 사용자가 붙인 이미지 등. 원본은 blob으로 따로 저장하고 여기엔 참조만 */
  attachments?: Attachment[];
  /**
   * 이 시스템 메시지는 **경계다** (C11).
   *
   * 압축 지점은 메모가 아니라 선이다 — «이 위로는 에이전트가
   * 요약으로만 기억한다»를 한눈에 보여줘야 한다. 화면이 그렇게
   * 그리도록 표시만 남긴다.
   */
  /**
   * 에이전트가 세운 계획 (`plan` 업데이트).
   *
   * 🔴 계획 모드의 **알맹이**인데 여태 통째로 버리고 있었다. 항목형과
   * 마크다운형 둘 다 오므로 받은 모양 그대로 담는다.
   */
  plan?: { entries?: Array<{ text: string; status: string }>; markdown?: string };
  mark?: "compaction";
  /**
   * 압축하면서 에이전트가 남긴 요약 (C11·F7).
   *
   * 🔴 **화면에는 안 보여준다** — 사용자가 읽을 건 자기 대화지
   * 요약이 아니다. 들고 있는 건 **되먹임(F7)을 위해서다.**
   *
   * 우리는 모델이 없어 대화를 요약할 수 없고, 시키려면 에이전트 턴을
   * 써야 하는데 **세션이 죽은 뒤에는 시킬 상대가 없다.** 살아 있을 때
   * 받아 두는 게 유일한 길이고, 에이전트가 이미 공짜로 준다.
   */
  summary?: string;
  /** 에이전트의 사고 과정. 기본은 접어둔다 */
  thought?: string;
  createdAt: number;
  /** 아직 스트리밍 중인지 */
  streaming?: boolean;
  /** 에러 메시지. 있으면 말풍선 대신 에러로 렌더 */
  error?: string;
  /**
   * 응답을 받다가 끊겼다.
   *
   * **에이전트는 전체 응답을 기억하는데 우리만 잘려 있는 상태다.**
   * 끊긴 메시지는 언제나 **마지막 에이전트 메시지 하나**이므로, 보정할 때
   * 전체 히스토리를 매칭할 필요 없이 `session/load`로 받은 **꼬리 하나만
   * 바꿔치기**하면 된다 (백로그).
   */
  truncated?: boolean;
  /**
   * 사용자 메시지가 **에이전트에 전달되지 못한** 이유.
   *
   * 있으면 말풍선에 `↻ 다시 보내기`를 붙인다. 메신저에서 실패한 메시지를
   * 그냥 버리지 않는 것과 같다.
   *
   * 응답을 받다가 끊긴 경우는 여기 해당하지 않는다 — 이미 답이 일부 왔으므로
   * 다시 보내면 중복이 된다.
   */
  sendFailed?: string;
}

/**
 * 첨부 파일. **원본 바이트는 여기 담지 않는다.**
 *
 * base64를 트랜스크립트 JSON에 넣으면 방 파일이 수십 MB가 되어 로딩과
 * 전문 검색이 둘 다 망가진다. 원본은 `blobs/<sha256>.<ext>`에 두고 여기엔
 * 해시만 둔다. 같은 스크린샷을 여러 번 붙여도 파일은 하나다.
 */
export interface Attachment {
  /** blob 파일 이름이자 중복 제거 키 */
  sha256: string;
  mimeType: string;
  /** 사용자에게 보여줄 이름 */
  name: string;
  /**
   * 원본 파일 경로 (있으면).
   *
   * **워크스페이스 안이면 내용 대신 경로만 보낸다**(I4) — 에이전트가 직접 읽어야
   * 미저장 버퍼가 반영되고 토큰도 아낀다. 붙여넣은 스크린샷처럼 디스크에 없는
   * 첨부는 이 값이 없다.
   */
  path?: string;
  byteSize: number;
  /** 이미지일 때만 */
  width?: number;
  height?: number;
}

/**
 * 이 첨부가 **내용으로** 가나, **경로로** 가나 (I4).
 *
 * 규칙이 두 군데에 있으면 어긋난다 — 실제로 보낼 때(`toContentBlock`)와
 * 저장할 때(셸)가 같은 답을 내야 한다. blob은 «무엇을 보냈나»의 기록이므로,
 * 경로로 가는 것의 전문을 담아두면 **기록이 거짓말을 한다.**
 *
 * ```
 * 이미지·오디오        내용   경로로는 못 본다
 * 워크스페이스 안 파일  경로   에이전트가 직접 읽는다 (미저장 버퍼까지)
 * 그 밖                내용   에이전트가 접근할 수 없다
 * ```
 */
export function sendsContent(
  a: { mimeType: string; path?: string },
  cwd: string,
): boolean {
  if (a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/")) return true;
  return !(a.path !== undefined && isInside(a.path, cwd));
}

/**
 * 그 경로가 이 디렉터리 안인가.
 *
 * **단순 `startsWith`로는 안 된다** — `/ws`로 검사하면 `/wsx/a.ts`가 통과한다.
 * 이름이 비슷한 이웃 폴더를 워크스페이스 안으로 착각하면, 에이전트가 못 읽는
 * 파일을 경로만 보내놓고 보냈다고 여기게 된다.
 */
export function isInside(path: string, cwd: string): boolean {
  if (!cwd) return false;
  const base = cwd.replace(/[\/]+$/, "");
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/**
 * 에이전트가 한 일 하나 (C3).
 *
 * **«과정»이라 기본으로 접힌다.** 채팅은 대화를 읽는 곳이지 로그를 읽는 곳이
 * 아니다. 다만 **기록은 남아야 한다** — 무슨 명령이 돌았는지 알 방법이
 * 승인 기록(D3)뿐이면, 자동 승인된 것들만 골라서 흔적이 없어진다.
 *
 * 파일 **변경**은 여기 넣지 않는다. 그건 과정이 아니라 결과라 카드로 따로 남긴다(E2).
 */
export interface ToolActivity {
  /** `toolCallId`. 같은 id로 여러 번 오므로 이걸로 합친다 */
  id: string;
  title: string;
  /** `read` · `edit` · `execute` · `fetch` … 아이콘과 필터에 쓴다 */
  kind?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  /** 건드린 파일들 */
  paths?: string[];
  /**
   * **실제로 돌린 명령** (있으면).
   *
   * 🔴 `Bash`라는 제목만으로는 `ls`인지 `rm -rf`인지 알 수 없다. 자동 승인된
   * 것은 승인 카드(D3)도 안 남으므로 **여기가 유일한 흔적**이다 —
   * 사람이 판단할 수 없는 걸 기록이라고 부를 수는 없다.
   */
  command?: string;
  /**
   * 그 도구가 **뱉은 것**.
   *
   * 들어간 것만 보이면 반쪽이다 — 테스트가 통과했는지 실패했는지는 여기 있다.
   * 길면 잘라서 담고 **잘랐다고 적는다**(`acpConnection.outputOf`).
   */
  output?: string;
  /** 시작 시각. 타임라인으로 읽으려면 필요하다 */
  at?: number;
  /**
   * **글의 어디쯤에서 일어났나** — 그 시점의 `Message.text` 길이.
   *
   * 🔴 이게 없으면 한 턴의 말이 통째로 한 덩어리가 되고 활동은 전부 그 아래에
   * 쌓인다. 실제 대화는 **«말하고 → 뭘 하고 → 다시 말하고»** 인데 화면은
   * «다 말하고 → 그 밑에 한 일 목록»이 되어 **무엇 때문에 그렇게 했는지**가
   * 끊긴다.
   */
  textAt?: number;
}

/**
 * 에이전트가 건드린 파일 하나. ACP `tool_call.content[]`의 `type: "diff"`에서 온다.
 *
 * UI는 3단계로 보여준다: 접힌 카드 → `▸ 자세히`(인라인 hunk) → 네이티브 diff.
 * 변경 전/후 내용이 있으므로 가상 문서로 만들어 디스크를 건드리지 않고
 * `vscode.diff`를 띄울 수 있다.
 */
export interface FileChange {
  path: string;
  kind: "read" | "edit" | "create" | "delete";
  /**
   * 변경 전/후 내용의 blob 해시. 새 파일이면 old가, 읽기·삭제면 new가 없다.
   *
   * **전문을 여기 담지 않는다.** 100KB 파일을 20번 고치면 트랜스크립트가 4MB가 되어
   * 부분 로딩과 전문 검색이 둘 다 망가진다. `Attachment`와 같이 `blobs/<sha256>`에 두고
   * 해시만 참조한다 — 내용이 같으면 중복 제거도 된다.
   */
  oldSha256?: string;
  newSha256?: string;
  added?: number;
  removed?: number;
  /** 어느 봇이 고쳤는지. v2.0 단체방에서 구분에 쓴다 */
  byBotId?: string;
}

/**
 * 채팅방.
 *
 * v1.0에서 `participants`는 항상 길이 1이다(1:1 채팅). v2.0에서 봇이 여러 개가
 * 되지만 방 구조 자체는 바뀌지 않는다 — 봇마다 각자 ACP 세션을 갖는다.
 *
 * 방을 나가도 세션은 살아 있으므로 에이전트는 계속 일하고, 돌아오면 unread가 쌓여 있다.
 */
export interface Room {
  id: string;
  /** 방 만들기 화면에서 사용자가 입력. 비우면 "새 대화 N" */
  title: string;
  /** v1.0: 길이 1. v2.0: 여러 개 */
  participants: BotInstance[];
  cwd: string;
  messages: Message[];
  /**
   * 안 읽은 에이전트 응답 수.
   *
   * **보고 있지 않은 방에서만** 늘어난다. 방을 열면 0이 된다.
   */
  unread: number;
  /**
   * 쓰다 만 메시지.
   *
   * 메신저라면 방을 나갔다 와도 입력창에 남아 있어야 한다.
   * 타이핑마다 저장하면 디스크를 혹사하므로 디바운스해서 쓴다.
   */
  draft?: string;
  /**
   * 마지막으로 읽은 메시지.
   *
   * 메신저의 **"여기서부터 안 읽음" 구분선**이 그어지는 자리다.
   * `unread` 숫자만으로는 *"2개 안 읽었다"* 는 알아도 어디서부터인지 모른다.
   *
   * **방을 열 때 스크롤도 이 값이 정한다** — 안 읽은 게 있으면 그 지점으로,
   * 없으면 맨 아래로. 스크롤 위치를 따로 저장하지 않는 이유다.
   */
  lastReadMessageId?: string;
  /** 세션 사용량 (B14). 에이전트가 주는 경우에만 채워진다 */
  usage?: RoomUsage;
  /**
   * **화면의 기록과 에이전트가 아는 것이 어긋났다** (F7).
   *
   * 이전 세션을 못 이어받아 새로 열었다는 뜻이다. 화면에는 예전 대화가 그대로
   * 보이는데 에이전트는 백지라서, **말해주지 않으면 사용자는 상대가 다 안다고
   * 믿은 채로 대화한다.** 그게 이 필드가 있는 유일한 이유다.
   *
   * 사용자가 «이어가기»나 «새로 시작»을 고르면 지워진다.
   */
  contextLost?: boolean;
  /**
   * 못 이어받은 세션 id (F7).
   *
   * 🔴 **일시적인 실패일 수 있다.** 에이전트가 늦게 뜨거나 잠깐 바빴던 것뿐이면
   * 나중에는 붙는다 — 그런데 실패하자마자 새 세션으로 갈아타 버리면 **다시
   * 시도할 대상 자체가 사라진다.** 사용자가 «새로 시작»을 고를 때까지 들고 있다가
   * «다시 시도»에 쓴다.
   */
  lostSessionId?: string;
  /**
   * 다음 프롬프트에 **지금까지의 대화를 함께 보낸다** (F7).
   *
   * 별도 턴으로 밀어 넣지 않는 이유는 역할 주입(B3)과 같다 — 턴을 쓰면 어색한
   * 답이 하나 생기고 그만큼 돈이 더 든다. 다음 메시지 앞에 붙이면 **필요한
   * 만큼만** 쓴다.
   *
   * 디스크에 남긴다. 고르자마자 창을 닫아도 약속은 지켜져야 한다.
   */
  refeedPending?: boolean;
  createdAt: number;
  lastActivityAt: number;
  /**
   * 봇끼리 서로 부를 수 있는지 (v3.0). 방 만들 때 정하고 **나중에 토글 가능**.
   *
   * 이 값이 곧 `mention_bot` 도구 노출 여부다. off면 도구를 아예 주지 않으므로
   * 봇이 시도조차 못 하고, 도구 정의가 프롬프트에 안 들어가 토큰도 아낀다.
   * 도구 노출은 `tools/list_changed`로 즉시 반영되고 되돌리기도 쉽다.
   */
  botRelayEnabled?: boolean;
  /**
   * 모든 봇이 방의 모든 대화를 보는 공유방인지 (v4.0).
   *
   * **방 만들 때만 정하고 나중에 바꿀 수 없다.** 켜면 봇들이 그동안 못 보던 대화를
   * 한꺼번에 받아 토큰이 튀고, 끄는 것은 이미 본 것을 못 본 것으로 만들 수 없어
   * 비가역적이다. `botRelayEnabled`가 토글 가능한 것과 대비된다.
   */
  contextShared?: boolean;
  /** fork로 생긴 방이면 원본 방 id (v1.1) */
  forkedFromRoomId?: string;
  /** 원본의 어느 메시지 지점에서 분기했는지 (v1.1) */
  forkedAtMessageId?: string;
}

/** 방 유형. 목록 아이콘이 이 값으로 갈린다 (B5) */
export type RoomKind = "direct" | "group" | "shared";

export function roomKind(room: Pick<Room, "participants" | "contextShared">): RoomKind {
  if (room.contextShared) return "shared";
  return room.participants.length > 1 ? "group" : "direct";
}

/**
 * 목록 화면에 필요한 것만 담은 요약.
 *
 * `rooms.json`에 이것만 저장해서 **목록을 즉시 띄운다.** 메시지는 방을 열 때
 * `rooms/<id>.json`에서 따로 읽는다 (F5의 부분 로딩).
 */
export interface RoomMeta {
  id: string;
  title: string;
  kind: RoomKind;
  cwd: string;
  /** 목록에는 안 쓰지만 방을 열 때 세션을 복구하려면 필요하다 */
  agentIds: string[];
  /**
   * 참여자의 모델 표시 이름. `agentIds`와 **같은 순서**다 (B5).
   *
   * 아직 세션을 안 연 방이나 모델을 안 알려주는 에이전트는 빈 문자열이다.
   */
  models?: string[];
  unread: number;
  /** 쓰다 만 초안이 있는지. 목록에 `초안: …`으로 표시한다 (WhatsApp 방식) */
  draftPreview?: string;
  createdAt: number;
  lastActivityAt: number;
  forkedFromRoomId?: string;
  /**
   * 원본의 어느 지점에서 갈라졌는지 (v1.1).
   *
   * 목록의 계보 배지를 누르면 **원본의 그 자리로** 간다. 방을 열어놓고
   * 다시 찾게 하지 않으려면 메타에도 있어야 한다 — 목록은 방을 안 읽는다.
   */
  forkedAtMessageId?: string;
}

/**
 * 검색 결과 하나 (H2).
 *
 * 메시지 전문을 담지 않는다 — 결과가 수백 개면 목록만으로 무거워진다.
 * 누르면 그 방을 열어 해당 메시지로 점프한다 (H3).
 */
export interface SearchHit {
  roomId: string;
  roomTitle: string;
  messageId: string;
  role: MessageRole;
  /** 매치 주변만 잘라낸 미리보기 */
  snippet: string;
  createdAt: number;
}

/** 방에 속하지 않는 앱 전체 상태. `app.json`에 따로 저장한다 */
export interface AppState {
  /** 에이전트별 마지막 모델 선택. 다음 방의 기본값이 된다 (B15) */
  lastModelByAgent?: Record<string, string>;
}

export function toMeta(room: Room): RoomMeta {
  return {
    id: room.id,
    title: room.title,
    kind: roomKind(room),
    cwd: room.cwd,
    agentIds: room.participants.map((b) => b.agentId),
    ...(room.participants.some((b) => b.modelLabel)
      ? { models: room.participants.map((b) => b.modelLabel ?? "") }
      : {}),
    unread: room.unread,
    ...(room.draft ? { draftPreview: room.draft.slice(0, 80) } : {}),
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    ...(room.forkedFromRoomId ? { forkedFromRoomId: room.forkedFromRoomId } : {}),
    ...(room.forkedAtMessageId ? { forkedAtMessageId: room.forkedAtMessageId } : {}),
  };
}

/**
 * 세션 사용량. ACP가 네이티브로 준다 — 외부 도구 연계가 필요 없다.
 *
 * `session/update`의 `usage_update`와 `PromptResponse.usage`에서 모은다.
 * **전부 optional이다.** 주지 않는 에이전트가 있으므로 없으면 UI에서 숨긴다.
 *
 * 구독 한도 잔량(Claude Pro의 5시간/주간 캡)은 여기 없다. ACP 범위 밖이다.
 */
export interface RoomUsage {
  /** 현재 컨텍스트에 든 토큰 */
  contextUsed?: number;
  /** 컨텍스트 창 전체 크기 */
  contextSize?: number;
  /**
   * 에이전트가 세는 누적 총합.
   *
   * **우리가 더하지 않는다.** 무엇을 총합에 넣을지는 에이전트가 정한다 —
   * 캐시 읽기를 넣기도 하고 빼기도 한다. 안 주면 입력+출력으로 대신한다.
   */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  /**
   * 캐시에서 읽은 토큰.
   *
   * LAB-1(캐시 리프레시)의 M2를 이 값으로 판정한다 — 리프레시 후 다음 턴에서
   * 이 값이 크면 fork가 캐시를 살린 것이고, 0에 가까우면 LAB-1은 폐기다.
   */
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  /** 누적 세션 비용 */
  cost?: { amount: number; currency: string };
}

/**
 * 방의 현재 상태. UI의 응답 대기 표시(C10)가 이 값으로 갈린다.
 *
 * 목록 화면에서도 쓰이므로 — 다른 방이 일하는 중인 걸 알아야 한다 —
 * 방 단위로 들고 있어야 하고, 채팅 화면의 지역 상태로 두면 안 된다.
 */
export type RoomStatus =
  /** 대기 */
  | "idle"
  /** CLI 프로세스 기동 또는 session/new */
  | "connecting"
  /** 프롬프트를 보냈고 첫 토큰이 오기 전 — `● ● ●` */
  | "waiting"
  /** agent_message_chunk 수신 중 */
  | "streaming"
  /** 도구 실행 중 */
  | "tool"
  /** 권한 요청 응답 대기 */
  | "permission"
  /** 에이전트의 질문(elicitation) 응답 대기 */
  | "asking"
  | "error";

/** 상태가 idle이 아니면 에이전트가 일하는 중 = 중단 버튼 활성화 */
export function isBusy(status: RoomStatus): boolean {
  return status !== "idle" && status !== "error";
}

/**
 * 승인을 **누가 답하나** (D2).
 *
 * 권한을 「봇 : 범위 : 대상」 세 칸으로 본다:
 *
 * ```
 * Claude : edit    : Codex     편집은 Codex가 봐준다
 * Claude : execute : 사용자     명령 실행은 사람이
 * ```
 *
 * **범위와 대상이 쌍이라는 게 핵심이다.** 위험한 범위만 사람에게 남기고
 * 나머지를 봇에게 넘길 수 있다 — 통째로 넘기거나 통째로 안 넘기거나가 아니다.
 */
export type Approver =
  | { kind: "user" }
  /** 같은 방의 다른 봇 (v2.0). 자기 자신은 지정할 수 없다 */
  | { kind: "bot"; botId: string };

export const ASK_USER: Approver = { kind: "user" };


/** 에이전트의 질문(elicitation)을 어떻게 처리할지 (D5) */
export type AnswerPolicy = "ask" | "auto";

/** 권한 요청 — 에이전트가 도구를 쓰기 전에 사용자에게 묻는다 */
export interface PermissionRequest {
  title: string;
  /** 읽기 전용 작업인지. 자동 승인 정책 판단에 쓴다 */
  readOnly: boolean;
  /**
   * 도구 종류 (`read` · `edit` · `execute` · `fetch` …).
   *
   * ACP `ToolKind`를 그대로 넘긴다. 아이콘을 고르고, 무엇을 승인하는지
   * 한마디로 말해주는 데 쓴다.
   */
  kind?: string;
  /** 건드릴 파일들 */
  paths?: string[];
  /**
   * 실행할 명령.
   *
   * **이게 없으면 사용자가 무엇을 승인하는지 모른다.** `rm -rf /`와 `ls`가
   * 똑같이 *"터미널 명령"* 으로 보이면 승인 버튼은 의미가 없다.
   */
  command?: string;
  /** 바뀔 내용. 승인 전에 diff를 볼 수 있어야 한다 */
  diff?: { path: string; oldText: string | null; newText: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/**
 * 에이전트가 사용자에게 던지는 질문 (D4).
 *
 * ACP 스키마를 그대로 노출하지 않고 셸이 렌더링할 만큼만 추린다 — core가
 * UI 구현을 강요하지 않도록.
 */
export interface ElicitationRequest {
  id: string;
  /** 폼 필드. JSON Schema에서 추린 것 */
  fields: ElicitationField[];
  /** URL 모드면 여기로 보낸다 (OAuth 등) */
  url?: string;
}

export interface ElicitationField {
  name: string;
  label: string;
  /** 렌더링할 수 없는 타입이면 `unsupported` — 건너뛰거나 안내를 띄운다 */
  type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect" | "unsupported";
  description?: string;
  required?: boolean;
  /** `select`·`multiselect`일 때의 선택지 */
  options?: Array<{ value: string; label: string }>;
}

export type ElicitationDecision =
  | { outcome: "accepted"; values: Record<string, unknown> }
  | { outcome: "declined" }
  | { outcome: "cancelled" };

/** 질문 정책의 기본값. 에이전트가 물으면 사용자에게 띄운다 */
export const DEFAULT_ANSWER_POLICY: AnswerPolicy = "ask";

export function createBotInstance(
  agent: AgentDef,
  opts: {
    taken?: ReadonlySet<string>;
    rolePrompt?: string;
    agentMode?: string;
    approver?: Approver;
    answerPolicy?: AnswerPolicy;
  } = {},
): BotInstance {
  const taken = opts.taken ?? new Set<string>();
  let name = agent.label;
  for (let n = 2; taken.has(name); n++) {
    name = `${agent.label} ${n}`;
  }
  return {
    id: `${agent.id}-${Date.now().toString(36)}`,
    agentId: agent.id,
    name,
    sessionId: null,
    // 권한은 봇에 붙는다 (D2). 비워두지 않는다 — «설정 안 됨» 상태가 있으면
    // 그때 무슨 권한인지 아무도 모른다.
    ...(opts.agentMode ? { agentMode: opts.agentMode } : {}),
    // 대상의 기본은 **사용자**다. 봇에게 넘기는 건 일부러 고르는 것이어야 한다.
    approver: opts.approver ?? ASK_USER,
    answerPolicy: opts.answerPolicy ?? DEFAULT_ANSWER_POLICY,
    ...(opts.rolePrompt ? { rolePrompt: opts.rolePrompt } : {}),
  };
}
