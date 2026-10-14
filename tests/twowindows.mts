/**
 * **창이 둘이어도 방이 안 사라진다** (2026-10-07).
 *
 * 사용자: *"저장소는 공유하고 영향도 공유하게 하자 어짜피 개인이 쓸거니까
 * (유저 영역으로 구분되잖아?)"*. 맞다 — `globalStorage` 는 OS 사용자 프로필
 * 아래라 한 사람 몫이고, 그 사람의 **VSCode 창들이 같은 자리를 나눠 쓴다.**
 *
 * 🔴 그런데 나눠 쓰는 것이 **안전하지 않았다.**
 *
 * ```
 * rooms/<id>.jsonl   붙이기만 한다        → 창이 둘이어도 안 잃는다
 * rooms.json         통째로 덮어 쓴다      → **나중에 쓴 쪽이 다 지운다**
 * ```
 *
 * 지표는 열 때 한 번 읽어 메모리에 들고 있다가 통째로 쓴다. 그래서 A 창에서
 * 만든 방이 **B 창이 방 하나 만들자마자 목록에서 사라진다.** 대화 파일은
 * 남아 있지만 목록에 없으니 **찾을 길이 없다.**
 *
 * 쓰기 전에 디스크를 다시 읽어 **우리 변경만 얹는 것**으로 고쳤다. 마지막에
 * 쓴 것이 이기는 것은 같은데, 이기는 범위가 **목록 전체에서 한 칸으로** 줄었다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomStore } from "../src/core/store.js";
import { RoomLocks } from "../src/core/roomLock.js";
import type { Message, Room } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

const room = (id: string, title: string, cwd: string): Room => ({
  id, title, participants: [], cwd, messages: [], unread: 0,
  createdAt: 0, lastActivityAt: 0,
});

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-twowin-"));

  console.log("\n[★ 두 창이 같은 자리를 쓴다]");
  {
    /* 둘 다 «켜질 때» 를 지난다 — 그때 지표를 읽어 들고 있는 것이 함정이었다 */
    const a = new RoomStore(dir); await a.init();
    const b = new RoomStore(dir); await b.init();

    await a.createRoom(room("r-a", "A 창에서 만든 방", dir));
    await b.createRoom(room("r-b", "B 창에서 만든 방", dir));

    /* 셋째 창이 새로 켜진 셈 — 디스크에 뭐가 남았나 */
    const c = new RoomStore(dir); await c.init();
    const ids = c.listMetas().map((m) => m.id).sort();
    console.log(`   디스크에 남은 방: ${JSON.stringify(ids)}`);
    ok(ids.includes("r-b"), "나중에 쓴 쪽은 당연히 있다");
    ok(ids.includes("r-a"),
       "★ **먼저 만든 방이 안 사라진다** — 전엔 B 가 목록을 통째로 덮어 지웠다");

    /* 지우는 것도 같은 자리다 */
    await b.deleteRoom("r-b");
    const d = new RoomStore(dir); await d.init();
    const left = d.listMetas().map((m) => m.id);
    console.log(`   하나 지운 뒤: ${JSON.stringify(left)}`);
    ok(left.length === 1 && left[0] === "r-a",
       "★ **지울 때도 그 한 칸만 지운다** — 옆 창 것을 쓸어가지 않는다");
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n[★ 옆 창이 쓰는 중인 방을 «끊겼다» 고 읽지 않는다 (2026-10-14)]");
  {
    /*
     * 🔴 「기록만 읽기」는 자물쇠를 **안 잡고** 연다 — 붙이지 않으니 잡을
     * 이유가 없다. 그래서 **옆 창이 지금 답을 받고 있는 방**도 열리는데,
     * 디스크에 남은 `streaming: true` 를 보고 고치면 **멀쩡히 돌고 있는 답에
     * 「응답이 중단되었습니다」**가 붙는다. 그쪽 창은 멀쩡한데 이쪽만
     * 거짓말을 하는 꼴이다.
     */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-peek-"));
    const store = new RoomStore(dir); await store.init();
    const live: Message = {
      id: "m1", role: "agent", text: "쓰는 중", deliveredTo: [],
      createdAt: 1, streaming: true,
    };
    await store.createRoom({
      ...room("r1", "도는 방", dir), messages: [live],
    });

    console.log("   ① 아무도 안 들고 있으면 — 끊긴 것이다");
    const alone = await store.loadRoom("r1");
    ok(alone!.messages[0]!.truncated === true,
       "★ **고친다** — 들고 있는 창이 없으면 그건 진짜로 끊긴 것이다");

    console.log("   ② 옆 창이 산 채로 들고 있으면 — 도는 중이다");
    /* 옆 창인 척: **살아 있는** 다른 pid 로 자리를 적어둔다 */
    const note = { pid: process.ppid, window: "옆 창", at: Date.now() };
    await fs.writeFile(path.join(dir, "rooms", "r1.open"), JSON.stringify(note), "utf8");

    const locks = new RoomLocks(path.join(dir, "rooms"), "내 창", () => {});
    const held = locks.heldByOther("r1");
    ok(held?.window === "옆 창", `전제 — 자물쇠가 «남이 들고 있다» 고 말한다 (${held?.window})`);

    const peeked = await store.loadRoom("r1", { heal: false });
    ok(peeked!.messages[0]!.truncated === undefined,
       "★ **안 고친다** — 옆 창은 멀쩡히 받고 있다");
    ok(peeked!.messages[0]!.streaming === true,
       "★ 그리고 **쓰는 중이라고 그대로 둔다** — 우리가 아는 사실 그대로다");

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
