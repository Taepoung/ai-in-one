/**
 * **Antigravity** — 애드온 (리팩토링 ①, 2026-10-20 · `docs/REFACTOR.md`).
 *
 * 🔴 **`core/agent-api.ts` 말고는 core 를 import 하지 않는다.** 다른 에이전트도
 * 안 본다. 이 경계가 «이 에이전트만 올릴 때 펴는 곳이 한 폴더» 를 지킨다 —
 * 린트가 막는다(`eslint.config.mjs`).
 *
 * ⚠️ 지금은 `src/core/agentCatalog.ts` 에서 **그대로 옮긴** 정의다. 표준 ACP 와
 * 다른 버릇을 이 폴더로 모으는 일은 다음 걸음들이 한다(§5 ③~⑤).
 */
import * as path from "node:path";
import type { AgentDef } from "../../core/agent-api.js";
import { parseAntigravityQuota } from "./quota.js";

export const antigravity: AgentDef = {
  id: "antigravity",
  label: "Antigravity",
  description: "Google Antigravity",
  /*
   * ★ **npm 이 아니라 zip 을 받는다** (2026-10-06).
   *
   * ACP 레지스트리의 `distribution.binary` 꼴이다 — 41개 중 19개가 이쪽이고
   * Antigravity 가 그 첫 사례다. `command`·`args` 는 받은 뒤에 우리가
   * 채워 넣는다(`withInstalled`) — 받기 전엔 띄울 것이 없으므로 빈 값이다.
   *
   * ⚠️ 푸는 실행파일 이름이 플랫폼마다 다르다 — 윈도우는 `.exe`, 나머지는
   * `.par`(파이썬 묶음). 리눅스는 `--uid=` 를 더 받는다.
   *
   * 🔴 레지스트리가 **해시를 안 준다.** 받은 것이 온전한지 맞춰볼 기준이
   * 없어서, HTTPS 와 **푸는 중 크기 확인**이 지금 가진 전부다(`unzip.ts`).
   *
   * ⚠️ **로그인 명령은 안 적었다.** 어떤 길인지 안 재봤고, 지어내면
   * 엉뚱한 걸 부르게 된다(`codex-code-mode-host` 전적).
   */
  command: "",
  args: [],
  /*
   * ★ **지울 명령이 없어서 파일을 지운다** (2026-10-12 실측).
   *
   * 🔴 여덟 이름을 두드려 봤다 — `delete`·`remove`·`discard`·`end`·
   * `archive`·`conversation/delete`·`conversation/remove` 전부 없고,
   * 되는 것은 `close`·`list`·`resume` 셋뿐이다(`probes/agymethods.cjs`).
   * `agy` CLI 에도 서브커맨드가 없고 **다른 집**을 본다(§G4-2).
   *
   * 안 지우면 **대화 전문이 평문으로 남는다** — 지운 뒤에도
   * `transcript.jsonl` 에 사용자가 친 말이 그대로 있었다
   * (`probes/agydelete.cjs`).
   *
   * 세션 하나가 파일 **다섯**을 만든다 — 폴더 하나와 sqlite 넷
   * (`-shm`·`-wal` 은 sqlite 가 쓰다 남기는 짝이라 같이 지운다).
   */
  purgeFiles: {
    home: "~/.gemini/antigravity-acp",
    paths: [
      "brain/{id}",
      "conversations/{id}.db",
      "conversations/{id}.db-shm",
      "conversations/{id}.db-wal",
      "conversations/{id}.meta",
    ],
  },
  pkg: {
    /*
     * ★ **받는 것은 zip 하나다** (2026-10-07).
     *
     * ⏪ 한때는 둘이었다. ACP zip 에는 서버뿐이고 CLI 는 따로
     * 나오므로(`agy`, 190MB), Claude·Codex 처럼 **로그인은 CLI 가
     * 한다** 고 보고 같이 받았다.
     *
     * 🔴 **그 전제가 틀렸다.** `agy` 와 ACP 서버는 **서로 다른 집을
     * 본다** — `antigravity-cli/` 와 `antigravity-acp/`. 그래서 `agy` 로
     * 로그인해도 세션은 계속 막혔다(§G4-2). 로그인도 로그아웃도
     * 모델 목록도 전부 **ACP 가 한다.**
     *
     * 직접 재봤다 — `agy.exe` 를 치워놓고도 `session/new` 가 붙고
     * 모델 11개가 그대로 온다. §0 P3 도 지켜진다 — **구독을 쓰는
     * 공식 바이너리는 `agy_acp_server` 자신**이고, 그걸 사용자 기계에서
     * 그대로 돌린다. Claude·Codex 는 어댑터가 **품은 CLI 를 제 손으로
     * 띄우므로** 그쪽은 CLI 가 실행 경로 위에 있다 — 구조가 다르다.
     *
     * ```
     * 뺀 것   agy.exe                   190MB
     * 남는 것 agy_acp_server.exe         81MB   ← 띄우는 것
     *          localharness_external.exe 145MB   ← 같은 zip 에 들어 있다
     * ```
     *
     * ⚠️ `localharness_external` 은 **구글이 같은 묶음에 넣어 보내는 것**이라
     * 그대로 둔다. 무엇을 하는지 우리는 모르고, 묶음을 통째로 받는 것이
     * 원칙이다(§G4) — **받는 것과 그 안에 든 것은 우리가 고르지 않는다.**
     *
     * ⚠️ **이미 받아둔 기계에는 `agy.exe` 가 남는다.** 낡음 판단은 zip
     * 주소만 보므로 «업데이트» 가 뜨지 않는다. 다음에 핀을 올리면
     * 받기 전에 자리를 비우므로(`fetchBinary`) 저절로 사라진다. 당장
     * 비우려면 제거 → 설치하기다.
     */
    binary: {
      "win32-x64": {
        archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip",
        cmd: "agy_acp_server.exe",
      },
      "win32-arm64": {
        archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-arm64.zip",
        cmd: "agy_acp_server.exe",
      },
      "darwin-arm64": {
        archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-arm64.zip",
        cmd: "agy_acp_server.par",
      },
      "darwin-x64": {
        archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-x86_64.zip",
        cmd: "agy_acp_server.par",
      },
      "linux-x64": {
        archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip",
        cmd: "agy_acp_server.par",
        args: ["--uid="],
      },
      "linux-arm64": {
        archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-arm64.zip",
        cmd: "agy_acp_server.par",
        args: ["--uid="],
      },
    },
    auth: {
      /*
       * 🔴 **`agy` 로 로그인해도 세션은 안 붙는다** (2026-10-07).
       *
       * 사용자가 봉착했다 — *"antigravity에 로그인해도 세션이
       * 안붙고 모델도 파악 불가임"*. 재보니 **둘이 서로 다른 집을
       * 본다:**
       *
       * ```
       * agy (CLI)       ~/.gemini/antigravity-cli/
       * agy_acp_server  ~/.gemini/antigravity-acp/settings.json   status=missing
       * ```
       *
       * 그래서 `agy` 로 아무리 로그인해도 `session/new` 는
       * *"Authentication required"* 로 막혔다. 저쪽이 직접 시킨 길은
       * **ACP 의 `authenticate`** 다 — 부르면 브라우저를 열고 주소도 뿜는다.
       *
       * ⚠️ **이제 `agy` 는 로그인과 상관없다.** 190MB 를 그것 때문에
       * 받고 있었는데 그 것이 아니었다. `agy models` 가 모델 목록을
       * 내주긴 하나, 그것도 ACP 세션이 붙으면 거기서 나온다 —
       * 붙는 걸 본 뒤에 뺌지 말지 정한다.
       */
      acp: true,
      /*
       * 🔴 **집이 있는 것과 들어가 있는 것은 다르다** (2026-10-07).
       *
       * 처음엔 `antigravity-cli/settings.json` 을 봤다 — 로그아웃해도
       * 그대로 있어서 단추가 안 바뀜다. 그래서 ACP 서버의 집으로
       * 옮겼는데 **그것도 틀렸다** — 사용자가 다시 짚었다
       * (*"안티그래비티 로그아웃이 안됨"*).
       *
       * 그 집은 **서버를 띄우기만 해도 생긴다.** 시작하면서
       * `settings.json` 을 써버리므로, 로그인을 한 적이 없어도
       * «들어가 있다» 가 된다 — 그 상태로 로그아웃을 눌러봤자
       * 지울 것도 없으니 **아무 일도 안 일어난다.**
       *
       * 진짜 자격은 여기다. 로그아웃이 지우는 것도 바로 이것이다:
       *
       * ```
       * credential_store.py: Cleared credential file at
       *   C:/Users/.../.gemini/antigravity-acp/acp_token.json
       * ```
       *
       * ⚠️ 기업 계정(`oauth-business`)은 `acp_business_token.json` 으로
       * 따로 간다. 지금은 개인 계정만 본다 — 둔 걸 본 적이 없어
       * 지어내지 않는다.
       */
      file: path.join(".gemini", "antigravity-acp", "acp_token.json"),
    },
  },
  // ★ 잔량 — 모델 묶음마다 «남은 양» (뜯기는 ./quota.ts)
  quota: { commands: ["usage"], parse: parseAntigravityQuota },
  // ★ 우리 도구는 **`_meta.mcp`** 로 안다 — 이름은 `ai-in-one_say` 꼴이라 못 쓴다 (리팩토링 ⑤)
  mcpIdentity: "meta",
};
