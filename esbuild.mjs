import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/**
 * ★ **다 쓴 다음에 갈아끼운다** (2026-10-13).
 *
 * 🔴 esbuild 는 파일을 **잘라내고 처음부터 쓴다.** `dist/extension.js` 는
 * 1.2MB 라 그 사이에 **반쪽짜리 파일**이 디스크에 있는 순간이 수십 ms 생긴다.
 * 하필 그때 F5 개발 창이 확장을 읽으면 `require` 가 문법 오류로 터지고,
 * 사용자 눈에 남는 것은 이것뿐이다:
 *
 * ```
 * command 'aiInOne.open' not found
 * ```
 *
 * 명령은 `activate` 의 맨 앞에서 등록하므로(그 앞은 출력창·상태표시줄뿐)
 * 「없다」 는 곧 **모듈을 못 읽었다**는 말이다 — 켜기가 세 번 다 실패해도
 * 명령은 있다. 그래서 의심할 곳이 여기다.
 *
 * 임시 이름으로 다 쓰고 **이름만 바꾼다.** 바꾸는 것은 한 순간이라
 * 반쪽짜리를 읽을 자리가 아예 없어진다 — 읽는 쪽은 **옛 것 아니면 새 것**이다.
 *
 * (소스맵 주석은 esbuild 가 `outfile` 이름으로 적으므로 임시 이름이 새지
 * 않는다 — 우리는 다 지어진 바이트를 옮기기만 한다.)
 */
async function landAtomically(files) {
  for (const f of files) {
    await fs.mkdir(path.dirname(f.path), { recursive: true });
    const tmp = `${f.path}.new`;
    await fs.writeFile(tmp, f.contents);
    /* 윈도우에서 읽는 중이면 잠깐 막힌다 — 몇 번 기다렸다 다시 */
    for (let i = 0; ; i++) {
      try { await fs.rename(tmp, f.path); break; } catch (err) {
        if (i >= 5) { await fs.rm(tmp, { force: true }); throw err; }
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
  }
}

/** 지은 것을 esbuild 가 **직접 쓰지 않게** 하고, 위 함수가 갈아끼운다 */
const atomic = {
  name: "atomic",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.outputFiles) await landAtomically(result.outputFiles);
    });
  },
};

/**
 * 코디콘을 `media/`로 복사한다.
 *
 * 웹뷰의 `localResourceRoots` 밖(node_modules)은 로드할 수 없으므로 확장 안으로 들여온다.
 * 아이콘이 VSCode와 같아야 "확장 안의 웹페이지"가 아니라 앱처럼 보인다 (F8).
 */
async function copyCodicons() {
  const from = "node_modules/@vscode/codicons/dist";
  await fs.mkdir("media", { recursive: true });
  for (const name of ["codicon.css", "codicon.ttf"]) {
    await fs.copyFile(`${from}/${name}`, `media/${name}`);
  }
}

/** 확장 호스트 번들. VSCode는 CJS를 로드하므로 ESM 의존성(@agentclientprotocol/sdk)을 CJS로 변환해 넣는다. */
const extension = {
  entryPoints: ["src/vscode/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** Webview 번들. CSP가 외부 CDN을 막으므로 전부 인라인/번들되어야 한다. */
const webview = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const styles = {
  entryPoints: ["src/webview/style.css"],
  bundle: true,
  outfile: "dist/webview.css",
  minify: production,
  logLevel: "info",
};

await copyCodicons();

/* 셋 다 **다 쓴 다음 갈아끼우는** 길로 — 짓는 중인 반쪽을 아무도 못 읽는다 */
const all = [extension, webview, styles].map((c) => ({
  ...c,
  write: false,
  plugins: [...(c.plugins ?? []), atomic],
}));

if (watch) {
  for (const config of all) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all(all.map((c) => esbuild.build(c)));
}
