import { useSyncExternalStore } from "react";
import type { Agent, Block, Mandate, Merchant, PaymentIntent, RuleToggle, SanctionEntry, SimulatorState, Snapshot, Stats } from "../../shared/types";

export interface TowerState {
  connected: boolean;
  ready: boolean;
  agents: Agent[];
  mandates: Mandate[];
  merchants: Merchant[];
  intents: PaymentIntent[];
  blocks: Block[];
  balances: Record<string, number>;
  spend: Snapshot["spend"];
  rules: RuleToggle[];
  sanctions: SanctionEntry[];
  stats: Stats;
  simulator: SimulatorState;
  ai: { enabled: boolean; model: string };
}

const MAX_INTENTS = 300;
const MAX_BLOCKS = 200;

let state: TowerState = {
  connected: false,
  ready: false,
  agents: [],
  mandates: [],
  merchants: [],
  intents: [],
  blocks: [],
  balances: {},
  spend: {},
  rules: [],
  sanctions: [],
  stats: { clearedVolume: 0, clearedCount: 0, divertedCount: 0, holdCount: 0, inFlight: 0, p50DecisionMs: 0, blocks: 0 },
  simulator: { running: false, periodStartedAt: null },
  ai: { enabled: false, model: "" },
};

const listeners = new Set<() => void>();
function set(patch: Partial<TowerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function upsert<T extends { id: string }>(list: T[], item: T, cap?: number): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = item;
    return next;
  }
  const next = [...list, item];
  return cap && next.length > cap ? next.slice(next.length - cap) : next;
}

let source: EventSource | null = null;

export function connect() {
  if (source) return;
  source = new EventSource("/api/stream");
  const on = <T,>(type: string, fn: (data: T) => void) =>
    source!.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data) as T));

  on<Snapshot>("snapshot", (s) => set({ ...s, connected: true, ready: true }));
  on<PaymentIntent>("intent", (i) => set({ intents: upsert(state.intents, i, MAX_INTENTS) }));
  on<Block>("block", (b) => {
    if (state.blocks.some((x) => x.height === b.height)) return;
    const blocks = [...state.blocks, b];
    set({ blocks: blocks.length > MAX_BLOCKS ? blocks.slice(blocks.length - MAX_BLOCKS) : blocks });
  });
  on<Agent>("agent", (a) => set({ agents: upsert(state.agents, a) }));
  on<Mandate>("mandate", (m) => set({ mandates: upsert(state.mandates, m) }));
  on<{ balances: TowerState["balances"]; spend: TowerState["spend"] }>("balances", (d) => set(d));
  on<Stats>("stats", (stats) => set({ stats }));
  on<RuleToggle[]>("rules", (rules) => set({ rules }));
  on<SanctionEntry[]>("sanctions", (sanctions) => set({ sanctions }));
  on<SimulatorState>("simulator", (simulator) => set({ simulator }));
  source.onopen = () => set({ connected: true });
  source.onerror = () => set({ connected: false });
}

export function useTower(): TowerState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function getTower() {
  return state;
}
