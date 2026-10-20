/**
 * ★ **세션 설정** — 모델 · 모드 · 사고 강도 (리팩토링 ⑧ L2, 2026-10-20).
 *
 * 둘을 따로 든다:
 *
 * - **에이전트별 선택지**(`byAgent`) — 방 만들기 화면 몫. 아직 방도 세션도 없다.
 * - **봇별 지금 값**(`byBot`) — 세션이 실제로 들고 있는 값. 세션은 봇 것이다(B1).
 *
 * 받는 것은 `ConfigPort` 가 전부다 — 아래층 둘(방 저장 · 연결 풀)과 디스크 · 정의.
 * 「에이전트가 스스로 바꿨다」 를 받아 어느 봇인지 고르는 일은 위층(턴 사건)이다 —
 * 여기는 봇이 정해진 뒤에 적기만 한다(`note`).
 */
import type * as acp from "@agentclientprotocol/sdk";

import { describe } from "../acpConnection.js";
import { cachedOptions, dirFor, keepOptions } from "../install/agentInstaller.js";
import { whose, type Rooms } from "../room/rooms.js";
import type { RoomStore } from "../store.js";
import { withTimeout } from "../time.js";
import type { AgentDef, BotInstance, Room } from "../types.js";
import type { WorkspaceHost } from "../workspaceHost.js";
import type { AgentPool } from "./pool.js";

/**
 * 설정 조회에 기다려 주는 시간.
 *
 * **기다리기만 하는 건 실패보다 나쁘다.** CLI가 설치가 안 됐거나 로그인이
 * 안 됐으면 `session/new`가 응답 없이 멈춰 있을 수 있는데, 그러면 권한 시트가
 * *"불러오는 중…"* 에서 영원히 멈춘다 — 사용자는 기능이 없는 줄 안다.
 * 처음 받는 npm 패키지를 감안해 넉넉히 주되, **끝은 있다.**
 */
const CONFIG_PROBE_MS = 90_000;

/**
 * 세션이 쓰는 모델 이름을 봇에 적어 둔다 (B5).
 *
 * **id가 아니라 보이는 이름이다.** 목록에 `Claude · Opus 5`로 나가는데
 * 거기에 `opus-5`가 뜨면 방 만들기 화면에서 고른 것과 달라 보인다.
 * 선택지는 평평하게도, 그룹으로 묶여서도 오므로 둘 다 훑는다.
 *
 * ★ **판이 올라간 것도 여기서 잡힌다** (2026-09-29).
 *
 * 실측해보니(`tests/probes/modelids.cjs`) 어댑터가 주는 모델 id 는 **전부
 * 별명**이다 — `default`, `opus[1m]`, `sonnet`, `haiku`. 날짜 박힌 id 가
 * 하나도 없다. 그래서 `sonnet` 뒤의 판이 갈려도 **id 는 그대로**고, 사라진
 * 값을 지켜보는 `restoreChoices` 의 감시망에는 **처음부터 안 걸린다.**
 *
 *   바뀌는 것은 **이름**이다 — `Sonnet 5` → `Sonnet 6`.
 *
 * 그 신호가 바로 이 함수의 «달라졌다» 였는데, 화면 새로고침에만 쓰고
 * **말은 안 했다.** 이제 «같은 id 인데 이름이 달라진 것»을 따로 알린다.
 */
function noteModel(
  bot: BotInstance,
  options: acp.SessionConfigOption[],
): { changed: boolean; renamed?: string } {
  const opt = options.find((o) => o.category === "model");
  if (!opt || opt.type !== "select") return { changed: false };

  const current = opt.currentValue;
  for (const entry of opt.options) {
    const found =
      "group" in entry
        ? entry.options.find((v) => v.value === current)
        : entry.value === current
          ? entry
          : undefined;
    if (!found) continue;

    /*
     * **id 는 그대로인데 이름이 달라졌다** — 별명 뒤의 판이 바뀐 것이다.
     *
     * 사용자가 직접 고르면 id 가 바뀌므로 여기 안 걸린다 — 그쪽은 `setConfig`
     * 가 이미 알린다. 처음 붙는 봇도 옛 이름이 없어 안 걸린다.
     */
    const was =
      bot.model === current && bot.modelLabel !== undefined && bot.modelLabel !== found.name
        ? bot.modelLabel
        : undefined;

    // **id도 같이 적는다** — 이름만으로는 나중에 다시 적용할 수 없다
    bot.model = found.value;
    if (bot.modelLabel === found.name) return { changed: false };
    bot.modelLabel = found.name;
    return { changed: true, ...(was !== undefined ? { renamed: was } : {}) };
  }
  return { changed: false };
}

/** 설정 캐시의 열쇠. **방 하나 안에서도 봇마다 다르다** (B1) */
function configKeyOf(roomId: string, botId: string): string {
  return `${roomId}:${botId}`;
}

/** 세션 설정층이 받는 것 — 이게 전부다 */
export interface ConfigPort {
  readonly host: WorkspaceHost;
  /** 앱 상태(에이전트별 마지막 모델)를 적는 곳 */
  readonly disk: RoomStore;
  /** 받아둔 자리 — 없으면 디스크 캐시를 안 쓴다 */
  readonly agentRoot: string | undefined;
  /** 조회 제한 — 검사가 줄인다 */
  readonly probeMs: number | undefined;
  readonly pool: AgentPool;
  readonly rooms: Rooms;
  agents(): readonly AgentDef[];
  /** 그 에이전트의 정의 — 모르면 던진다 */
  agent(agentId: string): AgentDef;
}

export class SessionConfig {
  /**
   * 에이전트별 설정 선택지 (B15).
   *
   * **방 만들기 화면 몫이다** — 거기엔 아직 방도 세션도 없다. 방이 생긴 뒤의
   * «지금 값»은 `byBot`을 봐야 한다.
   */
  private readonly byAgent = new Map<string, acp.SessionConfigOption[]>();
  /**
   * 그 방 **그 봇의** 설정. 모드·모델은 세션 것이고 세션은 봇 것이다(B1).
   *
   * 🔴 방까지만 내렸다가 또 샐 뻔했다 — 단체방에 에이전트가 다른 봇 둘이
   * 들어오면 방 열쇠 하나로는 둘을 못 가른다.
   */
  private readonly byBot = new Map<string, acp.SessionConfigOption[]>();
  /** 조회 중인 것들 — 같은 에이전트를 두 번 띄우지 않기 위해 */
  private readonly flight = new Map<string, Promise<acp.SessionConfigOption[]>>();

  constructor(private readonly port: ConfigPort) {}

  /** 그 봇 세션이 지금 들고 있는 값 — 아직 안 붙었으면 없다 */
  ofBot(roomId: string, botId: string): acp.SessionConfigOption[] | undefined {
    return this.byBot.get(configKeyOf(roomId, botId));
  }

  /** 그 봇의 지금 값을 잊는다 — 다음에 붙을 때 세션이 다시 준다 */
  forget(roomId: string, botId: string): void {
    this.byBot.delete(configKeyOf(roomId, botId));
  }

  /** 에이전트별 선택지 — 방 만들기 화면 몫이다. 메모리 · 디스크 · 조회 순 */
  async forAgent(agentId: string): Promise<acp.SessionConfigOption[]> {
    const cached = this.byAgent.get(agentId);
    if (cached) {
      // 백그라운드 갱신은 실패해도 조용히 넘어간다 — 보여줄 값이 이미 있다.
      void this.refresh(agentId).catch(() => {});
      return cached;
    }

    /*
     * ★ **디스크에 적어둔 것이 있으면 CLI 를 안 띄운다** (2026-10-13).
     *
     * 🔴 여기가 **18.6초**짜리 자리다(Antigravity 실측: 띄우기 12.5 + 세션 5).
     * 목록을 알려면 세션을 열어야 하고, 세션을 열려면 CLI 를 띄워야 하니까.
     * 그런데 캐시가 메모리에만 있어서 **창을 열 때마다** 다시 냈다.
     *
     * ⚠️ **뒤에서 갱신도 안 한다.** 갱신하려면 결국 띄워야 해서, 그러면
     * 아낀 것이 없다. 진짜 목록은 **방에 들어갈 때** 세션이 준다 —
     * 거기서 이 값이 덮인다.
     */
    const kept = this.kept(agentId);
    if (kept) {
      this.byAgent.set(agentId, kept);
      return kept;
    }
    // **같은 에이전트를 동시에 두 번 띄우지 않는다.** 방에 들어오면서 한 번,
    // 권한 시트를 열면서 또 한 번 부르는 게 정상 경로다.
    const flight = this.flight.get(agentId);
    if (flight) return flight;

    const started = this.refresh(agentId).finally(() =>
      this.flight.delete(agentId),
    );
    this.flight.set(agentId, started);
    return started;
  }

  /** 받아둔 자리 옆의 캐시 — `agentRoot` 가 없으면 안 쓴다 */
  private kept(agentId: string): acp.SessionConfigOption[] | undefined {
    const root = this.port.agentRoot;
    const pkg = this.port.agents().find((a) => a.id === agentId)?.pkg;
    if (!root || !pkg) return undefined;
    return cachedOptions<acp.SessionConfigOption>(dirFor(root, agentId), pkg);
  }

  private async keep(
    agentId: string,
    options: acp.SessionConfigOption[],
  ): Promise<void> {
    const root = this.port.agentRoot;
    const pkg = this.port.agents().find((a) => a.id === agentId)?.pkg;
    if (!root || !pkg) return;
    await keepOptions(dirFor(root, agentId), pkg, options);
  }

  private async refresh(agentId: string): Promise<acp.SessionConfigOption[]> {
    try {
      const limit = this.port.probeMs ?? CONFIG_PROBE_MS;
      const options = await withTimeout(
        this.port.pool.connection(agentId).probeConfigOptions(this.port.host.defaultCwd()),
        limit,
        /*
         * ⚠️ **첫 실행이면 이건 고장이 아니다** (2026-10-01).
         *
         * 어댑터를 `npx` 가 그때 받는다 — Codex 쪽은 **445MB** 라 느린 망에선
         * 90초를 넘긴다. 예전 문구는 «응답하지 않습니다 · 설치를 마쳤는지
         * 확인하세요» 였는데, 둘 다 틀렸다 — 저쪽은 멀줦히 살아서 **받는 중**
         * 이고, 사용자가 깔 것은 우리가 쓰지도 않는다(`docs/PIN.md` §F5).
         *
         * 물어볼 것은 둘이다: **다시 해보기**(받기가 끝나면 된다)와
         * **로그인**. 설치 판을 맞추라고 하면 엉뙡한 일을 시키는 것이다.
         */
        `${this.port.agent(agentId).label}이(가) ${Math.round(limit / 1000)}초 안에 ` +
          `응답하지 않았습니다. 첫 실행이라면 어댑터를 받는 중일 수 있습니다 ` +
          `(Codex 는 445MB). 잠시 뒤 다시 해보고, 계속 그러면 터미널에서 ` +
          `한 번 실행해 로그인을 마쳤는지 확인하세요.`,
      );
      this.byAgent.set(agentId, options);
      void this.keep(agentId, options);
      return options;
    } catch (err) {
      this.port.host.log(`[${agentId}] 설정 조회 실패: ${describe(err)}`);

      // 이전 값이 있으면 그걸 쓴다 — 일시적인 실패로 목록을 비울 이유가 없다.
      const cached = this.byAgent.get(agentId);
      if (cached) return cached;

      // **빈 배열로 삼키지 않는다.** 그러면 셀이 *"모델이 없다"* 와
      // *"CLI를 못 띄웠다"* 를 구별하지 못해 방 만들기 화면이 아무 설명 없이 비어 보인다.
      throw err;
    }
  }

  note(
    room: Room,
    bot: BotInstance,
    options: acp.SessionConfigOption[],
  ): void {
    this.byBot.set(configKeyOf(room.id, bot.id), options);
    // 만들기 화면의 기본값으로도 쓴다 — 최소한 최근에 본 목록이다
    this.byAgent.set(bot.agentId, options);
    /*
     * ★ **방 세션이 준 것이 제일 참이다** — 그러니 이것도 적어둔다.
     * 조회용 세션을 따로 안 열고도 디스크 캐시가 저절로 최신이 된다.
     */
    void this.keep(bot.agentId, options);
    const model = noteModel(bot, options);
    if (model.changed) this.port.rooms.emitMetas();
    if (model.renamed !== undefined) {
      // **고른 값은 그대로**라는 것까지 적는다 — 안 그러면 «내가 뭘 잘못 눌렀나»가 된다
      this.port.rooms.noteRoom(
        room,
        `${whose(room, bot)}${model.renamed}이(가) ${bot.modelLabel}(으)로 ` +
          `바뀌었습니다 — 고른 값 «${bot.model ?? ""}»은 그대로입니다.`,
        "info",
        [bot.id],
      );
    }

    const mode = options.find((o) => o.category === "mode");
    if (mode && typeof mode.currentValue === "string") bot.agentMode = mode.currentValue;

    // **범주를 가리지 않고 전부 담는다.** 사고 강도든 Fast mode든, 우리가 뜻을
    // 모르는 것이든 — 세션이 들고 있던 값이면 다음에도 그 값이어야 한다.
    const values: Record<string, string | boolean> = {};
    for (const o of options) {
      if (o.currentValue !== undefined && o.currentValue !== null) values[o.id] = o.currentValue;
    }
    bot.configValues = values;
  }

  /** 다음 방의 기본값이 되도록 에이전트별 마지막 선택을 남긴다 (F6) */
  rememberModel(agentId: string, configId: string, value: string): void {
    const options = this.byAgent.get(agentId) ?? [];
    const opt = options.find((o) => o.id === configId);
    if (opt?.category !== "model") return;
    const prev = this.port.disk.getAppState().lastModelByAgent ?? {};
    void this.port.disk.patchAppState({
      lastModelByAgent: { ...prev, [agentId]: value },
    });
  }
}
