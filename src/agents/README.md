# 에이전트 — 공통

> 2026-10-20 리팩토링 §6 에서 문서를 에이전트별로 나눴다. **절 이름(§A · §F4 · §G6 …)은
> 옮기기 전 그대로**라 옛 링크(`PIN.md §G6` 같은)는 그 파일의 지도로 한 번 건너면 닿는다.
> 이 문서: 셋 모두에 걸리는 것 · 셋을 맞대야 뜻이 서는 것

에이전트마다 다른 것은 각 폴더에 있다:

```
agents/claude/        Claude Code — 어댑터 핀(claude-agent-acp) 내력 · 모델
agents/codex/         Codex — 핀과 엔진 · 세션 뒷정리
agents/antigravity/   Antigravity — zip · 따로 받는 agy · 지우는 길 없음 · MCP 신원
```

★ **셋을 나란히 놓아야 뜻이 서는 표**(슬래시 한눈에 · 잔량의 쓴 양/남은 양)는 여기에
**한 번만** 둔다 — 같은 수를 두 군데 적으면 한쪽만 고쳐지는 날이 온다.

---

## 에이전트를 올릴 때 — 점검표

> 2026-10-06. `docs/PIN.md` 가 «핀이 움직이면 무엇이 바뀌나» 를 설명한다면,
> 여기는 **한 에이전트를 올릴 때 손으로 밟는 순서**다. 제품이 그 CLI 에
> 기대는 것이 핀 하나가 아니라 **아홉**이라 따로 둔다.
>
> 왜 그런지는 `PIN.md` 의 §A~§G 에 있다. 여기서는 그 절들을 가리킨다.

### 1. 제품이 그 CLI 에 기대는 것

| 기대는 것 | 깨지면 이렇게 보인다 | 재는 법 |
|---|---|---|
| **① 꾸러미 판** | 앱이 아예 안 뜬다 (§D1 — 게시 직후 tarball 404) | `npm view <꾸러미> version` · 레지스트리(§G1) |
| **①′ zip 주소** | 받기가 404 로 죽는다 | 레지스트리의 `distribution.binary` — 판이 주소에 들어 있다 |
| **② 엔진 판** | 조용히 딴 모델이 돈다 | `realinstall.mts` — overrides 가 눌렀나 |
| **③ 띄울 이름** | *"명령을 찾지 못했습니다"* | npm 꼴은 `.bin/<이름>`, zip 꼴은 푸는 자리의 `cmd` |
| **④ 품은 exe 경로** | 로그인 단추가 아무것도 안 한다 | `logindoor.mts` |
| **⑤ 로그인 길** | 터미널에 오류만 뜨거나, **들어갈 문이 없다** | `logindoor.mts` · `initialize` 의 `authMethods` |
| **⑥ 상태 명령** | **로그인했는데 «로그인하세요»** | `logindoor.mts` — 말을 돌려주나 |
| **⑦ env 문** | 사용자 기계의 판이 돈다 (§F5) | `realinstall.mts` — `CODEX_PATH` 가 박히나 |
| **⑧ 세션 뒷정리** | 목록에 «열 수 없는 세션» 이 쌓인다 (§F) | `codexdelete.mts` |
| **⑨ 오가는 모양** | 말풍선·활동 줄이 깨진다 | `sweep.mjs` 로 전후 비교 · ✅ `0.84.0`↔`0.90.0` 스물한 칸 같았다 (2026-10-15) |
| **⑩ MCP `http`** | 그 방은 **봇끼리 말을 못 건다** — 조용히 | `initialize` 의 `mcpCapabilities.http` |
| **⑪ 도구를 진짜 부르나** | 광고만 하고 안 부르면 **릴레이가 안 돈다** | `mcpagy.cjs` — `tools/call` 이 오나 |
| **⑫ 우리 도구의 신원 자리** | **자동 승인이 조용히 사라진다** — 매번 사용자에게 묻는다 | `mcpagy.cjs` — `name` / `_meta.mcp` / `rawInput.server` 중 어디인가 · `mcpself.mts` 가 셋을 다 흉내낸다 · 🔴 **애드온의 `mcpIdentity` 선언과 맞나** (리팩토링 ⑤) |
| **⑬ `allow_once` 를 주나** | **봇 심사가 통째로 사람에게 간다** — 조용히 | `request_permission` 의 `options` 종류 |
| **⑭ 세션이 지워지나** | 지운 대화가 **평문으로 남는다** — 조용히 | `agymethods.cjs`(지우는 길이 생겼나) · `agydelete.cjs`(파일 자리가 그대로인가) |
| **⑮ 잔량 글의 모양** | 사용량 팝업의 **막대가 조용히 사라진다** (글은 그대로 뜬다) | `quota.mts` 로 받아 `quotaparse.mts` 의 표본과 맞댄다 |

🔴 **⑫는 이제 그 애드온의 신원 어댑터와 맞대야 한다** (리팩토링 ⑤, 2026-10-20).
각 애드온이 «우리 도구는 여기서 꺼낸다» 를 **제 자리 하나에서만** 하는 함수를
든다(`src/agents/<id>/identity.ts`) — Claude 이름 · Antigravity `_meta` · Codex
`rawInput`. 셋 다 뒤지던 때는 저쪽이 자리를 옮겨도 그냥 돌았는데,
그러면 모델이 써 넣는 `rawInput` 으로도 «우리 것» 이 되어 **자동 승인**될 길이
열려 있었다. 이제 새 판이 자리를 옮기면 **봇이 말할 때마다 승인 카드가 뜬다** —
안전한 쪽으로 틀리지만 시끄럽다. `mcpagy.cjs` 가 보여주는 자리와
`src/agents/<id>/identity.ts` 가 읽는 자리가 같은지 본다. 코어는 꺼내 온 것을 한 번
더 본다 — 도구 이름이 우리 셋(`OUR_MCP_TOOLS`) 중 하나일 때만 자동 승인이다.

⚠️ **⑮는 «깨져도 조용하다».** 저쪽이 `/usage` 의 글 모양을 바꾸면 **그 애드온의**
파서(`src/agents/<id>/quota.ts`)가 빈손이 되고, 팝업에는 **막대 없이 받은 글만** 선다 — 고장처럼 안 보인다.
그래서 눈으로 찾을 생각을 말고 **검사가 잡게** 해뒀다:

```
npx tsx tests/probes/quota.mts          진짜로 받아온다
npx tsx tests/quotaparse.mts            받아온 모양으로 뜯히나
```

`quotaparse.mts` 의 표본 셋은 **진짜로 받아온 글을 그대로** 붙인 것이다. 빨개지면
할 일은 하나다 — `quota.mts` 가 새로 받아온 글로 **표본을 갈아 끼우고**, 그 글이
뜯히게 **그 에이전트의 `quota.ts` 만** 고친다 — 다른 애드온은 안 건드린다. 지어낸 표본으로 재면 «우리가 상상한 모양» 만
통과한다.

🔴 **셋의 뜻이 같지 않다는 것을 잊지 않는다.** Claude 는 «얼마나 **썼나**», 나머지
둘은 «얼마나 **남았나**» 를 준다. 새 판에서 그 말(`left`·`remaining`)이 빠지면
«3% 남음» 처럼 **정반대로** 읽힌다 — 수가 뜯히는 것만 보지 말고 **뜻까지** 본다.

⚠️ **⑭는 «명령이 생겼나» 부터 본다.** Antigravity 는 지금 **지우는 길이 아예
없어서** 우리가 파일을 지운다(`purgeFiles`, `PIN.md` §G6). 저쪽이 `session/delete`
를 만들면 **우리 파일 경로가 아니라 그 명령을 써야** 한다 — 남의 집 구조를
짚어 두는 것은 길이 없을 때만 하는 일이다.

⚠️ **⑤는 «이름이 바뀌나» 만이 아니다.** 꾸러미 안에 **CLI 가 아예 없을 수도**
있다 — Antigravity 가 그렇다(파일 둘뿐이고 둘 다 ACP 서버다). 그러면 로그인이
ACP `authenticate` 로만 되고 **터미널로 때우는 길이 없다**(`PIN.md` §G4).
들이기 전에 `initialize` 의 `authMethods` 를 보고 **어느 길인지** 가른다:

```
type: "terminal"   그 CLI 를 터미널로 띄운다        ← Claude · Codex
type 없음 = agent  authenticate 를 불러야 한다      ← Antigravity (저쪽이 브라우저를 연다)
```

둘 다 **만들어 뒀다.** 새 에이전트를 들일 때 고를 것은 «어느 쪽인가» 뿐이다 —
카탈로그 `auth.acp` 가 그 칸이고, 🔴 **짐작하면 안 된다**(`PIN.md` §G4-2).

🔴 **바로 할 수 없으면 «창을 열어주는 것» 까지만 한다.**

⑤·⑥ 에서 제일 자주 걸리는 자리다. 하위 명령이 없다고 **길이 없는 것이
아니다** — 그 CLI 를 그냥 띄우면 대화식으로 묻는 경우가 많다. 거꾸로,
명령이 없는데 **지어내면 더 나쁘다.** 밟은 순서가 그대로 남아 있다:

```
agy 에 logout 이 없다        → «길이 없다» 고 비워뒀다      ← 단추는 떠서 안 먹었다
사용자: "login도 cli 열어서 하지 않았어?"  → 맞다. 로그인도 그냥 띄운 것이었다
agy -i "/logout" 으로 고쳤다  → **슬래시로 안 풀리고 모델에게 말로 갔다**
                             그 에이전트가 사용자 폴더를 뒤지기 시작했다
```

그래서 규칙은 셋이다:

| | |
|---|---|
| **명령이 있으면** | 그 명령으로 띄운다 (`claude auth logout` · `codex logout`) |
| **없으면 창만 연다** | 그 CLI 를 그냥 띄우고 `AgentCmd.say` 로 **무엇을 더 해야 하는지** 한 줄 |
| **그것도 안 되면 단추를 뺀다** | `canLogout` — **안 먹는 단추는 고장보다 나쁘다** |

⚠️ 자동으로 만들어 넣는 길(터미널에 글자를 대신 치기, 자격 파일 지우기)은
안 쓴다. 앞엣것은 TUI 가 언제 준비되는지 알 수 없어 글자가 엉뚱한 데 들어가고,
뒤엣것은 §0 P3 — **구독 토큰은 안 건드린다.**

#### ⑩~⑬ — v3.0 이 들여온 것들 (2026-10-08)

봇이 봇을 부르는 길이 **MCP 위에 서 있어서**, 에이전트가 그 위에서 어떻게
구는지가 새로 걸린다. 그리고 **넷 다 조용히 깨진다** — 오류가 안 난다.

🔴 **제일 고약한 것은 ⑫다.** 우리 MCP 도구인지 가려서 자동 승인하는데, 그
신원을 **세 에이전트가 세 자리에 넣는다**(실측 2026-10-08):

```
Claude Code   name     = "mcp__ai-in-one__aio_peek"
Antigravity   _meta.mcp= { server: "ai-in-one", tool: "aio_peek" }
Codex         rawInput = { server: "ai-in-one", tool: "aio_peek", … }
```

**공통 칸이 하나도 없다.** 그래서 셋을 다 보고, 셋 다 없으면 사용자에게 묻는다 —
새 에이전트가 **네 번째 자리**에 넣으면 거기로 떨어진다. 안전한 쪽으로 틀리지만
**시끄러워지고, 왜 시끄러운지는 안 보인다.**

> 참고 — **묻지 않는 에이전트도 있다.** Codex 는 기본 모드에서 우리 도구에 권한을
> 아예 안 묻는다. 그래서 `ask_bot` 승인은 에이전트에 기대지 않고 **우리 서버에서**
> 건다. ⑫가 깨져도 그 승인은 안 사라진다.

✅ **2026-10-15 — Antigravity 1.4.0 에서 넷 다 그대로다** (`PIN.md` §G7-1).
신원은 여전히 `_meta.mcp` 고 `name` 은 `null` 로 온다.

⚠️ **`readOnlyHint` 로 자동 승인을 유도할 수 없다** — Antigravity 는 붙여놔도
물었다. 그 길은 닫힌 것으로 적어둔다.

⚠️ `usage_update` 를 안 주는 에이전트면 **맥락 창 표시가 빈다.** 기능이 걸리는
것은 아니다 — 셋 다 `{used, size}` 는 주고 **`cost` 는 아무도 안 준다**(M4).

⚠️ **①만 보고 올리면 ③~⑦ 이 조용히 깨진다.** 셋 다 «이름» 에 기대는 것인데
이름은 판이 올라가며 바뀌는 것 중 제일 흔하다. 실제로 우리가 밟은 것:

```
.bin 에 claude 가 없다          → 꾸러미 안의 exe 를 찾아야 했다
codex* 가 다른 exe 를 먼저 집었다  → codex-code-mode-host.exe
codex login status 가 stderr    → 로그인한 사람을 아니라고 봤다
CODEX_PATH 기본값이 "codex"      → 사용자 기계의 0.155.0 이 돌 뻔했다
```

### 2. 밟는 순서

```bash
# 0. 공식 목록이 무엇을 권하나 (§G1) — 손으로 재기 전에. npm 검색이 아니다
curl -s https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json |
  python -c "import json,sys;[print(a['id'],a['version'],(a.get('distribution') or {}).get('npx',{}).get('package','')) for a in json.load(sys.stdin)['agents']]"

# 1. 지금 나와 있는 판 · 엔진을 무는 방식
npm view <어댑터> version dependencies
#    zip 꼴이면 레지스트리의 distribution.binary 주소를 그대로 옮겨 적는다

# 2. **기준선 먼저** — 안 그러면 새 판의 NO 가 원래 그런 건지 알 수 없다
node tests/probes/sweep.mjs <옛판>
node tests/probes/sweep.mjs <새판>
#    OK/NO 줄만 보면 절반을 놓친다 (§B). .probe-out/<판>/ 에 본문이 통째로 남는다
#
#    ⚠️ **옛 판을 다시 돌리지 않는다** — .probe-out/ 은 안 지운다. 0.81.2 · 0.84.0
#       이 그렇게 남아 있어서 **새 판만** 돌리고 줄로 맞대면 된다. 한 판치가
#       진짜 턴 **스물일곱 번**이다(할당량).
#    ⚠️ **판을 타는 것은 열아홉 개뿐이다** — `AIO_ACP_VERSION` 을 읽는 것들.
#       나머지는 두 번 돌려도 같은 것을 잰다. 파일 이름을 뒤에 적어 고른다:
#         node tests/probes/sweep.mjs 0.90.0 elicit.cjs steer.cjs cancelwhy.cjs
#    🔴 **프로브가 틀렸을 확률을 먼저 센다.** 한 칸만 갈렸으면 그 자의 모양부터
#       본다 — 2026-10-15 에 갈린 한 칸(wakebusy)은 **판이 아니라 자**였다.
#       재는 낱말을 **프롬프트에 적어 보내고** 있어서 모델이 되뇌기만 해도 ✅ 가
#       됐다(ROADMAP §wakebusy). 낱말은 모델이 알 수 없는 곳에서 와야 한다.
#    ⚠️ **「아무것도 못 쟀다」는 뒷정리 실패에도 뜬다** — OK 줄을 안 찍는 프로브
#       (modelids)가 끝에 EPERM 하나만 내도 그렇게 적힌다. 본문을 봐야 한다.

# 3. 세션·되돌리기·모델 갈림 (Claude 쪽)
node tests/probes/bumpsafe.cjs <새판>
node tests/probes/bumpsonnet.cjs <새판>
node tests/probes/opusbump.cjs

# 4. 핀을 고친다 — src/agents/<에이전트>/index.ts 한 자리 (CODEX_PIN / args)

# 5. 진짜로 받아지고 **끝까지 도나**  ← ②③⑦ 과 왕복
npx tsx tests/probes/realinstall.mts     # npm 꼴
npx tsx tests/probes/antigravity.mts     # zip 꼴
#   zip·tar 꼴이면 **여섯 판 속을 다 본다** — 이름과 권한이 판마다 다르다 (§G5).
#   윈도우에서 돌려본 것만으로는 mac·리눅스가 산다고 말할 수 없다.
#   ⚠️ 2026-10-07: antigravity.mts 를 `agy` 없는 모양으로 고쳐놓고 **안 돌렸다**
#   (돌리면 119MB 를 진짜로 받는다). mac·리눅스도 이 기계에서는 못 본다.

# 6. 로그인 문이 열리나  ← ④⑤⑥
npx tsx tests/probes/logindoor.mts

# 7. 나가면 치워지나  ← ⑧
npx tsx tests/probes/codexdelete.mts

# 8. **우리 코드로** 진짜 어댑터를 한 번
npx tsx tests/probes/smokereal.mts

# 9. **릴레이가 되나** (v3.0) ← ⑩⑪⑫⑬
#    node tests/probes/mcpagy.cjs <에이전트>
#    mcpCapabilities.http · tools/call 이 오나 · 권한을 묻나 ·
#    묻는다면 신원이 어디 있나 · options 에 allow_once 가 있나

# 10. 우리 검사
npm test

# ── Codex 어댑터면 하나 더: 모델 목록과 세 판이 벌어진 폭 (§F4·F5)
node tests/probes/codexmodels.cjs
```

**probe 는 판을 손으로 안 적는다.** `tests/probes/pinned.cjs` 가
그 에이전트의 애드온 파일(`src/agents/<id>/index.ts`)에서 읽는다 — 4번만
고치면 5~8이 새 판을 잰다. 이게
없으면 핀을 박는 순간 probe 만 `latest` 를 재서 **아무도 안 쓰는 판**을
검사하게 된다.

8번이 따로 있는 이유: probe 는 ACP 를 손으로 말하고 `npm test` 는 가짜
에이전트를 쓴다 — **«우리 코드 + 진짜 어댑터»** 는 그 사이에 있어서
아무도 안 밟던 칸이었다.

### 3. 모델은 에이전트마다 다르게 움직인다

```
Claude   모델 표가 claude.exe 안에 박힌다  →  **핀을 올려야 새 모델이 온다** (§A)
Codex    서버가 내려준다 (models_cache)    →  핀과 무관하게 바뀐다 (§F4)
```

그래서 «새 모델이 안 보인다» 는 호소를 받으면 **에이전트마다 답이 다르다.**
Claude 면 핀을 올려야 하고, Codex 면 올려도 그대로다 — 그쪽은 계정·서버
몫이라 우리가 할 수 있는 것이 없다.

⚠️ Codex 는 **고른 뒤에 사라지기도 한다**(`visibility: hide`). 그때는
막음 화면이 받아야 한다 — `restoreChoices` 가 «지금 값과 같다» 고 넘어가면
그대로 보내서 404 가 난다. 검사는 `tests/modelgone.mts`.

### 4. 올린 뒤 꼭 눈으로 볼 것

probe 가 못 보는 자리다.

```
F5 → 로봇 아이콘 → 설치하기 → 로그인(터미널이 제대로 뜨나) → 방 만들기 → 한 마디
```

로그인은 **브라우저가 열리고 코드를 붙여넣는 흐름**이라 끝까지 자동으로 못
잰다. `logindoor.mts` 는 «명령이 뜬다» 까지만 본다.



---

## F. 세션 뒷정리 — **핀이 안 지켜주는 칸**

> 사용자 지적 (2026-10-01): *"지금 지우는게 acp가 아니라 cli 통해서 하는거면,
> 판이 올라갈때마다 acp 핀도 업데이트 하면서, 세션관리도 같이 검토해야겠네"*.
>
> 맞다. 그리고 **생각보다 더 나쁘다.**

§A–E 는 전부 «핀을 올리면 무엇이 바뀌나» 다. 그런데 방을 나갈 때 도는 것 중
**핀이 하나도 안 걸린 것이 둘** 있다:

```
claude-agent-acp@0.84.0   ← 못이 박혀 있다. 우리가 올릴 때만 움직인다
codex-acp                 ← **핀이 없다.** `npx -y` 라 받을 때마다 최신이다
codex delete --force      ← 핀이 아니라 **사용자 기계에 깔린 CLI** 다
```

세 번째가 핵심이다. 뒷정리는 ACP 가 아니라 **그 CLI 를 직접 띄운다**
(`AgentDef.purgeSession`). ACP 는 스키마가 있고 판이 적혀 있지만 CLI 의
플래그에는 그런 게 없다. `delete` 가 `remove` 가 되거나 `--force` 가
`--yes` 가 되면 **그날 깨진다.** 사용자가 `codex update` 한 번 하면 그만이라
**우리 판과 무관하게 아무 때나** 온다.

### F1. 왜 조용히 깨지나

뒷정리는 **일부러** 안 막고 안 기다린다 — `codex` 가 PATH 에 없다고 방이 안
닫히면 고치려던 것보다 나쁘다. 그 성질이 그대로 약점이 된다:

```
명령 자체가 없다     →  spawn 이 `error`     →  잡힌다
돌았는데 거절당한다  →  종료코드만 바뀐다   →  ⚠️ 예전엔 통째로 못 봤다
```

아래가 **훨씬 있을 법한 고장**인데 예전 코드는 `stdio: "ignore"` 에 `error`
만 들어서 아무것도 안 남겼다. 그러면 세션이 다시 쌓이는데 **기록이 없고**,
사용자는 몇 달 뒤 목록이 유령으로 차고 나서야 안다. 이미 한 번 걸은 길이다.

지금은 종료코드와 stderr 를 받아 로그로 흘린다. 나가기는 여전히 안 막는다.
검사는 `tests/purge.mts` ⑤.

### F2. 그래서 판을 올릴 때 같이 본다

```bash
npx tsx tests/probes/codexdelete.mts
```

이것 하나면 된다. 세 자리를 다 보고(**파일 · `threads` · 앱 목록**) ③에서
**우리 코드로 방을 나가** 걷히는지까지 잰다. 4/4 가 아니면 멈춘다.

⚠️ **OK 개수만 보지 말고 본문을 봐라.** «지우기 전엔 있었다» 가 NO 로
바뀌는 것은 *저장 자리가 옮겨갔다*는 뜻일 수 있고, 그건 지우기가 되는지와
별개로 **우리가 엉뚱한 데를 보고 있다**는 신호다.

### F3. 저장 자리는 이름부터 안 미덥다

```
~/.codex/sessions/**/*.jsonl                 파일
~/.codex/state_5.sqlite : threads            ← 이름에 판 번호가 박혀 있다
~/.codex/sqlite/codex-dev.db : local_…       ← **`-dev`** 가 붙어 있다
```

`state_5` 는 `state_6` 이 될 것이고 `codex-dev.db` 는 이름부터 임시다. 세
번째는 **한 번 놓쳐서**, «깨끗하다» 를 세 번 말하는 동안 사용자 앱은 계속
유령을 띄웠다. 아는 자리를 하나씩 확인하는 방식으로는 **아는 자리 밖**을 못
본다 — 증상이 가리키는 id 로 **전체를 뒤져서야** 찾았다.

**우리가 이 표들을 직접 쓰지 않는다는 게 이 설계의 요점이다.** 읽는 건
probe 뿐이고 지우는 건 늘 저쪽 CLI 다. 자리가 바뀌어도 제품은 안 깨지고
**probe 만 눈이 먼다** — 그래서 F2 의 본문 확인이 필요하다.

> F4 부터는 Codex 이야기라 `agents/codex/` 로 갔다.

---

## G. 에이전트마다 모양이 다르다 — 그리고 **공식 목록이 따로 있다**

> ⏪ **이 절을 한 번 틀리게 적었다** (2026-10-01).
>
> 처음엔 npm 의 `@agentclientprotocol/` scope 만 보고 *"공식은 셋뿐이고
> Antigravity·Grok 은 공식 어댑터가 없다"* 고 적었다. **둘 다 틀렸다.**
> 사용자가 *"acp 지원 목록을 한번 봐봐"* 해서 공식 문서를 보고 알았다.
>
> npm scope 는 **배포 자리 하나**일 뿐이다. 목록은 다른 데 있었다 — 그리고
> 거기 Antigravity 도 Grok 도 있다. **아는 자리만 뒤지면 아는 자리 밖을 못
> 본다** 는 것을, 이 저장소에서 `codex-dev.db` 때 이미 한 번 겪고도 또 했다.

### G1. 기계가 읽는 레지스트리가 있다

```
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

41개 에이전트, 전부 **판이 못 박힌 채로** 들어 있다. 한 항목의 모양:

```jsonc
{
  "id": "codex-acp", "name": "Codex", "version": "2.1.0",
  "authors": ["OpenAI", "JetBrains s.r.o", "Zed Industries"],
  "license": "Apache-2.0",
  "distribution": { "npx": { "package": "@agentclientprotocol/codex-acp@2.1.0" } },
  "icon": "…/codex-acp.svg"
}
```

★ **우리 핀 둘이 레지스트리와 정확히 같다** — `claude-agent-acp@0.84.0`,
`codex-acp@2.1.0`. 손으로 고른 것이 공식 권장과 맞았다. 그러니 **다음에
올릴 때는 이 파일을 먼저 본다.** §A–F 를 손으로 재기 전에, 저쪽이 무엇을
권하는지가 여기 적혀 있다.

받는 방식은 셋이다:

```
npx     22개   우리가 지금 쓰는 길
binary  19개   zip 을 받아 풀어야 한다  ← 2026-10-06 부터 된다
uvx      2개   파이썬 쪽
```

⏪ **«못 받는다» 를 무른다** (2026-10-06). Antigravity 를 들이면서
`AgentPackage.binary` 와 `unzip.ts` 를 만들었다 — 플랫폼별 주소를 받아
우리 자리에 푸는 길이다. 실측은 `probes/antigravity.mts`(6/6).

⚠️ 다만 **받는 것과 쓰는 것은 다르다.** binary 꼴은 꾸러미 안에 **CLI 가
없고 ACP 서버만** 들어 있기도 하다 — 그런 에이전트는 로그인이
`authenticate` 로만 된다(§G4).

### G2. 물어본 것들 — 실제 항목

| | 만든이 | 받는 법 | 라이선스 |
|---|---|---|---|
| **Claude Agent** | Anthropic · Zed · JetBrains | `npx @agentclientprotocol/claude-agent-acp@0.84.0` | proprietary |
| **Codex** | OpenAI · JetBrains · Zed | `npx @agentclientprotocol/codex-acp@2.1.0` | Apache-2.0 |
| **Gemini CLI** | Google | `npx @google/gemini-cli@0.62.0 --acp` | Apache-2.0 |
| **Grok Build** | **xAI** | `npx @xai-official/grok@1.0.46 agent stdio` | proprietary |
| **Google Antigravity** | **Google LLC** | binary — `dl.google.com/…/agy-acp-server-1.3.0-windows-x86_64.zip` → `agy_acp_server.exe` | proprietary |

⏪ **«Gemini 는 핀을 못 박는다» 도 틀렸다.** CLI 자체가 ACP 를 하는 건
맞지만 **그 CLI 를 npx 로 판 찍어 받으면 된다** — 레지스트리가 바로 그렇게
한다. Gemini 가 기본 목록에 없는 진짜 이유는 핀이 아니라 **인증**이다:
개인 구글 계정 로그인이 막혀 API 키만 남았고, 그러면 §0 P3 가 깨진다.

⏪ **«Claude 어댑터는 Anthropic 것이 아니다» 도 손봐야 한다.** 관리자
목록만 보고 그렇게 적었는데, 레지스트리의 `authors` 는 **Anthropic · Zed ·
JetBrains** 셋을 나란히 적는다. 셋이 같이 보는 물건이다.

### G3. 그래서 새 에이전트를 볼 때 묻는 순서

```
1. 레지스트리에 있나                      ← **여기부터.** npm 검색이 아니다
2. 받는 방식은 무엇인가                npx·binary 는 된다. uvx 는 아직 없다
3. 어댑터가 엔진을 품나, 범위로 무나       범위면 엔진도 지명한다 (§F4)
4. 구독으로 로그인되나                    키만 되면 §0 P3 위반 (Gemini)
5. **MCP http 를 광고하고 진짜 부르나**    없으면 그 방은 봇끼리 말을 못 건다 (v3.0)
6. 나갈 때 ACP delete 로 다 지워지나       아니면 `purgeSession` (§F)
```

★ **5번이 v3.0 에서 생겼다** (2026-10-08). 봇이 봇을 부르는 길이 MCP 위에 서
있어서다. `probes/mcpagy.cjs` 가 한 번에 찍는다 — 광고(`mcpCapabilities.http`)와
**실제로 `tools/call` 을 부르는가**는 다른 질문이라 둘 다 본다.

그리고 **우리 도구의 신원을 어디에 넣는지**까지 같이 본다. 셋이 세 자리다:

```
Claude Code   name     = "mcp__ai-in-one__…"
Antigravity   _meta.mcp= { server, tool }
Codex         rawInput = { server, tool, … }
```

**공통 칸이 없다.** 넷째 자리에 넣는 에이전트가 오면 자동 승인이 조용히
«사용자에게»로 떨어진다 — 점검표는 `BUMP.md` ⑩~⑬.

★ **셋 다 읽는다** (2026-10-09 — ⏪ 그때는 코어의 `mcpIdentity` 가 셋을 다 봤고, 2026-10-20
부터는 애드온이 제 자리에서만 꺼낸다; 셋 다 보는 것은 낯선 에이전트용 `standard` 뿐이다). 그리고 **셋 다
없으면 사용자에게 간다** — 못 알아본 것을 «우리 것»으로 읽으면 **남의 도구가
자동 승인으로 지나가므로**, 틀리는 방향을 안전한 쪽으로 두었다.

그래서 넷째 자리가 오면 **조용히 안 깨지고 «매번 묻는다»로 드러난다** — 불편하긴
해도 눈에 보이는 고장이다. `tests/mcpself.mts` 가 세 꼴을 다 흉내내므로, 넷째를
들일 때는 거기에 한 줄 늘리면 된다.

레지스트리에 **없는** 것을 기본에 넣는 일은 그 자체로 다른 결정이다.
어댑터는 사용자의 로그인 자리와 작업 폴더를 그대로 받으므로, 아무도
추려주지 않은 것을 우리가 골라 끼워주면 그 사람 자격증명이 **우리가 안
읽어본 코드**를 지나간다. 쓰고 싶은 사람은 `aiInOne.agents` 로 직접 넣을
수 있다 — **기본에 넣는 것과 넣을 수 있게 두는 것은 다르다.**

> G4 부터는 Antigravity 이야기라 `agents/antigravity/` 로 갔다.

---

## 슬래시 명령 — 셋을 맞대어

## 슬래시 명령 — 어댑터가 광고하는 것

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

### 한눈에

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


> 에이전트마다의 목록은 각 폴더에 있다.

### 그래서 무엇이 걸리나

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

### 토큰 한도 — 볼 수 있나

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
안 들어 있다.

#### `usage_update` — 어디서 오나

`size` 를 **우리가 짐작하지 않는다.** 모델별 표도 기본값도 없고, 어댑터가
보내준 `update.size` 를 그대로 적는다(`roomManager.noteUsage`). 그래서 이
숫자는 **어댑터가 아는 만큼**이다.

```
Claude        used 36,837 / size 1,000,000   cost 0.2948514 USD
Codex         used 17,495 / size   258,400   cost 없음
Antigravity   used 12,432 / size 1,048,576   cost 없음
```

★ **첫 턴에 «1 더하기 1» 만 묻고 잰 것**이다. 그런데도 1만~3만이 차 있다 —
시스템 프롬프트와 도구 설명이 먼저 앉은 자리다.

🔴 **슬래시 턴에는 안 온다.** `/usage`·`/status` 를 보냈을 때는 셋 다
`usage_update` 가 **안 왔다.** 어댑터가 모델을 안 부르고 제가 답하니 쓴 것이
없는 것이다 — «안 오는 어댑터» 와 **«안 오는 턴»** 은 다른 말이다.

★ **`cost` 는 Claude 만 보낸다.** 받을 준비는 셋 다 되어 있는데
(`acpConnection` 의 `usage_update`) 채워 오는 것은 하나뿐이었다.

⚠️ **`size` 는 모델에 딸린 값이다.** 위 Claude 의 1,000,000 은 1M 컨텍스트
판을 쓰고 있어서다 — 모델을 바꾸면 이 수도 바뀐다. 상수로 두면 안 된다.

#### 그래서 세우려면

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

#### 슬래시 턴은 맥락에 안 남는다

**셋 다 기억 안 한다** (`tests/probes/slashmem.mts`, 2026-10-19). 표식을
심고 → 슬래시를 한 번 쓰고 → «바로 앞에 내가 뭐라고 했지?» 를 물었더니,
셋 다 **슬래시 앞의 말**을 가리켰다.

```
Claude        표식을 토씨까지 그대로 읊었다        used +2,378
Codex         "암호가 포함되어 있어 반복 못 해"    used +1,005
Antigravity   표식을 그대로 읊었다                 used +222
```

★ Codex 가 읊기를 **거절한 것도 답이다.** 토씨는 안 돌려줬지만 «직전 말에
암호가 있다» 고 믿는다 — `/status` 가 직전이었다면 거절할 까닭이 없다.

★ `usage_update` 가 슬래시 턴에 안 오는 것과 **같은 이야기다.** 어댑터가
제 선에서 답하고 모델에 안 넘긴다.

🔴 **그런데 우리 대화에는 남는다.** `send()` 는 언제나 `role:"user"` 메세지를
하나 붙이므로([roomManager] `send`), 화면에는 `/usage` 와 그 답이 **말풍선
둘**로 선다. 모델은 잊었는데 사람은 보는 **어긋난 자리**다.

그래서 방 안에 «사용량» 버튼을 둔다면, 값은 **맥락이 아니라 화면**이다 —
누를 때마다 읽던 대화에 찌꺼기가 쌓인다. 치우려면 그 말풍선을 숨기거나
(그러면 압축 자국도 같이 숨겨진다) **대화 밖에서 묻는 길**이 필요하다.


> 「사용량」 팝업을 지은 이야기는 `src/core/quota.md` 로 갔다.

### 안 잰 것

- **인자를 받는 명령이 있나.** ACP 의 `availableCommands` 는 `input` 칸을
  줄 수 있는데(`ROADMAP.md:1037`), 셋 중 누가 그걸 채워 보내는지 안 봤다.
  자동완성에서 «인자가 필요한 명령» 을 가르려면 필요하다.
- **목록이 중간에 바뀌나.** `reload-plugins` 같은 것을 쓰면 다시 올 법한데,
  그때 우리가 덮어쓰는지(`onIdleEvent` 는 덮어쓴다) **실측은 없다.**
- **macOS·리눅스.** 여기 수는 Windows 11 것이다. 깔린 스킬이 OS 마다 다를
  수 있고, Antigravity 는 리눅스에서 `--uid=` 를 더 받는다.
- **같은 이름 = 같은 일인가** (위 ④).
- **잔량을 대화 밖에서 물을 길.** 지금은 `send` 뿐이라 턴이 남는다.
