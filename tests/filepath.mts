/**
 * **경로가 절대인지 아닌지** (E9 · 2026-09-28).
 *
 * 🔴 판정이 `/^([a-zA-Z]:[\/]|[\/])/` 였다. 문자 묶음 안의 `[\/]` 는
 * **«/» 하나뿐**이다 — 역슬래시를 escape 한 게 아니라 슬래시를 쓸데없이
 * escape 한 것이다. 그래서 `C:\Users\…` 가 **상대경로로 판정됐고**, 앞에
 * cwd 가 한 번 더 붙었다:
 *
 * ```
 * c:\Users\BASE\Desktop\Taein Yoon\c:\Users\BASE\Desktop\Taein Yoon\ABOUT.md
 *   └── 작업 폴더 ─────────────────┘└── 에이전트가 준 절대경로 ──────────┘
 * ```
 *
 * 에이전트는 **플랫폼 기본 구분자**로 경로를 준다. Windows 에서는 역슬래시가
 * 보통이므로 **파일 열기가 사실상 늘 깨져 있었다.** 슬래시로 온 경로만
 * 우연히 멀쩡했다.
 *
 * 화면에서 눌러야 나는 일이라 자동 검사에 안 걸렸다. 그래서 판정을 코어의
 * 작은 함수로 꺼내고 여기서 못 박는다.
 */
import { baseName, isAbsPath, isInside, taskIdOf, underCwd } from "../src/core/types.js";

const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m); console.log("  ok -", m); };

const CWD = "c:\\Users\\BASE\\Desktop\\Taein Yoon";

console.log("\n[★ 역슬래시 절대경로 — 이게 깨져 있었다]");
{
  const p = "c:\\Users\\BASE\\Desktop\\Taein Yoon\\ABOUT_SAMDOLI.md";
  ok(isAbsPath(p), "★ **Windows 역슬래시도 절대경로다** — 여기서 틀려서 cwd 가 두 번 붙었다");
  ok(underCwd(CWD, p) === p, `★ 그대로 둔다 («${underCwd(CWD, p).slice(0, 44)}…»)`);
  ok(!underCwd(CWD, p).includes("Yoon\\c:"), "★ **경로가 두 번 안 붙는다** — 이게 화면에 뜨던 그 모양이다");
}

console.log("\n[슬래시 쪽은 원래 됐다 — 그래서 더 안 보였다]");
{
  const p = "c:/Users/BASE/Desktop/x.md";
  ok(isAbsPath(p), "드라이브 + 슬래시");
  ok(underCwd(CWD, p) === p, "그대로 둔다");
}

console.log("\n[POSIX · UNC 도 절대경로다]");
{
  ok(isAbsPath("/home/me/a.ts"), "★ POSIX 절대경로");
  ok(isAbsPath("\\\\서버\\공유\\a.ts"), "★ **UNC** — 첫 글자가 구분자라 같이 걸린다");
  ok(isAbsPath("/ws/a.ts") && underCwd(CWD, "/ws/a.ts") === "/ws/a.ts", "그대로 둔다");
}

console.log("\n[상대경로는 작업 폴더 밑으로]");
{
  ok(!isAbsPath("src/core/types.ts"), "평범한 상대경로");
  ok(underCwd(CWD, "src/a.ts") === `${CWD}/src/a.ts`, "★ 앞에 작업 폴더를 붙인다");
  ok(!isAbsPath("./a.ts") && !isAbsPath("..\\a.ts"), "★ «.» 로 시작하는 것도 상대경로다");
  /*
   * 🔴 이름이 «c» 로 시작하는 파일에 걸리면 안 된다 — 드라이브 문자는
   * **뒤에 «:» 와 구분자**가 와야 한다.
   */
  ok(!isAbsPath("core/types.ts"), "★ «c» 로 시작해도 드라이브가 아니다");
  ok(!isAbsPath("c:notadrive.md"), "★ «:» 만으로는 부족하다 — 구분자까지 와야 한다");
}

console.log("\n[★ 파일 이름 뽑기 — 같은 실수가 다섯 군데 더 있었다]");
{
  /*
   * `path.split(/[\/]/).pop()` 로 이름을 뽑고 있었다. 같은 병이다 —
   * 역슬래시 경로는 안 쪼개져서 **이름 자리에 경로가 통째로** 들어간다.
   * 첨부 이름 · blob 문서 제목 · 선택 영역 이름 · 거절 메시지가 그랬다.
   */
  ok(baseName("c:\\Users\\BASE\\Desktop\\ABOUT_SAMDOLI.md") === "ABOUT_SAMDOLI.md",
     "★ **역슬래시 경로에서 이름만** — 여기서 틀리면 이름 자리에 경로가 다 나온다");
  ok(baseName("/ws/src/a.ts") === "a.ts", "슬래시 쪽도 그대로");
  ok(baseName("c:/ws\\mixed/b.ts") === "b.ts", "★ 섞여 있어도 — 에이전트가 섞어 주기도 한다");
  ok(baseName("a.ts") === "a.ts", "구분자가 없으면 그 자체가 이름");
  ok(baseName("c:\\ws\\dir\\") === "dir", "★ 끝에 구분자가 붙어도 빈 이름이 안 나온다");
}

console.log("\n[작업 폴더 안인지 — 끝의 구분자에 안 속는다]");
{
  ok(isInside("c:/ws/a.ts", "c:/ws"), "평범한 경우");
  ok(isInside("c:\\ws\\a.ts", "c:\\ws\\"),
     "★ **작업 폴더가 역슬래시로 끝나도** — 여기도 «/» 만 털고 있었다");
  ok(!isInside("c:/wsx/a.ts", "c:/ws"),
     "★ 이름이 비슷한 이웃은 안 통과한다 — 원래 규칙 그대로");
}

console.log("\n[★ 백그라운드 작업 id — 깨운 활동을 잇는 실]");
{
  /*
   * 봇이 백그라운드로 뭔가를 띄우면 도구 결과에 출력 파일이 적혀 온다.
   * 나중에 **스스로 깨어나면 제일 먼저 그 파일을 읽는다** — 양쪽에 같은
   * 조각이 있고, 그게 «이 활동이 저 말을 깨웠다»는 유일한 실이다(실측).
   *
   * ★ **영어 문장을 읽지 않는다.** «ID:» 를 찾으면 문구가 바뀌는 순간 조용히
   * 안 맞게 된다. 경로 모양으로 잡는 편이 덜 깨진다.
   */
  const launched = {
    title: "sleep 30 && echo 보라매아흔",
    output: "Command running in background with ID: bxgzrpssp. Output is being " +
            "written to: C:\\Users\\x\\tasks\\bxgzrpssp.output. You will be notified.",
  };
  const woke = {
    title: "Read C:\\Users\\x\\tasks\\bxgzrpssp.output",
    paths: ["C:\\Users\\x\\tasks\\bxgzrpssp.output"],
  };
  ok(taskIdOf(launched) === "bxgzrpssp", `★ **띄운 쪽에서 뽑힌다** (${taskIdOf(launched)})`);
  ok(taskIdOf(woke) === "bxgzrpssp", `★ **깨어난 쪽에서도** (${taskIdOf(woke)})`);
  ok(taskIdOf(launched) === taskIdOf(woke), "★ **같은 조각** — 이걸로 잇는다");

  ok(taskIdOf({ title: "Read /ws/src/a.ts" }) === undefined,
     "★ 평범한 읽기는 안 걸린다 — 아무 활동이나 짚으면 틀린 연결이 된다");
  ok(taskIdOf({ title: "Bash", output: "done" }) === undefined, "★ 결과가 없어도 안 터진다");
  ok(taskIdOf({}) === undefined, "★ 빈 것도");
}

console.log("\n전부 통과");
