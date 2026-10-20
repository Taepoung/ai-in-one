# core — 우리 확장의 코드

에이전트를 모른다. 에이전트마다 다른 것은 `agent-api.ts` 에 칸이 있고 `src/agents/*` 가
채운다. 화면(`webview`)도 셸(`vscode`)도 모른다 — 셸 기능은 `WorkspaceHost` 로 받는다.

## 층 — 아래만 본다

```
L0  room/rooms.ts        열린 방 · 저장 · 기록 남기기            아무 층도 안 본다
    room/runtimes.ts     봇 상태(턴·깊이·상태) — 디스크에 안 남는 것
L1  session/pool.ts      에이전트마다 CLI 하나 — CLI 가 뜨는 유일한 자리
L2  session/config.ts    모델 · 모드 · 사고 강도 (에이전트별 선택지 · 봇별 지금 값)
L3  session/sessions.ts  열기 · 되살리기 · 이어가기 · MCP 붙이기
    turn/activity.ts     도구 · 파일 변경을 대화에 · 같은 파일 부딪힘
    turn/prompt.ts       한 턴에 보낼 글과 첨부 (되먹임 기록 포함)
    room/fork.ts         대화 가르기 — 세션층의 손님
L4  turn/turns.ts        보내고 받는 흐름 · 턴 밖 발화 · 깨우기
L5  room/outbox.ts       사용자의 말이 들어오는 문 · 예약 · 초안

    mcp/                 우리 MCP 도구(say · check_queue · verdict) · 큐   → README.md
    review/              권한 카드 · 봇 심사 · 사람이 가로채기
    install/             받기 · 풀기 · 지우기 — 어느 에이전트든 같은 기계

    roomManager.ts       화면이 부르는 앞문 — 방 조작 · 붙이기 · 층을 엮는 포트
```

**린트가 지킨다**(`eslint.config.mjs`) — 아래층이 위층을 import 하면, 어느 층이든
`roomManager` 를 import 하면 빨개진다.

## 층은 무엇을 받나 — 포트

층마다 `XxxPort` 하나를 받는다. 그게 **그 층이 바깥에 바라는 것의 전부**다:

- 아래층은 객체째 받는다 (`rooms` · `runtimes` · `pool` …).
- 위층을 부를 일은 **갈고리**로 받는다 — 턴이 끝나면 예약을 보내는 일(`turnDone`)처럼.
  import 하지 않으므로 방향이 안 뒤집힌다.
- 값이 아니라 **읽는 길**(getter)을 넘긴다 — `roomManager` 의 필드가 어떤 차례로
  채워지든 부를 때의 값을 본다.

새 기능을 넣을 때: 그 일이 쓰는 것이 어느 층까지인지 보고, 그 층 바로 위에 둔다.
포트가 스무 칸이 되면 아래층이 덜 떼어진 것이다 — 이번에 세션층이 그랬다
(`docs/REFACTOR.md` §4 ⑤).
