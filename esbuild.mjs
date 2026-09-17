import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

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

if (watch) {
  for (const config of [extension, webview, styles]) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all([extension, webview, styles].map((c) => esbuild.build(c)));
}
