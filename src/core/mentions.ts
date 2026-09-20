/**
 * **멘션으로 한 메시지를 봇별 블록으로 쪼갠다** (§4.1.2).
 *
 * 단체방에서는 한 번에 쓴 글이 **여러 봇에게 서로 다른 지시**로 갈라진다.
 *
 * ```
 * (@claude) (@codex)          ← 연속 칩 = 한 그룹. 둘 다 같은 내용을 받는다
 * 이 코드 리뷰해줘
 *
 * (@리뷰어)                  ← 다음 그룹
 * 문서도 업데이트해줘
 * ```
 *
 * 🔴 **규칙은 화면이 아니라 여기 있다.** 입력창이 `contenteditable` 칩이 되든
 * `textarea` 폴백이 되든(한글 IME 검증 결과에 달렸다), 화면이 하는 일은
 * **토큰으로 적어 보내는 것**까지다. «줄 맨 앞인가», «연속인가», «누가 받나»는
 * 전부 이 파일이 정한다 — 그래야 한 군데서만 고치고 한 군데서만 잰다.
 *
 * 화면은 칩을 `mention`, 나머지를 `text`로 늘어놓기만 하면 된다.
 *
 * ★ **맨 앞에 지목이 없으면 전원에게** 간다. 단체방에서 제일 흔한 것이
 * «다들 이거 봐줘»인데 그때마다 `@everyone`을 치게 하면 수고가 된다.
 */

/** 입력창이 적어 보내는 것. 칩 하나, 또는 글자 덩어리 하나 */
export type ComposeToken =
  | { kind: "mention"; botId: string }
  | { kind: "text"; text: string };

/** 한 그룹에게 갈 한 덩어리 */
export interface ComposeBlock {
  /** 받는 봇들. 순서는 화면에 찍힌 순서 그대로 */
  botIds: string[];
  /** 그 그룹에게 갈 지시 */
  text: string;
  /**
   * 이 블록을 **연 칩들**이 `tokens`의 몇 번째였나.
   *
   * 🔴 화면이 «어느 칩이 어느 그룹인가»를 **혼자 다시 계산하면 안 된다** —
   * 그러면 «줄 맨 앞인가», «연속인가»가 두 군데 살게 되고, 한 쪽만 고치는
   * 날이 온다. 규칙은 여기 하나고(§4.1.2) 화면은 **결과를 받아 칠한다.**
   *
   * 지목 없이 전원에게 가는 첫 블록은 연 칩이 없으므로 비어 있다.
   */
  mentionAt: number[];
}

export interface ComposeParse {
  blocks: ComposeBlock[];
  /**
   * **보내면 안 되는 이유.** 있으면 전송을 막는다.
   *
   * 조용히 버리지 않는다 — 보낸 줄 알고 넘어가는 것이 제일 나쁘다(§4.1.2).
   */
  blocked?: string;
  /**
   * 막을 정도는 아니지만 **말해줘야 하는 것**.
   *
   * 예: 내용 없는 그룹은 건너뛰는데, 건너뛰었다고 말하지 않으면
   * «보냈는데 왜 조용하지»가 된다.
   */
  warnings: string[];
}

/** `@everyone` 을 나타내는 가짜 봇 id. 칩 데이터에 이 값이 들어온다 */
export const EVERYONE = "@everyone";

interface KnownBot {
  id: string;
  name: string;
}

/**
 * 토큰을 블록으로 접는다.
 *
 * `bots`는 **지금 방에 있는** 봇들이다. 여기 없는 id를 가진 칩은 나갔거나
 * 지워진 봇이므로 경고한다 — 칩은 `botInstanceId`를 들고 있어서 이름이 바뀌어도
 * 라우팅이 유지되지만, **사라진 봇까지 살려주지는 못한다.**
 */
export function parseCompose(tokens: ComposeToken[], bots: KnownBot[]): ComposeParse {
  const known = new Map(bots.map((b) => [b.id, b]));
  const warnings: string[] = [];

  const blocks: ComposeBlock[] = [];
  /** 지금 모으는 중인 그룹. 아직 지시를 안 받았으면 `text`가 빈 채로 있다 */
  let open: ComposeBlock | undefined;
  /** 첫 그룹 앞에 흘린 글자 — 지목이 없었으면 전원에게 간다 */
  let orphan = "";
  /**
   * 그 글자가 **지목을 시도한 뒤**에 흘러들었나.
   *
   * 나간 봇을 가리킨 칩은 건너뛰는데, 그 뒤의 글까지 «지목이 없다»고 보고
   * **전원에게 보내면 조용히 넓혀진다.** 사용자는 분명히 한 명을 골랐다.
   */
  let orphanAfterMention = false;
  /**
   * 지금 **줄 맨 앞**인가.
   *
   * 줄 맨 앞 칩만 라우팅이다. `아까 (@claude)가 말한 대로…` 의 칩은 참조일 뿐이고,
   * 그걸 라우팅으로 읽으면 **지나가는 말에 일을 시키게 된다.**
   */
  let atLineHead = true;
  /** 바로 앞 토큰이 라우팅 칩이었나 — 연속이면 같은 그룹이다 */
  let chaining = false;

  const push = (b: ComposeBlock | undefined) => {
    if (!b) return;
    const text = b.text.trim();
    if (!text) {
      warnings.push(`${nameOf(b.botIds, known)}에게 보낼 내용이 없어 건너뜁니다.`);
      return;
    }
    blocks.push({ botIds: b.botIds, text, mentionAt: b.mentionAt });
  };

  for (const [n, tk] of tokens.entries()) {
    if (tk.kind === "mention") {
      const routing = atLineHead;
      const ids = tk.botId === EVERYONE ? bots.map((b) => b.id) : [tk.botId];

      if (tk.botId !== EVERYONE && !known.has(tk.botId)) {
        warnings.push("이 방에 없는 봇이 지목되어 있습니다. 칩을 지우고 다시 골라주세요.");
        // 라우팅 자리였으면 **줄 맨 앞은 소비된 것**으로 친다 — 뒤따르는 글자가
        // 갑자기 «첫 멘션 앞의 텍스트»가 되어 엉뚱한 이유로 막히면 안 된다.
        if (routing) { chaining = true; orphanAfterMention = true; }
        continue;
      }
      if (tk.botId === EVERYONE && ids.length === 0) {
        warnings.push("방에 봇이 없어 @everyone이 가리킬 대상이 없습니다.");
        if (routing) { chaining = true; orphanAfterMention = true; }
        continue;
      }

      if (!routing) {
        // 문장 중간 칩은 **참조**다. 글자처럼 취급해 그 자리에 이름을 남긴다.
        const label = tk.botId === EVERYONE ? "@everyone" : `@${known.get(tk.botId)!.name}`;
        if (open) open.text += label;
        else orphan += label;
        continue;
      }

      if (chaining && open) {
        // 연속 칩 — 같은 그룹에 더한다. 중복은 한 번만 (같은 봇에게 두 번 보낼 이유가 없다)
        for (const id of ids) if (!open.botIds.includes(id)) open.botIds.push(id);
        open.mentionAt.push(n);
      } else {
        push(open);
        open = { botIds: [...ids], text: "", mentionAt: [n] };
      }
      chaining = true;
      atLineHead = true;
      continue;
    }

    // ── 글자
    const text = tk.text;
    if (open) open.text += text;
    else orphan += text;

    // 줄바꿈이 있으면 **마지막 줄바꿈 뒤**가 지금 위치다
    const at = text.lastIndexOf("\n");
    if (at >= 0) {
      atLineHead = text.slice(at + 1).trim() === "";
      // 줄이 바뀌었으니 연속은 끊긴다 — 다음 칩은 새 그룹이다.
      // 다만 **칩 사이의 공백·줄바꿈만이라면** 아직 연속이다(§4.1.2 규칙 3).
      chaining = chaining && text.trim() === "";
    } else if (text.trim() !== "") {
      atLineHead = false;
      chaining = false;
    }
  }
  push(open);

  /*
   * ★ **맨 앞에 지목 없이 쓴 글은 전원에게 간다.**
   *
   * 처음엔 막았다 — «깜빡했는데 전원이 파일을 고친다»가 무서워서였다.
   * 그 규칙을 정할 때는 **보내기 전 요약이 없었다.** 지금은 입력창 위에
   * «누구에게 가나»가 띄므로 깜빡은 보내기 전에 드러난다 — 조용한 사고가 아니다.
   *
   * 반대편은 비쌀다: 단체방에서 제일 흔한 «다들 이거 봐줘»에 매번
   * `@everyone`을 치게 하는 것이다. **기본값이 수고가 되면 사람은 다른 길을
   * 찾는다** — 그러다 진짜로 지목해야 할 때도 굴러가게 된다.
   *
   * `@everyone`은 남긴다 — **중간 블록**에서는 대신할 게 없다.
   */
  const head = orphan.trim();
  if (head && orphanAfterMention) {
    /*
     * 지목하려던 봇을 못 찾았다. 그 글은 **갈 곳이 없다** — 전원으로
     * 넓히면 조용히 넓혔지는 것이므로 보내지 않는다.
     *
     * 하지만 **나머지까지 죽이지는 않는다.** 멀줦히 지목된 블록은 그대로
     * 보내고, **못 보난 것을 글자까지 짚어** 말해준다 — 다시 쓸 수 있게.
     */
    const bit = head.length > 20 ? `${head.slice(0, 20)}…` : head;
    if (blocks.length > 0) {
      warnings.push(
        `없는 봇에게 보내려던 «${bit}»은 보내지 못했습니다. 나머지는 보냈습니다.`,
      );
      return { blocks, warnings };
    }
    return {
      blocks,
      blocked: `지목한 봇을 찾을 수 없어 «${bit}»을 보내지 못했습니다. 칩을 지우고 다시 골라주세요.`,
      warnings,
    };
  }
  if (head) {
    if (bots.length === 0) {
      return {
        blocks,
        blocked: "방에 봇이 없습니다.",
        warnings,
      };
    }
    // 지목 없이 전원에게 — 연 칩이 없다
    blocks.unshift({ botIds: bots.map((b) => b.id), text: head, mentionAt: [] });
  }

  const blocked =
    blocks.length === 0
      ? "보낼 내용이 없습니다."
      : undefined;

  return { blocks, ...(blocked ? { blocked } : {}), warnings };
}

function nameOf(ids: string[], known: Map<string, KnownBot>): string {
  const names = ids.map((id) => known.get(id)?.name ?? id);
  return names.join("·");
}

/**
 * 화면에 다시 그릴 수 있게 **토큰을 글로** 편다.
 *
 * 저장은 블록별로 쪼개지만(§4.1.2) 사용자가 쓴 원문도 남겨둬야 «내가 뭐라고
 * 썼더라»에 답할 수 있다. 칩은 `@이름`으로 편다.
 */
export function composeText(tokens: ComposeToken[], bots: KnownBot[]): string {
  const known = new Map(bots.map((b) => [b.id, b]));
  return tokens
    .map((t) =>
      t.kind === "text"
        ? t.text
        : t.botId === EVERYONE
          ? "@everyone"
          : `@${known.get(t.botId)?.name ?? "알 수 없는 봇"}`,
    )
    .join("");
}
