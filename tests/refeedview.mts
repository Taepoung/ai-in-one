/**
 * **되먹임이 남의 대화를 실어 나른다** (2026-10-09).
 *
 * 🔴 `transcriptText` 가 `room.messages` 를 **통째로** 훑었다. `system`·지금
 * 보낼 batch·`sendFailed` 만 거르고 **`inBotView` 는 안 썼다.**
 *
 * 그래서 단체방에서 알파를 되먹이면 **베타에게만 갔던 대화가 이름까지 붙어**
 * 들어갔다. §4.1.1 — «봇은 자기가 받은 것만 안다» — 를 **v2.0 부터** 깨고
 * 있었다. 되먹임은 세션이 끊겼을 때만 도는 길이라 눈에 안 띄었을 뿐이다.
 *
 * 받는 이를 적는 것도 같이 본다. 적어야 하는 이유는 릴레이 때문이고
 * (누가 누구에게 한 말인지 모르면 되먹인 기록이 뒤죽박죽이 된다), **다
 * 적으면 안 되는** 이유는 같은 §4.1.1 이다 — 수신자를 다 적으면
 * «베타도 이걸 받았다» 를 알파에게 알려주는 꼴이 된다.
 */
import { fileURLToPath } from "node:url";
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs/promises";
import { RoomManager } from "../src/core/roomManager.js";
import { RoomStore } from "../src/core/store.js";
import { DEFAULT_AGENTS } from "../src/core/agentCatalog.js";
import type { WorkspaceHost } from "../src/core/workspaceHost.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));

type Ev = { t: string; sessionId?: string; text?: string };

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aio-refeed-"));
  const state = path.join(dir, "s.jsonl");
  const store = new RoomStore(dir); await store.init();
  const host: WorkspaceHost = {
    readTextFile: async () => "", writeTextFile: async () => {},
    requestPermission: async () => ({ outcome: "cancelled" }),
    log: () => {}, defaultCwd: () => dir, hasWorkspace: () => true,
  };
  const base = {
    ...DEFAULT_AGENTS[0]!, command: "node", args: [path.join(here, "fakeagent.cjs")],
    env: { AIO_FAKE_STATE: state },
  };
  const mgr = new RoomManager({
    host, store, configProbeMs: 20000,
    agents: [
      { ...base, id: "alpha", label: "알파" },
      { ...base, id: "beta", label: "베타" },
    ],
  });
  mgr.on("roomError", () => {}); mgr.on("notice", () => {});

  const prompts = async (): Promise<string[]> => {
    try {
      return (await fs.readFile(state, "utf8")).split(NL).filter(Boolean)
        .map((l) => JSON.parse(l) as Ev).filter((e) => e.t === "prompt").map((e) => e.text ?? "");
    } catch { return []; }
  };

  const room = await mgr.createRoom({
    title: "둘", bots: [{ agentId: "alpha", name: "알파" }, { agentId: "beta", name: "베타" }],
  });
  const settle = async () => {
    for (let i = 0; i < 1200 && !["idle", "error"].includes(mgr.statusOf(room.id)); i++) await nap(25);
  };

  const alphaId = room.participants[0]!.id;
  const betaId = room.participants[1]!.id;

  console.log("\n[★ 둘에게 따로 말을 건다 — 칩으로 갈라서]");
  await mgr.sendCompose(room.id, [
    { kind: "mention", botId: alphaId }, { kind: "text", text: " 알파한테만 하는 말" },
  ]);
  await settle();
  await mgr.sendCompose(room.id, [
    { kind: "mention", botId: betaId }, { kind: "text", text: " 베타한테만 하는 말 — 비밀감자" },
  ]);
  await settle();

  const seen = room.messages.filter((m) => m.role === "user");
  console.log(`   사용자 메시지 ${seen.length}개 · 받은 이: ${seen.map((m) => m.deliveredTo.join("/")).join(" | ")}`);

  console.log("\n[★ ① 알파를 되먹이면 베타의 대화는 안 들어간다]");
  {
    await mgr.decideRefeed(room.id, true);
    const before = (await prompts()).length;
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: alphaId }, { kind: "text", text: " 이어서 해줘" },
    ]);
    await settle();
    const sent = (await prompts()).slice(before).join("\n@@@\n");
    const mine = sent.includes("알파한테만");
    const theirs = sent.includes("비밀감자");
    console.log(`   되먹인 글에 «알파한테만» ${mine} · «비밀감자» ${theirs}`);
    ok(mine, "제가 받았던 말은 들어간다");
    ok(!theirs, "★ **베타에게만 갔던 말은 안 들어간다** (§4.1.1)");
  }

  console.log("\n[★ ② 받는 이는 당사자인 쪽만 적는다]");
  {
    /*
     * 릴레이(§7)가 아직 없어서 «알파 → 베타» 를 만들 길이 없다. 그래서 그
     * 상태를 **손으로** 만든다 — 알파의 답이 베타에게도 갔다고 적어둔다.
     * `say` 가 들어오면 이 모양이 저절로 생긴다.
     */
    const said = room.messages.find((m) => m.role === "agent" && m.authorBotId === alphaId);
    ok(said !== undefined, "알파가 한 말이 있다");
    said!.deliveredTo = [alphaId, betaId];
    said!.text = "베타야 이것 좀 봐줘 — 당근팔십";

    await mgr.decideRefeed(room.id, true);
    const before = (await prompts()).length;
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: betaId }, { kind: "text", text: " 이어서 해줘" },
    ]);
    await settle();
    const sent = (await prompts()).slice(before).join("\n@@@\n");
    const line = sent.split("\n").find((l) => l.includes("당근팔십")) ?? "";
    console.log(`   줄: ${JSON.stringify(line)}`);
    ok(line.startsWith("알파 → 베타:"), "★ 봇끼리 한 말에는 받는 이가 붙는다");

    const userLine = sent.split("\n").find((l) => l.includes("베타한테만")) ?? "";
    console.log(`   사용자 줄: ${JSON.stringify(userLine)}`);
    ok(userLine.startsWith("사용자:") && !userLine.includes("→"),
       "★ **사용자 줄에는 제3자가 안 붙는다** — 다 적으면 우리가 §4.1.1 을 깬다");
  }

  console.log("\n[★ ③ 요약도 봇마다 다르다 — 남의 압축분을 글머리에 안 붙인다]");
  {
    /*
     * 압축은 **세션 단위**라 자국에 `aboutBotIds` 가 붙는다(B1). 그런데
     * 요약을 긁어모으는 쪽이 그걸 안 봤다 — 알파에게 되먹이는 글머리에
     * **베타가 압축하며 남긴 요약**이 «이전 요약» 으로 붙었다. `kept` 와
     * **같은 병**이고, 고치는 자리도 같은 함수 안이다.
     */
    room.messages.push({
      id: "cut-beta", role: "system", mark: "compaction", deliveredTo: [],
      text: "여기까지 압축됨", summary: "베타가 요약한 것 — 고구마아홉",
      aboutBotIds: [betaId], createdAt: Date.now(),
    });

    await mgr.decideRefeed(room.id, true);
    const before = (await prompts()).length;
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: alphaId }, { kind: "text", text: " 또 이어서" },
    ]);
    await settle();
    const sent = (await prompts()).slice(before).join("\n");
    console.log(`   «고구마아홉» 들어감: ${sent.includes("고구마아홉")}`);
    ok(!sent.includes("고구마아홉"), "★ **베타의 요약은 알파에게 안 간다**");
  }

  console.log("\n[★ ④ 받는 이가 안 적힌 옛 메시지는 «모두가 봤다»]");
  {
    /*
     * 🔴 `deliveredTo` 는 단체방(v2.0)과 함께 생긴 칸이다. 그 전에 저장된
     * 줄에는 **아예 없고**, 저장소는 JSONL 을 그대로 읽으므로 `undefined` 로
     * 올라온다 — 타입은 «있다»고 말하지만 디스크는 아니다.
     *
     * 없는 것을 «아무도 못 봤다»로 읽으면 **옛 대화가 통째로 사라진다.**
     * 그때는 방에 봇이 하나뿐이었으니 «모두가 봤다»가 사실이기도 하다.
     */
    const old = {
      id: "old-1", role: "user" as const, text: "아주 옛날 말 — 수박셋",
      createdAt: 1,
    } as unknown as (typeof room.messages)[number];
    room.messages.unshift(old);

    await mgr.decideRefeed(room.id, true);
    const before = (await prompts()).length;
    await mgr.sendCompose(room.id, [
      { kind: "mention", botId: alphaId }, { kind: "text", text: " 또또 이어서" },
    ]);
    await settle();
    const sent = (await prompts()).slice(before).join("\n");
    console.log(`   «수박셋» 들어감: ${sent.includes("수박셋")}`);
    ok(sent.includes("수박셋"), "★ **옛 메시지를 잃지 않는다**");
  }

  mgr.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log("\n통과");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
