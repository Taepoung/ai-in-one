/**
 * **zip 을 Node 안에서 푼다** (2026-10-06).
 *
 * Antigravity 는 npm 이 아니라 **zip 을 내려받는** 꼴이라(ACP 레지스트리의
 * `distribution.binary`) 푸는 길이 필요했다.
 *
 * 🔴 바깥 도구에 안 기댄다. `tar` 는 윈도우(bsdtar)에선 zip 을 풀지만
 * **GNU tar 는 못 푼다.** `unzip` 도 리눅스에 늘 있지 않다 — 기계마다
 * 있는 것이 달라서, 없으면 **설치가 통째로 막힌다.**
 *
 * 재는 것:
 *
 * ```
 * ① 눌린 것·안 눌린 것 다 푼다
 * ② 폴더 안의 파일도 자리를 만들어 푼다
 * ③ **바깥을 가리키면 거절한다** (zip-slip)
 * ④ 깨진 것은 깨졌다고 말한다
 * ```
 *
 * ③이 핵심이다. 압축파일 속 이름은 **남이 정한 것**이라 `../../` 가 들어
 * 있을 수 있고, 그대로 쓰면 우리 자리 밖에 파일을 쓴다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path";
import * as fs from "node:fs"; import * as fsp from "node:fs/promises";
import * as zlib from "node:zlib";
import { unzip } from "../src/core/unzip.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

/** 손으로 zip 하나를 만든다 — 만드는 쪽은 제품에 없으므로 여기서 짓는다 */
function makeZip(entries: Array<{ name: string; body: string; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.body, "utf8");
    const packed = e.store ? raw : zlib.deflateRawSync(raw);
    const crc = 0; // 우리는 안 본다

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(e.store ? 0 : 8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(packed.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, packed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.store ? 0 : 8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(at, 42);
    cens.push(cen, name);
    at += 30 + name.length + packed.length;
  }
  const body = Buffer.concat(locals);
  const dir = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-zip-"));
  const zipAt = path.join(dir, "a.zip");
  const out = path.join(dir, "out");

  console.log("\n[★ 눌린 것도 안 눌린 것도 푼다]");
  {
    fs.writeFileSync(zipAt, makeZip([
      { name: "bin/agy_acp_server.exe", body: "실행파일인 척" },
      { name: "note.txt", body: "짧다", store: true },
      { name: "deep/", body: "" },
      { name: "deep/inside.txt", body: "x".repeat(5000) },
    ]));
    const n = unzip(zipAt, out);
    console.log(`   푼 파일 ${n}개`);
    ok(n === 3, `★ 폴더 항목은 안 센다 (${n})`);
    ok(fs.readFileSync(path.join(out, "bin", "agy_acp_server.exe"), "utf8") === "실행파일인 척",
       "★ **폴더 안의 것도 자리를 만들어 푼다**");
    ok(fs.readFileSync(path.join(out, "note.txt"), "utf8") === "짧다",
       "★ 안 눌린 항목(method 0)도 푼다");
    ok(fs.readFileSync(path.join(out, "deep", "inside.txt"), "utf8").length === 5000,
       "★ 눌린 항목이 원래 크기로 돌아온다");
  }

  console.log("\n[★ 바깥을 가리키면 거절한다 — zip-slip]");
  {
    for (const bad of ["../밖에.txt", "a/../../밖에.txt"]) {
      fs.writeFileSync(zipAt, makeZip([{ name: bad, body: "나쁜 것" }]));
      let said = "";
      try { unzip(zipAt, path.join(dir, "guard")); } catch (e) { said = (e as Error).message; }
      console.log(`   ${bad} → ${said || "(안 막혔다)"}`);
      ok(said.includes("바깥"), `★ **${bad} 를 막는다** — 안 막으면 우리 자리 밖에 쓴다`);
    }
    ok(!fs.existsSync(path.join(dir, "\ubc16\uc5d0.txt")), "★ 실제로 아무것도 안 나갔다");
  }

  console.log("\n[★ 깨진 것은 깨졌다고 말한다]");
  {
    fs.writeFileSync(zipAt, Buffer.from("zip 이 아니다"));
    let said = "";
    try { unzip(zipAt, out); } catch (e) { said = (e as Error).message; }
    ok(said.includes("zip 이 아닙니다"), `★ 조용히 빈 손으로 끝내지 않는다 (${said})`);

    /* 크기가 안 맞으면 — 받다 만 파일이 이 꼴이다 */
    const good = makeZip([{ name: "x.txt", body: "열글자짜리입" }]);
    /* 끝 표시가 «중앙 목록이 어디서 시작하나» 를 들고 있다 — 거기서 센다 */
    const dirAt = good.readUInt32LE(good.length - 22 + 16);
    good.writeUInt32LE(99999, dirAt + 24);
    fs.writeFileSync(zipAt, good);
    said = "";
    try { unzip(zipAt, path.join(dir, "o2")); } catch (e) { said = (e as Error).message; }
    ok(said.includes("크기"), `★ **푼 크기가 다르면 멈춘다** — 받다 만 것을 성공으로 치면 안 된다 (${said})`);
  }

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
