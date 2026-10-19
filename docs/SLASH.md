# 슬래시 명령 — 어댑터가 광고하는 것

에이전트는 세션을 열면서 **쓸 수 있는 명령 목록**을 보내준다
(`available_commands_update`). 우리는 봇마다 그걸 받아 들고 있지만
(`BotRuntime.commands`), **쓰는 것은 압축 하나뿐**이다 —
`compactCommand()` 가 `/^(compact|compress)$/i` 로 하나를 골라낸다.

나머지는 들고만 있다. 입력창 `/` 자동완성은 v1.0 밖이다
(`ROADMAP.md` 의 «슬래시 명령 전반 UI»).

그 UI 를 짓기 전에 **무엇을 다루게 되는지** 먼저 쟀다. 아래는 전부
2026-10-19 에 Windows 11 에서 `tests/probes/slashlist.mts` 로 받은 것이고,
안 잰 것은 안 잰 것이라고 적었다.

```
npx tsx tests/probes/slashlist.mts                       셋 다
npx tsx tests/probes/slashlist.mts antigravity --turn    빈손일 때 턴까지
```

## 한눈에

| 에이전트 | 개수 | 언제 오나 | 압축 |
| --- | --- | --- | --- |
| Claude | 66 | 세션 연 뒤 **7.6초** | `compact` ✔ |
| Codex | 28 | **7.2초** | `compact` ✔ |
| Antigravity | 3 | **18.6초** | 🔴 **없다** |

★ **프롬프트 없이 온다.** 셋 다 턴을 보내기 전에 목록이 왔다. 그래서 이
측정은 구독 토큰을 안 쓴다(§0 P3). Antigravity 만 느려서 한 번 턴까지
보내 봤는데, 턴과 무관하게 **20초쯤 걸리는 것**이었다.

🔴 **셋 다 겹치는 명령은 하나도 없다.**

```
Claude ∩ Codex   compact · goal · mcp · rename
Claude ∩ Agy     usage
Codex  ∩ Agy     logout · plan
셋 다            (없다)
```

## Claude — 66개

```
compact · context · model · effort · fast · focus · config · output-style
init · import · import-memory · recap · insights · usage · usage-credits
extra-usage · autocompact · color · heapdump · rename · doctor · mcp
agents · list-agents · auto-mode-setup · loop · schedule · run · batch
verify · debug · simplify · code-review · security-review · advisor · goal
reload-plugins · reload-skills · plugin-authoring · workflow-authoring
run-skill-generator · skill-creator · skill-doctor · claude-api
update-config · design-consent · design-revoke · team-onboarding
__remote-workflow · workflow-launch-exec
deep-research · design · design-sync · slides · dataviz · docs · docx · pdf
pptx · xlsx · google-workspace · morning · artifact-diagramming
artifact-capabilities · jump2paper:j2p
```

## Codex — 28개 (바탕 11 + 꽂은 것 17)

```
바탕      plan · review · review-branch · review-commit · skills · status
          compact · goal · rename · mcp · logout

꽂은 것   $computer-use:computer-use · $documents:documents · $pdf:pdf
          $plugin-management:plugin-management · $presentations:Presentations
          $spreadsheets:Spreadsheets · $spreadsheets:excel-live-control
          $template-creator:template-creator · $visualize:visualize
          $work-pets:create-pet · $work-pets:pets · $work-pets:update-pet
          $imagegen · $openai-docs · $review-agent · $skill-creator
          $skill-installer
```

## Antigravity — 3개

```
plan · logout · usage
```

## 그래서 무엇이 걸리나

**① Antigravity 는 압축 버튼이 영영 안 뜬다.** 목록에 `compact` 도
`compress` 도 없다. 지금 그렇게 돌고 있고, 화면에는 «이 봇은 압축을
못 한다» 고 말해 주는 자리가 없다. 길게 가는 방에서 맥락이 차면
**사용자는 까닭을 모른 채 막힌다.**

**② 목록은 사람마다 다르다.** Claude 66개 중 절반 넘게, Codex 28개 중
17개가 **그 컴퓨터에 깔린 스킬·플러그인**이다. 자동완성을 짓는다면 고정
목록을 못 박고 **세션마다 받아 쓰는 수밖에 없다** — 이미 그렇게 들고 있다.

**③ 이름 규칙이 어댑터마다 다르다.**

```
Codex     $plugin:command   ·  $plugin
Claude    plugin:skill      ·  __internal
```

그대로 뿌리면 `$work-pets:create-pet` 같은 것이 `compact` 옆에 선다.
«바탕 명령» 과 «꽂은 것» 을 가르려면 그 규칙을 알아야 하는데, 둘이 다르고
**레지스트리가 그걸 말해주지 않는다**(`description` 만 온다).

**④ 같은 이름이 같은 일이라는 보장이 없다.** `plan` 이 Codex 와
Antigravity 양쪽에 있는데, 두 `plan` 이 같은 것인지는 **안 쟀다.**
`usage` 도 마찬가지다(Claude·Antigravity).

## 토큰 한도 — 볼 수 있나

**된다. 셋 다 글로 준다.** `tests/probes/quota.mts` 로 불러봤다(2026-10-19).

부르는 길은 이미 있다 — 압축이 그러듯 **`/이름` 을 프롬프트로 보내면**
된다(`RoomManager.compact` 가 `send(roomId, "/" + cmd)` 를 한다).

```
Claude        /usage    5시간 한도 3% · 주간(전 모델) 9% · 리셋 시각까지
Codex         /status   주간 한도 100% 남음 · 리셋 날짜 · 모델 · 승인 모드
Antigravity   /usage    모델 묶음마다 주간 잔량 100% · 리셋 시각
```

🔴 **우리가 받는 `usage_update` 와는 다른 것이다.** `used/size` 는 «이 세션
컨텍스트가 얼마나 찼나» 라 **압축하면 되레 내려간다.** 구독 잔량은 거기
안 들어 있고, `/usage` 를 불러도 `usage_update` 는 **같이 안 왔다**(셋 다).

### 그래서 세우려면

**① 글을 뜯어야 한다.** 구조로 안 오므로 **어댑터마다 다른 모양**을 읽어야
한다. 공통으로 건질 수 있는 것은 **퍼센트와 리셋 시각** 둘이고, 그 둘이면
«얼마 남았나 · 언제 찬다» 는 세울 수 있다. 나머지는 제각각이다 —
Antigravity 는 **모델 묶음마다** 따로 주고(Gemini / Claude·GPT), Claude 는
**5시간과 주간**을 나눠 주며, Codex 는 거기에 모델·승인 모드·세션 id 까지
섞어 준다.

**② 부르면 대화에 남는다.** `send` 를 타므로 방에 **턴이 하나 생기고**
맥락도 먹는다. 압축은 «대화의 사건» 이라 남는 게 맞지만, 잔량 조회는
그렇지 않다 — 조회용으로 쓰려면 **따로 세션을 열거나 숨긴 턴**이 필요하고,
그 길은 아직 없다.

**③ 수는 믿을 만하다.** 셋 다 «data not available yet» 과 진짜 수를 **갈라서**
준다(Codex 의 토큰 수, Antigravity 의 세션 합계가 그렇게 왔다). 안 가진
것을 0 으로 꾸며 보내지는 않았다.

## 안 잰 것

- **인자를 받는 명령이 있나.** ACP 의 `availableCommands` 는 `input` 칸을
  줄 수 있는데(`ROADMAP.md:1037`), 셋 중 누가 그걸 채워 보내는지 안 봤다.
  자동완성에서 «인자가 필요한 명령» 을 가르려면 필요하다.
- **목록이 중간에 바뀌나.** `reload-plugins` 같은 것을 쓰면 다시 올 법한데,
  그때 우리가 덮어쓰는지(`onIdleEvent` 는 덮어쓴다) **실측은 없다.**
- **macOS·리눅스.** 여기 수는 Windows 11 것이다. 깔린 스킬이 OS 마다 다를
  수 있고, Antigravity 는 리눅스에서 `--uid=` 를 더 받는다.
- **같은 이름 = 같은 일인가** (위 ④).
- **`usage_update` 의 `cost` 를 누가 채우나.** 받을 준비는 돼 있는데
  (`acpConnection.ts` 의 `usage_update`) 셋 중 누가 보내는지 본 적이 없다.
  위 세 번 모두 `usage_update` 자체가 안 왔다.
- **잔량을 대화 밖에서 물을 길.** 지금은 `send` 뿐이라 턴이 남는다.
