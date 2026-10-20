/**
 * ★ **창 공통 — 마크다운 그리기** (말풍선 · 설명글).
 */
import { el, icon } from "./dom.js";
import { post } from "./state.js";

/**
 * 에이전트 출력은 거의 항상 마크다운이다. 평문으로 흘리면 읽기가 크게 나빠진다.
 *
 * **`innerHTML`을 쓰지 않는다** — 에이전트가 만든 문자열이므로 노드로 직접 짓는다.
 * 표는 아직 다루지 않는다(백로그).
 */
export function renderMarkdown(host: HTMLElement, text: string): void {
  // 펜스로 먼저 가른다. 코드 안의 `*`나 `#`이 서식으로 오해받으면 안 된다.
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const lang = (nl >= 0 ? part.slice(0, nl) : "").trim();
      const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, "");
      host.append(codeBlock(code, lang));
      return;
    }
    if (part) renderBlocks(host, part);
  });
}

function renderBlocks(host: HTMLElement, text: string): void {
  const lines = text.split("\n");
  let para: string[] = [];
  let i = 0;

  const flush = () => {
    if (para.length === 0) return;
    const p = el("p");
    renderInline(p, para.join("\n"));
    host.append(p);
    para = [];
  };

  const bulletOf = (s: string) => /^\s*[-*+]\s+(.*)$/.exec(s);
  const numberOf = (s: string) => /^\s*\d+[.)]\s+(.*)$/.exec(s);
  const quoteOf = (s: string) => /^\s*>\s?(.*)$/.exec(s);

  while (i < lines.length) {
    const line = lines[i]!;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // 말풍선 안이라 h1으로 시작하면 너무 크다. 두 단계 낮춘다.
      const node = el(`h${Math.min(heading[1]!.length + 2, 6)}` as "h3");
      renderInline(node, heading[2]!);
      host.append(node);
      i++;
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      host.append(el("hr"));
      i++;
      continue;
    }

    const ordered = !bulletOf(line) && !!numberOf(line);
    if (bulletOf(line) || ordered) {
      flush();
      const list = el(ordered ? "ol" : "ul");
      for (;;) {
        const item = ordered ? numberOf(lines[i] ?? "") : bulletOf(lines[i] ?? "");
        if (!item) break;
        const li = el("li");
        renderInline(li, item[1]!);
        list.append(li);
        i++;
      }
      host.append(list);
      continue;
    }

    // 표 (GFM). **에이전트가 비교·요약에 자주 쓴다** — 못 그리면 `|---|---|`가
    // 그대로 나와서 정작 읽어야 할 답이 제일 안 읽힌다.
    if (isTableRow(line) && isTableRule(lines[i + 1] ?? "")) {
      flush();
      host.append(tableNode(lines, i, (next) => (i = next)));
      continue;
    }

    if (quoteOf(line)) {
      flush();
      const buf: string[] = [];
      for (;;) {
        const q = quoteOf(lines[i] ?? "");
        if (!q) break;
        buf.push(q[1]!);
        i++;
      }
      const bq = el("blockquote");
      renderBlocks(bq, buf.join("\n"));
      host.append(bq);
      continue;
    }

    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
}

/**
 * 코드 블록 하나.
 *
 * **복사 버튼이 붙는다.** 에이전트가 준 명령이나 코드를 쓰려면 드래그해서
 * 골라야 하는데, 여러 줄이면 그게 번거롭고 앞뒤 공백까지 딸려온다.
 *
 * 문법 강조는 아직 없다 — 라이브러리를 들여야 하는 일이라 따로 정한다.
 * 언어 이름은 받아서 표시만 한다.
 */
function codeBlock(code: string, lang: string): HTMLElement {
  const copy = el("button", { class: "copy", title: "복사" }, icon("copy")) as HTMLButtonElement;
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(code).then(
      () => {
        // 눌렀는지 아닌지 모르면 또 누르게 된다
        copy.replaceChildren(icon("check"));
        setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
      },
      () => {
        copy.replaceChildren(icon("error"));
        setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
      },
    );
  });

  return el(
    "div",
    { class: "code-wrap" },
    el(
      "div",
      { class: "code-bar" },
      el("span", { class: "code-lang", text: lang }),
      copy,
    ),
    el("pre", {}, el("code", { text: code })),
  );
}

/** `| a | b |` 처럼 보이는 줄인가. 파이프가 최소 하나는 있어야 한다 */
function isTableRow(line: string): boolean {
  return /\|/.test(line) && line.trim() !== "";
}

/** `|---|:--:|` 구분선. **이 줄이 있어야 표다** — 없으면 그냥 파이프 쓴 문장이다 */
function isTableRule(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

/**
 * `| a | b |` 를 칸으로 쪼갠다.
 *
 * 양끝 파이프는 있어도 없어도 된다(GFM). **`\|`는 칸 구분이 아니다** —
 * 에이전트가 표 안에 코드를 넣으면서 자주 쓴다.
 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out;
}

/** 정렬은 구분선이 정한다 — `:--` 왼쪽, `--:` 오른쪽, `:-:` 가운데 */
function alignOf(rule: string): string {
  const t = rule.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : "";
}

/**
 * 표 하나를 그리고, 다음에 읽을 줄 번호를 알려준다.
 *
 * **칸 수가 안 맞아도 그린다.** 에이전트가 표를 만들다 칸을 빠뜨리는 건 흔한데,
 * 그때 표 전체를 포기하면 내용이 통째로 안 보인다 — 머리 줄 기준으로 맞춘다.
 */
function tableNode(lines: string[], start: number, done: (next: number) => void): HTMLElement {
  const head = splitRow(lines[start]!);
  const aligns = splitRow(lines[start + 1]!).map(alignOf);

  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  head.forEach((cell, c) => {
    const th = el("th");
    if (aligns[c]) th.style.textAlign = aligns[c]!;
    renderInline(th, cell.trim());
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  let i = start + 2;
  for (; i < lines.length && isTableRow(lines[i]!); i++) {
    const cells = splitRow(lines[i]!);
    const tr = el("tr");
    for (let c = 0; c < head.length; c++) {
      const td = el("td");
      if (aligns[c]) td.style.textAlign = aligns[c]!;
      renderInline(td, (cells[c] ?? "").trim());
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  done(i);

  // 좁은 폭에서 표만 가로로 스크롤된다 — 말풍선 전체가 밀리면 안 된다
  return el("div", { class: "table-wrap" }, table);
}

/**
 * `src/foo.ts:42` 같은 걸 클릭 가능하게 (E9).
 *
 * **확장자와 줄 번호가 둘 다 있을 때만** 잡는다. `1:30`(시각)이나 `a:b`를
 * 파일로 오인하면 엉뚱한 곳이 눌린다.
 */
const FILE_REF = /(^|[\s([<'"`])((?:[A-Za-z]:)?(?:[\w.~-]*[/\\])*[\w.-]+\.[A-Za-z]{1,8}):(\d+)(?::(\d+))?/g;

function linkFileRefs(host: HTMLElement, text: string): void {
  FILE_REF.lastIndex = 0;
  let last = 0;
  for (let m = FILE_REF.exec(text); m; m = FILE_REF.exec(text)) {
    const start = m.index + m[1]!.length;
    if (start > last) host.append(text.slice(last, start));
    const path = m[2]!;
    const line = Number(m[3]);
    host.append(
      el("button", {
        class: "file-ref",
        text: `${path}:${m[3]}`,
        title: "에디터에서 열기",
        onclick: () => post({ t: "openFile", path, line }),
      }),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) host.append(text.slice(last));
}

/** 인라인 서식. 한 번 훑으면서 처리한다 */
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/g;

function renderInline(host: HTMLElement, text: string): void {
  INLINE.lastIndex = 0;
  let last = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) linkFileRefs(host, text.slice(last, m.index));
    if (m[1] !== undefined) host.append(el("code", { text: m[1] }));
    else if (m[2] !== undefined) host.append(el("strong", { text: m[2] }));
    else if (m[3] !== undefined) host.append(el("strong", { text: m[3] }));
    else if (m[4] !== undefined) host.append(el("em", { text: m[4] }));
    // 링크는 http(s)만. VSCode 웹뷰가 바깥 브라우저로 열어준다.
    else if (m[5] !== undefined) host.append(el("a", { href: m[6]!, text: m[5] }));
    else if (m[7] !== undefined) host.append(el("a", { href: m[7], text: m[7] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) linkFileRefs(host, text.slice(last));
}
