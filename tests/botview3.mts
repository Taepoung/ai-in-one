/**
 * **봇끼리 멘션하면 «봇 뷰»가 무엇이 되나** (v3.0 대비, 2026-09-28).
 *
 * v2.1 의 봇 뷰는 «그 봇과의 1:1처럼»이라고 소개했다. 그런데 `inBotView` 가
 * 실제로 고르는 것은 **«이 봇이 멘션됐거나, 이 봇이 한 말»** 이다:
 *
 * ```
 * agent  authorBotId === botId  ||  deliveredTo.includes(botId)
 * user   deliveredTo.includes(botId)  ||  notSentTo.includes(botId)
 *                                         ↑ **못 갔어도** 포함한다
 * ```
 *
 * ★ 못 간 것까지 넣는 것이 결정적이다. 배달 기준이면 뺐을 텐데 넣는다 — 즉
 * 이미 **멘션 기준**이다(`deliveredTo ∪ notSentTo` = 그 블록에서 멘션된 봇).
 *
 * v2.x 에서는 봇끼리 말을 안 하므로 «나와의 1:1»과 **우연히 같았다.** v3.0 에서
 * 갈라지는데, 갈라진 쪽이 더 쓸모 있다 — 알파가 베타에게 물어 받은 답이 뷰에서
 * 빠지면 **알파의 결론이 허공에서 온 것처럼** 보인다(혼잣말과 같은 문제다).
 *
 * 그래서 여기서 못 박는 것은 **경계**다: 그 봇이 **모르는** 대화는 안 들어온다.
 */
import { inBotView, type Message } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

/*
 * 내가 알파에게 시키고 → 알파가 베타에게 묻고 → 베타가 답한다.
 * 그 사이 베타는 감마에게 따로 묻는다 — **알파는 그걸 모른다.**
 */
const MSGS: Message[] = [
  { id: "u1", role: "user", text: "리팩터링 좀 봐줘",
    deliveredTo: ["a"], createdAt: 10 },
  { id: "a1", role: "agent", text: "@베타 이 타입 정의 맞아?",
    authorBotId: "a", deliveredTo: ["a", "b"], replyToIds: ["u1"], createdAt: 20 },
  { id: "b1", role: "agent", text: "@알파 아니, 제네릭이 빠졌어",
    authorBotId: "b", deliveredTo: ["b", "a"], replyToIds: ["a1"], createdAt: 30 },
  // ★ 알파가 모르는 갈래
  { id: "b2", role: "agent", text: "@감마 테스트는 어때?",
    authorBotId: "b", deliveredTo: ["b", "c"], createdAt: 40 },
  { id: "c1", role: "agent", text: "@베타 다 통과해",
    authorBotId: "c", deliveredTo: ["c", "b"], replyToIds: ["b2"], createdAt: 50 },
  { id: "a2", role: "agent", text: "고쳤어",
    authorBotId: "a", deliveredTo: ["a"], replyToIds: ["u1"], createdAt: 60 },
  // 멘션은 됐는데 **못 간** 말 — 배달 기준과 멘션 기준이 갈리는 자리
  { id: "u2", role: "user", text: "@감마 이것도",
    deliveredTo: [], notSentTo: ["c"], sendFailed: "세션을 열지 못했습니다", createdAt: 70 },
];

const seen = (botId: string) => MSGS.filter((m) => inBotView(m, botId)).map((m) => m.text);

console.log("\n[★ 알파 뷰 — 건 말과 받은 답이 같이 있다]");
{
  const mine = seen("a");
  console.log("   " + mine.join("\n   "));
  ok(mine.includes("@베타 이 타입 정의 맞아?"), "★ 알파가 **건 말**");
  ok(mine.includes("@알파 아니, 제네릭이 빠졌어"),
     "★ 알파가 **받은 답** — 빠지면 «고쳤어»가 허공에서 온 것처럼 보인다");
  ok(mine.length === 4, `★ 넷 (${mine.length}) — «나와의 1:1»이었으면 둘이다`);
}

console.log("\n[★ 그 봇이 «모르는» 갈래는 안 들어온다 — 이게 경계다]");
{
  const mine = seen("a");
  ok(!mine.includes("@감마 테스트는 어때?"), "★ 베타↔감마 대화는 알파 뷰에 없다");
  ok(!mine.includes("@베타 다 통과해"), "★ 그 답도 없다");
  /*
   * 이 경계가 곧 «알파의 세션이 아는 것»이다. 어긋나면 §4.1.1 의 위험이
   * 되살아난다 — **화면엔 보이는데 봇은 모른다.**
   */
}

console.log("\n[★ 멘션됐으면 «못 갔어도» 들어온다 — 배달 기준이 아니다]");
{
  const mine = seen("c");
  console.log("   감마 뷰: " + mine.join(" / "));
  ok(mine.includes("@감마 이것도"),
     "★ **못 간 말도 감마 뷰에 있다** — 조용히 지우지 않는다(§0 뺄셈 규칙)");
  ok(!seen("a").includes("@감마 이것도"), "★ 그리고 알파 뷰에는 없다");
}

console.log("\n[베타 뷰 — 같은 규칙, 다른 범위]");
{
  const mine = seen("b");
  console.log("   " + mine.join("\n   "));
  ok(!mine.includes("리팩터링 좀 봐줘"), "★ 내가 알파에게만 한 말은 베타가 모른다");
  ok(mine.includes("@감마 테스트는 어때?"), "★ 베타가 건 말은 있다");
  ok(mine.length === 4, `★ 넷 (${mine.length})`);
}

console.log("\n전부 통과");
