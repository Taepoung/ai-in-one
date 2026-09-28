/**
 * 첫 페인트(HTML에 박아 보내는 목록)와 스크립트가 **같은 줄을 그리는가** (F8).
 *
 * 두 곳에 손으로 같은 마크업을 적어 두었으므로 한쪽만 고치면 스크립트가 붙는
 * 순간 목록이 튄다. 여기서 구조를 못 박아 둔다.
 */
import { roomListHtml, orderRooms } from "../src/protocol.js";
import type { Boot } from "../src/protocol.js";
import type { RoomMeta } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

const meta = (over: Partial<RoomMeta> = {}): RoomMeta => ({
  id: "r1", title: "리팩터링", kind: "direct", cwd: "/ws",
  agentIds: ["claude"], unread: 0, createdAt: 1, lastActivityAt: 2, ...over,
});

const boot = (rooms: RoomMeta[]): Boot => ({
  rooms,
  agents: [
    { id: "claude", label: "Claude", color: "#d97757" },
    { id: "codex", label: "Codex", color: "#10a37f" },
  ],
  reducedMotion: true,
  screen: "list",
  cwd: "/ws",
});

function main() {
  console.log("\n[한 줄의 구조 — 유형 아이콘 · 제목 · 시각 / 누구와 · 폴더 (B5·B10)]");
  {
    const html = roomListHtml(boot([meta({ models: ["Opus 5"] })]));
    ok(!html.includes('class="dot"'), "**색 점이 없다**");
    ok(html.includes("codicon-comment"), "1:1은 말풍선 아이콘");
    // 🔴 둘째 줄은 **부를 이름만** 둔다 — 모델까지 적으면 줄이 길어져
    //    정작 이름이 안 읽힌다. 모델·에이전트는 툴팁으로 접는다(§0).
    ok(html.includes('>Claude</span>'), "**제목 아래는 누구와**");
    ok(!html.includes("Claude · Opus 5</span>"), "★ 줄에는 모델이 없다");
    ok(html.includes('title="Claude · Opus 5"'),
       "★ **모델은 툴팁에 남는다** — 버리는 게 아니라 접는 것이다");
    ok(html.indexOf("room-who") < html.indexOf("room-cwd"), "폴더는 그다음 — 시각 아래");
    ok(html.includes('class="room-cwd"'), "여기 방이면 평범하게");
  }

  console.log("\n[방 유형마다 아이콘이 다르다]");
  {
    ok(roomListHtml(boot([meta({ kind: "group", agentIds: ["claude", "codex"] })]))
       .includes("codicon-organization"), "단체방");
    ok(roomListHtml(boot([meta({ kind: "shared" })])).includes("codicon-sync"), "공유방");
  }

  console.log("\n[다른 프로젝트의 방은 표시가 다르다]");
  {
    const html = roomListHtml(boot([meta({ cwd: "/other/repo" })]));
    ok(html.includes('class="room-cwd elsewhere"'), "클래스가 붙는다");
    ok(html.includes("…/other/repo") || html.includes("/other/repo"), "경로가 보인다");
  }

  console.log("\n[모델을 모르면 지어내지 않는다]");
  {
    ok(roomListHtml(boot([meta()])).includes('>Claude</span>'), "에이전트 이름만");
    ok(roomListHtml(boot([meta({ agentIds: ["없는것"] })])).includes("없는것"),
       "모르는 에이전트는 id라도 보여준다 — 빈칸보다 낫다");
  }

  console.log("\n[초안이 있으면 그게 먼저다]");
  {
    const html = roomListHtml(boot([meta({ draftPreview: "이거 고쳐줘" })]));
    ok(html.includes("초안:"), "왼쪽을 초안이 가져간다");
    ok(html.includes("room-cwd"), "**폴더는 안 밀려난다** — 자리가 다르다");
  }

  console.log("\n[제목에 태그가 들어가도 새지 않는다]");
  {
    const html = roomListHtml(boot([meta({ title: '<img src=x onerror="1">' })]));
    ok(!html.includes("<img"), "escape된다");
    ok(html.includes("&lt;img"), "글자로 남는다");
  }

  console.log("\n[순서는 웹뷰와 같다]");
  {
    const rooms = [
      meta({ id: "저기-최근", cwd: "/other", lastActivityAt: 90 }),
      meta({ id: "여기-오래", cwd: "/ws", lastActivityAt: 10 }),
    ];
    const html = roomListHtml(boot(rooms));
    ok(html.indexOf("여기-오래") < html.indexOf("저기-최근"),
       "**현재 워크스페이스가 위** — `orderRooms`를 같이 쓴다");
    ok(orderRooms(rooms, "/ws")[0]!.id === "여기-오래", "같은 함수다");
  }

  console.log("\n[방이 없으면 안내를 이미 그려 둔다]");
  {
    ok(roomListHtml(boot([])).includes("아직 대화가 없습니다"), "빈 상태도 첫 프레임에");
  }

  console.log("\n전부 통과\n");
}
main();
