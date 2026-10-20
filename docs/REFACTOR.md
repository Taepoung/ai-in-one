# 리팩토링 계획 — 에이전트는 애드온, 우리 코드는 기능별 코어

> 2026-10-20 세움. **아직 한 줄도 안 옮겼다** — 이 문서는 «어떻게 옮길까» 이고,
> 옮긴 뒤에는 각 자리의 문서가 이 내용을 이어받고 이 파일은 지운다.

## 0. 왜

지금 두 파일이 코드의 **60%** 다.

```
src/webview/main.ts        9,323줄
src/core/roomManager.ts    7,462줄
───────────────────────────────────
나머지 전부              11,041줄
```

크기만 문제가 아니다. **에이전트에 대해 우리가 아는 것이 일반 코드 사이에
흩어져 있다.** `if (agent === "codex")` 꼴의 갈래는 카탈로그 밖에 사실상 없다 —
대신 «표준 ACP 와 다르게 구는 버릇» 을 **모양을 보고 갈리는 일반 코드**로
받고 있고, 왜 그 코드가 있는지는 **주석에만** 적혀 있다:

```
주석에 에이전트 이름이 나오는 횟수 (agentCatalog 밖)
  roomManager.ts   42      types.ts      36
  main.ts          37      acpConnection 29
  agentInstaller   18      chatPanel     10
```

그래서 **«Codex 만 올릴 때 어디를 봐야 하나» 를 코드가 말해주지 못한다.** 저쪽이
버릇을 고쳐도, 그걸 받던 갈래가 죽은 채로 남는 것도 안 보인다.

## 1. 모양

```
src/
  core/                  우리 확장의 코드 — 에이전트를 모른다
    room/                방 · 턴 · 큐 · 저장 (메시지)
    mcp/                 say · verdict · check_queue · 거절 · 설명글 · 서버
    review/              권한 카드 · 봇 심사 · 사람이 가로채기
    session/             붙이기 · 되살리기 · 지우기 · 분기
    install/             받기 · 풀기 · 지우기 — 어느 에이전트든 같은 기계
    acp/                 ACP 클라이언트 — 표준대로만
    agent-api.ts         애드온이 채우는 꼴

  agents/                애드온 — 표준과 다른 점만 (§3)
    standard/            아무것도 안 덮었을 때. 설정으로 넣은 낯선 에이전트도 여기
    claude/
    codex/
    antigravity/
    index.ts             목록

  vscode/                확장 호스트 배선 — core 와 agents 를 잇는 유일한 자리
  webview/               화면 — 에이전트도 core 도 모른다
  protocol.ts            webview ↔ 호스트 메세지 (타입만)
```

★ **방은 하나다 — 나누지 않는다.** `roomKind` 는 저장된 칸이 아니라 봇 수로
계산한 값이고, 1:1 방에 봇을 초대하면 **같은 방이 그대로** 단체방이 된다. 1:1 과
단체방이 갈리는 35곳은 전부 «둘 이상이면 켜지는 기능» (멘션 · 릴레이 · 누가
말했나 표기) 이라 방의 종류가 아니라 **기능의 스위치**다(§4-③).

## 2. 의존 규칙 — 격리는 이걸로 선다

폴더만 나누면 서로 import 하기 시작해서 금방 다시 섞인다. **방향을 정하고
린트로 막는다.**

```
core/*      →  agent-api 만             agents/* 를 import 못 한다
agents/*    →  agent-api 만             서로도, core 내부도 못 본다
vscode/*    →  core · agents/index      둘을 잇는 유일한 자리
webview/*   →  protocol (타입)만        에이전트도 core 도 모른다
```

`npm run lint` 에 `no-restricted-imports` 몇 줄이면 된다. 🔴 **이게 없으면 몇 달 뒤
«Antigravity 만 잠깐» 하는 import 하나로 격리가 끝난다.**

## 3. 애드온 — 에이전트마다 다른 것

### 3.1 무엇을 들고 있나 — 표준과 **다른 점만**

전부를 기술하면 셋이 거의 같은 내용을 세 번 들고 다닌다 — Claude 와 Codex 는
대부분 똑같이 군다. **선언으로 되는 것은 선언으로**, 선언으로 못 하는 것만
함수로 둔다. 🔴 갈고리(hook)가 버릇마다 늘면 인터페이스가 세 에이전트의 버릇을
그대로 베낀 모양이 된다.

```ts
// agent-api.ts — 초안. 칸은 아래 재고(§3.2)에서 나왔다
interface AgentAddon {
  id: string; label: string;

  install:  { npm: { pkg, bin, env? } } | { zip: { urls, cmd, args? } };
  login:    { terminal: { login, logout, status } } | { acp: true };
  extras?:  …                          // 같이 받아야 하는 것 (Antigravity 의 agy)

  session: {
    startMs?:  number;                 // 붙는 데 드는 시간 — 화면이 «받는 중» 을 세운다
    delete:    "acp" | "cli" | "files";
    purge?:    …;                      // cli 명령 또는 파일 자리
    sharedProcess?: boolean;           // 한 프로세스가 세션 여럿 (MCP 열쇠를 세션에 매단다)
  };

  permission: {
    mcpIdentity: "name" | "meta" | "rawInput";   // 우리 도구인지 알아보는 자리
    askOptions?: …;                               // allow_once 를 주나
  };

  turn?: { cancelSettles: boolean };   // 취소하면 prompt 약속이 끝나나

  tools?: { realOutput?: (ev) => string | undefined };  // 자리표시 글 대신 진짜 결과

  quota?: { command: "usage" | "status"; parse(text): QuotaLine[] };

  probes: string[];                    // 판을 올릴 때 돌리는 것들
}
```

★ **`standard` 가 기본값이다.** 칸을 안 채운 에이전트는 지금처럼 **모양을 보고
짐작**한다. 그래서 설정으로 넣은 낯선 에이전트도 비슷하게 굴면 그냥 돈다 —
레지스트리에 41개가 있고, «아무 ACP 에이전트나 붙는다» 는 약속이 이 길이다.

### 3.2 재고 — 지금 흩어져 있는 차이 (2026-10-20 주석에서 뽑음)

| 갈래 | Claude | Codex | Antigravity | 지금 사는 곳 |
|---|---|---|---|---|
| **설치** | npm · `.bin` 에 `claude` 가 **없다** (품은 exe) | npm · 445MB · `CODEX_PATH` 는 PATH 에서 | **zip** · 398MB 네이티브 서버 | `agentCatalog` · `types` · `agentInstaller` |
| **로그인** | 터미널 CLI | 터미널 CLI · `chat-gpt` 는 앱 안에서도 | ACP `authenticate` — **브라우저를 제 손으로** 연다 · 로그인용 `agy` 를 따로 받는다 · 로그아웃은 CLI 안의 `/logout` | `agentCatalog` · `acpConnection:180` · `types:105` |
| **세션 붙이기** | 375ms + 962ms | 585ms + 1,662ms | **12.5초 + 5초** · 한 프로세스가 세션 여럿 · MCP 서버를 이름당 한 번만 묶는다 | `roomManager:364` · `:3633` · `:6761` |
| **세션 지우기** | `session/delete` | 파일 **+ sqlite 인덱스** — CLI 로 | **길이 없다** — 우리가 파일을 지운다 · 파이썬 서버가 안 끝난다 | `acpConnection:950-1008` · `types:27-46` · `agentInstaller:978` |
| **권한 — 우리 도구 알아보기** | `name = mcp__ai-in-one__say` | `rawInput` (애초에 안 묻는다) | `_meta.mcp` | `acpConnection:1335` |
| **턴 취소** | prompt 약속이 **거절된다** → 턴이 닫힌다 | 약속이 **안 깨진다** → 칸이 열린 채 남는다 | (안 잼) | `roomManager:5669` |
| **도구 결과** | 진짜 결과 | 진짜 결과 | **자리표시 글** · 제목에 `ai-in-one_say` 를 그대로 | `acpConnection:40` · `roomManager:5938` |
| **모델·설정** | Model · Effort · Fast mode | Mode · Collaboration · Model · Reasoning | (안 적힘) | `main.ts:1573` · `types:502` |
| **슬래시** | 66개 | 28개 (`$` 꾸러미) | 3개 · **압축 없음** | `docs/SLASH.md` |
| **잔량** | `/usage` · **쓴 양** | `/status` · 남은 양 | `/usage` · 남은 양 · 모델 묶음마다 | `quotaParse.ts` |
| **질문 (폼)** | 쓴다 | **안 쓴다** | (안 잼) | 🔴 9월에 기능째 뺐다 (§3.3) |

### 3.3 «질문» 은 지금 갈래가 없다

폼 질문(`elicitation/create`, D4)은 **2026-09-21 에 통째로 뺐다**(ROADMAP D4).
광고를 빼니 Claude 도 Codex 도 **글로 묻고 혼자 정하지 않았다** — 그래서 지금
질문은 전부 말풍선이고, 코드에 에이전트별 차이가 **없다.** 재둔 차이는 표의
기록일 뿐이다. 다시 넣게 되면 그때 `agents/*` 에 칸이 생긴다.

## 4. 코어 — 기능별로

### ① 제일 어려운 것은 파일 옮기기가 아니라 **같이 쓰는 상태**다

`roomManager` 의 안쪽 상태를 기능들이 **같이** 만진다:

```
open       열린 방                 거의 전부
runtimes   봇마다 턴·깊이·saidZero  room · mcp · review · session
queue      봇마다 큐               room · mcp · review
closed     답이 난 id              mcp · review
```

기능별로 나누려면 **이 넷을 누가 들고 누가 빌려 쓰나** 를 먼저 정해야 한다.
그래서 첫 걸음은 입구가 하나인 MCP 도구층이다(§5-②) — 무엇을 빌려 쓰는지가
제일 잘 보인다.

### ② `soleBot` 을 걷는다 — 잠복한 버그다

열 군데가 `botId ?? this.soleBot(room)` 꼴인데, `soleBot` 은 `participants[0]` 을
돌려준다. 주석은 «단체방에서는 부르는 쪽이 봇을 지목해야 한다» 고 말하지만
**코드는 막지 않는다** — 단체방에서 `botId` 를 빠뜨리면 압축·설정·재시도가
**첫 번째 봇에 조용히** 걸린다. 부르는 쪽이 늘 봇을 지목하게 바꾼다.

### ③ `participants.length > 1` 서른다섯 곳을 이름 붙은 술어로

같은 질문을 35번 따로 묻고 있다. 「왜 묻는지」가 보이게 모은다 —
`canMention(r)` · `canRelay(r)` · `showsAuthor(r)`.

### ④ 한 이름이 두 일을 진 자리를 가른다

2026-10-19 에 `usageOf` 가 **두 번 선언됐다** — 하나는 방의 컨텍스트, 하나는 구독
잔량. 같은 낱말 «사용량» 이 두 물건을 가리켜서다. 코드에서는 `quota` 로 갈랐다.
옮기면서 비슷한 자리를 더 찾는다.

## 5. 옮기는 순서 — 단계마다 지키는 검사가 있다

| | 하는 일 | 동작 변화 | 지키는 것 |
|---|---|---|---|
| ① | `agent-api.ts` 를 세우고 카탈로그 항목을 `agents/*` 로 **그대로** 옮긴다 · 린트 규칙 | 없음 | `npm test` 전체 · 린트 |
| ② | MCP 도구층을 `core/mcp/` 로 — 입구 `mcpCall` 하나 | 없음 | `saybot` · `queuecall` · `relaydepth` · `judgeflow` · `tooldump` 차이 0 |
| ③ | 잔량 뜯기를 각 애드온으로 · **화면이 아니라 호스트에서** 뜯는다 | 화면은 `QuotaLine[]` 을 받는다 | `quotaparse` · `quotaui` |
| ④ | 세션 지우기를 `session.delete` 로 | 없음 | `codexdelete` · `agydelete` (프로브) |
| ⑤ | 우리 도구 알아보기 · 도구 결과 버릇 | 없음 | `mcpself` · `saybot` |
| ⑥ | `soleBot` 걷기 · 술어로 모으기 | **단체방에서 봇을 안 짚은 부름이 거절된다** | 새 검사 하나 |
| ⑦ | 나머지 `roomManager` 를 room · review · session 으로 | 없음 | 전체 |

⚠️ **③은 동작이 바뀐다.** 지금은 화면이 `parseQuota` 를 import 해서 뜯는데,
애드온으로 가면 화면은 에이전트를 몰라야 한다(§2). 뜯기는 호스트 쪽 그 에이전트
폴더로 가고 화면은 다 뜯긴 것과 받은 글만 받는다 — 오히려 더 깨끗하다.

★ **단계마다 따로 커밋한다.** 한 판에 몰면 검사가 빨개졌을 때 어느 걸음이 깼는지
못 가른다.

### 5.1 밟은 기록

```
① 88c43fe   애드온 폴더 · 경계 린트                 동작 변화 없음
② e133cda   MCP 도구층 → core/mcp/calls.ts           동작 변화 없음   roomManager 7,462 → 6,516
③ 65fc6bd   잔량: 애드온 선언 + 호스트가 뜯는다      화면이 안 뜯는다
④ —         할 일이 없었다 (아래)
⑤ 89c933e   우리 도구 알아보기: 애드온 선언          제 자리만 본다 — 자동 승인 구멍을 닫았다
⑥ 800d5e5   soleBot 은 하나일 때만 · hasManyBots      단체방에서 첫 봇으로 새지 않는다
⑦-1 2a1449d 큐는 core/mcp/ 아래 · 장부는 큐 안으로       동작 그대로
⑦-2 0f27a47 심사 봇은 MCP 로 답할 수 있을 때만         얼어붙던 권한 요청을 막았다
     117e449 재귀 막이 비어 있었다 — 큐에서 읽는다      서로를 기다리던 고리를 막았다
⑦-3 4bfb06e review 층 → core/review/review.ts         동작 그대로   roomManager 6,553 → 6,077
```

**⑦ 은 계획을 고쳐 밟았다.** 처음엔 «review · session · room 으로 나눈다» 였는데,
review 를 떼려고 보니 **큐가 누구의 것인가**부터 정해야 했다. 사용자: *«MCP를
안쓰면 queue에 쌓일 일도 없지 않아?»* — 맞았다. 큐에 들어오는 길 둘(봇의
`say` · 심사 봇에게 넘기는 권한)이 다 MCP 에 묶여 있고, 방 흐름이 큐로 하는 일도
«MCP 수신함을 봇에게 배달하는 것» 이다. 그래서 큐를 MCP 아래로 옮기고(⑦-1),

그 눈으로 보니 **코드에 그 의존이 안 적혀 있었다**(⑦-2). 심사 봇에게 넘길 때
«세션이 열렸나» 만 봤는데, 심사 봇이 판정하는 길은 MCP 의 `verdict` 뿐이다.
MCP 가 꺼져 있거나, 심사 봇 세션이 MCP 보다 먼저 열렸거나, 에이전트가 http MCP 를
못 받으면 — 재 보니 권한 요청이 **8초가 지나도 안 풀리고, 사람에게도 안 가고,
알림도 없었다.** 요청한 봇은 사람이 가로채거나 방을 나갈 때까지 얼어 있다.

**④ 는 이미 끝나 있었다.** `session/delete` 를 부를지는 ACP 표준 능력
(`caps.delete`)이 정하고, 그 너머의 뒷정리는 `purgeSession`(Codex 의 CLI) ·
`purgeFiles`(Antigravity 의 파일) **선언**을 따른다 — 이름으로 갈리는 코드가 없다.
그 선언은 ① 에서 이미 각 애드온으로 갔다. 칸 이름만 `session.delete` 로 바꾸는 건
소란만 늘어서 안 했다.

**⑥ 에서 고친 버그가 검사 안에 숨어 있었다.** `saybot` 의 «사용자가 셋에게 한
말» 검사가 단체방에서 `send` 를 봇을 안 짚고 불렀는데, 화면은 그 길을 안 쓴다
(`sendCompose`). 옛 `soleBot` 이 첫 봇을 대신 골라줘서 돌았던 것이다 — «셋 다»를
재는 검사가 실은 **첫 봇 하나에게만** 턴을 돌리고 있었다. `@everyone` 칩으로
바꾸니 셋이 다 받고, 검사도 «적어도 하나» 에서 «셋 다» 로 세졌다.

`participants.length` 로 묻던 자리는 **코어의 것만** `hasManyBots` 로 모았다.
화면 쪽 열다섯은 webview 를 나누는 판에서 한다(§7 ③). `=== 1`·`=== 2` 처럼
**정확한 수**를 묻는 자리는 술어로 안 바꿨다 — «막 단체방이 된 순간» 이 흐려진다.

**⑤ 는 계획보다 값이 컸다.** «우리 도구인가» 를 셋 다 뒤져 보던 코드가, 모델이
써 넣는 `rawInput` 까지 믿고 있었다 — 그 판정이 **자동 승인**에 쓰인다. 각
애드온이 제 자리 하나만 선언하면서 그 길이 닫혔다(`mcpself` 가 민다). «도구
결과 버릇»(자리표시 글)은 어느 에이전트든 우리 도구는 **우리가 쥔 답을 쓴다**
는 일반 규칙이라 선언할 것이 없었다.

## 6. 문서도 같은 모양으로

```
docs/
  core/
    room.md          방 · 턴 · 큐
    mcp.md           ← TOOLS.md (생성물 — tooldump 가 여기로 쓴다)
    review.md        권한 · 심사
    session.md       붙이기 · 지우기 · 분기
    install.md       ← INSTALL.md
    quota.md         사용량 팝업 — 기능이다 (← SLASH.md 의 «지었다»)
  agents/
    README.md        애드온 꼴 · standard · 판 올리는 공통 순서 · 셋을 맞대는 표
    claude/README.md       에이전트마다 같은 꼴:
    codex/README.md          다른 점 · 핀(판) 내력 · 올릴 때 걸음과 점검 항목
    antigravity/README.md    · 프로브 · 슬래시 · 잔량 표본
                     (어느 절이 어디로 가는지는 §6.1)
  ROADMAP.md  USAGE.md  RELEASE.md     제품 전체라 위에 그대로
```

★ **에이전트 하나를 올릴 때 펴는 문서가 하나**가 된다 — 그 폴더의 README.
지금은 PIN · BUMP · SLASH · ROADMAP 을 오가야 한다.

### 6.1 지금 문서가 어디로 가나 — 절 단위로

🔴 **PIN · BUMP · SLASH 는 통째로 못 옮긴다.** 셋 다 에이전트 이야기와 공통
이야기가 **절마다 섞여** 있다. 이름만 보면 PIN 은 Claude 핀 문서 같지만, 절반은
Codex 와 Antigravity 다.

```
TOOLS.md (생성물)                              → core/mcp.md
                                                 tooldump 가 쓰는 자리도 같이 옮긴다

PIN.md
  A  모델 · B 모양 · C 이어받기 · D 받기 · E    → agents/claude/       claude-agent-acp 핀 내력
  F1~F3  세션 뒷정리가 왜 조용히 깨지나         → agents/README.md     공통
  F4~F7  codex-acp 핀·엔진 · app-server          → agents/codex/
  G1~G3  레지스트리 · 새 에이전트를 볼 때 순서   → agents/README.md     공통
  G4~G4-3  CLI 와 ACP 서버가 다른 집을 본다      → agents/antigravity/
  G5  판(OS)마다 이름도 권한도 다르다            → agents/antigravity/  + core/install.md 에 OS 규칙
                                                 (zip 실행 권한 · 꾸러미 속 이름)
  G6~G7-1  지우는 길 없음 · §4 도구를 쓰나       → agents/antigravity/

BUMP.md
  §1 표 ①~⑮ 의 틀 · §2 공통 걸음 · §4 눈으로 볼 것 → agents/README.md
  ⑤ ⑭ 의 Antigravity 단서 · zip 걸음             → agents/antigravity/
  §2-3 «Claude 쪽» 세션·되돌리기·모델             → agents/claude/
  §2 끝 «Codex 어댑터면 하나 더»                   → agents/codex/
  §3 모델은 에이전트마다 다르게 움직인다            → 셋으로 갈라 각자에
  ⑮ 잔량 글의 모양                                → 각자에 — quotaparse 표본도 같이

SLASH.md
  한눈에 · 그래서 무엇이 걸리나                    → agents/README.md     셋을 맞대는 표
  Claude 66 · Codex 28 · Antigravity 3 목록        → 각자에
  토큰 한도 · usage_update · 맥락에 안 남는다      → 각자에 «그 에이전트의 값»
                                                   + agents/README.md 에 공통 결론
  지었다 — 방 머리의 「사용량」                    → core/quota.md        기능이지 에이전트가 아니다
```

⚠️ **표는 갈라지면 맞대기가 어려워진다.** 셋을 나란히 놓고 봐야 뜻이 서는 것들
(슬래시 한눈에 · 잔량의 쓴 양/남은 양 · §3.2 재고)은 `agents/README.md` 에 **맞대는
표로 한 번** 두고, 각 폴더에는 **그 에이전트의 값과 근거**를 둔다. 같은 수를 두
군데 적지 않는다 — 표는 각 폴더를 가리키기만 한다.

⚠️ 문서 사이 링크가 많다. 옮기는 날 `grep -rn '\](.*\.md' docs/` 로 깨진 링크를
한 번에 잡는다.

## 7. 정할 것

**① `standard` 의 «모양 보고 짐작» 을 남기나.** 내장 셋이 다 선언하면 그 짐작은
설정으로 넣은 낯선 에이전트만을 위한 것이 된다. → **남기는 쪽을 권한다.**

**② 밖에서 받는 애드온을 열까.** 그 코드는 확장 호스트 안에서 **우리 권한 그대로**
돈다 — 로그인 자격이 있는 집에 남의 코드를 들이는 것이라 «구독 토큰을 안
건드린다»(§0 P3)를 장담할 수 없게 된다. → **저장소 안에 든 것만** 을 권한다.
낯선 에이전트를 쓰는 길은 이미 있다(설정의 `command`·`args` → `standard`).

**③ webview 도 같은 판에 나누나.** 9,323줄이라 필요는 하지만 축이 다르다 —
기능이 아니라 **화면별**(목록 · 채팅 · 서랍 · 에이전트 화면 · 팝업). → **따로** 가는
것을 권한다. 같이 하면 판이 너무 커진다.

## 8. 안 잰 것

- **Antigravity 의 턴 취소** — prompt 약속이 끝나나. 주석에 Claude·Codex 만 적혀
  있고 Antigravity 를 잰 기록은 못 찾았다.
- **Antigravity 의 폼 질문** — 광고하면 쓰나. 지금은 광고를 안 하므로 급하지 않다.
- **Antigravity 의 모델·설정 칸 이름** — 코드에 적혀 있지 않다.
- **`startMs` 가 판마다 얼마나 흔들리나** — 위 수는 한 번씩 잰 것이다.
