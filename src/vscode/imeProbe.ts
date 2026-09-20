import * as vscode from "vscode";

/**
 * **한글 IME × `contenteditable` 시험판** (v2.0 선결 과제).
 *
 * 단체방의 멘션 칩(§4.1.2)은 `contenteditable` + `<span contenteditable="false">`
 * 구조를 요구한다. 그런데 그 조합은 **한글 조합 중 입력이 깨지는 사례가 잦다** —
 * 로드맵이 «주 사용 언어라 선결 과제»라고 적어둔 이유다.
 *
 * 🔴 **이건 jsdom으로 못 잰다.** 조합(composition)은 OS의 IME가 만드는 것이라
 * 가짜 이벤트로 흉내 내면 «우리가 만든 이벤트가 우리 코드를 통과했다»만 확인하게
 * 된다. 실제 VSCode 웹뷰에서 **사람이 쳐봐야** 답이 나온다.
 *
 * 그래서 이 패널은 **제품 기능이 아니라 자**다. 같은 문장을 두 입력창에 쳐보고,
 * 글자가 빠지는지·칩이 통째로 지워지는지·Enter가 조합을 끊는지를 눈과 로그로
 * 함께 확인한다. 답이 나오면(칩으로 간다 / textarea 폴백으로 간다) 지운다.
 */
export function openImeProbe(ctx: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "aiInOne.imeProbe",
    "AI in One — 한글 입력 시험",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = html();
  ctx.subscriptions.push(panel);
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
  h2 { font-size: 14px; margin: 20px 0 6px; }
  p.dim { color: var(--vscode-descriptionForeground); margin: 4px 0 10px; }
  .box {
    min-height: 62px; padding: 8px 10px; border: 1px solid var(--vscode-input-border, #555);
    border-radius: 6px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); outline: none; white-space: pre-wrap;
  }
  textarea.box { width: 100%; resize: vertical; font: inherit; }
  .chip {
    display: inline-block; padding: 1px 7px; margin: 0 2px; border-radius: 9px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    user-select: none;
  }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  button {
    padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    cursor: pointer; font: inherit;
  }
  .verdict { padding: 8px 10px; border-left: 3px solid var(--vscode-focusBorder); margin: 10px 0; }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .bad { color: var(--vscode-errorForeground, #f14c4c); }
  pre#log {
    max-height: 220px; overflow: auto; padding: 8px 10px; border-radius: 6px;
    background: var(--vscode-textCodeBlock-background); font-size: 11px; line-height: 1.5;
  }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h2>무엇을 재는가</h2>
<p class="dim">
  단체방 입력창에 <b>멘션 칩</b>을 넣으려면 <code>contenteditable</code>이 필요합니다.
  그게 <b>한글 조합을 깨뜨리는지</b>가 이 시험의 전부입니다. 깨지면 칩을 포기하고
  <code>textarea</code> 폴백으로 갑니다.
</p>

<h2>1. 칩이 있는 contenteditable — <span class="dim">여기가 진짜 후보</span></h2>
<p class="dim">아래 상자에 <b>«안녕하세요 반갑습니다»</b>를 칩 뒤에 이어서 쳐보세요.</p>
<div class="box" id="ce" contenteditable="true"><span class="chip" contenteditable="false">@Claude</span>&nbsp;</div>
<div class="row">
  <button id="add">칩 하나 더 넣기</button>
  <button id="reset">처음으로</button>
  <span class="dim" id="ceLen"></span>
</div>

<h2>2. 견줄 대상 — 평범한 textarea</h2>
<p class="dim">같은 문장을 여기에도 쳐보세요. <b>둘이 다르면</b> 원인은 contenteditable입니다.</p>
<textarea class="box" id="ta" rows="2"></textarea>

<h2>3. 확인할 것</h2>
<div class="verdict" id="verdict">
  아직 아무것도 안 쳤습니다.
</div>
<p class="dim">
  · 글자가 <b>빠지거나 겹치는지</b> (예: «안녕하세요» → «안녕하세요요», «안녕하세」)<br>
  · 조합 중에 <b>커서가 튀는지</b><br>
  · <b>백스페이스 한 번</b>에 칩이 통째로 지워지는지<br>
  · 조합 중 <b>Enter</b>가 글자를 자르는지 (한글 확정과 전송이 겹치는 자리)
</p>

<h2>4. 일어난 일</h2>
<pre id="log"></pre>

<script nonce="${nonce}">
(function () {
  const ce = document.getElementById("ce");
  const ta = document.getElementById("ta");
  const log = document.getElementById("log");
  const verdict = document.getElementById("verdict");
  const ceLen = document.getElementById("ceLen");

  const seen = { compositions: 0, enterWhileComposing: 0, chipWholeDelete: 0, chipPartial: 0 };
  let composing = false;

  const say = (s) => {
    log.textContent += s + "\\n";
    log.scrollTop = log.scrollHeight;
  };
  const textOf = (el) =>
    [...el.childNodes].map((n) => (n.nodeType === 3 ? n.data : n.classList?.contains("chip") ? "[칩]" : n.textContent)).join("");

  const paint = () => {
    const t = textOf(ce).replace(/\\u00a0/g, " ");
    ceLen.textContent = "지금 내용: " + JSON.stringify(t);
    const chips = ce.querySelectorAll(".chip").length;
    const lines = [];
    lines.push("조합 " + seen.compositions + "회");
    if (seen.chipPartial > 0) {
      lines.push('<span class="bad">칩이 <b>글자 단위로 부서졌습니다</b> — 통째 삭제가 안 됩니다</span>');
    } else if (seen.chipWholeDelete > 0) {
      lines.push('<span class="ok">칩이 <b>한 번에</b> 지워집니다</span>');
    }
    if (seen.enterWhileComposing > 0) {
      lines.push('<span class="bad">조합 중 Enter가 ' + seen.enterWhileComposing + '번 들어왔습니다 — <b>isComposing으로 걸러야 합니다</b></span>');
    }
    lines.push("칩 " + chips + "개");
    verdict.innerHTML = lines.join("<br>");
  };

  for (const el of [ce, ta]) {
    const who = el === ce ? "칩상자" : "textarea";
    el.addEventListener("compositionstart", () => {
      composing = true;
      if (el === ce) seen.compositions++;
      say(who + "  조합 시작");
      paint();
    });
    el.addEventListener("compositionupdate", (e) => say(who + "  조합 중: " + JSON.stringify(e.data)));
    el.addEventListener("compositionend", (e) => {
      composing = false;
      say(who + "  조합 끝: " + JSON.stringify(e.data));
      paint();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // ★ 여기가 핵심이다. 조합 중 Enter는 **확정**이지 전송이 아니다.
        if (e.isComposing || composing) {
          seen.enterWhileComposing++;
          say(who + "  ⚠ 조합 중 Enter (isComposing=" + e.isComposing + ") — 전송하면 글자가 잘린다");
        } else {
          say(who + "  Enter (조합 아님) — 전송해도 되는 자리");
        }
        e.preventDefault();
        paint();
      }
      if (e.key === "Backspace" && el === ce) {
        const before = ce.querySelectorAll(".chip").length;
        setTimeout(() => {
          const after = ce.querySelectorAll(".chip").length;
          const broke = [...ce.querySelectorAll(".chip")].some((c) => c.textContent.length < 3);
          if (broke) { seen.chipPartial++; say("칩상자  ⚠ 칩이 부서졌다"); }
          else if (after < before) { seen.chipWholeDelete++; say("칩상자  칩이 통째로 지워졌다"); }
          paint();
        }, 0);
      }
    });
    el.addEventListener("input", () => paint());
  }

  document.getElementById("add").addEventListener("click", () => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.contentEditable = "false";
    chip.textContent = "@Codex";
    ce.append(chip, document.createTextNode("\\u00a0"));
    ce.focus();
    paint();
  });
  document.getElementById("reset").addEventListener("click", () => {
    ce.innerHTML = '<span class="chip" contenteditable="false">@Claude</span>&nbsp;';
    ta.value = "";
    log.textContent = "";
    seen.compositions = 0; seen.enterWhileComposing = 0;
    seen.chipWholeDelete = 0; seen.chipPartial = 0;
    paint();
  });

  ce.focus();
  paint();
})();
</script>
</body>
</html>`;
}
