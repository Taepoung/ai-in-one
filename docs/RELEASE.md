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
npm run typecheck && npm run lint && npm run build
```

그리고 **테스트 스위트를 전부 돌린다.** 스크래치패드의 `*.mts`(코어) ·
`shell.cjs`(가짜 vscode) · `webview.mjs`(jsdom + 실제 번들).

버전을 올린다 — **마켓플레이스는 같은 버전을 두 번 받지 않는다.**

```bash
npm version patch   # 0.1.0 → 0.1.1   버그 수정
npm version minor   # 0.1.0 → 0.2.0   기능 추가
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

**들어가는 것은 이것뿐이다** (약 226KB · 10개 파일):

```
extension/
├─ dist/extension.js · webview.js · webview.css   ← 번들 결과
├─ media/codicon.css · codicon.ttf                 ← 아이콘 폰트
├─ package.json · readme.md · LICENSE.txt
```

`node_modules`(102MB)와 `src`는 `.vscodeignore`가 막는다. **그게 없으면 100MB짜리
확장이 된다** — esbuild로 `dist`에 번들하므로 소스도 의존성도 패키지에 있을
이유가 없다.

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

### 있으면 좋은 것

| | 왜 |
|---|---|
| **아이콘** 128×128 PNG | 없으면 기본 아이콘이라 목록에서 안 띈다. `"icon": "media/icon.png"` |
| `keywords` | 검색에 걸리려면 — `acp` · `claude-code` · `codex` · `ai-agent` |
| `CHANGELOG.md` | 상세 페이지에 탭으로 뜬다 |
| `galleryBanner` | 상세 페이지 배경색 |

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

## 6. 설치한 다음 — **여기서 대부분 막힌다**

확장만 깔면 아무것도 안 된다. **에이전트 CLI는 사용자가 직접 깔고 로그인해야
한다.** 우리가 대신 할 수 없다 (§0 P3 — 구독을 합법적으로 쓰는 유일한 길이
공식 CLI를 사용자 기기에서 그대로 돌리는 것이라서).

| 에이전트 | 사용자가 할 일 |
|---|---|
| **Claude Code** | 터미널에서 `claude` 를 실행해 설치·로그인 |
| **Codex** | 터미널에서 `codex` 를 실행해 설치·로그인 |

**터미널에서 한 번 직접 실행해 로그인까지 끝내는 게 핵심이다.** 그 뒤에야
확장에서 방을 만들 수 있다.

> **우리가 띄우는 건 CLI 자체가 아니라 ACP 어댑터다** — `npx -y
> @agentclientprotocol/claude-agent-acp` 같은 것(`src/core/agentCatalog.ts`).
> 어댑터는 `npx`가 알아서 받아오지만, **로그인 상태는 CLI 것을 쓴다.**
> 그래서 «어댑터는 받아졌는데 로그인이 안 됐다»가 가능하고, 그때
> `auth_required`로 막힌다.
>
> 명령이나 플래그가 바뀌면 설정으로 덮어쓸 수 있다 — `aiInOne.agents`.

확인 순서:

1. 터미널에서 `claude` 를 쳐서 뜨는지
2. VS Code에서 `Ctrl+Shift+P` → **`AI in One: 채팅 열기`**
3. `+` 로 방을 만들 때 에이전트 목록에 나오는지

안 나오면 **방 만들기 화면에 설치 안내가 뜬다**(A8). 로그인이 안 된 경우엔
방을 만들 때 *"터미널에서 해당 CLI로 먼저 로그인하세요"* 가 나온다(A6).

> ⏳ `npx`로 CLI를 처음 받으면 **수십 초** 걸린다. 멈춘 게 아니라
> «처음 시작하는 중입니다» 안내가 뜬다 (A9).

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
