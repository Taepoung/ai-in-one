/**
 * 통쓰기는 안 섞였다. 그럼 **나눠 쓰면** 섞이나?
 *
 * `fs.writeFile(전체)` 는 OS 한 번 호출이라 NTFS가 알아서 줄 세운다.
 * 그런데 스트림이나 «열고-조금씩-쓰기»는 호출이 여러 번이라 사이가 벌어진다.
 */
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function chunked(p, ch, n) {
  const h = await fs.open(p, "w");
  for (let i = 0; i < n; i++) {
    await h.write(ch.repeat(4096));
  }
  await h.close();
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winw2-"));
  const p = path.join(dir, "api.ts");
  let mixed = 0, err = 0;
  const N = 30;

  for (let i = 0; i < N; i++) {
    const rs = await Promise.allSettled([chunked(p, "A", 40), chunked(p, "B", 40)]);
    for (const r of rs) if (r.status === "rejected") err++;
    const got = await fs.readFile(p, "utf8");
    if (got.includes("A") && got.includes("B")) mixed++;
  }
  console.log(`[나눠 쓰기 (4KB x 40번씩) 동시에, ${N}번]`);
  console.log(`  에러 : ${err}건`);
  console.log(`  ★ 섞임 : ${mixed}번  ← 여기서는 진짜로 깨진다`);

  await fs.rm(dir, { recursive: true, force: true });
}
void main();
