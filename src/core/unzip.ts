import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

/**
 * ★ **푸는 일을 우리 가닥에서 내린다** (2026-10-13).
 *
 * 🔴 여기가 통째로 동기였다. 확장 호스트는 **설치된 모든 확장이 나눠 쓰는 한
 * 가닥**이라, 푸는 내내 그 가닥이 우리에게 묶인다 — git 표시도 자동완성도
 * 다른 확장의 명령도 **차례가 안 온다.**
 *
 * ```
 * 실측   푼 뒤 150MB · 310ms · 그동안 타이머 **0번** (20ms 마다 돌 예정이었다)
 *        398MB 로 치면 대략 0.8초
 * ```
 *
 * ⚠️ **`async` 를 붙인다고 풀리지 않는다.** 푸는 것은 **우리 코드**라, 그냥
 * 비동기로 선언해도 그 일을 하는 동안은 똑같이 가닥을 쥔다. 풀리는 까닭은
 * `zlib` · `fs` 의 **비동기 판이 libuv 스레드풀에서 돌기** 때문이다 — 일을
 * 진짜로 **남에게 넘긴다.** 그리고 항목마다 `await` 가 걸리므로 그 틈에
 * 밀린 것들이 끼어든다.
 */
const inflateRaw = promisify(zlib.inflateRaw);

/**
 * **zip 을 Node 안에서 푼다** (2026-10-06).
 *
 * 🔴 **바깥 도구에 안 기댄다.** `tar` 로 풀려고 했더니 갈렸다 — 윈도우의
 * `tar.exe` 는 bsdtar 라 zip 을 풀지만 **GNU tar 는 못 푼다.** `unzip` 은
 * 리눅스에 늘 있지도 않다. 사용자 기계마다 **있는 것이 다른데 없으면
 * 설치가 통째로 막힌다.**
 *
 * zip 은 모양이 고정이고 `zlib` 이 이미 있으니 직접 읽는 편이 낫다. 쓰는
 * 것은 **푸는 것뿐** — 만들지 않는다.
 *
 * ⚠️ **zip-slip 을 막는다.** 받아온 압축파일의 이름은 남이 정한 것이라
 * `../../` 가 들어 있을 수 있다. 그대로 쓰면 **우리 자리 밖에 파일을
 * 쓴다.** 나온 경로가 목적지 안인지 매번 확인한다.
 */

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/**
 * 중앙 목록 한 칸에 실린 **유닉스 권한** 을 꺼낸다. 없으면 `null`.
 *
 * `madeOn` 은 «어디서 만든 zip 인가» — 3 이 유닉스다. 윈도우에서 만든
 * zip 은 0 이고 바깥 속성이 통째로 비어 있어, 그걸 권한으로 읽으면
 * **0 으로 chmod 해버려 아무도 못 읽는 파일이 된다.**
 */
export function modeIn(madeOn: number, outer: number): number | null {
  if (madeOn !== 3) return null;
  const mode = (outer >>> 16) & 0o7777;
  return mode === 0 ? null : mode;
}

/** 끝에서부터 «중앙 목록이 어디서 시작하나» 를 적어둔 자리를 찾는다 */
function findEnd(buf: Buffer): { count: number; at: number } {
  /*
   * 주석이 붙어 있을 수 있어 끝에서 거슬러 올라간다. 주석 길이는 2바이트라
   * 최대 64KB — 그만큼만 본다.
   */
  const from = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    return { count: buf.readUInt16LE(i + 10), at: buf.readUInt32LE(i + 16) };
  }
  throw new Error("zip 이 아닙니다 — 끝 표시를 못 찾았습니다");
}

/**
 * `zip` 을 `into` 아래에 푼다. 돌려주는 것은 **푼 파일 수**.
 *
 * 디렉터리 항목(이름이 `/` 로 끝나는 것)은 만들기만 하고 세지 않는다.
 */
export async function unzip(zip: string, into: string): Promise<number> {
  const buf = await fsp.readFile(zip);
  const end = findEnd(buf);
  let at = end.at;
  let made = 0;

  for (let n = 0; n < end.count; n++) {
    if (buf.readUInt32LE(at) !== CEN) throw new Error(`zip 목록이 깨졌습니다 (${n}번째)`);
    /*
     * 🔴 **유닉스 권한을 같이 꺼낸다** (2026-10-06).
     *
     * zip 은 권한을 중앙 목록의 «바깥 속성» 위 16비트에 싣는다. 이걸
     * 버리면 푸는 쪽의 umask 대로 **0644 로 떨어져 실행이 안 된다** —
     * mac·리눅스에서 `agy_acp_server.par` 를 못 띄운다는 뜻이다.
     * 윈도우용 zip 은 «만든 곳» 이 0 이라 실릴 권한이 없고, 윈도우는
     * 그 비트를 안 보므로 그대로 놓아두면 된다.
     */
    const madeOn = buf.readUInt16LE(at + 4) >> 8;
    const outer = buf.readUInt32LE(at + 38);
    const method = buf.readUInt16LE(at + 10);
    const sizeC = buf.readUInt32LE(at + 20);
    const sizeU = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    /*
     * ⚠️ **여기가 zip-slip 을 막는 자리다.** `path.resolve` 로 펴고 나서
     * 목적지 안인지 본다 — `..` 든 절대경로든 여기서 걸린다.
     */
    const out = path.resolve(into, name);
    const root = path.resolve(into) + path.sep;
    if (out !== path.resolve(into) && !out.startsWith(root)) {
      throw new Error(`압축파일이 바깥을 가리킵니다: ${name}`);
    }

    if (name.endsWith("/")) { await fsp.mkdir(out, { recursive: true }); continue; }

    /* 지역 머리말에서 진짜 데이터 자리를 센다 — 이름·덧붙임 길이가 여기선 다를 수 있다 */
    if (buf.readUInt32LE(localAt) !== LOC) throw new Error(`zip 항목이 깨졌습니다: ${name}`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + sizeC);

    let body: Buffer;
    if (method === 0) body = Buffer.from(raw);
    else if (method === 8) body = await inflateRaw(raw);
    else throw new Error(`모르는 압축 방식 ${method}: ${name}`);

    if (body.length !== sizeU) {
      throw new Error(`푼 크기가 안 맞습니다: ${name} (${body.length} ≠ ${sizeU})`);
    }
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, body);
    /* 3 = 유닉스에서 만든 zip 일 때만 권한이 들어 있다 */
    const mode = modeIn(madeOn, outer);
    if (process.platform !== "win32" && mode !== null) await fsp.chmod(out, mode);
    made += 1;
  }
  return made;
}
