# AI in One

여러 AI 코딩 에이전트를 **메신저처럼 한 곳에서** 쓰는 VSCode 확장.
한 방에 봇을 여럿 불러 멘션으로 일을 나누고, **봇끼리도 서로 말을 건다**.

사용자의 기존 구독을 그대로 사용한다. 공식 CLI 를 사용자 기기에서 그대로
실행하므로 **토큰을 직접 다루지 않는다.**

**CLI 를 미리 깔 필요는 없다** — 우리가 받아둔다. 사용자가 할 일은 **로그인
한 번**뿐이다.

---

## 처음 구상

> 사용자가 사용하는 여러 AI chat 혹은 에이전트 서비스를 한 곳에서 사용할 수 있는 서비스
> 사용자의 구독을 그대로 사용하여, chatbot을 사용할 수 있고, context를 그대로 이동해 다른 AI와 공유할 수 있다.
> 채팅방 기능을 통해, 여러 bot을 추가하여 호출을 통해 일을 시킬 수 있다.

조사 결과 구상은 이렇게 구체화됐다.

| 처음 구상 | 확정된 형태 | 왜 |
|---|---|---|
| 여러 AI를 한 곳에서 | VSCode 확장, ACP로 CLI 에이전트 연결 | 구독을 합법적으로 쓰는 유일한 경로 |
| 구독 그대로 사용 | 공식 CLI를 subprocess로 실행 | 구독 ≠ API. 토큰 재사용은 ToS 위반/회색지대 |
| 채팅방 + 여러 bot | **v2.0** 단체방 + 멘션 | 1:1이 먼저 검증돼야 함 |
| context 이동 / 공유 | **v4.0** | 단체방의 기록 주입이 먼저 서야 함 |
| 챗봇(ChatGPT/Gemini 웹) | 범위 밖 | webview가 외부 사이트를 못 띄움 + ToS |

---

## 형태

단일 컬럼 모바일 메신저형. **WebviewPanel**을 `ViewColumn.Beside`로 에디터 오른쪽에 연다.
사이드바를 쓰지 않으므로 파일 탐색기가 가려지지 않는다.

```
┌──────┬──────────┬──────────────┬──────────────────┐
│ 📁   │ EXPLORER │  main.ts     │ ← Claude : 리팩터링│
│ 🔍   │  src/    │              │                  │
│ ⑂    │   app.ts │              │   이거 고쳐줘 ▷  │
│ 🐞   │   ...    │              │ ◁ 3개 파일 수정   │
│      │          │              │  [메시지...]   ▶ │
└──────┴──────────┴──────────────┴──────────────────┘
        가려지지 않음               WebviewPanel
```

**방 1개 = ACP 세션 1개.** 같은 에이전트로 방을 여러 개 팔 수 있고,
방 이름은 사용자가 수정할 수 있다. 방을 나가도 세션은 살아 있다.

---

## 구조

```
src/
├─ core/        ← 진짜 제품. vscode를 import하지 않음 (ESLint로 강제)
│   ├─ types.ts          Room / Message / BotInstance 모델 · 방 정책
│   ├─ workspaceHost.ts  셸에게 요구하는 능력 (ACP 클라이언트 메서드와 1:1)
│   ├─ agentCatalog.ts   에이전트 정의 — 핀·받는 주소·로그인 길
│   ├─ agentInstaller.ts 받아두기 (npm · zip) · Node 까지 · 창 사이 락
│   ├─ unzip.ts          zip 꼴 에이전트를 푼다
│   ├─ acpConnection.ts  CLI spawn + ACP 세션 · 턴 실행 · 설정 조회
│   ├─ mcpServer.ts      봇에게 여는 도구 창구 (say · check_queue · verdict)
│   ├─ botQueue.ts       봇마다의 큐 — 이번 몫 · 다음 몫 · 꺼내 본 것
│   ├─ mentions.ts       입력창의 칩 → «누가 무엇을 받나»
│   ├─ roomManager.ts    방 CRUD · 세션 수명 · 턴 · 승인 · 릴레이 · 사용량
│   ├─ store.ts          파일 영속화 (rooms.json · rooms/ · blobs/) · 원자적 쓰기
│   ├─ roomLock.ts       창이 둘일 때 한 방을 둘이 안 쓰게
│   └─ purgeBacklog.ts   지운 방의 세션 뒷정리를 미뤄 두고 끝까지 따라간다
├─ protocol.ts    ← 셸 ↔ 웹뷰 메시지 타입
├─ vscode/        ← 셸 (얇게)
│   ├─ extension.ts      활성화 · 커맨드 · 상태표시줄(미읽음 배지)
│   ├─ chatPanel.ts      WebviewPanel · 목록을 박은 첫 페인트
│   ├─ blobDocuments.ts  변경 전후를 네이티브 diff 로
│   ├─ imeProbe.ts       한글 조합 중 Enter 를 가린다
│   └─ vscodeHost.ts     미저장 버퍼 읽기/쓰기 · 물어보기 중계
└─ webview/       ← 메신저 UI
    ├─ main.ts           화면 전부 (목록 · 방 만들기 · 채팅 · 참여자 · 권한 ·
    │                    에이전트 · 붙는 중 · 고치기 · 대기 · 유저 승인)
    └─ style.css         VSCode 테마를 그대로 따르는 시맨틱 토큰
```

`core`가 셸에 의존하지 않으므로 단독 테스트가 가능하고, 나중에 다른 셸을 붙여도 그대로 재사용된다.

---

## 개발

```bash
npm install
npm run watch      # esbuild watch
# VSCode에서 F5 → Extension Development Host
```

필요한 것:

| | |
|---|---|
| **에이전트 로그인** | 구독은 사용자 것이고 그 자리는 우리가 안 건드린다 |
| **망** | 처음 받을 때. Codex 444MB · Claude 292MB · Antigravity 119MB (2026-10-14 실측 · 자리 크기와 받는 크기) |
| ~~CLI 깔아두기~~ | **안 해도 된다** — 아래 |
| ~~Node~~ | **안 해도 된다** — 없으면 그것도 받는다 (34MB) |

⚠️ **CLI 를 미리 깔 필요가 없다.** 어댑터도 그 안에 품은 CLI 도 **우리가 받아서
돌린다** — 핀으로 박아 제 것을 쓰므로 사용자가 깔아둔 `claude`·`codex` 는 안 쓴다
(실측: `tests/probes/whichcli.cjs`, `pinmismatch.mts`). 세션 뒷정리까지 우리 엔진이
한다. 받는 곳은 **목록 화면 위의 로봇 아이콘** 한 군데다.

**사용자 것은 로그인뿐이다.** 들어가는 문은 에이전트가 정한다:

| | 어떻게 |
|---|---|
| **터미널** | 품은 CLI 를 띄운다 — Claude (`claude auth login`) · Codex (`codex login`) |
| **ACP** | `authenticate` 를 부르면 저쪽이 브라우저를 연다 — Antigravity |

> 🔴 **어느 쪽인지 짐작하면 안 된다.** Antigravity 는 `agy` 라는 터미널 CLI 가
> **있는데도** 그 길이 아니다 — `agy` 와 ACP 서버가 서로 다른 자리를 본다.
> 자세한 것은 `src/agents/antigravity/README.md` §G4-2.

터미널 CLI 를 따로 쓰고 있다면 그쪽 **판은** 낡아도 상관없다. 다만 **로그인
자리**(`~/.codex`·`~/.claude`)는 공유하므로 거기서는 만나야 한다.

---

## 문서

| | |
|---|---|
| **`docs/ROADMAP.md`** | 버전별 기능 계획 · 설계 결정 · 리스크 |
| **`docs/USAGE.md`** | 사용법. 버전을 낼 때마다 갱신한다 |
| **`docs/RELEASE.md`** | 배포와 설치 — `.vsix` · 마켓플레이스 · Open VSX |
| **`src/agents/README.md`** | 에이전트 공통 — 올릴 때 점검표 · 세션 뒷정리 · 셋을 맞댄 표 |
| **`src/agents/<id>/README.md`** | 에이전트마다 — 핀 내력 · 다른 점 · 슬래시 (claude · codex · antigravity) |
| **`src/core/install/README.md`** | 에이전트를 우리 자리에 받아두는 설계 |
| **`src/core/mcp/README.md`** | 봇이 받는 글 전부 — `tooldump` 가 뽑는 생성물 |
| **`src/core/quota.md`** | 방 머리의 「사용량」 |

---

## 계획

| 버전 | 내용 |
|---|---|
| **1.0** ✅ | 에이전트를 골라 1:1 채팅방을 만들고 대화 |
| **1.1** ✅ | 채팅방 fork — 대화를 분기해 여러 갈래로 실험 |
| **2.0** ✅ | 단체 채팅방 — 여러 봇 초대, 멘션으로 명령 분리, `@everyone` |
| **2.1** ✅ | 단체방 안에서 봇별 1:1 뷰 |
| **2.2** ✅ | 같은 에이전트로 봇 여러 개 + 부를 이름 직접 지정 |
| **3.0** ✅ | 봇끼리 주고받기 — 도구로, 단방향, 상한 안에서 |
| 4.0 | 컨텍스트를 옮기거나 완전 공유하는 채팅방 |

버전 계보 밖에 두 묶음이 따로 있다 — **실험실**(효과가 미검증이라 시기를 못 정하는 것)과
**백로그**(효과는 알지만 우선순위가 낮은 것).
