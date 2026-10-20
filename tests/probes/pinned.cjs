/**
 * **probe 가 제품과 같은 판을 보게 한다** (2026-10-01).
 *
 * 🔴 Codex 어댑터에 핀을 박는 순간 **probe 가 엉뚱한 걸 재기 시작한다.**
 * 제품은 `@2.1.0` 을 띄우는데 probe 들은 `-y @agentclientprotocol/codex-acp`
 * 로 **그때그때 최신**을 띄우고 있었다. 오늘은 둘이 같아서 안 보이지만,
 * 저쪽이 2.2 를 내는 날 probe 는 **아무도 안 쓰는 판**을 재게 된다.
 *
 * 이 세션에서만 \u00ab좁게 재서 틀린 결론\u00bb 을 여러 번 냈다. 그 중 제일 고약한
 * 종류가 이것이다 — 숫자는 멀쩡히 나오는데 **다른 것을 재고 있는** 경우.
 *
 * 그래서 판을 손으로 안 적는다. **그 에이전트의 애드온 파일에서 읽는다.**
 * 거기가 제품이 쓰는 유일한 자리이므로 둘이 갈릴 수가 없다.
 *
 * ★ 리팩토링 ①(2026-10-20)부터 에이전트마다 파일이 하나다 —
 * `src/agents/<id>/index.ts`. 예전처럼 한 파일을 뒤져 `id:` 를 찾을 때보다
 * **남의 정의를 잘못 집을 길**이 없어졌다.
 */
const fs = require("node:fs");
const path = require("node:path");

/** 그 에이전트의 애드온 파일 */
const srcOf = (id) => path.join(__dirname, "..", "..", "src", "agents", id, "index.ts");

/**
 * 그 에이전트의 애드온이 주는 `args` 를 그대로.
 *
 * 핀이 없으면 없는 대로 돌려준다 — 여기서 고치지 않는다. 제품이 안 박았으면
 * probe 도 안 박은 것을 재는 게 맞다.
 */
function argsOf(id) {
  const file = srcOf(id);
  if (!fs.existsSync(file)) throw new Error(`애드온이 없다: src/agents/${id}/`);
  const src = fs.readFileSync(file, "utf8");
  const at = src.indexOf(`id: "${id}"`);
  if (at < 0) throw new Error(`src/agents/${id}/index.ts 에 id: "${id}" 가 없다`);
  const m = /args: \[([^\]]*)\]/.exec(src.slice(at));
  if (!m) throw new Error(`${id} 의 args 를 못 찾았다`);

  const one = (t) => t.trim().replace(/^"|"$/g, "");
  const out = [];
  for (const tok of m[1].split(",")) {
    const t = tok.trim();
    if (!t) continue;
    /*
     * ★ **`...CODEX_PIN` 같은 펼침도 풀어준다** (2026-10-01).
     *
     * 어댑터와 엔진을 한 줄에 묶어두면서 상수가 생겼다. 여기서 안
     * 풀면 probe 는 «...CODEX_PIN» 이라는 **글자열을 어댑터로 띄우려 한다.**
     */
    const spread = t.startsWith("...") ? t.slice(3) : "";
    if (spread) {
      const head = `const ${spread} = [`;
      const at2 = src.indexOf(head);
      if (at2 < 0) throw new Error(`${spread} 〖을〗 못 찾았다`.replace("〖을〗", "을"));
      const end = src.indexOf("]", at2);
      for (const x of src.slice(at2 + head.length, end).split(",")) {
        const v2 = one(x);
        if (v2) out.push(v2);
      }
      continue;
    }
    const v = one(t);
    if (v) out.push(v);
  }
  return out;
}

/** `-y` 를 뺀 패키지 이름 하나 (`ask(pkg)` 꼴 probe 용) */
function pkgOf(id) {
  return argsOf(id).find((a) => a.includes("/")) ?? "";
}

module.exports = { argsOf, pkgOf };
