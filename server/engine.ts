import { EventEmitter } from "node:events";
import {
  UNIT,
  formatAmount,
  type Agent,
  type Currency,
  type Jurisdiction,
  type KyaLevel,
  type Mandate,
  type Merchant,
  type PaymentIntent,
  type Rail,
  type RuleResult,
  type RuleToggle,
  type SanctionEntry,
  type ServerEvent,
  type Snapshot,
  type Stats,
} from "../shared/types.js";
import { evaluateCompliance, DEFAULT_RULES, FX_USD, SEED_SANCTIONS } from "./compliance.js";
import { fingerprint, generateAgentKeys, id, sha256, walletFromKey } from "../shared/crypto.js";
import { Ledger, LedgerError, verifyChain, type ChainVerification } from "./ledger.js";
import { evaluateMandate } from "./policy.js";

export interface EngineOptions {
  /** Artificial pause between pipeline stages so the console can show movement. */
  stageDelayMs?: number;
  /** Network fee in basis points, credited to the Clearance fee account. */
  feeBps?: number;
  /** Holds older than this are diverted automatically. */
  holdTimeoutMs?: number;
  now?: () => number;
}

export interface PaymentRequest {
  agentId: string;
  merchantId: string;
  amount: number;
  memo?: string;
  rail?: Rail;
  source: PaymentIntent["source"];
  /** Skip stage delays (used by x402 so the HTTP request isn't held open). */
  instant?: boolean;
  /** Synthetic history: not counted toward velocity limits. */
  backfill?: boolean;
}

export interface NewAgentInput {
  name: string;
  callSign?: string;
  owner: string;
  model: string;
  purpose: string;
  jurisdiction: Jurisdiction;
  currency: Currency;
  kyaLevel: KyaLevel;
  mandateId: string;
}

export class ClearanceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const DAY = 86_400_000;
const MAX_INTENTS = 600;
export const FEE_ACCOUNT = "clearance:fees";
export const MINT_ACCOUNT = "external:onramp";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTerminal = (i: PaymentIntent) => i.stage === "cleared" || i.stage === "diverted";

/**
 * The Clearance core: identity registry, mandate store, compliance state,
 * the payment pipeline and the ledger. Everything observable goes through
 * `events` so the console (and anything else) can follow along live.
 */
export class Clearance {
  readonly events = new EventEmitter();
  readonly ledger: Ledger;
  readonly agents = new Map<string, Agent>();
  readonly mandates = new Map<string, Mandate>();
  readonly merchants = new Map<string, Merchant>();
  readonly intents = new Map<string, PaymentIntent>();
  rules: RuleToggle[] = DEFAULT_RULES.map((r) => ({ ...r }));
  sanctions: SanctionEntry[];

  /** Private keys of agents whose keys Clearance custodies (sandbox fleet, x402 lab). */
  private readonly custodial = new Map<string, string>();
  private readonly spendLog = new Map<string, { at: number; amount: number }[]>();
  private readonly attempts = new Map<string, { at: number; usd: number }[]>();
  private readonly decisionTimes: number[] = [];
  private readonly usedNonces = new Map<string, number>();
  simulatorRunning = false;
  /** Start of the current sandbox period; daily and monthly limits count from here when set. */
  periodStartedAt: number | null = null;
  ai = { enabled: false, model: "" };

  readonly stageDelayMs: number;
  readonly feeBps: number;
  readonly holdTimeoutMs: number;
  readonly now: () => number;

  constructor(opts: EngineOptions = {}) {
    this.stageDelayMs = opts.stageDelayMs ?? 0;
    this.feeBps = opts.feeBps ?? 5;
    this.holdTimeoutMs = opts.holdTimeoutMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    this.ledger = new Ledger(this.now);
    this.sanctions = SEED_SANCTIONS.map((s) => ({ ...s, addedAt: this.now() }));
    this.events.setMaxListeners(200);
  }

  emit(event: ServerEvent) {
    this.events.emit("event", event);
  }

  // ── Registry ────────────────────────────────────────────────────────────

  addMerchant(m: Merchant) {
    this.merchants.set(m.id, m);
  }

  saveMandate(input: Omit<Mandate, "id" | "createdAt"> & { id?: string }): Mandate {
    const existing = input.id ? this.mandates.get(input.id) : undefined;
    const mandate: Mandate = {
      ...input,
      id: existing?.id ?? input.id ?? id("mnd"),
      createdAt: existing?.createdAt ?? this.now(),
    };
    this.mandates.set(mandate.id, mandate);
    this.emit({ type: "mandate", data: mandate });
    return mandate;
  }

  createAgent(input: NewAgentInput, opts: { custodial?: boolean } = {}): { agent: Agent; privateKey: string } {
    if (!this.mandates.has(input.mandateId)) throw new ClearanceError("unknown mandate", 404);
    const keys = generateAgentKeys();
    const callSign = (input.callSign || this.makeCallSign()).toUpperCase();
    if ([...this.agents.values()].some((a) => a.callSign === callSign)) {
      throw new ClearanceError(`call sign ${callSign} already in use`, 409);
    }
    const agent: Agent = {
      id: id("agt"),
      callSign,
      name: input.name,
      owner: input.owner,
      model: input.model,
      purpose: input.purpose,
      jurisdiction: input.jurisdiction,
      currency: input.currency,
      publicKey: keys.publicKey,
      fingerprint: fingerprint(keys.publicKey),
      walletAddress: walletFromKey(keys.publicKey),
      kyaLevel: input.kyaLevel,
      status: "active",
      mandateId: input.mandateId,
      createdAt: this.now(),
    };
    this.agents.set(agent.id, agent);
    if (opts.custodial) this.custodial.set(agent.id, keys.privateKey);
    this.emit({ type: "agent", data: agent });
    return { agent, privateKey: keys.privateKey };
  }

  custodialKey(agentId: string): string | undefined {
    return this.custodial.get(agentId);
  }

  updateAgent(agentId: string, patch: Partial<Pick<Agent, "status" | "mandateId" | "kyaLevel">>): Agent {
    const agent = this.requireAgent(agentId);
    if (patch.mandateId && !this.mandates.has(patch.mandateId)) throw new ClearanceError("unknown mandate", 404);
    Object.assign(agent, patch);
    this.emit({ type: "agent", data: agent });
    return agent;
  }

  fund(account: string, amount: number, memo: string) {
    if (!Number.isInteger(amount) || amount <= 0) throw new ClearanceError("amount must be a positive integer");
    const block = this.ledger.transfer(MINT_ACCOUNT, account, amount, memo);
    this.emit({ type: "block", data: block });
    this.emitBalances();
    return block;
  }

  /** Move funds from the owner treasury into an agent's wallet. */
  topUp(agentId: string, amount: number) {
    const agent = this.requireAgent(agentId);
    try {
      const block = this.ledger.transfer(treasuryAccount(agent.owner), agentAccount(agent.id), amount, `top-up ${agent.callSign}`);
      this.emit({ type: "block", data: block });
      this.emitBalances();
      return block;
    } catch (err) {
      if (err instanceof LedgerError) throw new ClearanceError(err.message, 409);
      throw err;
    }
  }

  setRule(ruleId: string, enabled: boolean) {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) throw new ClearanceError("unknown rule", 404);
    rule.enabled = enabled;
    this.emit({ type: "rules", data: this.rules });
    return rule;
  }

  addSanction(name: string, address: string | null, list = "operator") {
    const entry: SanctionEntry = { id: id("sdn"), name, address, list, addedAt: this.now() };
    this.sanctions.push(entry);
    this.emit({ type: "sanctions", data: this.sanctions });
    return entry;
  }

  removeSanction(entryId: string) {
    this.sanctions = this.sanctions.filter((s) => s.id !== entryId);
    this.emit({ type: "sanctions", data: this.sanctions });
  }

  /** Replay protection for signed agent requests and x402 authorizations. */
  claimNonce(nonce: string, ttlMs = 10 * 60_000): boolean {
    const now = this.now();
    for (const [n, exp] of this.usedNonces) if (exp < now) this.usedNonces.delete(n);
    if (this.usedNonces.has(nonce)) return false;
    this.usedNonces.set(nonce, now + ttlMs);
    return true;
  }

  // ── Spend accounting ────────────────────────────────────────────────────

  /**
   * Sandbox only: begin a fresh spending period so daily and monthly limits
   * refill while a demo runs, without rewriting any ledger history.
   */
  startSandboxPeriod() {
    this.periodStartedAt = this.now();
    this.emit({ type: "simulator", data: { running: this.simulatorRunning, periodStartedAt: this.periodStartedAt } });
    this.emitBalances();
  }

  spend(agentId: string): { day: number; month: number } {
    const now = new Date(this.now());
    const floor = this.periodStartedAt ?? 0;
    const dayStart = Math.max(floor, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = Math.max(floor, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let day = 0;
    let month = 0;
    for (const s of this.spendLog.get(agentId) ?? []) {
      if (s.at >= monthStart) month += s.amount;
      if (s.at >= dayStart) day += s.amount;
    }
    return { day, month };
  }

  private recordSpend(agentId: string, amount: number) {
    const log = this.spendLog.get(agentId) ?? [];
    const cutoff = this.now() - 32 * DAY;
    log.push({ at: this.now(), amount });
    this.spendLog.set(agentId, log.filter((s) => s.at >= cutoff));
  }

  private recordAttempt(agentId: string, usd: number) {
    const now = this.now();
    const list = (this.attempts.get(agentId) ?? []).filter((a) => now - a.at < 120_000);
    list.push({ at: now, usd });
    this.attempts.set(agentId, list);
  }

  // ── Pipeline ────────────────────────────────────────────────────────────

  /**
   * Run a payment through identity → mandate → compliance → settlement.
   * Resolves once the intent is cleared, diverted, or parked in a hold.
   */
  async submit(req: PaymentRequest): Promise<PaymentIntent> {
    if (!Number.isInteger(req.amount) || req.amount <= 0) throw new ClearanceError("amount must be a positive integer in base units");
    const agent = this.requireAgent(req.agentId);
    const merchant = this.merchants.get(req.merchantId);
    if (!merchant) throw new ClearanceError("unknown merchant", 404);
    const delay = req.instant ? 0 : this.stageDelayMs;

    const intent: PaymentIntent = {
      id: id("pi"),
      agentId: agent.id,
      merchantId: merchant.id,
      amount: req.amount,
      currency: agent.currency,
      rail: req.rail ?? (merchant.x402 ? "x402" : "base"),
      memo: req.memo ?? "",
      source: req.source,
      stage: "inbound",
      squawk: "1200",
      riskScore: 0,
      trace: [],
      travelRule: null,
      receipt: null,
      createdAt: this.now(),
      decidedAt: null,
      decidedBy: null,
      callout: `${agent.callSign}, ${merchant.name}, ${formatAmount(req.amount, agent.currency)} — radar contact.`,
    };
    this.storeIntent(intent);
    if (!req.backfill) this.recordAttempt(agent.id, (req.amount / UNIT) * FX_USD[agent.currency]);

    const identity: RuleResult = {
      layer: "identity",
      rule: "kya.identity",
      outcome: agent.status === "active" ? "pass" : "fail",
      detail:
        agent.status === "active"
          ? `KYA L${agent.kyaLevel} · key ${agent.fingerprint.slice(0, 11)} · owner ${agent.owner}`
          : `${agent.callSign} is grounded by its operator`,
    };
    intent.trace.push(identity);
    this.emit({ type: "intent", data: intent });
    if (delay) await sleep(delay);

    if (identity.outcome === "fail") {
      return this.divert(intent, "7600", "engine", `${agent.callSign}, unable — you are grounded. Hold position.`);
    }

    intent.stage = "screening";
    this.emit({ type: "intent", data: intent });
    if (delay) await sleep(delay * 1.4);

    const mandate = this.mandates.get(agent.mandateId);
    if (!mandate) return this.divert(intent, "7600", "engine", `${agent.callSign}, unable — no flight plan on file.`);

    const spent = this.spend(agent.id);
    const policy = evaluateMandate({
      mandate,
      merchant,
      amount: req.amount,
      spentToday: spent.day,
      spentThisMonth: spent.month,
      now: this.now(),
    });
    const compliance = evaluateCompliance({
      agent,
      merchant,
      amount: req.amount,
      currency: agent.currency,
      rules: this.rules,
      sanctions: this.sanctions,
      recentAttempts: this.attempts.get(agent.id) ?? [],
      recentAmounts: (this.spendLog.get(agent.id) ?? []).slice(-30).map((s) => s.amount),
      now: this.now(),
    });
    intent.trace.push(...policy.results, ...compliance.results);
    intent.travelRule = compliance.travelRule;
    intent.riskScore = compliance.riskScore + (policy.verdict === "fail" ? 20 : 0);

    if (compliance.verdict === "fail" || policy.verdict === "fail") {
      const squawk = compliance.verdict === "fail" ? compliance.squawk : "7600";
      const reason = [...intent.trace].find((r) => r.outcome === "fail")!;
      const why = squawk === "7500" ? `sanctions hit on ${merchant.name}` : `${reason.rule} — ${reason.detail}`;
      return this.divert(intent, squawk, "engine", `${agent.callSign}, unable — ${why}. Squawk ${squawk}, divert.`);
    }

    if (compliance.verdict === "hold" || policy.verdict === "hold") {
      intent.stage = "hold";
      intent.squawk = compliance.verdict === "hold" && compliance.squawk !== "1200" ? compliance.squawk : "4000";
      const reason = intent.trace.find((r) => r.outcome === "hold")!;
      intent.callout = `${agent.callSign}, hold at the tower — ${reason.rule}. Expect further clearance from a human.`;
      this.emit({ type: "intent", data: intent });
      this.emitStats();
      return intent;
    }

    if (delay) await sleep(delay);
    return this.settle(intent, "engine");
  }

  async approve(intentId: string, by: string): Promise<PaymentIntent> {
    const intent = this.requireHold(intentId);
    intent.trace.push({ layer: "human", rule: "human.approval", outcome: "pass", detail: `approved by ${by}` });
    return this.settle(intent, `human:${by}`);
  }

  deny(intentId: string, by: string, reason = "denied by operator"): PaymentIntent {
    const intent = this.requireHold(intentId);
    intent.trace.push({ layer: "human", rule: "human.approval", outcome: "fail", detail: `${reason} (${by})` });
    const agent = this.requireAgent(intent.agentId);
    return this.divert(intent, intent.squawk === "4000" ? "7600" : intent.squawk, `human:${by}`, `${agent.callSign}, unable — ${reason}. Divert.`);
  }

  /** Divert holds nobody answered in time. */
  expireHolds() {
    const now = this.now();
    for (const intent of this.intents.values()) {
      if (intent.stage === "hold" && now - intent.createdAt > this.holdTimeoutMs) {
        intent.trace.push({ layer: "human", rule: "human.approval", outcome: "fail", detail: "no human response before hold timeout" });
        const agent = this.agents.get(intent.agentId);
        this.divert(intent, intent.squawk, "engine", `${agent?.callSign ?? "UNKNOWN"}, holding fuel exhausted — divert.`);
      }
    }
  }

  private settle(intent: PaymentIntent, by: string): PaymentIntent {
    const agent = this.requireAgent(intent.agentId);
    const merchant = this.merchants.get(intent.merchantId)!;
    const mandate = this.mandates.get(agent.mandateId);

    // Re-check hard limits at settlement: concurrent requests and time spent in a hold
    // must not let an agent exceed what its mandate allows.
    if (mandate) {
      const spent = this.spend(agent.id);
      const recheck = evaluateMandate({ mandate, merchant, amount: intent.amount, spentToday: spent.day, spentThisMonth: spent.month, now: this.now() });
      const breach = recheck.results.find((r) => r.outcome === "fail" && r.rule.startsWith("limit."));
      if (breach) {
        intent.trace.push({ ...breach, layer: "settlement", detail: `at settlement: ${breach.detail}` });
        return this.divert(intent, "7600", by, `${agent.callSign}, unable — ${breach.rule} exceeded at settlement. Divert.`);
      }
    }

    const fee = Math.floor((intent.amount * this.feeBps) / 10_000);
    try {
      const block = this.ledger.transfer(
        agentAccount(agent.id),
        merchantAccount(merchant.id),
        intent.amount,
        `${agent.callSign} → ${merchant.name}${intent.memo ? ` · ${intent.memo}` : ""}`,
        intent.id,
        { account: FEE_ACCOUNT, amount: fee },
      );
      intent.receipt = {
        blockHeight: block.height,
        blockHash: block.hash,
        txRef: `0x${sha256(`${block.hash}:${intent.rail}`)}`,
        fee,
        settledAt: block.timestamp,
        rail: intent.rail,
      };
      intent.trace.push({ layer: "settlement", rule: "ledger.post", outcome: "pass", detail: `block #${block.height} · fee ${formatAmount(fee)}` });
      intent.stage = "cleared";
      intent.squawk = "1200";
      intent.decidedAt = this.now();
      intent.decidedBy = by;
      intent.callout = `${agent.callSign}, cleared direct ${merchant.name}, ${formatAmount(intent.amount, intent.currency)}. Squawk 1200.`;
      this.recordSpend(agent.id, intent.amount);
      this.recordDecision(intent);
      this.emit({ type: "block", data: block });
      this.emit({ type: "intent", data: intent });
      this.emitBalances();
      this.emitStats();
      return intent;
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      intent.trace.push({ layer: "settlement", rule: "wallet.balance", outcome: "fail", detail: err.message });
      return this.divert(intent, "7600", by, `${agent.callSign}, unable — insufficient fuel in wallet. Divert.`);
    }
  }

  private divert(intent: PaymentIntent, squawk: PaymentIntent["squawk"], by: string, callout: string): PaymentIntent {
    intent.stage = "diverted";
    intent.squawk = squawk;
    intent.decidedAt = this.now();
    intent.decidedBy = by;
    intent.callout = callout;
    this.recordDecision(intent);
    this.emit({ type: "intent", data: intent });
    this.emitStats();
    return intent;
  }

  /** Evaluate a hypothetical payment without touching state. */
  dryRun(mandate: Mandate, merchantId: string, amount: number, agentId?: string) {
    const merchant = this.merchants.get(merchantId);
    if (!merchant) throw new ClearanceError("unknown merchant", 404);
    const spent = agentId ? this.spend(agentId) : { day: 0, month: 0 };
    const policy = evaluateMandate({ mandate, merchant, amount, spentToday: spent.day, spentThisMonth: spent.month, now: this.now() });
    const agent = agentId ? this.agents.get(agentId) : undefined;
    const compliance = agent
      ? evaluateCompliance({
          agent,
          merchant,
          amount,
          currency: agent.currency,
          rules: this.rules,
          sanctions: this.sanctions,
          recentAttempts: [],
          recentAmounts: [],
          now: this.now(),
        })
      : null;
    const results = [...policy.results, ...(compliance?.results ?? [])];
    const verdict = results.some((r) => r.outcome === "fail") ? "fail" : results.some((r) => r.outcome === "hold") ? "hold" : "pass";
    return { verdict, results };
  }

  verifyLedger(tamperHeight?: number): ChainVerification & { tampered: number | null } {
    let blocks = this.ledger.blocks;
    if (tamperHeight !== undefined && blocks[tamperHeight]) {
      // Verify a doctored *copy* — demonstrates detection without corrupting the real journal.
      blocks = blocks.map((b) =>
        b.height === tamperHeight
          ? {
              ...b,
              // Still balanced, so only the hash chain can catch it.
              entries: b.entries.map((e, i) =>
                i === 0 ? { ...e, debit: e.debit + 1_000_000 } : i === 1 ? { ...e, credit: e.credit + 1_000_000 } : e,
              ),
            }
          : b,
      );
    }
    return { ...verifyChain(blocks), tampered: tamperHeight ?? null };
  }

  // ── Read models ─────────────────────────────────────────────────────────

  stats(): Stats {
    let clearedVolume = 0;
    let clearedCount = 0;
    let divertedCount = 0;
    let holdCount = 0;
    let inFlight = 0;
    for (const i of this.intents.values()) {
      if (i.stage === "cleared") {
        clearedCount++;
        clearedVolume += i.amount;
      } else if (i.stage === "diverted") divertedCount++;
      else if (i.stage === "hold") holdCount++;
      else inFlight++;
    }
    const sorted = [...this.decisionTimes].sort((a, b) => a - b);
    return {
      clearedVolume,
      clearedCount,
      divertedCount,
      holdCount,
      inFlight,
      p50DecisionMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      blocks: this.ledger.blocks.length,
    };
  }

  balancesAndSpend() {
    const balances = Object.fromEntries(this.ledger.balances);
    const spend: Snapshot["spend"] = {};
    for (const a of this.agents.values()) spend[a.id] = this.spend(a.id);
    return { balances, spend };
  }

  snapshot(): Snapshot {
    const { balances, spend } = this.balancesAndSpend();
    return {
      agents: [...this.agents.values()],
      mandates: [...this.mandates.values()],
      merchants: [...this.merchants.values()],
      intents: [...this.intents.values()].slice(-250),
      blocks: this.ledger.blocks.slice(-120),
      balances,
      spend,
      rules: this.rules,
      sanctions: this.sanctions,
      stats: this.stats(),
      simulator: { running: this.simulatorRunning, periodStartedAt: this.periodStartedAt },
      ai: this.ai,
    };
  }

  requireAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new ClearanceError("unknown agent", 404);
    return agent;
  }

  private requireHold(intentId: string): PaymentIntent {
    const intent = this.intents.get(intentId);
    if (!intent) throw new ClearanceError("unknown payment", 404);
    if (intent.stage !== "hold") throw new ClearanceError(`payment is ${intent.stage}, not on hold`, 409);
    return intent;
  }

  private storeIntent(intent: PaymentIntent) {
    this.intents.set(intent.id, intent);
    if (this.intents.size > MAX_INTENTS) {
      for (const [key, value] of this.intents) {
        if (this.intents.size <= MAX_INTENTS) break;
        if (isTerminal(value)) this.intents.delete(key);
      }
    }
  }

  private recordDecision(intent: PaymentIntent) {
    if (intent.decidedBy !== "engine") return;
    this.decisionTimes.push(Math.max(0, (intent.decidedAt ?? this.now()) - intent.createdAt));
    if (this.decisionTimes.length > 500) this.decisionTimes.shift();
  }

  emitBalances() {
    this.emit({ type: "balances", data: this.balancesAndSpend() });
  }

  emitStats() {
    this.emit({ type: "stats", data: this.stats() });
  }

  private makeCallSign(): string {
    const birds = ["HERON", "KITE", "OSPREY", "WREN", "FALCON", "SWIFT", "PLOVER", "TERN", "MERLIN", "IBIS", "AVOCET", "CURLEW"];
    for (;;) {
      const sign = `${birds[Math.floor(Math.random() * birds.length)]}-${String(Math.floor(Math.random() * 900) + 100)}`;
      if (![...this.agents.values()].some((a) => a.callSign === sign)) return sign;
    }
  }
}

export const agentAccount = (agentId: string) => `agent:${agentId}`;
export const merchantAccount = (merchantId: string) => `merchant:${merchantId}`;
export const treasuryAccount = (owner: string) => `treasury:${owner.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
