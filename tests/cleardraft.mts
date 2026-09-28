/**
 * **지운 것이 지워지나** (2026-09-28).
 *
 * 🔴 사용자가 보고: *"쓰다 만 거 지웠는데도 껐다 킬 때마다 자꾸 붙는다."*
 *
 * 원인은 저장 층에 있었다. `JSON.stringify` 는 값이 `undefined` 인 키를
 * **통째로 버린다:**
 *
 * ```
 * {t:"room", draft: undefined, unread: 0}  →  {"t":"room","unread":0}
 * ```
 *
 * 그런데 불러올 때는 `{...props, ...rest}` 로 **덮어쓰기**만 한다 — 키가 없으면
 * 앞줄 값이 살아남는다. 즉 **«비웠다»를 적을 길이 아예 없었다.**
 *
 * `draft` 만의 문제가 아니다. `undefined` 로 비우는 모든 필드가 영영 안 지워
 * 진다. 그래서 여기서는 **draft 와 그 밖의 필드를 같이** 잰다 — 고침이 한
 * 자리(`erasable`/`merge`)에 있으므로 검사도 그 층에서 해야 의미가 있다.
 */
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomStore } from "../src/core/store.js";
import type { Room } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-clear-"));
  const store = new RoomStore(dir);
  await store.init();

  const room: Room = {
    id: "r1", title: "방", cwd: "/ws", participants: [],
    messages: [], unread: 0, createdAt: 1, lastActivityAt: 2,
  };
  await store.createRoom(room);

  console.log("\n[★ 초안을 썼다가 지운다]");
  room.draft = "쓰다 만 글";
  await store.updateRoom(room, { draft: room.draft });
  {
    const back = await store.loadRoom("r1");
    ok(back?.draft === "쓰다 만 글", `★ 쓴 것은 남는다 («${back?.draft}»)`);
  }

  // 사용자가 지운다 — 코어는 `text || undefined` 로 비운다
  room.draft = undefined;
  await store.updateRoom(room, { draft: room.draft });
  {
    const back = await store.loadRoom("r1");
    console.log(`   지운 뒤: ${JSON.stringify(back?.draft)}`);
    ok(back?.draft === undefined,
       `★ **지운 것은 사라진다** (${JSON.stringify(back?.draft)}) — 여기서 남으면 껐다 켤 때마다 되살아난다`);
  }

  console.log("\n[★ draft 만의 문제가 아니었다]");
  {
    room.lastReadMessageId = "m9";
    await store.updateRoom(room, { lastReadMessageId: room.lastReadMessageId });
    ok((await store.loadRoom("r1"))?.lastReadMessageId === "m9", "★ 넣으면 들어간다");

    room.lastReadMessageId = undefined;
    await store.updateRoom(room, { lastReadMessageId: room.lastReadMessageId });
    ok((await store.loadRoom("r1"))?.lastReadMessageId === undefined,
       "★ **비우면 비워진다** — `undefined` 로 지우는 모든 필드가 같은 병을 앓았다");
  }

  console.log("\n[★ 멀쩡한 값은 안 건드린다]");
  {
    const back = await store.loadRoom("r1");
    ok(back?.title === "방" && back?.cwd === "/ws", "★ 제목·폴더는 그대로");
    ok(back?.unread === 0, "★ 0 은 «비움»이 아니다 — 숫자 0 이 사라지면 안 된다");
  }

  console.log("\n[★ 빈 문자열도 «비움»이 아니다]");
  {
    /*
     * 코어는 `text || undefined` 라 빈 문자열이 여기까지 안 오지만, 저장 층은
     * 그걸 모른다. `""` 를 «지움»으로 삼으면 **다른 뜻이 섞인다.**
     */
    await store.updateRoom(room, { title: "" });
    ok((await store.loadRoom("r1"))?.title === "", "★ 빈 문자열은 빈 문자열로 남는다");
  }

  await fs.rm(dir, { recursive: true, force: true });
  console.log("\n전부 통과");
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
