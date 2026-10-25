import { toUnits } from "../shared/types.js";
import { agentAccount, type Clearance } from "./engine.js";

interface Scenario {
  merchantId: string;
  min: number;
  max: number;
  memo: string[];
  weight: number;
  /** "hold" scenarios are skipped while the tower already has a queue of holds. */
  kind: "normal" | "hold" | "deny";
}

/** Traffic patterns per call sign. Amounts in whole tokens. */
const TRAFFIC: Record<string, { weight: number; scenarios: Scenario[] }> = {
  "HERON-417": {
    weight: 3,
    scenarios: [
      { merchantId: "m_helios", min: 120, max: 950, memo: ["8×H200 reserved block", "spot GPU hours", "eval cluster top-up"], weight: 10, kind: "normal" },
      { merchantId: "m_quanta", min: 20, max: 300, memo: ["batch inference credits", "embedding job"], weight: 4, kind: "normal" },
      { merchantId: "m_helios", min: 1100, max: 1450, memo: ["weekend training run"], weight: 1.2, kind: "hold" },
      { merchantId: "m_cobalt", min: 180, max: 260, memo: ["CRM seat expansion"], weight: 1, kind: "deny" },
      { merchantId: "m_helios", min: 2100, max: 2600, memo: ["full-node reservation"], weight: 0.8, kind: "deny" },
    ],
  },
  "KITE-221": {
    weight: 5,
    scenarios: [
      { merchantId: "m_signal", min: 0.002, max: 0.01, memo: ["signal ETH", "signal SOL", "signal BTC"], weight: 10, kind: "normal" },
      { merchantId: "m_tidewater", min: 0.5, max: 3, memo: ["shipping-lane dataset", "port congestion feed"], weight: 5, kind: "normal" },
      { merchantId: "m_quanta", min: 0.04, max: 0.04, memo: ["summarize filing"], weight: 4, kind: "normal" },
      { merchantId: "m_tidewater", min: 11, max: 18, memo: ["full historical archive"], weight: 1, kind: "deny" },
      { merchantId: "m_tiger", min: 2, max: 3, memo: ["odds feed"], weight: 0.6, kind: "deny" },
    ],
  },
  "OSPREY-090": {
    weight: 2,
    scenarios: [
      { merchantId: "m_northstar", min: 180, max: 780, memo: ["SFO→JFK economy", "AUS→DEN", "BOS→ORD"], weight: 6, kind: "normal" },
      { merchantId: "m_lumen", min: 120, max: 650, memo: ["2 nights Berlin", "3 nights Lisbon"], weight: 5, kind: "normal" },
      { merchantId: "m_northstar", min: 900, max: 2100, memo: ["SFO→LHR business", "team offsite block"], weight: 1.4, kind: "hold" },
      { merchantId: "m_tiger", min: 250, max: 400, memo: ["\"hospitality\" package"], weight: 0.6, kind: "deny" },
    ],
  },
  "WREN-733": {
    weight: 2.5,
    scenarios: [
      { merchantId: "m_pixelhaus", min: 40, max: 380, memo: ["retargeting flight DE", "creative test FR", "brand lift NL"], weight: 8, kind: "normal" },
      { merchantId: "m_cobalt", min: 60, max: 200, memo: ["seat renewal"], weight: 3, kind: "normal" },
      { merchantId: "m_kestrelx", min: 120, max: 180, memo: ["EURC → USDC rebalance"], weight: 0.6, kind: "hold" },
      { merchantId: "m_kestrelrelay", min: 80, max: 120, memo: ["\"growth partner\" payout"], weight: 0.8, kind: "deny" },
    ],
  },
  "FALCON-512": {
    weight: 1.5,
    scenarios: [
      { merchantId: "m_atlas", min: 400, max: 900, memo: ["pallet freight", "customs brokerage"], weight: 4, kind: "normal" },
      { merchantId: "m_meridian", min: 3000, max: 4800, memo: ["USDC → T-bill fund sweep", "OTC rebalance"], weight: 2, kind: "normal" },
      { merchantId: "m_cobalt", min: 600, max: 950, memo: ["annual CRM contract"], weight: 2, kind: "normal" },
      { merchantId: "m_atlas", min: 2200, max: 2800, memo: ["container deposit"], weight: 0.8, kind: "hold" },
      { merchantId: "m_meridian", min: 9000, max: 20000, memo: ["quarter-end treasury sweep"], weight: 1, kind: "hold" },
      { merchantId: "m_nightjar", min: 2000, max: 3000, memo: ["vendor settlement"], weight: 0.8, kind: "deny" },
    ],
  },
  "SWIFT-008": {
    weight: 0.25,
    scenarios: [{ merchantId: "m_signal", min: 0.01, max: 0.01, memo: ["scheduled scrape"], weight: 2, kind: "deny" }],
  },
};

const MAX_HOLDS = 5;
/** Length of a sandbox "day": limits refill this often so a long-running demo never starves. */
export const SANDBOX_PERIOD_MS = 15 * 60_000;

function pick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function roundAmount(value: number): number {
  if (value < 1) return toUnits(Number(value.toFixed(4)));
  if (value < 50) return toUnits(Number(value.toFixed(2)));
  return toUnits(Math.round(value * 100) / 100);
}

/** Autonomous sandbox traffic so the tower is never quiet. */
export class Simulator {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly clearance: Clearance,
    private readonly cadence = { minMs: 900, maxMs: 2400 },
  ) {}

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    const loop = () => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => {
          if (this.timer) loop();
        });
      }, this.cadence.minMs + Math.random() * (this.cadence.maxMs - this.cadence.minMs));
    };
    loop();
    this.clearance.simulatorRunning = true;
    this.clearance.emit({ type: "simulator", data: { running: true, periodStartedAt: this.clearance.periodStartedAt } });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearance.simulatorRunning = false;
    this.clearance.emit({ type: "simulator", data: { running: false, periodStartedAt: this.clearance.periodStartedAt } });
  }

  /** Generate one payment. `instant` skips stage delays (used for backfill). */
  async tick(opts: { instant?: boolean; normalOnly?: boolean } = {}) {
    const { clearance } = this;
    clearance.expireHolds();
    const now = clearance.now();
    const periodStart = clearance.periodStartedAt ?? now;
    if (clearance.periodStartedAt === null || now - periodStart > SANDBOX_PERIOD_MS) clearance.startSandboxPeriod();

    const agents = [...clearance.agents.values()].filter((a) => TRAFFIC[a.callSign]);
    if (!agents.length) return;
    const holds = [...clearance.intents.values()].filter((i) => i.stage === "hold").length;

    // Try a few draws: agents that are ahead of their pace for the period sit this one out.
    for (let attempt = 0; attempt < 6; attempt++) {
      const agent = pick(agents.map((a) => ({ agent: a, weight: TRAFFIC[a.callSign].weight }))).agent;
      const options = TRAFFIC[agent.callSign].scenarios.filter(
        (s) => (!opts.normalOnly || s.kind === "normal") && !(s.kind === "hold" && holds >= MAX_HOLDS),
      );
      if (!options.length) continue;
      const scenario = pick(options);
      const amount = roundAmount(scenario.min + Math.random() * (scenario.max - scenario.min));

      if (scenario.kind === "normal" && !opts.normalOnly) {
        const mandate = clearance.mandates.get(agent.mandateId);
        if (mandate) {
          // Spread spend evenly across the sandbox period instead of front-loading it.
          const elapsed = Math.min(1, (clearance.now() - (clearance.periodStartedAt ?? now)) / SANDBOX_PERIOD_MS);
          const allowance = mandate.dailyLimit * 0.9 * Math.min(1, elapsed + 0.15) + mandate.perTxLimit;
          if (clearance.spend(agent.id).day + amount > Math.min(allowance, mandate.dailyLimit * 0.9)) continue;
        }
      }
      await this.fly(agent.id, scenario, amount, opts);
      return;
    }
  }

  private async fly(agentId: string, scenario: Scenario, amount: number, opts: { instant?: boolean; normalOnly?: boolean }) {
    const { clearance } = this;
    const agent = clearance.requireAgent(agentId);

    // Keep the fleet fuelled: refill from treasury when a wallet runs low.
    if (agent.status === "active" && clearance.ledger.balance(agentAccount(agent.id)) < amount * 3) {
      try {
        clearance.topUp(agent.id, Math.max(amount * 20, toUnits(50)));
      } catch {
        /* treasury empty — the payment will divert on insufficient funds */
      }
    }

    await clearance.submit({
      agentId: agent.id,
      merchantId: scenario.merchantId,
      amount,
      memo: scenario.memo[Math.floor(Math.random() * scenario.memo.length)],
      source: "simulator",
      instant: opts.instant,
      backfill: opts.normalOnly,
    });
  }
}
