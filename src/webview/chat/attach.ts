/**
 * ★ **채팅 화면 — 첨부** (I).
 */
import type { Attachment, Message, Room } from "../../core/types.js";
import { el, icon } from "../common/dom.js";
import { S, post } from "../common/state.js";

/** 에이전트가 받아주는 종류 (I5). 연결 전이면 전부 허용으로 온다 */
type Caps = { image: boolean; audio: boolean; embeddedContext: boolean; fork: "yes" | "no" | "unknown" };

const ANY: Caps = { image: true, audio: true, embeddedContext: true, fork: "unknown" };

/**
 * **에이전트마다 따로 들고 있는다** (v2.0).
 *
 * ⚠ 예전엔 칸이 하나였고 `participants[0]`의 것만 담았다. 단체방에서는
 * 그게 **거짓말이 된다** — Claude·Gemini 방에서 분기 다이얼로그가 Claude를 보고
 * «그대로 갈라집니다»라고 말하는 사이 Gemini는 조용히 폴백으로 떨어졌다.
 * 잡는 것은 D1이 정한 «폴백은 미리 명시한다»이다.
 */
export const capsBy = new Map<string, Caps>();

export const capsOf = (agentId: string): Caps => capsBy.get(agentId) ?? ANY;

/** 방의 봇들을 합친 값 — 첨부처럼 **전원이 받아야** 보낼 수 있는 것에 쓴다 */
function capsAll(r: Room | null | undefined): Caps {
  const list = (r?.participants ?? []).map((b) => capsOf(b.agentId));
  if (list.length === 0) return ANY;
  return {
    image: list.every((c) => c.image),
    audio: list.every((c) => c.audio),
    embeddedContext: list.every((c) => c.embeddedContext),
    fork: list.every((c) => c.fork === "yes")
      ? "yes"
      : list.some((c) => c.fork === "no")
        ? "no"
        : "unknown",
  };
}

/** sha256 → data: URI. 같은 이미지를 두 번 받아오지 않는다 */
export const blobCache = new Map<string, string>();

export const blobWaiters = new Map<string, Array<(uri: string) => void>>();

/**
 * 비전 모델이 실제로 쓰는 해상도.
 *
 * 4K 스크린샷을 그대로 base64로 보내면 **토큰이 폭발한다**(I7). 줄여도 글자는
 * 읽히므로 손해가 없다. 캔버스가 웹뷰에 있으니 보내기 전에 여기서 줄인다.
 */
const MAX_IMAGE_EDGE = 1568;

export async function attachFiles(roomId: string, files: File[]): Promise<void> {
  const items: Array<{ name: string; mimeType: string; base64: string }> = [];
  const rejected: string[] = [];

  for (const file of files) {
    const isImage = file.type.startsWith("image/");
    const isAudio = file.type.startsWith("audio/");
    // 못 받는 종류는 **보내기 전에** 말해준다 — 보내고 조용히 버리면 기다리게 된다
    const able = capsAll(S.room);
    if ((isImage && !able.image) || (isAudio && !able.audio)) {
      rejected.push(`${file.name} — 이 에이전트는 ${isImage ? "이미지" : "오디오"}를 받지 못합니다`);
      continue;
    }
    try {
      items.push(isImage ? await downscale(file) : await rawBytes(file));
    } catch {
      rejected.push(`${file.name} — 읽지 못했습니다`);
    }
  }

  if (rejected.length) noticeInChat(rejected.join("\n"));
  if (items.length) post({ t: "attach", roomId, items });
}

async function rawBytes(file: File): Promise<{ name: string; mimeType: string; base64: string }> {
  return {
    name: file.name,
    mimeType: file.type || "text/plain",
    base64: toBase64(await file.arrayBuffer()),
  };
}

async function downscale(file: File): Promise<{ name: string; mimeType: string; base64: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));

  // 이미 작으면 원본 그대로 — 다시 인코딩하면 오히려 커지거나 흐려진다
  if (scale === 1) {
    bitmap.close();
    return rawBytes(file);
  }

  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // PNG는 스크린샷(글자)에 유리하고, 사진은 JPEG가 훨씬 작다
  const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const url = canvas.toDataURL(mimeType, 0.85);
  return { name: file.name, mimeType, base64: url.slice(url.indexOf(",") + 1) };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  // 한 번에 넘기면 인자 개수 한도에 걸린다
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export function paintChips(): void {
  const c = S.chat;
  if (!c) return;
  c.chips.replaceChildren(...S.pending.map((a) => chipNode(a, true)));
  c.chips.hidden = S.pending.length === 0;
}

/** 보내기 전(제거 가능)과 보낸 뒤(읽기 전용)가 같은 모양이어야 한다 */
function chipNode(a: Attachment, removable: boolean): HTMLElement {
  const node = el(
    "span",
    { class: "chip", title: `${a.name} · ${sizeText(a.byteSize)}` },
    icon(a.mimeType.startsWith("image/") ? "file-media" : "file"),
    el("span", { class: "chip-name", text: a.name }),
    el("span", { class: "chip-size", text: sizeText(a.byteSize) }),
  );

  if (removable) {
    node.append(
      el("button", {
        class: "chip-x",
        title: "빼기",
        onclick: () => {
          S.pending = S.pending.filter((x) => x !== a);
          paintChips();
        },
      }),
    );
    return node;
  }

  // 보낸 뒤: 텍스트면 앞부분을 펼쳐 볼 수 있다 (I8)
  if (!a.mimeType.startsWith("image/") && !a.mimeType.startsWith("audio/")) {
    node.classList.add("openable");
    node.addEventListener("click", () => void togglePreview(node, a));
  }
  return node;
}

/** 뭘 보냈는지 알아야 한다 — 앞 몇 줄만 (I8) */
async function togglePreview(chip: HTMLElement, a: Attachment): Promise<void> {
  const open = chip.nextElementSibling;
  if (open?.classList.contains("preview")) {
    open.remove();
    return;
  }
  const uri = await loadBlob(a);
  const text = decodeDataUri(uri).split("\n").slice(0, 12).join("\n");
  chip.after(el("pre", { class: "preview" }, el("code", { text })));
}

function decodeDataUri(uri: string): string {
  try {
    const bin = atob(uri.slice(uri.indexOf(",") + 1));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "(읽을 수 없습니다)";
  }
}

/** 이미지는 방을 열 때 한꺼번에 싣지 않는다 — 보이는 것만 가져온다 */
function loadBlob(a: Attachment): Promise<string> {
  const hit = blobCache.get(a.sha256);
  if (hit) return Promise.resolve(hit);

  return new Promise((resolve) => {
    const waiting = blobWaiters.get(a.sha256);
    if (waiting) {
      waiting.push(resolve);
      return;
    }
    blobWaiters.set(a.sha256, [resolve]);
    // 경로만 보낸 첨부는 blob이 없다. 셸이 지금 파일을 읽어 준다 (I4).
    post({ t: "needBlob", sha256: a.sha256, ...(a.path ? { path: a.path } : {}) });
  });
}

export function attachmentsNode(m: Message): HTMLElement {
  const wrap = el("div", { class: "attachments" });
  for (const a of m.attachments ?? []) {
    if (a.mimeType.startsWith("image/")) {
      const img = el("img", { class: "thumb", alt: a.name, title: a.name }) as HTMLImageElement;
      img.addEventListener("click", () => img.classList.toggle("zoom"));
      void loadBlob(a).then((uri) => (img.src = uri));
      wrap.append(img);
    } else {
      wrap.append(chipNode(a, false));
    }
  }
  return wrap;
}

function sizeText(bytes: number): string {
  return bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)}KB`
      : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 방 안에 한 줄 안내를 남긴다 (오류가 아니라 알림) */
export function noticeInChat(text: string): void {
  const c = S.chat;
  if (!c) return;
  c.list.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text })));
  if (S.stick) c.list.scrollTop = c.list.scrollHeight;
}
