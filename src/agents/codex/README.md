# Codex

> 2026-10-20 리팩토링 §6 에서 문서를 에이전트별로 나눴다. **절 이름(§A · §F4 · §G6 …)은
> 옮기기 전 그대로**라 옛 링크(`PIN.md §G6` 같은)는 그 파일의 지도로 한 번 건너면 닿는다.
> 이 문서: Codex 의 핀과 엔진 · 세션 뒷정리 (옛 PIN §F4~F7)

세션 뒷정리가 **왜** 조용히 깨지는지(§F1~F3)는 셋에 걸리는 이야기라
`src/agents/README.md` 에 있다.

## F4. ✅ `codex-acp` 에도 핀을 박았다 — **엔진까지** (2026-10-01)

사용자 지시: *"codex에 핀도 박아"*, 이어서 *"codex는 핀을 못박아? 범위로만
박을 수 있어?"*.

**범위로만 박히는 게 아니다.** 처음엔 어댑터만 지명해서 엔진이 저쪽
package.json 의 `^0.159.1` 을 따라 움직였는데, **엔진도 같이 지명하면
그걸 쓴다**:

```ts
const CODEX_PIN = [
  "-p", "@agentclientprotocol/codex-acp@2.1.0",
  "-p", "@openai/codex@0.159.3",
];
```

npm 이 둘을 호이스팅해 한 본만 두고, 어댑터의 범위는 그 한 본으로 충족된다.
중첩 복사본이 안 생기는 것까지 봤다. 일부러 `0.159.2` 로 낮춰서 그게
실제로 집히는 것도 확인했다.

범위가 글이 아니라는 증거는 이 기계에 실물로 있었다 — **같은 2.1.0 을
받아둔 자리 둘의 엔진이 각각 0.159.2 와 0.159.3** 이었다.

⏪ **「핀 아래의 모델」이라고 적었던 것을 무른다** (2026-10-06).

여기에 네 개를 적어뒀었다. 닷새 뒤 **같은 핀·같은 엔진**으로 다시 재니
세 개였다:

```
2026-10-01   6 Luna · 5.6 Terra · 5.6 Luna · 5.5
2026-10-06   6 Luna · 5.6 Terra · 5.6 Luna
```

🔴 **Codex 는 모델 표를 바이너리에 안 박는다 — 서버에서 받아온다.**
`~/.codex/models_cache.json` 이 그것이고 `fetched_at`·`etag`·`identity` 를
달고 있다. 모델마다 `visibility` 가 있는데 `gpt-5.5` 가 `list` 에서
`hide` 로 바뀌었다. 새 판(2.1.1 · 0.160.1)으로도 목록은 같았다.

그러니 **Codex 에는 «핀이 곧 모델 판» 이 성립하지 않는다.** 그건 Claude
이야기다(§A — 모델 표가 `claude.exe` 안에 박힌다). 여기에 목록을 적어두면
**그날 그 계정이 본 것**을 영구 사실처럼 남기게 되므로, 적지 않는다.
알고 싶으면 그때 `codexmodels.cjs` 를 돌린다.

⚠️ **두 지명은 반드시 같은 줄에서 나와야 한다.** npx 는 «지명한 글자열»로
받아둔 자리를 가른다. 한 글자라도 다르면 **다른 자리를 새로 만들고**, 그건
방을 나가는 도중에 445MB 를 받는다는 뜻이다. 그래서 `CODEX_PIN` 상수다.

💾 자리당 **445MB**. 핀을 올리면 옆에 하나 더 생기고 옛 자리는 안 지워진다
(이 기계에 15자리 · 3.7GB). 치우려면 `~/AppData/Local/npm-cache/_npx` 의
낡은 자리를 지운다.

## F5. ✅ 뒷정리도 **어댑터가 품은 `codex`** 를 부른다 (2026-10-01)

사용자 물음: *"어댑터에 있는 exe에 접근해서 cli로 지우거나 할 수는
없는건가"*.

된다. 그리고 **그렇게 해야 맞았다.** 예전엔 PATH 의 `codex` 를 불렀는데
그건 세션을 만든 엔진과 다른 판이었다:

```
어댑터가 도는 엔진   0.159.3   ← 이게 세션을 만들었다
사용자 PATH 의 codex  0.155.0   ← 그걸 지우라고 시켰다
```

넷 판 차이로 **우연히** 돌고 있었다. 낡으면 `--force` 가 없고, 새로우면
저장 자리가 옮겨가 엔진이 쓴 세션을 못 보고, 아예 안 깔린 사람도 있다.

`npx -p` 는 받아둔 꾸러미에서 **다른 명령을 골라 띄울 수 있다.** 그래서
경로를 한 글자도 안 적고 그 exe 를 부른다:

```
npx -y -p …codex-acp@2.1.0 -p @openai/codex@0.159.3 codex delete --force <id>
```

재보니 1초다 — 방을 나갈 때는 방금 그 어댑터를 띄운 뒤라 캐시가 항상
덥다. 들어 있는 exe 는 310MB 짜리
(`@openai/codex-win32-x64/vendor/…/bin/codex.exe`)이고 `--version` 이
0.159.3 로 어댑터 엔진과 같다.

**이제 사용자 기계에 `codex` 가 없어도 뒷정리가 된다.** §F1 의 로그는
그대로 둔다 — 이 길도 깨질 수 있고, 깨지면 여전히 조용하면 안 된다.

---


## F6. ✅ 그런데 **`npx` 길이 남아 있었다** (2026-10-07)

> 사용자: *"세션 지우는거 로직 다시 확인 한번 해보고"*. 보니 §F5 의 결론이
> 반만 반영돼 있었다.

우리 자리에 직접 받기로 하면서(`docs/core/install.md`) `withInstalled` 가
`command`·`args`·`env` 를 갈아끼운다. 그런데 **`purgeSession` 은 안 건드렸다.**
그래서 방을 나갈 때마다

```
받아둔 codex.exe 를 두고   npx 가 따로 받은 판을 돌렸다
```

§F5 가 고쳤다고 적어둔 바로 그 모양이 **다른 문으로 돌아와 있었다.** 망이
없으면 그냥 실패하고, 있으면 445MB 를 또 받는다.

이제 `AgentPackage.purge` 에 적고 `withInstalled` 가 **받은 자리의 실행파일로**
바꿔 단다:

```
purge: { find: CODEX_EXE, args: ["delete", "--force", "{id}"] }
→ …/agents/codex/node_modules/@openai/codex-win32-x64/vendor/…/codex.exe delete --force {id}
```

⚠️ **`AgentDef` 에 적힌 것은 `withInstalled` 를 안 거친다.** 받아두는 것과
띄우는 것을 나눠놓은 구조라, 그런 칸을 더할 때마다 **둘 다 손대야 한다.**

## F7. 🔴 **`app-server` 가 떠 있으면 못 지운다** (2026-10-07)

남은 세션을 정리하다 걸렸다. `codex delete --force <id>` 가 계속 이랬다:

```
Error: failed to delete session      (종료코드 1)
```

잠금인가 싶어 셋 다 열어봤는데 **안 잠겨 있었다** — sqlite 둘 다 `BEGIN
IMMEDIATE` 가 통과했고 롤아웃 파일도 `r+b` 로 열렸다. 범인은 따로 있었다:

```
codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled
  ← …/.vscode/extensions/openai.chatgpt-…/bin/…/codex.exe
```

사용자의 **ChatGPT VS Code 확장**이 띄운 데몬이고 우리 것이 아니다. 그걸
내리자마자 `Deleted session …` 이 떴다.

⚠️ **확장을 끄는 것만으로는 안 내려간다.** «shared local app-server» 라
확장을 disable 해도 프로세스가 남는다. 직접 내려야 한다.

그래서 **우리 뒷정리는 사용자가 Codex 쪽 확장을 쓰고 있으면 실패할 수 있다.**
막을 길은 없다 — 남의 프로세스를 우리가 내릴 일은 아니다. 다만 §F1 의 로그가
여전히 값을 한다는 것이 여기서 확인됐다:

```
실패하면 종료코드 1 → 출력 패널에 명령과 까닭이 그대로 찍힌다
```

⏪ 중간에 «파일이 잠긴 것 같다» 고 적을 뻔했다. 재보니 아니었다 —
**짐작을 적기 전에 열어보는 것**이 여기서 값을 했다.


---

## 올릴 때

밟는 순서와 점검표는 **셋이 같다** — `src/agents/README.md` 의 «에이전트를 올릴 때».

올릴 때 Codex 만 하나 더 — 모델 목록과 세 판이 벌어진 폭을 본다:

```
node tests/probes/codexmodels.cjs
```

## 슬래시

### Codex — 28개 (바탕 11 + 꽂은 것 17)

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
