# 에이전트를 우리 자리에 둔다

> 2026-10-01 에 정했다. 사용자: *"우리 자리를 만들어 넣으면 이 모든게
> 가능한가"* → *"시행할 것"*.

## 왜

지금은 방을 열 때마다 `npx -y <꾸러미>` 를 띄운다. npx 가 알아서 받아주니
편한데, **받아둔 자리가 우리 것이 아니다.** 그래서 하고 싶은 일이 줄줄이
막혔다 (전부 2026-10-01 실측):

| 하고 싶은 것 | npx 로는 | 왜 |
|---|---|---|
| 품은 `claude.exe` 를 부르기 | ❌ | 자리가 `_npx/<해시>` 다. npm 내부 구조라 못 박는다 |
| 옛 판 지우기 | ⚠️ | **남의 자리다.** Zed·JetBrains 도 같은 꾸러미를 같은 폴더에 받는다 |
| 엔진 판 정확히 박기 | △ | `-p` 를 둘 줘서 되긴 하는데 꼼수다. `overrides` 가 정식이다 |
| 사용자가 고른 것만 받기 | ❌ | 받는 시점이 «처음 쓸 때» 라 우리가 못 고른다 |
| 받는 동안 진행률 보여주기 | ❌ | npx 안에서 일어나는 일이다 |

쌓인 값도 실물로 있다 — 이 기계에 **15자리 3.7GB**, 자리당 277~445MB.
한 번 받으면 아무도 안 지운다.

## 어디에

```
<globalStorageUri>/agents/<에이전트id>/
  package.json          ← 우리가 쓴다. overrides 가 여기 들어간다
  node_modules/
    .bin/<bin이름>      ← 어댑터를 띄우는 자리
```

`globalStorageUri` 는 이미 방 저장에 쓰는 자리다(`extension.ts`). **우리
것이므로 마음대로 지운다** — 이게 전환의 핵심이다.

## 받는 길이 둘이다

2026-10-06 에 Antigravity 를 들이면서 갈렸다. **어디에 두느냐는 같고**
받아오는 방식만 다르다.

```
npm 꼴 (Claude · Codex)          zip 꼴 (Antigravity)
<자리>/package.json              <자리>/agy_acp_server.exe
<자리>/node_modules/.bin/<이름>   <자리>/aio-installed.json   ← 무엇을 받았나
```

| | npm 꼴 | zip 꼴 |
|---|---|---|
| 적는 곳 | `pkg.spec` · `pkg.bin` | `pkg.binary[플랫폼]` |
| 받는 법 | `npm install --prefix` | `fetch` → `unzip.ts` |
| 판을 가리는 법 | `node_modules/…/package.json` | 받아둔 주소를 적어둔 표 |
| 엔진 박기 | `overrides` | 주소에 판이 들어 있다 |

🔴 **푸는 것은 바깥 도구에 안 기댄다.** `tar` 는 윈도우(bsdtar)에선 zip 을
풀지만 **GNU tar 는 못 풀고**, `unzip` 도 리눅스에 늘 있지 않다. 기계마다
있는 것이 달라서, 없으면 **설치가 통째로 막힌다.** `zlib` 으로 직접 읽는다.

⚠️ **zip-slip 을 막는다.** 압축파일 속 이름은 남이 정한 것이라 `../../` 가
들어 있을 수 있다 — 나온 경로가 목적지 안인지 매번 확인한다
(`tests/unzip.mts` 가 그 자리를 직접 때린다).

⚠️ **받는 것과 그 안에 든 것은 다르다.** 셋 다 우리가 받지만, npm 꼴은
안에 **진짜 CLI**(`claude.exe`·`codex.exe`)가 들어 있어 `auth login` 을
부를 수 있고, Antigravity 의 zip 에는 **ACP 서버뿐**이라 로그인이
`authenticate` 로만 된다. 자세한 건 `PIN.md` §G4.

⚠️ **지우기는 떠 있으면 막힌다.** 윈도우는 돌고 있는 실행파일을 못
지운다 — 지우기 전에 연결을 내리고(`dropConnection` → `killTree`),
그래도 안 되면 몇 번 기다렸다 **못 지웠다고 말한다.** 반만 지운 자리를
«지웠다» 고 하면 다음에 «받아져 있다» 고 잘못 읽는다.


## 무엇을 적어두나 — `AgentDef.pkg`

```ts
pkg?: {
  spec: string;                    // "@agentclientprotocol/codex-acp@2.1.0"
  bin: string;                     // "codex-acp"
  overrides?: Record<string, string>;  // { "@openai/codex": "0.159.3" }
  exeEnv?: { name: string; bin: string };
}
```

`exeEnv` 가 🔴 **제일 중요하다.** 두 어댑터 다 엔진 바이너리를 **PATH 에서
찾는 문**을 두고 있는데, 기본값이 다르다:

```
Claude   CLAUDE_CODE_EXECUTABLE   기본: 품은 exe
Codex    CODEX_PATH               기본: **"codex" — PATH 에서 찾는다**
```

지금 Codex 가 핀 판으로 도는 건 **npx 가 제 `.bin` 을 PATH 앞에 끼워주기
때문**이다. 우리 자리에서 직접 띄우면 그 도움이 없어져 **사용자의 `codex`
가 걸린다**(이 기계: 0.155.0). 그러니 전환과 동시에 `CODEX_PATH` 를
우리 `.bin` 으로 박아야 한다. **안 하면 조용히 딴 판이 돈다.**

## 화면이 보여줄 단추 — `AgentState`

사용자가 정한 표 그대로다 (2026-10-01). 계산은 `agentInstaller.stateOf`,
검사는 `tests/installer.mts`.

| 상태 | 언제 | 단추 |
|---|---|---|
| `none` | 안 받았다 | **설치하기** |
| `stale` | 핀이 올라갔다 | **업데이트** · <span style="color:#c00">제거</span> |
| `needLogin` | 받았는데 로그인 안 됨 | **로그인** · <span style="color:#c00">제거</span> |
| `ready` | 받았고 로그인됨 | **로그아웃** · **사용량** · <span style="color:#c00">제거</span> |

- **핀이 안 올라갔으면 그대로 둔다** — 맞는 판이 있으면 `npm` 을 아예 안 부른다
- **낡음이 로그인보다 앞선다.** 핀을 올렸는데 낡은 판이 돌면 «모델이 올라간 줄
  알았는데 아니었다» 가 된다(`docs/PIN.md` §A). 다만 `loggedIn` 도 같이
  돌려주므로 화면은 둘 다 보여줄 수 있다
- **제거는 빨간 단추다.** 받아둔 뒤라면 어느 상태에서나 할 수 있다. 저장소에
  이미 `.danger` 꼴이 있다(`fieldset.bot .bot-drop.danger` — 봇 «빼기»).
  지우는 건 **우리 자리**라 남의 것을 건드리지 않는다
- 제거해도 **로그인은 안 날아간다.** 자격은 `~/.codex`·`~/.claude` 에 있고
  거긴 우리 자리가 아니다 — 로그아웃은 따로 있는 단추다

## 안 하는 것

- **`--omit=optional`** — 바이너리를 빼고 우리가 대주면 227MB 를 아끼지만,
  플랫폼별 꾸러미를 우리가 골라야 한다. npm 이 `os`/`cpu` 로 알아서 고르는
  일을 손으로 하는 셈이라 **지금은 안 한다.** 한 벌만 받으면 중복은 없다.
- **옛 npx 자리 치우기** — 3.7GB 가 남지만 **남의 자리라 안 건드린다.**
  사용자에게 «여기에 이만큼 있습니다» 라고 알려주는 것까지가 우리 몫이다.

## 되돌리기

`pkg` 를 안 적은 에이전트는 예전처럼 `command`+`args` 로 띄운다.
`aiInOne.agents` 로 사용자가 덮어쓴 것도 그 길로 간다. **전환은 에이전트
단위이고, 한 줄 빼면 돌아간다.**
