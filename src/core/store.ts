import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  toMeta,
  type AppState,
  type Message,
  type Room,
  type RoomMeta,
  type SearchHit,
} from "./types.js";

/** 트랜스크립트 파일의 한 줄 */
type Line =
  /** 방 속성. 나중 줄이 앞 줄을 덮는다 */
  | ({ t: "room" } & Partial<Omit<Room, "messages">>)
  /** 메시지. **같은 `id`면 병합**이므로 추가와 갱신이 같은 형식이다 */
  | ({ t: "msg"; id: string } & Partial<Message>);

/** 줄 수가 메시지 수의 이 배를 넘으면 정리한다 */
const COMPACT_RATIO = 3;
const COMPACT_MIN_LINES = 64;

/**
 * 파일 기반 영속화 (F5).
 *
 * ```
 * baseDir/
 * ├─ rooms.json          방 메타데이터만 → 목록을 즉시 띄운다
 * ├─ app.json            방에 속하지 않는 상태
 * ├─ rooms/<id>.jsonl    트랜스크립트. **한 줄씩 덧붙인다**
 * └─ blobs/<sha256>      첨부 원본(I9) + 파일 변경 전/후 내용(E6)
 * ```
 *
 * **왜 JSONL인가.** 방 하나를 JSON 하나로 두면 저장할 때마다 전체를 다시 써야 한다.
 * 턴마다 3번 쓰므로(사용자 메시지·응답 자리·턴 종료) 1000턴 쌓인 방에서는
 * **메시지 한 번 주고받을 때마다 수 MB**가 되고, 대화가 길어질수록 선형으로 나빠진다.
 * 덧붙이기는 길이와 무관하게 일정하다.
 *
 * `globalState`를 쓰지 않는 이유는 용량 제한이다. 경로는 셸이 정해서 넘긴다
 * (`context.globalStorageUri`) — core는 `vscode`를 모른다.
 */
export class RoomStore {
  private readonly roomsDir: string;
  private readonly blobsDir: string;
  private readonly indexPath: string;
  private readonly appPath: string;
  private index: RoomMeta[] = [];
  private appState: AppState = {};
  /** 방별 줄 수. 정리 시점 판단에 쓴다 */
  private readonly lineCounts = new Map<string, number>();
  /** 동시 쓰기가 순서를 뒤섞지 않도록 직렬화한다 */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string) {
    this.roomsDir = path.join(baseDir, "rooms");
    this.blobsDir = path.join(baseDir, "blobs");
    this.indexPath = path.join(baseDir, "rooms.json");
    this.appPath = path.join(baseDir, "app.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.roomsDir, { recursive: true });
    await fs.mkdir(this.blobsDir, { recursive: true });
    this.index = await this.readIndex();
    this.appState = await this.readApp();
  }

  // ── 목록 ────────────────────────────────────────────────────────────────

  /** 목록 화면용. 최근 활동순 (B11) */
  listMetas(): RoomMeta[] {
    return [...this.index].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  hasRoom(id: string): boolean {
    return this.index.some((m) => m.id === id);
  }

  // ── 방 ──────────────────────────────────────────────────────────────────

  /** 새 방. 속성과 메시지를 한 번에 쓴다 */
  async createRoom(room: Room): Promise<void> {
    const lines: Line[] = [
      { t: "room", ...stripMessages(room) },
      ...room.messages.map((m) => ({ t: "msg" as const, ...m })),
    ];
    return this.serialize(async () => {
      await writeLinesAtomic(this.roomPath(room.id), lines);
      this.lineCounts.set(room.id, lines.length);
      await this.reindex(room);
    });
  }

  /** 메시지 하나를 덧붙인다 */
  async appendMessage(room: Room, message: Message): Promise<void> {
    return this.append(room, { t: "msg", ...message });
  }

  /**
   * 메시지를 갱신한다. **같은 `id`로 덧붙이면 병합된다.**
   *
   * 바뀐 필드만 넘겨도 되지만, 스트리밍이 끝난 응답처럼 통째로 넘겨도 무방하다.
   */
  async updateMessage(room: Room, patch: Partial<Message> & { id: string }): Promise<void> {
    return this.append(room, { t: "msg", ...patch });
  }

  /** 제목·미읽음·초안 같은 방 속성을 갱신한다 */
  async updateRoom(room: Room, patch: Partial<Omit<Room, "messages">>): Promise<void> {
    return this.append(room, { t: "room", ...patch });
  }

  /**
   * 트랜스크립트를 읽어 방을 복원한다. 없으면 null.
   *
   * 줄을 순서대로 적용한다 — `room`은 속성을 덮고, `msg`는 같은 id를 병합한다.
   */
  async loadRoom(id: string): Promise<Room | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.roomPath(id), "utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }

    let props: Partial<Room> = {};
    const byId = new Map<string, Message>();
    let lines = 0;

    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(text) as Line;
      } catch {
        // 덧붙이는 도중에 꺼지면 마지막 줄이 잘려 있을 수 있다. 버리고 간다.
        continue;
      }
      lines++;
      if (line.t === "room") {
        const { t: _t, ...rest } = line;
        props = { ...props, ...rest };
      } else {
        const prev = byId.get(line.id);
        const { t: _t, ...rest } = line;
        byId.set(line.id, { ...prev, ...rest } as Message);
      }
    }

    this.lineCounts.set(id, lines);
    const room = { ...props, id, messages: [...byId.values()] } as Room;
    return this.healAfterCrash(room);
  }

  /**
   * 방을 지운다 (B6). 그 방만 참조하던 blob도 함께 정리한다.
   *
   * 정리하지 않으면 blob이 계속 쌓인다 — 이미지와 파일 변경 내용이라 금방 커진다.
   */
  async deleteRoom(id: string): Promise<void> {
    return this.serialize(async () => {
      await fs.rm(this.roomPath(id), { force: true });
      this.lineCounts.delete(id);
      this.index = this.index.filter((m) => m.id !== id);
      await writeJsonAtomic(this.indexPath, this.index);
      await this.sweepBlobs();
    });
  }

  // ── 앱 상태 ──────────────────────────────────────────────────────────────

  getAppState(): AppState {
    return { ...this.appState };
  }

  async patchAppState(patch: Partial<AppState>): Promise<void> {
    this.appState = { ...this.appState, ...patch };
    return this.serialize(() => writeJsonAtomic(this.appPath, this.appState));
  }

  // ── blob ────────────────────────────────────────────────────────────────

  /**
   * 내용을 저장하고 sha256을 돌려준다.
   *
   * 이름이 곧 해시이므로 **같은 내용은 한 번만 저장된다** — 같은 스크린샷을
   * 여러 번 붙여도, 같은 파일을 여러 방에서 읽어도 파일은 하나다.
   */
  async putBlob(data: Buffer | string): Promise<string> {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const sha = createHash("sha256").update(buf).digest("hex");
    const dest = path.join(this.blobsDir, sha);
    try {
      await fs.access(dest);
    } catch {
      await fs.writeFile(dest, buf);
    }
    return sha;
  }

  async getBlob(sha256: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(path.join(this.blobsDir, sha256));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getBlobText(sha256: string): Promise<string | null> {
    const buf = await this.getBlob(sha256);
    return buf === null ? null : buf.toString("utf8");
  }

  /**
   * 어느 방도 참조하지 않는 blob을 지운다.
   *
   * 참조 카운트를 관리하는 대신 **전체를 훑어 mark-and-sweep** 한다.
   * 방 삭제처럼 드문 시점에만 돌리므로 비용이 문제되지 않고, 카운트가 어긋나
   * blob이 영영 남는 사고도 없다.
   */
  async sweepBlobs(): Promise<number> {
    const alive = new Set<string>();
    for (const meta of this.index) {
      const room = await this.loadRoom(meta.id);
      if (!room) continue;
      for (const msg of room.messages) {
        for (const a of msg.attachments ?? []) alive.add(a.sha256);
        for (const f of msg.files ?? []) {
          if (f.oldSha256) alive.add(f.oldSha256);
          if (f.newSha256) alive.add(f.newSha256);
        }
      }
    }

    let removed = 0;
    for (const name of await fs.readdir(this.blobsDir)) {
      if (alive.has(name)) continue;
      await fs.rm(path.join(this.blobsDir, name), { force: true });
      removed++;
    }
    return removed;
  }

  /**
   * 모든 방의 대화를 훑는다 (H2).
   *
   * **인덱스를 만들지 않는다.** 방별 파일이라 한 방씩 읽으면 되고, 방이 수백 개가
   * 되어도 체감 지연이 없다(실측: 방 1000개 메타 로드 1.2ms · 방 하나 6000메시지 25ms).
   * 느려지면 그때 인덱스를 넣는다.
   *
   * 최신 방부터 보므로 `limit`에 걸려 잘려도 **쓸모 있는 쪽이 남는다.**
   */
  async search(query: string, limit = 200): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const hits: SearchHit[] = [];
    for (const meta of this.listMetas()) {
      const room = await this.loadRoom(meta.id);
      if (!room) continue;

      for (const msg of room.messages) {
        const at = msg.text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        hits.push({
          roomId: meta.id,
          roomTitle: room.title,
          messageId: msg.id,
          role: msg.role,
          snippet: snippetAround(msg.text, at, needle.length),
          createdAt: msg.createdAt,
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private append(room: Room, line: Line): Promise<void> {
    return this.serialize(async () => {
      await fs.appendFile(this.roomPath(room.id), JSON.stringify(line) + "\n", "utf8");
      const lines = (this.lineCounts.get(room.id) ?? 0) + 1;
      this.lineCounts.set(room.id, lines);
      await this.reindex(room);
      await this.maybeCompact(room, lines);
    });
  }

  /**
   * 갱신 줄이 쌓이면 통합해서 다시 쓴다.
   *
   * 덧붙이기만 하면 파일이 계속 자란다 — 스트리밍 응답 하나가 여러 줄을 남기므로
   * 읽기가 점점 느려진다. 드물게 한 번 정리해 균형을 맞춘다.
   */
  private async maybeCompact(room: Room, lines: number): Promise<void> {
    if (lines < COMPACT_MIN_LINES) return;
    if (lines < (room.messages.length + 1) * COMPACT_RATIO) return;

    const compacted: Line[] = [
      { t: "room", ...stripMessages(room) },
      ...room.messages.map((m) => ({ t: "msg" as const, ...m })),
    ];
    await writeLinesAtomic(this.roomPath(room.id), compacted);
    this.lineCounts.set(room.id, compacted.length);
  }

  /**
   * 턴 도중에 꺼진 흔적을 정리한다.
   *
   * 프로세스는 이미 죽었으므로 영원히 "응답 중"으로 보이면 안 된다.
   */
  private healAfterCrash(room: Room): Room {
    for (const msg of room.messages) {
      if (msg.streaming) {
        msg.streaming = false;
        // 에이전트는 전체를 기억하는데 우리만 잘린 상태다. 나중에 보정할 수 있도록
        // 표식을 남긴다 — 끊긴 건 언제나 이 하나뿐이라 꼬리만 바꿔치기하면 된다.
        msg.truncated = true;
        if (!msg.text && !msg.error) msg.error = "응답이 중단되었습니다.";
      }
    }

    // 답이 달리지 않은 마지막 사용자 메시지는 **전달되지 못한 것**이다.
    //
    // 턴을 시작하면 응답 자리를 **프롬프트보다 먼저 저장**하므로, 그게 없다는 건
    // 프롬프트를 보내기 전에 꺼졌다는 뜻이다. 스트리밍 도중에 꺼진 경우는
    // 빈 응답이라도 남아 있어 여기 걸리지 않는다 — 중복 전송을 막는 핵심이다.
    const last = room.messages.at(-1);
    if (last?.role === "user" && !last.sendFailed) {
      last.sendFailed = "보내지 못했습니다.";
    }
    return room;
  }

  private async reindex(room: Room): Promise<void> {
    const meta = toMeta(room);
    const at = this.index.findIndex((m) => m.id === room.id);
    if (at >= 0) this.index[at] = meta;
    else this.index.push(meta);
    await writeJsonAtomic(this.indexPath, this.index);
  }

  private roomPath(id: string): string {
    return path.join(this.roomsDir, `${id}.jsonl`);
  }

  private async readIndex(): Promise<RoomMeta[]> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RoomMeta[]) : [];
    } catch (err) {
      if (isNotFound(err)) return [];
      // 인덱스가 깨졌다고 방 파일까지 버리면 안 된다. 다시 만든다.
      return this.rebuildIndex();
    }
  }

  /** `rooms.json`이 깨졌을 때 방 파일들로부터 되살린다 */
  private async rebuildIndex(): Promise<RoomMeta[]> {
    const metas: RoomMeta[] = [];
    let names: string[];
    try {
      names = await fs.readdir(this.roomsDir);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const room = await this.loadRoom(name.slice(0, -".jsonl".length));
      if (room) metas.push(toMeta(room));
    }
    await writeJsonAtomic(this.indexPath, metas);
    return metas;
  }

  private async readApp(): Promise<AppState> {
    try {
      const raw = await fs.readFile(this.appPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? (parsed as AppState) : {};
    } catch {
      // 앱 상태는 편의 정보일 뿐이다. 깨졌으면 그냥 비우고 간다.
      return {};
    }
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op, op);
    // 실패가 체인을 끊지 않도록 삼킨 사본을 이어붙인다
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}

function stripMessages(room: Room): Partial<Omit<Room, "messages">> {
  const { messages: _messages, ...rest } = room;
  return rest;
}

/**
 * 임시 파일에 쓰고 rename 한다.
 *
 * 쓰는 도중 VSCode가 죽어도 **반쪽짜리 파일이 남지 않는다.**
 */
async function writeJsonAtomic(dest: string, value: unknown): Promise<void> {
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, dest);
}

async function writeLinesAtomic(dest: string, lines: Line[]): Promise<void> {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, dest);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** 매치 앞뒤를 적당히 남긴다. 너무 길면 목록이 읽히지 않는다 */
function snippetAround(text: string, at: number, length: number): string {
  const PAD = 48;
  const from = Math.max(0, at - PAD);
  const to = Math.min(text.length, at + length + PAD);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}
