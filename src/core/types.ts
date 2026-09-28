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
   * 이 봇의 **컨텍스트가 얼마나 찼나** · 토큰 씀씀이.
   *
   * 🔴 예전에는 `Room.usage` 하나였다. 그런데 `usage_update`는 **세션마다** 오고
   * 세션은 봇 단위다(B1) — 봇이 둘이면 **나중에 온 봇이 앞 봇의 숫자를 덮어썼다.**
   * 이벤트에 이미 봇이 실려 오는데 우리가 버린 것이라, §0의 «준 것을 버리지
   * 않는다»를 우리 쪽에서 어긴 자리였다.
   *
   * 압축을 시킬지 말지는 **봇마다 따로 판단할 일이다** — 62% 찬 봇과 21% 찬 봇을
   * 한 숫자로 뭉개면 둘 다 틀린다.
   */
  usage?: RoomUsage;
  /**
   * **분기가 폴백으로 떨어졌다** — 그 이유 (v1.1·v2.0).
   *
   * 네이티브 분기가 안 되어 `session/new`로 열었다는 표시다. 있으면 화면이
   * **«다시 시도»를 권한다** — 세션 복구 실패(F7)과 같은 이유다:
   * **일시적인 실패일 수 있다.** 에이전트가 잠깐 바쁜 것뿐인데 그 한 번 때문에
   * 영영 «글자만 옮긴 방»으로 살 이유가 없다.
   *
   * 다시 해서 성공하면 지운다.
   */
  forkFallback?: string;
  /**
   * ★ **이 봇의 세션이 끊겼다** (F7) — 화면과 에이전트가 어긋난 상태.
   *
   * 🔴 예전에는 `Room.contextLost` 뿐이었다. 그런데 **세션은 봇 단위다**(B1) —
   * 알파의 세션만 죽어도 방 전체가 «위 대화를 모릅니다»가 됐고, 멀쩡한
   * 베타에게도 배너가 떴다. 에이전트를 갈아탈 때도 같았다.
   */
  contextLost?: boolean;
  /** 그때 놓친 세션 id — 그 CLI에서 `--resume` 으로 열어볼 수 있다 */
  lostSessionId?: string;
  /**
   * ★ **이 봇에게** 지난 대화를 다음 프롬프트에 실어 보낸다 (F7).
   *
   * 🔴 이것도 방에 있었다. 그래서 **먼저 말을 거는 봇이 남의 되먹임을 먹었다** —
   * 실측에서 알파가 잃은 맥락이 베타에게 들어갔고, 정작 알파는 못 받았다
   * (`refeedPending` 이 한 번 쓰이고 꺼지므로).
   */
  refeedPending?: boolean;
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
   * ★ **이 말이 어디서 이어진 것인가** (2026-09-28).
   *
   * 봇은 **질문 없이도 말한다** — 백그라운드로 띄운 일이 끝나면 턴이 닫힌
   * 뒤에 제 발로 결과를 알려온다(실측 `probes/selfwake.cjs`). 그런 말풍선은
   * `replyToIds` 가 **없다.** 가리킬 질문이 애초에 없기 때문이다.
   *
   * 🔴 그러면 화면에서 *"이게 왜 왔지"* 가 된다. 사용자는 «내 말 → 답»을
   * 짝지으며 읽는데, 짝이 없는 말은 앞 답의 뒷부분처럼 읽힌다.
   *
   * 🔴 **«무엇이 끝나서»는 못 적는다**(실측 `probes/waketrigger.cjs`).
   * 백그라운드 도구는 «띄우는 데 성공»한 시점에 이미 `completed` 로 닫히고,
   * 깨어난 뒤에는 **그 id 로 아무 갱신도 안 온다** — 완전히 새 도구만 생긴다.
   * ACP 층에 «이 작업이 저 말을 불렀다»는 실이 없다.
   *
   * 그래서 **확실한 것만** 적는다: 그 일을 시킨 **원래 요청**이다. «무엇이
   * 끝나서»만큼 정확하진 않지만 «왜 이게 왔지»에는 답한다.
   */
  afterIds?: string[];
  /**
   * 한 번에 작성된 메시지 묶음의 id (v2.0).
   *
   * 사용자가 한 메시지 안에서 여러 봇을 멘션하면 대상별로 쪼개 저장하는데,
   * 원래 한 번에 쓴 것이라는 정보를 여기에 남겨 UI에서 붙여 렌더링한다.
   */
  composeGroupId?: string;
  /**
   * ★ **이 말이 대화에서 자리를 잡은 시각** (v2.x 대기 정렬).
   *
   * 보통은 `createdAt` 과 거의 같다 — 쓰자마자 나가므로. 그런데 앞 턴이 돌고
   * 있으면 **줄에 섰다가 나중에** 나간다(§4.3). 그 사이에 옆 봇의 답이나
   * 시스템 줄이 생기면, 화면을 **쓴 시각**으로 늘어놓았을 때 **아직 안 간
   * 말이 이미 일어난 일들 위에** 놓인다 — 바닥으로 내려가 «지금 상태»를
   * 보려는데 정작 안 간 것이 위에 묻힌다.
   *
   * 🔴 **«대기 중이면 맨 아래»만으로는 부족하다.** 그러면 줄에서 나오는 순간
   * 조건이 풀려 말풍선이 **위로 튄다** — 이미 본 것이 두 번 움직인다.
   *
   * 🔴 그리고 이것을 처음에 `sentAt`(«간 시각»)이라고 불렀는데, **이름이
   * 경우를 하나 빠뜨렸다**: 「빼기」로 물린 말은 **안 갔지만 줄에서는 나왔다.**
   * 그래서 자리를 못 잡고 **위로 튀었다** — 누른 말풍선이 눈앞에서 달아났다.
   *
   * 자리를 정하는 것은 «간 시각»이 아니라 **«줄에서 나온 시각»** 이다. 나간
   * 이유(보냄·빼기·중단)는 상관없다 — **더 이상 기다리지 않게 된 그때**다.
   */
  placedAt?: number;
  /**
   * ★ **이 시스템 줄이 누구 이야기인가** (v2.1).
   *
   * 🔴 시스템 줄에는 **주인이 없었다** — `deliveredTo` 도 `authorBotId` 도 비어
   * 있다. 방 하나만 볼 때는 문제가 없지만 **봇별 뷰**에서는 갈 곳이 없다:
   * «리뷰어의 모델이 바뀌었습니다»가 구현 뷰에 뜨면 노이즈이고, 아예 숨기면
   * 정작 리뷰어 뷰에서도 안 보인다.
   *
   * **없으면 방 전체 이야기**다 (압축 경계, 기억 공유 공지 …). 있으면 그 봇들의
   * 뷰에만 나온다. 부딪힘처럼 **둘 이상**인 것이 있어서 배열이다.
   */
  aboutBotIds?: string[];
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
  /**
   * 이 시스템 메시지의 종류.
   *
   * `compaction` 은 **경계**다 — 선으로 그어 «이 위로는 요약»을 보인다.
   * `review` 는 **우리가 봇에게 물어본 것**이다(§4.2.2) — 사용자가 쓴 말이
   *   아니므로 말풍선이 아니고, 그렇다고 숨기지도 않는다(§0). 접어서 보인다.
   * `error` 는 **못 한 일**이다 — 세션을 못 열었거나, 프로세스가 죽었거나,
   * 첨부를 못 보냈거나. 화면에서 붉게 갈라진다.
   *
   * 🔴 이걸 **기록으로** 두는 이유는 §0 P5다. 예전엔 이벤트로만 보내서
   * 화면을 다시 그리면 사라졌다 — **이름만 바꿔도** 그랬다.
   */
  mark?: "compaction" | "error" | "review";
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
  /**
   * **안 간 봇들** (v2.0).
   *
   * 🔴 한 메시지가 여러 봇에게 갈 수 있으므로(`@알파 @베타`) «실패»도 봇마다다.
   * 알파의 턴만 중단했는데 말풍선 전체가 «전달 실패»가 되면, 멀쩡히 받은
   * 베타에게까지 다시 보내게 된다 — **중복 작업**이고, 코딩 에이전트에서는
   * 파일을 두 번 고치는 일이다.
   *
   * 비어 있으면 `deliveredTo` 전원에게 못 간 것으로 본다 (v1.0 경로).
   */
  notSentTo?: string[];
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
  const base = cwd.replace(/[\\/]+$/, "");
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
/**
 * ★ **지금 같은 파일에서 부딪히고 있는 봇들** (§4.3).
 *
 * 🔴 **«덮어쓴다»가 아니다** (2026-09-22 실측). 예전에는 *"나중에 끝나는 쪽이
 * 앞의 변경을 덮어쓸 수 있습니다"* 라고 적었는데, 재보니 **그렇지 않다**:
 *
 * ```
 * Edit  · 고치는 자리가 안 겹침  →  통과.  둘 다 살아남는다
 * Edit  · 고치는 자리가 겹침    →  거부.  "File has been modified since read"
 * Write                         →  거부.  항상
 * bash (`> file`, `sed -i`)     →  덮어쓴다. 가드도 경고도 없다
 * ```
 *
 * 그래서 진짜 위험은 «작업이 사라지는 것»이 아니라 **«막혀서 다시 읽느라 조용히
 * 느려지는 것»** 이다. 안 망가지는 대신 아무도 이유를 모른다.
 *
 * ★ **그리고 여기가 우리 자리다.** 에이전트가 주는 사유는 *"by the user or by a
 * linter"* 다 — **얘는 누가 바꿨는지 모른다.** 어느 봇이 이번 턴에 어느 파일을
 * 건드렸는지 아는 것은 우리뿐이라, **«누가»를 채워 넣을 수 있는 것도 우리뿐이다.**
 */
export interface Clash {
  /** 부딪힌 파일 */
  path: string;
  /** 부딪힌 봇들 (`BotInstance.id`) */
  botIds: string[];
  /**
   * ★ **정황이 아니라 사실인가.**
   *
   * `false`면 «둘 다 이 파일을 만졌다»는 관찰일 뿐이다 — 고치는 자리가
   * 안 겹치면 아무 일도 안 일어난다. `true`면 **에이전트가 실제로 거부당했다고
   * 신고**한 것이다(`tool_call` 의 `status: "failed"`).
   */
  blocked?: boolean;
  /** 거부 사유. **CLI가 준 말 그대로** 옮긴다 (§0) */
  reason?: string;
  /** 막힌 쪽 */
  blockedBotId?: string;
  at: number;
}

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
  /**
   * ★ **이 활동의 승인 결과** (D3).
   *
   * 🔴 예전에는 승인할 때마다 **시스템 메시지 한 줄**을 대화에 붙였다.
   * 한두 번이면 괜찮은데 에이전트가 스무 번 물으면 **대화가 시스템 줄로
   * 덮인다** — 정작 읽을 내 대화가 그 사이에 묻힌다.
   *
   * 승인도 **활동의 일종**이다. 그 도구가 무엇이었는지 옆에 붙어 있을 때
   * 제일 읽기 쉽고(«무엇을 승인했나»가 한 자리에), 평소에는 접혀 있다.
   *
   * `toolCallId` 로 잇는다 — `session/request_permission` 이 그걸 실어 온다.
   */
  decision?: {
    /** `✓` 허용 · `✕` 거절 · `·` 모르는 종류 */
    mark: string;
    /** 고른 선택지의 이름. 답을 안 했으면 «거부했습니다» */
    label: string;
    /** 사람이 아니라 봇이 정했으면 그 이름 (§4.2.2) */
    by?: string;
  };
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
  /**
   * ★ **내보낸 봇들 — 이름만** (2026-09-23).
   *
   * 세션도 설정도 따라가지 않는다. 그런데 **이름은 기록의 일부**다 —
   * 지난 말풍선과 멘션 칩이 «@나간 봇»이라는 익명이 되면 *"누구한테 시킨
   * 거였지"* 에 답할 수 없다. 기록은 우리 것이고(§0), 떠났다고 그 사람이
   * 한 말이 익명이 되지는 않는다. 나간 뒤에는 **이름이 얼어붙는다.**
   */
  left?: LeftBot[];
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
  /**
   * **방 전체** 사용량 (B14) — 에이전트가 주는 경우에만 채워진다.
   *
   * 진짜 숫자는 봇마다 `BotInstance.usage`에 있다. 이건 목록의 고리와 «거의 찼다»
   * 경고처럼 **방 하나를 한 눈금으로 보여줘야 하는 자리**를 위한 값이고,
   * **가장 많이 찬 봇**을 옮겨 적는다 — 경고는 제일 급한 것을 따라가야 한다.
   *
   * 봇이 하나면 그 봇의 값과 같다.
   */
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

/**
 * 네이티브 분기가 **안 될 때 무엇을 할지** (v1.1).
 *
 * 🔴 **기본은 언제나 네이티브다.** 세션을 복제하면 계획·파일 기억까지 그대로
 * 오므로 잃는 게 없고 토큰도 안 든다. 이 값은 **그게 불가능할 때만** 쓰인다.
 *
 * 그때는 **우리가 정하지 않는다.** 둘 다 손해가 있고 방향이 반대라서다:
 *
 * ```
 * refeed   대화를 글로 옮긴다      맥락은 잇지만 **토큰이 든다**
 * fresh    기록만 두고 백지로 간다  싸지만 **상대는 아무것도 모른다**
 * ```
 *
 * 어느 쪽이 나은지는 대화 길이와 지갑 사정이 정한다 — 우리가 알 수 없는 것들이다.
 */
export type ForkFallback = "refeed" | "fresh";

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
/** 방을 떠난 봇 — **이름만** 남긴다. 세션도 설정도 따라가지 않는다 */
export interface LeftBot {
  id: string;
  name: string;
  /** 언제 나갔나 — 같은 이름이 다시 들어와도 헷갈리지 않게 */
  at: number;
}

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
  /**
   * ★ **봇 이름.** `agentIds` 와 **같은 순서**다.
   *
   * 🔴 목록은 여태 **에이전트 이름**을 썼다. 그런데 봇 이름은 사용자가 정하는
   * 것이고(방 만들 때·서랍에서), **부를 때 쓰는 이름도 그쪽이다**(멘션). 「구현」과
   * 「리뷰어」로 갈라 놓고 목록에서 «Claude, Codex» 만 보면 **어느 방이 무슨
   * 방이었는지 목록에서 알 수가 없다.**
   *
   * 에이전트는 안 버린다 — 툴팁에 남긴다(§0).
   */
  names?: string[];
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
    names: room.participants.map((b) => b.name),
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


/**
 * **사용자가 자리에 있나** (D5).
 *
 * 🔴 예전 이름은 «질문 정책»이었고 `elicitation` 을 어떻게 받을지였다.
 * 그 채널을 없앴으므로(ROADMAP §D4) 이제 남은 뜻은 하나다 —
 * **`auto` 면 프롬프트에 «묻지 말고 스스로 판단해 진행하라»를 붙인다.**
 *
 * 없애려다 말았다. 구조화된 질문이 사라진 뒤로는 **이것이 «묻지 마»를
 * 말할 수 있는 유일한 자리**라서, 빼면 대신할 것이 없다.
 */
export type AnswerPolicy = "ask" | "auto";

/** 권한 요청 — 에이전트가 도구를 쓰기 전에 사용자에게 묻는다 */
export interface PermissionRequest {
  /**
   * 어느 도구 호출에 대한 승인인가.
   *
   * 결정을 **그 활동에 붙이려면**(`ToolActivity.decision`) 이게 있어야 한다 —
   * 없으면 제목으로 넘겨짚는 수밖에 없고, 같은 제목이 여러 번 나온다.
   */
  toolCallId?: string;
  /**
   * ★ **누가 이걸 하려고 하나** (§4.2.2).
   *
   * 🔴 승인 큐에 제목만 있었다. 단체방에서 «파일 고치기»가 셋 뜨면
   * **어느 봇 것인지 알 수가 없다** — 그런데 그게 허용할지 말지를 가르는
   * 첫 번째 근거다(리뷰어가 파일을 고치려 하면 그것부터 이상하다).
   *
   * 세션은 봇 하나에 속하므로(B1) 우리가 붙여줄 수 있다.
   */
  askerBotId?: string;
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
 * **심사 하나가 줄에 서 있는 상태** (§4.2.2).
 *
 * 디스크에 안 남긴다 — 켜져 있는 동안만 뜻이 있는 것이고, 껐다 켜면
 * 그 승인 요청 자체가 사라진다(세션이 끊기므로).
 */
export interface ReviewWait {
  id: string;
  roomId: string;
  /** 승인을 요청한 봇 */
  askerBotId: string;
  /** 맡은 심사 봇 */
  judgeBotId: string;
  /** 무엇을 승인하려는지 */
  title: string;
  /**
   * `waiting` 은 **심사 봇이 한가해지길 기다리는 중**,
   * `asking` 은 **물어보고 답을 기다리는 중**이다.
   *
   * 둘을 가르는 이유는 사람이 볼 화면이 다르기 때문이다 — 앞엣것은
   * «언제 시작될지 모른다»고, 뒤엣것은 «곧 끝난다»고 읽혀야 한다.
   */
  state: "waiting" | "asking";
  since: number;
}

/** 질문 정책의 기본값. 에이전트가 물으면 사용자에게 띄운다 */
export const DEFAULT_ANSWER_POLICY: AnswerPolicy = "ask";

/**
 * 방 안에서 **겹치지 않는 봇 이름**을 만든다.
 *
 * 이름이 곧 멘션 이름이라(B1) 둘이 같으면 `@Claude` 가 누구를 가리키는지
 * 우리가 정할 수 없다. 겹치면 뒤에 수를 붙인다 — `Claude`, `Claude 2`, …
 *
 * 🔴 **규칙이 세 군데에 흩어져 있었다** — 봇을 만들 때, 이름을 바꿀 때,
 * 그리고 방 만들기 화면이 «이렇게 됩니다»를 미리 보여줄 때. 셋이 어긋나면
 * **화면이 약속한 이름과 실제 이름이 달라진다.** 한 곳에서만 정한다.
 */
export function uniqueBotName(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const tryThis = `${wanted} ${n}`;
    if (!taken.has(tryThis)) return tryThis;
  }
}

/**
 * ★ **이 메시지가 «그 봇의 뷰»에 나오나** (v2.1 · §5).
 *
 * 봇별 뷰는 **방이 아니라 필터**다. 데이터는 하나고 보는 창만 다르다 — 그래서
 * «1:1 뷰에서 보냈다» 같은 표시도 하지 않는다(§5 결정 사항).
 *
 * ```
 * user    그 봇에게 갔거나, **가려다 못 간** 것 (안 갔다는 사실도 그 봇 이야기다)
 * agent   그 봇이 한 말
 * system  주인이 없으면 방 전체 이야기라 **어디서나** 보인다
 * ```
 *
 * 🔴 **코어와 화면이 같은 함수를 쓴다.** 규칙을 베껴 두면 «뷰에는 있는데 봇은
 * 못 본 말» 같은 것이 생기는데, 이 뷰의 존재 이유가 바로 **«그 봇이 실제로 본
 * 전부»를 보여주는 것**이라(§5) 어긋나는 순간 기능이 거짓말이 된다.
 */
/**
 * ★ **이름을 찾는다 — 나간 봇까지** (2026-09-23).
 *
 * 🔴 `removeBot` 이 `participants` 에서 빼므로 **이름이 통째로 사라졌다.** 그래서
 * 지난 말풍선과 멘션 칩이 «@나간 봇» 이라는 **익명**이 됐다 — 대화를 다시 읽을 때
 * *"누구한테 시킨 거였지"* 에 답할 수 없다. 기록은 우리 것이고(§0), 사람이
 * 떠났다고 그 사람이 한 말이 익명이 되지는 않는다.
 *
 * 나간 뒤에는 **이름이 얼어붙는다** — 더 이상 바꿀 수 없으니 그게 맞다.
 */
export function botLabel(
  room: { participants: BotInstance[]; left?: LeftBot[] },
  botId: string,
): { name: string; gone: boolean } | undefined {
  const here = room.participants.find((b) => b.id === botId);
  if (here) return { name: here.name, gone: false };
  const gone = room.left?.find((b) => b.id === botId);
  return gone ? { name: gone.name, gone: true } : undefined;
}

/**
 * ★ **이 경로가 이미 절대경로인가** (E9 · 2026-09-28).
 *
 * 🔴 여기 있던 판정이 `/^([a-zA-Z]:[\/]|[\/])/` 였다. 문자 묶음 안의 `[\/]`
 * 는 **«/» 하나뿐**이다 — 역슬래시를 escape 한 게 아니라 슬래시를 쓸데없이
 * escape 한 것이라, `C:\Users\…` 가 **상대경로로 판정됐다.** 그러면 앞에
 * cwd 가 한 번 더 붙어서 이런 것이 열린다:
 *
 * ```
 * c:\Users\BASE\Desktop\Taein Yoon\c:\Users\BASE\Desktop\Taein Yoon\ABOUT.md
 * ```
 *
 * 에이전트는 **플랫폼 기본 구분자**로 경로를 준다. Windows 에서는 역슬래시가
 * 보통이므로, 사실상 **Windows 에서 파일 열기가 늘 깨져 있었다.**
 *
 * UNC(`\\서버\공유`)도 절대경로다 — 첫 글자가 구분자이므로 같이 걸린다.
 */
export function isAbsPath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

/**
 * ★ **경로에서 파일 이름만** (2026-09-28).
 *
 * 🔴 여기저기서 `path.split(/[\/]/).pop()` 으로 뽑고 있었다. 같은 실수다 —
 * `[\/]` 는 «/» 하나뿐이라 **역슬래시 경로는 안 쪼개진다.** 그러면 이름
 * 자리에 **경로가 통째로** 들어간다:
 *
 * ```
 * 지금  c:\Users\BASE\Desktop\ABOUT.md  →  «c:\Users\BASE\Desktop\ABOUT.md»
 * 고침  c:\Users\BASE\Desktop\ABOUT.md  →  «ABOUT.md»
 * ```
 *
 * 첨부 이름 · blob 문서 제목 · 선택 영역 이름 · 거절 메시지에서 그랬다.
 * 다섯 자리가 같은 병을 앓고 있었으므로 **한 자리로 모은다.**
 */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * 상대 경로면 방의 작업 폴더를 앞에 붙인다 (E9).
 *
 * 구분자는 «/» 로 잇는다 — Windows 도 섞인 구분자를 받는다.
 */
export function underCwd(cwd: string, p: string): string {
  return isAbsPath(p) ? p : `${cwd}/${p}`;
}

export function inBotView(m: Message, botId: string): boolean {
  if (m.role === "system") {
    return m.aboutBotIds === undefined || m.aboutBotIds.includes(botId);
  }
  /*
   * ★ 봇의 말은 **글쓴이에게도, 받은 봇에게도** 보인다 (v3.0 대비).
   *
   * 오늘은 `deliveredTo` 가 글쓴이 자신뿐이라 이 줄은 아무것도 안 바꾼다.
   * 🔴 그런데 **릴레이(§7)가 들어오면 달라진다** — 알파가 베타를 부르면 그
   * 말은 «알파가 쓴 것»이면서 «베타가 받은 것»이다. 글쓴이로만 가르면
   * **베타가 실제로 받은 말이 베타 뷰에 안 뜬다** — 이 뷰가 «그 봇이 실제로
   * 본 전부»라는 약속(§5)이 그 순간 깨진다.
   */
  if (m.role === "agent") {
    return m.authorBotId === botId || m.deliveredTo.includes(botId);
  }
  return m.deliveredTo.includes(botId) || (m.notSentTo?.includes(botId) ?? false);
}

export function createBotInstance(
  agent: AgentDef,
  opts: {
    taken?: ReadonlySet<string>;
    /** 사용자가 방 만들 때 정한 이름. 비우면 에이전트 이름을 쓴다 */
    name?: string;
    rolePrompt?: string;
    agentMode?: string;
    approver?: Approver;
    answerPolicy?: AnswerPolicy;
  } = {},
): BotInstance {
  const taken = opts.taken ?? new Set<string>();
  const name = uniqueBotName(opts.name?.trim() || agent.label, taken);
  return {
    // 🔴 시각만 쓰면 **같은 에이전트로 봇을 둘 만들 때 같은 ms에 걸려 id가 겹친다.**
    // 그러면 멘션도 상태도 둘이 섞인다 — 단체방에서는 정상 경로다(v2.0).
    id: `${agent.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
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
