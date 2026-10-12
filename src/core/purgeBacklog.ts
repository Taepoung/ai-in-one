import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentDef } from "./types.js";

/**
 * **못 지운 세션 파일을 다음에 켤 때 치운다** (2026-10-12 실측).
 *
 * 🔴 Antigravity 는 세션을 지우는 길이 **아예 없어서** 우리가 파일을 지운다
 * (`AgentDef.purgeFiles`). 그런데 방을 나가는 그 순간에는 **sqlite 가 잠겨
 * 있다** — 재봤더니 `close` 뒤에도, 프로세스를 내린 뒤에도 3초를 기다려도
 * `EPERM` 이었다.
 *
 * 까닭은 이미 알고 있던 것이다: **Antigravity 의 파이썬 서버는 stdin 이 닫혀도
 * 안 끝난다**(`sweepStrays` 가 있는 이유). 우리가 내린 것은 우리가 띄운
 * 프로세스고, 그 **자식들이 살아남아 파일을 들고 있다.**
 *
 * 그래서 버려진 프로세스를 죽이는 **바로 그 자리**에 붙는다 — 죽은 다음이라야
 * 지울 수 있다.
 *
 * ★ **우리가 만든 것만, 우리가 지우려다 못 지운 것만** 치운다. «그 집에 있는
 * 남는 것» 을 쓸면 **남이 만든 세션까지 지운다** — 같은 집을 보는 다른 ACP
 * 클라이언트가 있을 수 있다. 밀린 목록을 들고 있는 이유가 그것이다.
 */

/** 치우다 만 것 하나 */
export interface PurgeLeft {
  agentId: string;
  sessionId: string;
  /** 언제 밀렸나 — 너무 오래된 것은 포기한다 */
  at: number;
}

/**
 * 밀린 것을 **너무 오래 들고 있지 않는다**.
 *
 * 저쪽이 자리를 옮겼거나 사용자가 손으로 치웠으면 영영 안 지워지는데, 그걸
 * 계속 들고 있으면 켤 때마다 헛일을 하고 목록만 자란다.
 */
const GIVE_UP_MS = 14 * 24 * 60 * 60 * 1000;

/** 그 세션의 파일들을 지운다. **지운 개수**를 돌려준다 */
export function purgeOnce(
  agent: AgentDef,
  sessionId: string,
  log: (m: string) => void,
): { wiped: number; left: number } {
  const spec = agent.purgeFiles;
  if (!spec) return { wiped: 0, left: 0 };

  /*
   * 🔴 **세션 id 는 저쪽이 준 값이다.** 경로에 꽂기 전에 본다 — `..` 나
   * 구분자가 섞이면 **홈 밖을 지우게 된다.**
   */
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    log(`[${agent.id}] 세션 id 모양이 낯설어 파일 정리를 건너뜁니다: ${sessionId}`);
    return { wiped: 0, left: 0 };
  }

  const home = spec.home.startsWith("~/")
    ? path.join(os.homedir(), spec.home.slice(2))
    : spec.home;

  let wiped = 0;
  let left = 0;
  for (const rel of spec.paths) {
    const target = path.resolve(home, rel.replace("{id}", sessionId));
    // 한 겹 더 — 선언이 잘못돼도 홈 밖은 안 건드린다
    if (!target.startsWith(path.resolve(home) + path.sep)) continue;
    try {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      wiped++;
    } catch {
      /*
       * 🔴 **여기서 떠들지 않는다.** 잠겨 있는 것이 **보통**이다 — 방을
       * 나가는 그 순간에는 저쪽 프로세스가 아직 들고 있다. 밀린 목록에
       * 넣고 다음에 켤 때 치운다. 적는 것은 그때 **또 실패하면**이다.
       */
      left++;
    }
  }
  return { wiped, left };
}

/**
 * **밀린 것을 치운다** — 확장이 켜질 때, 버려진 프로세스를 죽인 **다음에**.
 *
 * @returns 치운 것과 아직 남은 목록
 */
export function sweepBacklog(
  backlog: PurgeLeft[],
  agents: AgentDef[],
  log: (m: string) => void,
): { done: number; keep: PurgeLeft[] } {
  const keep: PurgeLeft[] = [];
  let done = 0;
  const now = Date.now();

  for (const item of backlog) {
    const agent = agents.find((a) => a.id === item.agentId);
    if (!agent?.purgeFiles) continue;   // 그 에이전트를 지웠다 — 들고 있을 이유가 없다

    const { left } = purgeOnce(agent, item.sessionId, log);
    if (left === 0) { done++; continue; }

    if (now - item.at > GIVE_UP_MS) {
      /*
       * ★ **포기할 때는 말한다.** 조용히 버리면 사용자는 **남아 있는 줄도
       * 모른다** — 지웠다고 믿은 대화가 디스크에 그대로다.
       */
      log(
        `[${agent.id}] 세션 ${item.sessionId} 의 파일을 끝내 못 지웠습니다 — ` +
          `${agent.purgeFiles.home} 아래를 손으로 치워야 합니다`,
      );
      continue;
    }
    keep.push(item);
  }
  return { done, keep };
}
