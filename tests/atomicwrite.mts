/**
 * ★ **적었다고 믿은 것이 디스크에 있어야 한다** (2026-10-14).
 *
 * 전체 검사 한 판에서 `EPERM: rename … rooms.json` 이 났다. 윈도우는 **다른
 * 손이 그 파일을 열고 있으면** 덮어쓰는 rename 을 거절한다 — 바이러스
 * 검사기·탐색기·다른 창이 그 순간 읽고 있으면 그렇다.
 *
 * 그 김에 하나 더 보였다: 임시 이름이 `<dest>.<pid>.tmp` 라 **한 프로세스
 * 안에서 같은 파일을 겹쳐 쓰면 이름이 같았다.**
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { RoomStore } from "../src/core/store.js";

const NL = "\n";
const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aio-atomic-"));
  const store = new RoomStore(dir);
  await store.init();

  console.log(`${NL}[★ 겹쳐 써도 섞이지 않는다]`);
  {
    /*
     * 🔴 임시 이름이 같으면 **두 쓰기가 한 파일에 섞여 들어간다.** 먼저 끝난
     * 쪽이 rename 해 가면 남은 쪽은 **없는 파일을 옮기려 한다**(ENOENT).
     */
    const rooms = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        store.createRoom({
          id: `r${n}`, title: `방 ${n}`, cwd: dir, participants: [],
          messages: [], unread: 0, createdAt: n, lastActivityAt: n,
        })),
    );
    ok(rooms.length === 5, "다섯을 한꺼번에 만들었다");

    const again = new RoomStore(dir);
    await again.init();
    ok(again.listMetas().length === 5,
       `★ **다섯 다 디스크에 있다** (${again.listMetas().length}개) — 섞였으면 덜 읽힌다`);
  }

  console.log(`${NL}[★ 죽은 판이 남긴 임시 파일은 켤 때 치운다]`);
  {
    /*
     * 🔴 예전엔 이름에 번호가 없어서 **다음 쓰기가 덮어썼다.** 겹침을 막으려고
     * 번호를 붙이면서 그 길이 사라졌다 — 안 치우면 쌓인다.
     */
    const roomsDir = path.join(dir, "rooms");
    const dead = path.join(roomsDir, `rooms.json.${deadPid()}.7.tmp`);
    const live = path.join(roomsDir, `rooms.json.${process.pid}.7.tmp`);
    fs.writeFileSync(dead, "찌꺼기", "utf8");
    fs.writeFileSync(live, "남의 것", "utf8");

    const third = new RoomStore(dir);
    await third.init();
    ok(!fs.existsSync(dead), "★ **죽은 판의 것은 치운다**");
    ok(fs.existsSync(live),
       "★ **산 판의 것은 안 건드린다** — 다른 창이 지금 쓰는 중일 수 있다");
    fs.rmSync(live, { force: true });
  }

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`${NL}전부 통과${NL}`);
}

/** 거의 확실히 **죽은** 번호 */
function deadPid(): number {
  for (let pid = 999999; pid > 900000; pid--) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as { code?: string }).code === "ESRCH") return pid;
    }
  }
  return 999999;
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
