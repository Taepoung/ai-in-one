# 배포

이 확장을 남에게 주는 방법. **세 가지 길이 있고 목적이 다르다.**

| 길 | 누가 받나 | 계정 |
|---|---|---|
| **`.vsix` 파일** | 나, 그리고 파일을 줄 수 있는 사람 | 필요 없음 |
| **VS Code 마켓플레이스** | VS Code 사용자 전부 | Azure DevOps |
| **Open VSX** | Cursor · VSCodium · Windsurf | Open VSX 계정 |

> 마켓플레이스는 **한 번 올리면 되돌릴 수 없다**(버전 삭제는 되지만 이미 설치한
> 사람에게는 남는다). `.vsix`로 며칠 써보고 올리는 순서를 권한다.

---

## 0. 올리기 전에

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

`npm test` 가 **저장소의 `tests/` 를 전부 돈다.** 예전엔 임시 폴더에 있어서
«스크래치패드의 `*.mts`» 라고 적어뒀는데, 그러다 검사 셋을 영영 잃었다.
이제 전부 저장소 안이다.

> `tests/probes/` 는 **자동으로 안 돈다.** 진짜 CLI 를 받아 띄우고 수백 MB 를
> 내려받으므로 손으로 돌린다 — 에이전트 판을 올릴 때만 필요하고, 무엇을
> 밟는지는 `docs/BUMP.md` 에 있다.

버전을 올린다 — **마켓플레이스는 같은 버전을 두 번 받지 않는다.**

```bash
npm version patch   # 0.2.0 → 0.2.1   버그 수정
npm version minor   # 0.2.0 → 0.3.0   기능 추가
```

`docs/USAGE.md`도 같이 고친다. 로드맵 §0의 문서 규칙상 **각 버전의 완료 정의에
포함**된다 — 새 기능에는 `v1.1+` 같은 표기를 단다.

---

## 1. `.vsix` 파일로

```bash
npx @vscode/vsce package
```

`ai-in-one-<버전>.vsix` 가 생긴다. 설치는:

```bash
code --install-extension ai-in-one-0.1.0.vsix
```

또는 VS Code에서 `Extensions` 패널 → `⋯` → **Install from VSIX…**

**들어가는 것은 이것뿐이다** (272KB · 12개 파일):

```
extension/
├─ dist/extension.js · webview.js · webview.css   ← 번들 결과
├─ media/codicon.css · codicon.ttf · icon.png     ← 아이콘 폰트와 확장 아이콘
├─ package.json · readme.md · changelog.md · LICENSE.txt
```

`node_modules`(102MB)와 `src`는 `.vscodeignore`가 막는다. **그게 없으면 100MB짜리
확장이 된다** — esbuild로 `dist`에 번들하므로 소스도 의존성도 패키지에 있을
이유가 없다.

🔴 **`vsce package` 를 돌려 목록을 눈으로 본다.** 한동안 `.probe-out/`(41개)와
`NEXT.md` 가 **그대로 실려 나가고 있었다.** 재본 기록과 내부 메모라 남에게 줄
것이 아닌데, `.vscodeignore` 가 «실행에 필요한가» 로만 짜여 있어서 안 걸렸다.
새 폴더를 만들면 여기도 같이 본다:

```bash
npx @vscode/vsce ls --tree
```

⚠️ **확장이 작은 것과 사용자 디스크가 작은 것은 다르다.** 에이전트는 패키지에
안 들어 있고 **쓸 때 받는다**(§6). 받으면 `globalStorage` 에 쌓인다 — 이 기계:

```
claude       290MB
codex        445MB
antigravity  217MB
```

---

## 2. VS Code 마켓플레이스

### 2.1 한 번만 하는 준비

1. **Azure DevOps 조직** 만들기 — <https://dev.azure.com> (마이크로소프트 계정)
2. **Personal Access Token** 발급
   - `User settings → Personal access tokens → New Token`
   - **Organization: `All accessible organizations`** ← 이걸 틀리면 인증이 안 된다
   - **Scopes: `Marketplace → Manage`**
   - 토큰은 **한 번만 보인다.** 그때 복사한다
3. **퍼블리셔 등록** — <https://marketplace.visualstudio.com/manage>
   `package.json`의 `publisher` 값(`taein-yoon`)과 **같은 id로** 만든다

### 2.2 올릴 때마다

```bash
npx @vscode/vsce login taein-yoon    # 토큰을 묻는다. 한 번 하면 기억한다
npx @vscode/vsce publish             # package + 업로드
```

`publish`가 `vscode:prepublish`(타입 검사 + 프로덕션 빌드)를 알아서 돌린다.

올라간 뒤 상세 페이지에 뜨기까지 **몇 분** 걸린다.

---

## 3. Open VSX — Cursor · VSCodium

이들은 MS 마켓플레이스를 쓸 수 없어 **별도 레지스트리**를 본다.

**이 확장에는 여기가 오히려 중요할 수 있다** — Cursor를 쓰면서 Claude Code를
같이 쓰는 경우가 흔하다.

1. <https://open-vsx.org> 에서 GitHub으로 로그인 → 액세스 토큰 발급
2. 퍼블리셔 약관 서명 (한 번)

```bash
npx ovsx publish ai-in-one-0.1.0.vsix -p <토큰>
```

---

## 4. 아직 안 된 것

### `repository` — **지금 막고 있다**

```
ERROR  Couldn't detect the repository where this extension is published.
       The link 'docs/ROADMAP.md' will be broken in README.md
```

README가 `docs/`를 상대 경로로 가리키는데 저장소 주소가 없으면 vsce가 링크를
절대 주소로 못 바꿔서 **멈춘다.** GitHub에 올린 뒤 `package.json`에 넣는다:

```json
"repository": { "type": "git", "url": "https://github.com/<계정>/ai-in-one.git" }
```

임시로 넘기려면 `--allow-missing-repository --baseContentUrl <주소>` 를 줄 수도
있지만, **README의 링크가 깨진 채로 나간다.**

### ✅ 나머지는 넣었다 (2026-10-07)

| | |
|---|---|
| **아이콘** | `media/icon.png` — 128×128. 말풍선 하나에 점 셋(여럿이 한 방에) |
| `keywords` | `acp` · `agent-client-protocol` · `claude-code` · `codex` · `antigravity` · `ai-agent` · `chat` |
| `CHANGELOG.md` | 상세 페이지에 탭으로 뜬다 |
| `galleryBanner` | `#202228` · dark — 아이콘 바탕과 같은 색 |

아이콘은 **8배로 그려 줄였다** — 128로 바로 그리면 둥근 모서리가 계단이 된다.
작게 보일 때가 많으므로 모양은 하나만 두고(말풍선) 색은 점 셋으로만 준다.

---

## 5. 받는 쪽 — 설치법

배포한 길에 따라 설치법이 다르다. **이 절을 그대로 복사해 사용자에게 주면 된다.**

### 5.1 `.vsix` 파일을 받았다면

가장 확실한 길은 명령줄이다:

```bash
code --install-extension ai-in-one-0.1.0.vsix
```

VS Code 안에서 하려면 — `Ctrl+Shift+X`(확장 패널) → 오른쪽 위 `⋯` →
**Install from VSIX…** → 파일 선택.

Cursor·VSCodium도 같다 (`cursor --install-extension …`, `codium --install-extension …`).

> **설치 후 창을 새로 고친다** — `Ctrl+Shift+P` → `Developer: Reload Window`.
> 안 해도 대개 뜨지만, 안 뜨면 이것부터.

**업데이트**는 새 `.vsix`를 같은 방법으로 설치하면 덮어쓴다. 버전이 같으면
갱신이 안 되니 **버전을 올려서** 묶어야 한다.

**지우기**: 확장 패널에서 찾아 `Uninstall`, 또는

```bash
code --uninstall-extension taein-yoon.ai-in-one
```

### 5.2 마켓플레이스에 올렸다면

`Ctrl+Shift+X` → **`AI in One`** 검색 → `Install`. 업데이트는 VS Code가 알아서
한다.

명령줄로도 된다:

```bash
code --install-extension taein-yoon.ai-in-one
```

### 5.3 Cursor · VSCodium (Open VSX)

확장 패널에서 똑같이 검색해 설치한다. 이쪽은 **Open VSX에 올라가 있어야만**
보인다 — 마켓플레이스에만 올리면 이 편집기들에서는 검색해도 안 나온다.
그때는 `.vsix`를 직접 주는 게 답이다.

---

## 6. 설치한 다음 — **에이전트를 받는다**

> ⏪ 예전엔 여기가 *"에이전트 CLI는 사용자가 직접 깔고 로그인해야 한다"* 였다.
> **이제 아니다.** 어댑터도 그 안에 품은 CLI 도 **우리가 받는다** — 자세한
> 까닭은 `docs/INSTALL.md`.

확장만 깔면 아직 에이전트가 없다. 받는 곳은 한 군데다 — **목록 화면 위의
로봇 아이콘**. 거기서 받고·업데이트하고·로그인하고·지운다.

| 상태 | 단추 |
|---|---|
| 안 받음 | **설치하기** |
| 받음 · 핀이 올라감 | **업데이트** · 제거 |
| 받음 · 로그인 안 됨 | **로그인** · 제거 |
| 받음 · 로그인 됨 | 로그아웃 · **제거**(빨강) |

받는 자리는 `<globalStorage>/taein-yoon.ai-in-one/agents/<id>/` 다. 확장을
지우면 같이 없어진다.

### 6.1 로그인은 **여전히 사용자 것이다**

§0 P3 — **구독 토큰은 우리가 안 건드린다.** 구독을 합법적으로 쓰는 길이 공식
바이너리를 사용자 기기에서 그대로 돌리는 것이라서, 로그인은 그쪽이 한다.
우리 화면은 **문만 열어준다.**

**문은 두 가지다.** 어느 쪽인지는 그 에이전트가 정한다:

| | 어떻게 | 누가 |
|---|---|---|
| **터미널** | 품은 CLI 를 띄운다 | Claude (`claude auth login`) · Codex (`codex login`) |
| **ACP** | `authenticate` 를 부른다 — 저쪽이 브라우저를 연다 | Antigravity |

ACP 쪽은 `initialize` 응답의 `authMethods` 에 길이 적혀 있다. 여럿이면 골라
묻는다 — Antigravity 는 넷을 내놓는다(Google · Gemini Enterprise · API 키 ·
Agent Platform).

> ⚠️ **주소는 답이 아니라 stderr 로 나온다.** 브라우저는 저쪽이 직접 열지만
> 원격·컨테이너처럼 안 열리는 자리가 있다. 그 줄을 잡아 알림으로 띄운다.

🔴 **어느 쪽인지 짐작하면 안 된다.** Antigravity 는 `agy` 라는 터미널 CLI 가
**있는데도** 그 길이 아니다 — `agy` 와 ACP 서버가 **서로 다른 집을 본다**
(`antigravity-cli/` 와 `antigravity-acp/`). `agy` 로 로그인해도 세션은 계속
*"Authentication required"* 였다. 그걸 모르고 **190MB 를 로그인용으로 받고
있었다.** 지금은 안 받는다 — `docs/PIN.md` §G4-2.

**바로 할 수 없으면 창을 열어주는 데까지만 한다.** 지어내서 자동으로 만들지
않는다. `agy -i "/logout"` 으로 넘겨봤더니 슬래시로 안 풀리고 **모델에게 말로
들어가서**, 그 에이전트가 «`/logout` 이 무슨 뜻이지» 를 알아보겠다고 사용자
폴더를 뒤지기 시작했다. 자격 파일을 직접 지우는 길도 안 쓴다 — 남의 계정
파일이고, 틀리면 되돌릴 수 없다.

### 6.2 받는 쪽이 갖춰야 할 것

| | |
|---|---|
| 망 | 처음 받을 때 수백 MB |
| 그 외 | **없다** |

✅ **Node 도 우리가 받는다** (2026-10-07). 사용자가 짚었다 — *"노드 20은 이거
깔릴때 같이 깔리게는 못해?"*. CLI 를 안 깔아도 된다고 해놓고 Node 는 깔라고
하는 것은 앞뒤가 안 맞는다. 34MB 고, Codex 445MB 옆에서 티가 안 난다.

```
<globalStorage>/node/current/   ← v24.21.0 (npm 11.19.0 동봉)
```

**있어도 우리 것을 쓴다** — 받을 때도 띄울 때도 `PATH` 맨 앞에 세운다. 판이
어긋나서 생기는 일을 아예 없애려는 것이다. 못 받으면 **막지 않고** 사용자
기계의 것으로 돌아간다 — 거기서 던지면 원래 되던 사람까지 막는 셈이다.

⏪ 전엔 *"Node 20+ 가 필요하다, 다만 npm 꼴에만"* 이라고 적어뒀다. 사용자가
그 전에도 한 번 짚었다 — *"배포판 받을때 알아서 충족하게 해줘야지"*. 그때는
안내 문구만 뺐는데, 이번에 요구 자체를 없앴다.

자세한 것은 `docs/INSTALL.md`.

### 6.3 확인 순서

1. `Ctrl+Shift+P` → **`AI in One: 채팅 열기`**
2. 목록 위 **로봇 아이콘** → 쓸 에이전트에 **설치하기**
3. 받아지면 **로그인**
4. `+` 로 방 만들기 — 받은 에이전트만 고를 수 있다

안 받은 에이전트는 **목록에 안 뜬다.** 이미 그 에이전트로 만든 방을 열면
막히면서 «로봇 아이콘에서 받아주세요» 가 나온다. 그 화면에서 다른 에이전트와
모델로 **갈아탈 수도 있다** — 지난 대화를 기록째 넘길지 요약만 넘길지도 거기서
고른다.

무슨 일이 일어나는지 보려면 **출력 패널 → `AI in One` 채널**을 연다.
CLI의 stderr와 우리 진단이 전부 거기 찍힌다 (A7).

---

## 7. 배포하고 나면

**README가 첫인상이다.** 마켓플레이스 상세 페이지가 곧 README라서, 위 §6의
전제(«CLI를 직접 깔고 로그인해야 한다»)를 **맨 위에** 써야 한다.
*"왜 안 되지"의 대부분이 거기서 나온다.*

문제 제보를 받으려면 `bugs` 필드도 넣는다:

```json
"bugs": { "url": "https://github.com/<계정>/ai-in-one/issues" }
```
