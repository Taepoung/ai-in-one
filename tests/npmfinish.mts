/**
 * **npm 이 요약을 찍고도 안 끝날 때** (사용자, 2026-10-23: *"코덱스 설치중 added 25 packages in
 * 9s에 멈춤"*).
 *
 * «added N packages in Ns» 는 npm 이 **일을 마치고** 찍는 줄이다. 그 뒤로 끝났다는 신호가 안
 * 와 화면이 거기 멈췄다. 이제 요약을 찍고 조용하면 마무리한다 — 정말 받아졌는지는 `install`
 * 이 따로 본다. 그리고 npm 의 «새 판 있나» 확인을 끈다(망에 붙잡히던 유력한 자리).
 *
 * 가짜 npm(요약을 찍고 영영 안 끝나는 스크립트)을 꽂아 잰다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { spawnRun } from "../src/core/install/agentInstaller.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-npmfinish-"));
  // 받는 척 — 몇 줄 찍고, 요약을 찍고, 영영 안 끝난다. 새 판 확인 설정이 꺼졌는지도 적는다
  const hang = path.join(dir, "fake-npm.cjs");
  await fs.writeFile(hang, [
    'console.log("npm warn deprecated 어떤 꾸러미");',
    'console.log("added 25 packages in 9s");',
    'console.log("update_notifier=" + process.env.npm_config_update_notifier);',
    "setInterval(() => {}, 1 << 30);",
  ].join(NL));
  const done = path.join(dir, "fake-npm-ok.cjs");
  await fs.writeFile(done, 'console.log("added 25 packages in 9s"); process.exit(0);');

  console.log(`${NL}[★ 요약을 찍고 안 끝나면 — 마무리한다]`);
  {
    const lines: string[] = [];
    const t0 = Date.now();
    const r = await spawnRun("node", [hang], 800)(["install"], dir, (l) => lines.push(l));
    const took = Date.now() - t0;
    ok(r.code === 0, `★ **멈추지 않고 돌아온다** (code ${r.code})`);
    ok(took < 5000, `★ 요약 뒤 끝(0.8초)쯤에 (${took}ms)`);
    ok(/마무리했습니다/.test(r.say), "★ 마무리했다는 것을 적는다 — 출력 창에 남는다");
    ok(lines.includes("update_notifier=false"), `★ **새 판 확인을 껐다** (${lines.find((l) => l.startsWith("update_notifier"))})`);
  }

  console.log(`${NL}[★ 제대로 끝나면 — 기다리지 않는다]`);
  {
    const t0 = Date.now();
    const r = await spawnRun("node", [done], 10_000)(["install"], dir);
    ok(r.code === 0 && !/마무리했습니다/.test(r.say), "★ 그대로 끝난 것으로");
    ok(Date.now() - t0 < 5000, `★ 끝을 기다려 주는 시간을 안 쓴다 (${Date.now() - t0}ms)`);
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과`);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
