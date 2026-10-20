/**
 * **봇에게 갈 것들이 모이는 한 칸** (v3.0 2-H).
 *
 * 권한과 메시지를 **같은 큐**에 담는다 — 둘은 생긴 것이 다르지만 **관리하는
 * 방식이 같다.** 큐를 둘로 두면 중지·스냅샷·소유자 검사를 **두 번씩** 정의해야
 * 한다.
 *
 * 여기서 재는 것은 셋이다:
 *
 * ```
 * 턴 몫      프롬프트 보내는 순간 떼어낸다 → **그래야 left 가 0 에 닿는다**
 * 한 종류씩   권한 먼저 — 권한을 기다리는 봇은 **턴이 얼어 있다**
 * 소유자     남의 것은 못 꺼낸다 — 안 그러면 제 요청을 스스로 승인한다
 * ```
 */
import { BotQueue } from "../src/core/mcp/botQueue.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };
const NL = String.fromCharCode(10);

const perm = (to: string, title: string, over = {}) =>
  ({ kind: "permission" as const, to, from: "알파", fromId: "alpha-1", title, readOnly: false, ...over });
const msg = (to: string, text: string, over = {}) =>
  ({ kind: "message" as const, to, from: "알파", fromId: "alpha-1", depth: 1, text, ...over });

function main(): void {
  console.log(`${NL}[★ 떼어낸 몫만 보인다 — 그래야 턴이 끝난다]`);
  {
    /*
     * 🔴 **안 떼면 턴이 안 끝난다.** 봇이 큐를 비우는 사이에 새 것이 들어오면
     * `left` 가 계속 0 이 안 되고, 모델은 «아직 남았구나» 하며 또 꺼낸다 —
     * 들어오는 속도가 처리 속도보다 빠르면 **영영 안 끝난다.**
     */
    const q = new BotQueue();
    q.put(msg("베타", "하나"));
    q.put(msg("베타", "둘"));
    ok(q.view("베타") === null, "★ **떼기 전에는 아무것도 안 보인다** — 큐에 있어도 이번 몫이 아니다");

    q.startTurn("베타");
    const got = q.view("베타")!;
    ok(got.item !== undefined && got.left === 1,
       `★ 떼면 보이지만 **하나씩** 나온다 (left ${got.left})`);

    // 턴 도중에 들어온 것 — **다음 몫**이다
    q.put(msg("베타", "도중에 온 것"));
    const again = q.view("베타")!;
    ok(again.left === 1,
       `★ **도중에 온 것은 이번 몫이 아니다** (left ${again.left}) — 안 그러면 left 가 0 에 안 닿는다`);
    ok(q.waiting("베타") === 1, "★ 그래도 **깨울 거리로는 세어둔다**");

    // 하나씩 꺼내 답한다 — 이번 몫이 빌 때까지
    for (let v = q.view("베타"); v; v = q.view("베타")) q.answer("베타", v.item.id);
    ok(q.view("베타") === null, "★ 다 답하면 이번 몫이 빈다 — 턴이 끝난다");
    q.startTurn("베타");
    ok(q.view("베타")?.item !== undefined, "★ 다음 턴에 그것이 나온다");
  }

  console.log(`${NL}[★ 한 번에 한 종류만 — 권한 먼저]`);
  {
    /*
     * 🔴 섞어 주면 모델이 **한 번에 두 가지 도구를 써야 한다.** 한 종류씩
     * 주면 «이번엔 verdict» 로 끝난다.
     *
     * 🔴 **권한이 먼저인 이유**: 권한을 기다리는 봇은 **턴이 얼어 있다.**
     * 메시지를 기다리는 쪽은 안 그렇다 — 급한 쪽이 먼저다.
     */
    const q = new BotQueue();
    q.put(msg("베타", "말 하나"));
    q.put(perm("베타", "터미널 명령", { command: "rm -rf build/", tool: "execute" }));
    q.put(msg("베타", "말 둘"));
    q.startTurn("베타");

    const first = q.view("베타")!;
    ok(first.kind === "permission", `★ **권한이 먼저** (${first.kind})`);
    ok(first.kind === "permission" && first.left === 2,
       `★ **권한이 먼저**, 나머지는 left 로 (${first.kind} · left ${first.left})`);
    ok(first.answer_with === "verdict",
       `★ **뭐로 답할지 같이 준다** (${first.answer_with}) — 설명은 한 번 읽고 잊는다`);

    const only = first.item;
    ok(only?.kind === "permission" && only.command === "rm -rf build/",
       "★ **무엇을 하려는지 그대로** (D1) — 제목만 넘기면 `rm -rf /` 와 `ls` 가 똑같이 보인다");

    q.answer("베타", only!.id);
    const then = q.view("베타")!;
    ok(then.kind === "message" && then.answer_with === "say",
       `★ 권한이 빠지면 메시지 차례 (${then.kind} · ${then.answer_with})`);
    ok(then.left === 1,
       `★ **그것도 하나씩** — 하나 보이고 하나 남는다 (left ${then.left})`);
  }

  console.log(`${NL}[★ 꺼낸다고 빠지지 않는다 — 빠지는 것은 답이다]`);
  {
    /*
     * 꺼내 보고 답을 못 한 채 턴이 끝날 수 있다. 그때 **잃으면 안 된다** —
     * 권한이라면 저쪽 봇은 영영 멈춰 있다.
     */
    const q = new BotQueue();
    q.put(perm("베타", "고치기"));
    q.startTurn("베타");
    q.view("베타");
    q.view("베타");
    ok(q.pending("베타").length === 1, "★ **두 번 봐도 그대로 있다**");
    ok(q.view("베타")?.item !== undefined, "★ 다시 꺼내도 같은 것이 나온다");
  }

  console.log(`${NL}[★ 남의 것은 못 뺀다 — 소유자 검사]`);
  {
    /*
     * 🔴 이게 없으면 **봇이 남의 권한 요청을 대신 승인**할 수 있고, 제
     * 요청을 스스로 승인하는 길도 열린다. 뿌리는 헤더 비밀이다(2-F).
     */
    const q = new BotQueue();
    const id = q.put(perm("베타", "고치기"));
    q.startTurn("베타");

    ok(q.answer("감마", id) === undefined, "★ **남이 답하면 안 먹는다**");
    ok(q.pending("베타").length === 1, "★ 그래서 그대로 남아 있다");
    ok(q.answer("베타", id) !== undefined, "★ 주인이 답하면 빠진다");
    ok(q.pending("베타").length === 0, "비었다");
  }

  console.log(`${NL}[★ 봇마다 따로 — 한 봇이 많다고 옆 봇이 밀리지 않는다]`);
  {
    const q = new BotQueue();
    q.put(msg("베타", "베타 것"));
    q.put(msg("감마", "감마 것"));
    q.startTurn("베타");
    ok(q.view("베타")?.left === 0, "베타 몫은 하나");
    ok(q.view("감마") === null, "★ **감마는 제 턴이 시작돼야 본다** — 몫은 봇마다다");
    q.startTurn("감마");
    const got = q.view("감마")!;
    ok(got.item.kind === "message" && got.item.text === "감마 것",
       "★ 그리고 제 것만 본다");
  }

  console.log(`${NL}[★ 비우면 뺀 것을 돌려준다 — 권한은 답해줘야 한다]`);
  {
    /*
     * 🔴 그냥 버리면 **권한을 기다리던 에이전트가 영영 멈춘다.** 비우는 쪽이
     * 돌려받아 `cancelled` 로 답해줘야 한다.
     */
    const q = new BotQueue();
    q.put(perm("베타", "하나"));
    q.put(msg("베타", "둘"));
    q.startTurn("베타");
    q.put(perm("베타", "셋"));

    const dropped = q.drop("베타");
    ok(dropped.length === 3,
       `★ **이번 몫과 다음 몫을 다** (${dropped.length}) — 하나라도 남기면 그 봇이 멈춘 채로 남는다`);
    ok(q.pending("베타").length === 0, "그리고 비었다");
  }

  console.log(`${NL}[🔴 «0» 은 절대 안 내준다 — say(id: "0") 이 쓰는 자리다]`);
  {
    /*
     * 겹치면 «사용자가 방금 한 말 때문에»가 **남의 큐 항목에 대한 답**으로
     * 읽히고, 그 길로 사슬 깊은 데 있는 봇이 새 대화를 시작한다 — 오류가
     * 아니라 **조용히** 뚫린다. 앞글자와 «1 부터» 둘 중 하나만 바뀌어도
     * 보장이 사라지므로 여기서 지킨다.
     */
    const q = new BotQueue();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(q.put(msg("베타", `${i}`)));
      ids.push(q.put({ kind: "permission", to: "베타", from: "알파", fromId: "a", title: "x", readOnly: true }));
    }
    ok(ids.every((id) => /^[px]\d+$/.test(id)), "★ 앞글자 + 1 부터 — 그 둘이 보장의 전부다");
  }

  console.log(`${NL}[★ 꺼내 본 **메시지만** 닫는다 — 권한은 안 닫는다 (2026-10-13)]`);
  {
    const q = new BotQueue();
    q.put({ kind: "message", to: "b", from: "알파", fromId: "a", text: "봐줄래", depth: 1 });
    q.put({ kind: "permission", to: "b", from: "알파", fromId: "a", title: "파일 고치기", readOnly: false });
    q.startTurn("b");

    /* 권한이 먼저 나온다 — 그쪽만 꺼내 본 셈이 된다 */
    const first = q.view("b");
    ok(first?.kind === "permission", "전제 — 권한이 먼저 나온다");
    ok(q.closeSeen("b") === 0,
       "★ **권한은 안 닫는다** — 요청한 봇이 얼어 있다. 조용히 닫으면 영영 멈춘다");
    ok(q.shareLeft("b") === 2, "둘 다 그대로다");

    /* 권한을 답하면 메시지가 나온다 */
    q.answer("b", first!.item.id);
    const second = q.view("b");
    ok(second?.kind === "message", "전제 — 이번엔 메시지다");
    ok(q.shareLeft("b") === 1, "★ 꺼냈다고 빠지지는 않는다");
    ok(q.closeSeen("b") === 1 && q.shareLeft("b") === 0,
       "★ **턴이 끝나면 꺼내 본 메시지는 닫힌다**");

    /* 안 꺼낸 것은 안 닫힌다 */
    q.put({ kind: "message", to: "b", from: "알파", fromId: "a", text: "또", depth: 1 });
    q.startTurn("b");
    ok(q.closeSeen("b") === 0 && q.shareLeft("b") === 1,
       "★ **안 꺼냈으면 안 닫는다** — 본 적도 없는 것을 버리면 잃는 것이다");
  }

  console.log(`${NL}전부 통과`);
}

main();
