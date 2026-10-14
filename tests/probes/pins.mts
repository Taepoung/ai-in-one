/**
 * ★ **못 돌려보는 OS 의 칸을 글로라도 맞춰본다** (2026-10-14).
 *
 * mac 은 우리 기계에서 **어떤 길로도 못 잰다** — 도커는 호스트 커널을 함께
 * 쓰고(리눅스뿐), 저장소가 안 올라가 있어 CI 의 맥 러너도 못 쓴다.
 *
 * 리눅스를 돌리면서 **공통 길은 전부 밟혔다**(tar 로 풀기 · chmod +x · POSIX
 * 경로). 그래서 mac 전용으로 남는 것은 **카탈로그의 글자**뿐이다:
 *
 * ```
 * NODE_PIN.at["darwin-*"]   주소와 sha256
 * binary["darwin-*"]        주소와 푸는 실행파일 이름(.par)
 * ```
 *
 * 돌려보는 것과 같지는 않지만 **「주소가 틀렸다」·「해시가 틀렸다」·「칸이
 * 빠졌다」는 여기서 다 걸린다** — 그 셋이 못 돌려본 OS 에서 제일 흔한 사고다.
 *
 * ```
 * npx tsx tests/probes/pins.mts
 * ```
 *
 * 🔴 **손으로 돌린다** — 망을 탄다. 판을 올린 날과 「한 달에 한 번」이 그 자리다
 * (`adapter-pin-is-the-model`).
 */
import { DEFAULT_AGENTS, NODE_PIN } from "../../src/core/agentCatalog.js";

const mark = (okay: boolean) => (okay ? "OK" : "🔴");
let bad = 0;

/** 우리가 돈다고 말하는 자리들 — 하나라도 비면 그 기계에선 못 쓴다 */
const HOSTS = [
  "win32-x64", "win32-arm64",
  "darwin-x64", "darwin-arm64",
  "linux-x64", "linux-arm64",
] as const;

async function main(): Promise<void> {
  console.log(`\n[Node ${NODE_PIN.version} — 주소와 해시]`);
  /*
   * nodejs.org 가 판마다 `SHASUMS256.txt` 를 준다. **우리가 적어둔 해시를
   * 거기와 맞춰본다** — 틀리면 그 기계에서 받기가 통째로 막히는데, 그 사실을
   * 그 기계에서만 알 수 있다.
   */
  const sums = await fetch(`https://nodejs.org/dist/v${NODE_PIN.version}/SHASUMS256.txt`);
  if (!sums.ok) {
    console.log(`  🔴 SHASUMS256.txt 를 못 받았다 (${sums.status})`);
    bad++;
  } else {
    const real = new Map<string, string>();
    for (const line of (await sums.text()).split("\n")) {
      const [hash, name] = line.trim().split(/\s+/);
      if (hash && name) real.set(name, hash);
    }
    for (const host of HOSTS) {
      const at = NODE_PIN.at[host];
      if (!at) { console.log(`  🔴 ${host} — 칸이 비었다`); bad++; continue; }
      const file = at.url.split("/").pop()!;
      const want = real.get(file);
      const same = want === at.sha256;
      if (!same) bad++;
      console.log(`  ${mark(same)} ${host.padEnd(14)} ${file}`);
      if (!same) console.log(`       적어둔 것 ${at.sha256}\n       진짜    ${want ?? "(목록에 없다)"}`);
    }
  }

  console.log(`\n[에이전트 꾸러미 — 주소가 살아 있나]`);
  for (const agent of DEFAULT_AGENTS) {
    const table = agent.pkg?.binary;
    if (!table) continue;
    for (const host of HOSTS) {
      const at = table[host];
      if (!at) { console.log(`  🔴 ${agent.id} ${host} — 칸이 비었다`); bad++; continue; }
      /*
       * HEAD 로 묻는다 — **받지는 않는다.** Antigravity 는 398MB 라 여섯 번
       * 받으면 2GB 다. 여기서 알고 싶은 것은 「그 주소가 있나」 뿐이다.
       */
      let okay = false;
      let say = "";
      try {
        const res = await fetch(at.archive, { method: "HEAD", redirect: "follow" });
        okay = res.ok;
        say = `${res.status} · ${mb(res.headers.get("content-length"))}`;
      } catch (err) {
        say = err instanceof Error ? err.message : String(err);
      }
      if (!okay) bad++;
      console.log(`  ${mark(okay)} ${agent.id.padEnd(12)} ${host.padEnd(14)} ${at.cmd.padEnd(22)} ${say}`);
    }
  }

  console.log(`\n${bad === 0 ? "전부 맞는다" : `🔴 ${bad}군데가 어긋난다`}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

function mb(len: string | null): string {
  const n = Number(len ?? 0);
  return n > 0 ? `${(n / 1048576).toFixed(0)}MB` : "크기 모름";
}

main().catch((e) => { console.error(e); process.exit(1); });
