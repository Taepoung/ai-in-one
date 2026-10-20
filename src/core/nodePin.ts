/**
 * ★ **Node 도 우리가 받는다** (2026-10-07).
 *
 * 사용자: *"노드 20은 이거 깔릴때 같이 깔리게는 못해?"*. 된다. 그리고 그래야
 * 맞다 — **CLI 를 안 깔아도 된다고 해놓고 Node 는 깔라고 하는 것**은 앞뒤가
 * 안 맞는다. VSCode 를 쓰는 사람이 다 JS 를 쓰는 것도 아니다.
 *
 * ⏪ **VSCode 가 품은 Node 를 쓰는 길도 있다.** 재봤고, 띄우는 쪽은 실제로
 * 된다(`ELECTRON_RUN_AS_NODE=1`). 그런데 **받는 쪽이 막힌다** — VSCode 는
 * npm 을 안 품는다. npm 만 따로 받으면 되나 싶었는데:
 *
 * ```
 * npm 12.x   engines = ^22.22.2 || ^24.15.0 || >=26.0.0   ← VSCode 의 22.21.1 을 거절
 * npm 11.21  engines = ^20.17.0 || >=22.9.0               ← 된다
 * ```
 *
 * **한 패치 차이로 갈린다.** 그 길로 가면 우리가 VSCode 의 Node 판에 묶이고,
 * 저쪽이 올리거나 사용자가 옛 VSCode 를 쓰면 **설치가 통째로 막힌다** —
 * 사용자가 손쓸 수 없는 고장이다. 그래서 Node 를 통째로 받아 **핀을 우리가
 * 쥔다.** npm 이 같이 온다.
 *
 * 크기는 win 34MB · linux 29MB · mac 48MB 다. Codex 445MB 옆에서 티가 안 난다.
 *
 * ⚠️ **꼴을 `.zip`·`.tar.gz` 로만 고른다.** 리눅스는 `.tar.xz` 가 더 작지만
 * 푸는 데 `xz` 가 필요하고 그건 늘 있지 않다 — 우리가 이미 가진 배선
 * (`unzip.ts` · `tar -xzf`)으로 끝나는 쪽이 낫다.
 */
export const NODE_PIN = {
  version: "24.21.0",
  at: {
    "win32-x64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip",
      sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    },
    "win32-arm64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-arm64.zip",
      sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
    },
    "darwin-x64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz",
      sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    },
    "darwin-arm64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
      sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    },
    "linux-x64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz",
      sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    },
    "linux-arm64": {
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz",
      sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    },
  } as Record<string, { url: string; sha256: string } | undefined>,
};
