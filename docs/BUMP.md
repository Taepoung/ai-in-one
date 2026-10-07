# 에이전트를 올릴 때 — 점검표

> 2026-10-06. `docs/PIN.md` 가 «핀이 움직이면 무엇이 바뀌나» 를 설명한다면,
> 여기는 **한 에이전트를 올릴 때 손으로 밟는 순서**다. 제품이 그 CLI 에
> 기대는 것이 핀 하나가 아니라 **아홉**이라 따로 둔다.
>
> 왜 그런지는 `PIN.md` 의 §A~§G 에 있다. 여기서는 그 절들을 가리킨다.

## 1. 제품이 그 CLI 에 기대는 것

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
| **⑨ 오가는 모양** | 말풍선·활동 줄이 깨진다 (§B) | `sweep.mjs` 로 전후 비교 |

⚠️ **⑤는 «이름이 바뀌나» 만이 아니다.** 꾸러미 안에 **CLI 가 아예 없을 수도**
있다 — Antigravity 가 그렇다(파일 둘뿐이고 둘 다 ACP 서버다). 그러면 로그인이
ACP `authenticate` 로만 되고 **터미널로 때우는 길이 없다**(`PIN.md` §G4).
들이기 전에 `initialize` 의 `authMethods` 를 보고 **어느 길인지** 가른다:

```
type: "terminal"   그 CLI 를 터미널로 띄운다        ← 지금 우리가 하는 것
type 없음 = agent  authenticate 를 불러야 한다      ← 아직 안 만들었다
```

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

⚠️ **①만 보고 올리면 ③~⑦ 이 조용히 깨진다.** 셋 다 «이름» 에 기대는 것인데
이름은 판이 올라가며 바뀌는 것 중 제일 흔하다. 실제로 우리가 밟은 것:

```
.bin 에 claude 가 없다          → 꾸러미 안의 exe 를 찾아야 했다
codex* 가 다른 exe 를 먼저 집었다  → codex-code-mode-host.exe
codex login status 가 stderr    → 로그인한 사람을 아니라고 봤다
CODEX_PATH 기본값이 "codex"      → 사용자 기계의 0.155.0 이 돌 뻔했다
```

## 2. 밟는 순서

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

# 3. 세션·되돌리기·모델 갈림 (Claude 쪽)
node tests/probes/bumpsafe.cjs <새판>
node tests/probes/bumpsonnet.cjs <새판>
node tests/probes/opusbump.cjs

# 4. 핀을 고친다 — src/core/agentCatalog.ts 한 자리 (CODEX_PIN / args)

# 5. 진짜로 받아지고 **끝까지 도나**  ← ②③⑦ 과 왕복
npx tsx tests/probes/realinstall.mts     # npm 꼴
npx tsx tests/probes/antigravity.mts     # zip 꼴
#   zip·tar 꼴이면 **여섯 판 속을 다 본다** — 이름과 권한이 판마다 다르다 (§G5).
#   윈도우에서 돌려본 것만으로는 mac·리눅스가 산다고 말할 수 없다.
#   ⚠️ 2026-10-07: antigravity.mts 를 `agy` 없는 모양으로 고쳐놓고 **안 돌렸다**
#   (돌리면 217MB 를 진짜로 받는다). mac·리눅스도 이 기계에서는 못 본다.

# 6. 로그인 문이 열리나  ← ④⑤⑥
npx tsx tests/probes/logindoor.mts

# 7. 나가면 치워지나  ← ⑧
npx tsx tests/probes/codexdelete.mts

# 8. **우리 코드로** 진짜 어댑터를 한 번
npx tsx tests/probes/smokereal.mts

# 9. 우리 검사
npm test

# ── Codex 어댑터면 하나 더: 모델 목록과 세 판이 벌어진 폭 (§F4·F5)
node tests/probes/codexmodels.cjs
```

**probe 는 판을 손으로 안 적는다.** `tests/probes/pinned.cjs` 가
`agentCatalog.ts` 에서 읽는다 — 4번만 고치면 5~8이 새 판을 잰다. 이게
없으면 핀을 박는 순간 probe 만 `latest` 를 재서 **아무도 안 쓰는 판**을
검사하게 된다.

8번이 따로 있는 이유: probe 는 ACP 를 손으로 말하고 `npm test` 는 가짜
에이전트를 쓴다 — **«우리 코드 + 진짜 어댑터»** 는 그 사이에 있어서
아무도 안 밟던 칸이었다.

## 3. 모델은 에이전트마다 다르게 움직인다

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

## 4. 올린 뒤 꼭 눈으로 볼 것

probe 가 못 보는 자리다.

```
F5 → 로봇 아이콘 → 설치하기 → 로그인(터미널이 제대로 뜨나) → 방 만들기 → 한 마디
```

로그인은 **브라우저가 열리고 코드를 붙여넣는 흐름**이라 끝까지 자동으로 못
잰다. `logindoor.mts` 는 «명령이 뜬다» 까지만 본다.

