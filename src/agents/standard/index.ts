/**
 * **standard** — 아무것도 안 덮었을 때 (리팩토링, 2026-10-20 · `docs/REFACTOR.md` §3.1).
 *
 * 설정으로 넣은 **처음 보는 에이전트**가 여기 기댄다. 내장 셋은 저마다 제 것을
 * 들고 있고, 칸을 비운 에이전트만 `agents/index.ts` 가 이걸 끼워 준다 — 코어는
 * 애드온을 import 못 하므로(린트), 끼우는 일은 목록을 세우는 쪽이 한다.
 *
 * 🔴 **여기는 «짐작» 이다.** 그 에이전트가 무슨 모양으로 줄지 모르니 글을 보고
 * 가늠한다. 내장 셋이 짐작을 안 쓰는 까닭이 그것이다 — 짐작은 판에서 말 한
 * 마디가 빠지면 **정반대로** 틀린다(`tests/quotaparse.mts` 가 그걸 보여준다).
 */
import {
  mcpPair, quotaLine,
  type AgentDef, type McpWho, type QuotaLine, type ToolCallShape,
} from "../../core/agent-api.js";

/** `**굵게**` 와 군더더기를 걷어 이름만 남긴다 */
function clean(raw: string): string {
  return raw.replace(/\*\*/g, "").replace(/[:\-\s]+$/, "").trim();
}

/**
 * ★ **«남았다» 라고 적힌 것만 남은 양이다.**
 *
 * 🔴 기본값을 «남았다» 로 두면 «3% 씀» 이 «3% 남음» 이 되어 **멀쩡한 계정이
 * 빨갛게** 보인다. 반대로 틀리면 다 쓴 계정이 괜찮아 보인다 — 둘 다 나쁘지만,
 * 말이 적혀 있을 때만 믿는 쪽이 **지어내지 않는** 쪽이다.
 */
const LEFT = /\b(left|remaining|available)\b|남(음|았)/i;

/** `- **이름**` 한 줄짜리 묶음 머리 */
const GROUP = /^\s*[-*]?\s*\*\*([^*]+?)\*\*\s*:?\s*$/;

/** 퍼센트가 든 줄 — 이름과 수와 (있으면) 리셋 시각 */
const LINE = /\*\*([^*]+?)\*\*[^\n%]*?(\d+(?:\.\d+)?)\s*%([^\n]*)/;

/**
 * 모르는 모양의 잔량 글을 가늠해 뜯는다. **못 뜯으면 빈 배열**이다.
 *
 * ⚠️ 줄 단위로 본다 — 한 줄에 한 한도라는 것은 내장 셋이 다 같았다. 아니게 되면
 * 여기가 조용히 비는데, 그때도 받은 글은 화면에 그대로 있다.
 */
export function parseStandardQuota(text: string): QuotaLine[] {
  const out: QuotaLine[] = [];
  let group = "";
  for (const raw of text.split("\n")) {
    const head = GROUP.exec(raw);
    if (head && !/\d\s*%/.test(raw)) { group = clean(head[1]!); continue; }

    const hit = LINE.exec(raw);
    if (!hit) continue;
    const tail = hit[3] ?? "";
    const inner = clean(hit[1]!);
    // 리셋 시각은 «resets …» 뒤를 통째로 — 괄호 안이면 괄호까지만
    const when = /resets?\s*:?\s*([^)\n]+)/i.exec(tail);
    const line = quotaLine(
      group && group !== inner ? `${group} · ${inner}` : inner,
      Number(hit[2]),
      LEFT.test(tail) || LEFT.test(inner) ? "left" : "used",
      when?.[1]?.trim(),
    );
    if (line) out.push(line);
  }
  return out;
}

/**
 * 낯선 에이전트의 잔량 — **아는 이름 둘을 차례로** 물어 본다. 광고한 목록에 있는
 * 것을 고른다(`AcpConnection.probeUsage`).
 */
export const standardQuota: NonNullable<AgentDef["quota"]> = {
  commands: ["usage", "status"],
  parse: parseStandardQuota,
};

/**
 * ★ **처음 보는 에이전트의 MCP 신원 — 세 자리를 다 본다** (2026-10-20).
 *
 * 어디에 실어 올지 모르니 아는 세 꼴을 차례로 본다 — 이름(`mcp__서버__도구`) ·
 * `_meta.mcp` · `rawInput`. 그래야 처음 보는 에이전트에서도 봇끼리 말하기가 돈다.
 *
 * ⚠️ **셋째(`rawInput`)는 모델이 써 넣는 자리다.** 내장 셋이 제 자리만 보는 까닭이
 * 그것이고, 여기서도 코어가 한 번 더 본다(도구 이름이 우리 셋 중 하나일 때만).
 */
export function standardMcpIdentity(tc: ToolCallShape): McpWho | undefined {
  const name = typeof tc.name === "string" ? tc.name : "";
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const at = rest.indexOf("__");
    if (at > 0 && at + 2 < rest.length) return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
  }
  return mcpPair(tc._meta?.["mcp"]) ?? mcpPair(tc.rawInput);
}
