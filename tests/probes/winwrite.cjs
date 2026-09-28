/**
 * **Windows에서 같은 파일에 동시 쓰기를 하면 무슨 일이 나나** (실측).
 *
 * 나는 "공유 위반으로 터진다"고 적었는데, 그건 Windows API 기본값 이야기지
 * Node 이야기가 아닐 수 있다. libuv가 CreateFileW 를 어떤 share mode 로
 * 부르느냐가 전부다.
 *
 * 두 가지를 본다:
 *   ① 에러가 나나 (공유 위반 / EBUSY / EPERM)
 *   ② 섞이나 (A 바이트와 B 바이트가 한 파일에)
 */
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MB = 1024 * 1024;
const ROUNDS = 30;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "winw-"));
  const p = path.join(dir, "api.ts");

  for (const size of [4 * 1024, 8 * MB]) {
    const A = "A".repeat(size);
    const B = "B".repeat(size);
    let errs = [];
    let mixed = 0, wonA = 0, wonB = 0, wrongLen = 0;

    for (let i = 0; i < ROUNDS; i++) {
      const rs = await Promise.allSettled([
        fs.writeFile(p, A), fs.writeFile(p, B),
      ]);
      for (const r of rs) if (r.status === "rejected") errs.push(String(r.reason.code || r.reason));

      const got = await fs.readFile(p, "utf8");
      const hasA = got.includes("A"), hasB = got.includes("B");
      if (hasA && hasB) mixed++;
      else if (hasA) wonA++;
      else if (hasB) wonB++;
      if (got.length !== size) wrongLen++;
    }

    console.log(`\n[${size >= MB ? size / MB + "MB" : size / 1024 + "KB"} 씩 동시에, ${ROUNDS}번]`);
    console.log(`  에러      : ${errs.length}건 ${errs.length ? "→ " + [...new Set(errs)].join(",") : "(없음)"}`);
    console.log(`  섞임      : ${mixed}번   ← 진짜 깨짐`);
    console.log(`  길이 이상 : ${wrongLen}번`);
    console.log(`  한쪽만 남음: A=${wonA}, B=${wonB}   ← 조용한 덮어쓰기`);
  }

  // 같은 파일을 둘이 **열어둔 채로** — 공유 위반이 난다면 여기서 난다
  console.log("\n[둘이 동시에 열어둔 채]");
  try {
    const h1 = await fs.open(p, "w");
    try {
      const h2 = await fs.open(p, "w");
      console.log("  ok - 둘 다 열렸다 → **공유 위반 없음**");
      await h2.close();
    } catch (e) { console.log("  ★ 두 번째 열기 실패:", e.code); }
    await h1.close();
  } catch (e) { console.log("  첫 열기 실패:", e.code); }

  await fs.rm(dir, { recursive: true, force: true });
}
void main();
