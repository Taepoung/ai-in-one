/**
 * **로그인 문이 실제로 열리나** (2026-10-02).
 *
 * 사용자 물음: *"우리가 claude나 codex를 미리 로그인 안해놓으면 못쓴다는거
 * 아님? 확인좀"*.
 *
 * 맞다 — 로그인은 반드시 필요하다. 다만 **미리 해둘 필요는 없고** 우리
 * 화면에서 열어주면 된다. 그 «열어주는» 길이 진짜로 되는지를 잰다.
 *
 * ⚠️ **로그아웃은 안 해본다.** 사용자의 자격을 날리면 안 되므로, 명령이
 * 잡히고 뜨는 것까지만 본다. 진짜 로그인 흐름(브라우저·코드 붙여넣기)은
 * 사람이 한 번 밟아야 한다.
 */
import * as os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { DEFAULT_AGENTS } from "../../src/core/agentCatalog.js";
import { dirFor, cmdPath, statusOf } from "../../src/core/agentInstaller.js";

const mark = (c: boolean, m: string) => { console.log(`  ${c ? "OK" : "NO"} -`, m); return c; };
const ROOT = os.homedir() + "/AppData/Roaming/Code/User/globalStorage/taein-yoon.ai-in-one";

const out: boolean[] = [];
for (const a of DEFAULT_AGENTS) {
  if (!a.pkg) continue;
  console.log(`\n[${a.label}]`);
  const dir = dirFor(ROOT, a.id);
  if (!statusOf(dir, a.pkg).installed) { console.log("   안 받아져 있다 — 건너뛴다"); continue; }

  for (const what of ["login", "logout"] as const) {
    const cmd = what === "login" ? a.pkg.auth?.login : a.pkg.auth?.logout;
    if (!cmd) { out.push(mark(false, `★ ${what} 명령이 안 적혀 있다`)); continue; }
    const found = cmdPath(dir, cmd);
    out.push(mark(found !== undefined, `★ ${what} 명령을 찾는다`));
    if (!found) continue;
    console.log(`   …${found.exe.slice(-40)} ${found.args.join(" ")}`);

    /*
     * `--help` 로만 띄운다. 진짜로 부르면 **로그인 창이 뜨거나 자격이 날아간다.**
     * 여기서 보려는 것은 «그 서브커맨드가 있고 실행된다» 까지다.
     */
    let ok = false, say = "";
    try {
      say = execFileSync(found.exe, [...found.args, "--help"],
        { encoding: "utf8", shell: true, timeout: 120000 }).trim();
      ok = say.length > 0;
    } catch (e) {
      say = String((e as { message?: string }).message ?? e).slice(0, 120);
    }
    out.push(mark(ok, `★ ${what} 이 실제로 뜬다 (${say.split("\n")[0]?.slice(0, 48)})`));
  }

  /* 지금 상태를 CLI 에게 직접 물어본다 — 파일 존재보다 이쪽이 참말이다 */
  const status = a.id === "claude"
    ? { bin: cmdPath(dir, { find: "node_modules/@anthropic-ai/claude-agent-sdk-*/claude*", args: ["auth", "status"] }) }
    : { bin: cmdPath(dir, { bin: "codex", args: ["login", "status"] }) };
  if (status.bin) {
    try {
      /*
       * 🔴 **stdout 만 읽으면 Codex 는 빈 글을 준다** (2026-10-02).
       *
       * `codex login status` 는 *"Logged in using ChatGPT"* 를 **stderr** 로 쓴다.
       * 처음엔 비었다고 읽고 «못 물었다» 로 판정했는데, 터미널엔
       * 멀줩히 찍힐있었다. 나중에 이걸 제품에서 쓰면 **로그인된 사람을
       * 로그아웃된 것으로** 보게 된다.
       */
      const r = spawnSync(status.bin.exe, status.bin.args,
        { encoding: "utf8", shell: true, timeout: 120000 });
      const said = `${r.stdout ?? ""} ${r.stderr ?? ""}`.trim();
      const line = said.replace(/\s+/g, " ").slice(0, 90);
      out.push(mark(said.length > 0, `★ CLI 가 로그인 상태를 말해준다 (${line})`));
    } catch (e) {
      out.push(mark(false, `★ 상태를 못 물었다 — ${String((e as { message?: string }).message).slice(0, 80)}`));
    }
  }
}
console.log(`\n  ${out.filter(Boolean).length}/${out.length}`);
