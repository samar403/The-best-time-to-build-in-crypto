import { describe, expect, it } from "vitest";
import { toUnits, type Agent, type Mandate, type Merchant } from "../shared/types";
import { generateAgentKeys, signMessage, verifyMessage } from "../shared/crypto";
import { Ledger, LedgerError, verifyChain } from "../server/ledger";
import { evaluateMandate } from "../server/policy";
import { DEFAULT_RULES, evaluateCompliance, nameSimilarity, screen, SEED_SANCTIONS } from "../server/compliance";
import { heuristicDraft } from "../server/composer";
import { MERCHANTS } from "../server/seed";

const merchant = (id: string) => MERCHANTS.find((m) => m.id === id)!;

const mandate = (patch: Partial<Mandate> = {}): Mandate => ({
  id: "m",
  name: "test",
  source: "",
  perTxLimit: toUnits(1000),
  dailyLimit: toUnits(3000),
  monthlyLimit: toUnits(20000),
  allowedCategories: null,
  blockedCategories: [],
  allowedMerchants: null,
  blockedMerchants: [],
  approvalThreshold: null,
  activeHoursUtc: null,
  weekdaysOnly: false,
  expiresAt: null,
  createdBy: "human",
  createdAt: 0,
  ...patch,
});

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: "agt_1",
  callSign: "TEST-001",
  name: "Test",
  owner: "Acme",
  model: "claude-opus-5-5",
  purpose: "",
  jurisdiction: "US",
  currency: "USDC",
  publicKey: "",
  fingerprint: "",
  walletAddress: "0xabc",
  kyaLevel: 2,
  status: "active",
  mandateId: "m",
  createdAt: 0,
  ...patch,
});

const sanctions = SEED_SANCTIONS.map((s) => ({ ...s, addedAt: 0 }));
const compliance = (patch: Partial<Parameters<typeof evaluateCompliance>[0]>) =>
  evaluateCompliance({
    agent: agent(),
    merchant: merchant("m_helios"),
    amount: toUnits(100),
    currency: "USDC",
    rules: DEFAULT_RULES,
    sanctions,
    recentAttempts: [],
    recentAmounts: [],
    now: 1_000_000,
    ...patch,
  });

describe("ledger", () => {
  it("posts balanced entries and tracks balances", () => {
    const l = new Ledger(() => 1);
    l.transfer("external:onramp", "treasury:a", 500, "fund");
    l.transfer("treasury:a", "agent:x", 200, "top-up", null, { account: "fees", amount: 2 });
    expect(l.balance("treasury:a")).toBe(300);
    expect(l.balance("agent:x")).toBe(198);
    expect(l.balance("fees")).toBe(2);
    expect(verifyChain(l.blocks).valid).toBe(true);
  });

  it("rejects overdrafts and unbalanced postings", () => {
    const l = new Ledger();
    expect(() => l.transfer("treasury:a", "agent:x", 1, "nope")).toThrow(LedgerError);
    expect(() =>
      l.post(
        [
          { account: "a", debit: 1, credit: 0 },
          { account: "b", debit: 0, credit: 2 },
        ],
        "bad",
      ),
    ).toThrow(/unbalanced/);
    expect(l.blocks).toHaveLength(0);
  });

  it("detects tampering anywhere in the chain", () => {
    const l = new Ledger();
    for (let i = 0; i < 5; i++) l.transfer("external:onramp", "t", 10 + i, `b${i}`);
    const forged = l.blocks.map((b) => ({ ...b, entries: b.entries.map((e) => ({ ...e })) }));
    forged[2].entries[0].debit += 5;
    forged[2].entries[1].credit += 5;
    expect(verifyChain(forged)).toMatchObject({ valid: false, brokenAt: 2 });
  });
});

describe("mandate policy", () => {
  const base = { merchant: merchant("m_helios"), spentToday: 0, spentThisMonth: 0, now: Date.UTC(2026, 9, 21, 12) };

  it("passes a payment inside every limit", () => {
    expect(evaluateMandate({ ...base, mandate: mandate(), amount: toUnits(500) }).verdict).toBe("pass");
  });

  it("fails per-tx, daily and monthly caps independently", () => {
    const r = evaluateMandate({ ...base, mandate: mandate(), amount: toUnits(1500), spentToday: toUnits(2000), spentThisMonth: toUnits(19000) });
    expect(r.verdict).toBe("fail");
    expect(r.results.filter((x) => x.outcome === "fail").map((x) => x.rule)).toEqual(["limit.per_tx", "limit.daily", "limit.monthly"]);
  });

  it("enforces category allow and block lists", () => {
    expect(evaluateMandate({ ...base, mandate: mandate({ allowedCategories: ["travel"] }), amount: 1 }).verdict).toBe("fail");
    expect(evaluateMandate({ ...base, mandate: mandate({ blockedCategories: ["compute"] }), amount: 1 }).verdict).toBe("fail");
  });

  it("holds above the approval threshold, but never overrides a hard failure", () => {
    expect(evaluateMandate({ ...base, mandate: mandate({ approvalThreshold: toUnits(100) }), amount: toUnits(200) }).verdict).toBe("hold");
    const r = evaluateMandate({ ...base, mandate: mandate({ approvalThreshold: toUnits(100) }), amount: toUnits(5000) });
    expect(r.verdict).toBe("fail");
    expect(r.results.some((x) => x.rule === "approval.threshold")).toBe(false);
  });

  it("respects UTC windows, weekdays and expiry", () => {
    const sunday = Date.UTC(2026, 9, 25, 3);
    expect(evaluateMandate({ ...base, now: sunday, mandate: mandate({ weekdaysOnly: true }), amount: 1 }).verdict).toBe("fail");
    expect(evaluateMandate({ ...base, now: sunday, mandate: mandate({ activeHoursUtc: { start: 8, end: 20 } }), amount: 1 }).verdict).toBe("fail");
    expect(evaluateMandate({ ...base, now: sunday, mandate: mandate({ activeHoursUtc: { start: 22, end: 6 } }), amount: 1 }).verdict).toBe("pass");
    expect(evaluateMandate({ ...base, mandate: mandate({ expiresAt: base.now - 1 }), amount: 1 }).verdict).toBe("fail");
  });
});

describe("compliance", () => {
  it("screens by exact address and fuzzy name", () => {
    expect(screen(merchant("m_nightjar"), sanctions)?.by).toBe("address");
    expect(screen({ name: "Kestrel Relay", address: "0x1" }, sanctions)?.score).toBe(1);
    expect(screen(merchant("m_kestrelx"), sanctions)).toBeNull();
    expect(nameSimilarity("Obsidian Bridge Services", "OBSIDIAN BRIDGE ltd")).toBe(1);
  });

  it("diverts sanctioned counterparties with squawk 7500", () => {
    const r = compliance({ merchant: merchant("m_nightjar") });
    expect(r.verdict).toBe("fail");
    expect(r.squawk).toBe("7500");
  });

  it("applies the EU Travel Rule to every VASP transfer and holds without verified originator data", () => {
    const eu = agent({ jurisdiction: "EU", currency: "EURC", kyaLevel: 1 });
    const r = compliance({ agent: eu, merchant: merchant("m_kestrelx"), amount: toUnits(10), currency: "EURC" });
    expect(r.verdict).toBe("hold");
    expect(r.results.find((x) => x.rule === "travel_rule")?.outcome).toBe("hold");
  });

  it("attaches an IVMS101 payload at the US $3,000 threshold", () => {
    expect(compliance({ merchant: merchant("m_meridian"), amount: toUnits(2999) }).travelRule).toBeNull();
    const r = compliance({ merchant: merchant("m_meridian"), amount: toUnits(3000) });
    expect(r.verdict).toBe("pass");
    expect(r.travelRule?.standard).toBe("IVMS101");
  });

  it("rejects settlement assets outside the jurisdiction's registry", () => {
    expect(compliance({ currency: "USDT" }).verdict).toBe("fail");
    expect(compliance({ agent: agent({ jurisdiction: "EU" }), currency: "USDT" }).results.find((x) => x.rule === "eu.mica.authorised_emt")?.outcome).toBe("fail");
  });

  it("gives micropayments a far higher burst ceiling than larger payments", () => {
    const now = 1_000_000;
    const micro = Array.from({ length: 30 }, (_, i) => ({ at: now - i * 1000, usd: 0.01 }));
    expect(compliance({ merchant: merchant("m_signal"), amount: toUnits(0.01), recentAttempts: micro }).verdict).toBe("pass");
    const large = Array.from({ length: 8 }, (_, i) => ({ at: now - i * 1000, usd: 200 }));
    expect(compliance({ amount: toUnits(200), recentAttempts: large }).verdict).toBe("hold");
  });

  it("can suspend a rule", () => {
    const rules = DEFAULT_RULES.map((r) => (r.id === "global.sanctions" ? { ...r, enabled: false } : r));
    expect(compliance({ merchant: merchant("m_nightjar"), rules }).results.some((x) => x.rule === "sanctions.screen")).toBe(false);
  });
});

describe("agent keys", () => {
  it("signs and verifies with raw ed25519 keys", () => {
    const k = generateAgentKeys();
    const sig = signMessage(k.privateKey, "hello");
    expect(verifyMessage(k.publicKey, "hello", sig)).toBe(true);
    expect(verifyMessage(k.publicKey, "hellO", sig)).toBe(false);
    expect(verifyMessage(generateAgentKeys().publicKey, "hello", sig)).toBe(false);
  });
});

describe("composer fallback parser", () => {
  const ms: Merchant[] = MERCHANTS;
  it("extracts caps, categories, approval and schedule", () => {
    const d = heuristicDraft("Only buy GPU compute and inference. Up to $2k per payment, $10k a day. Ask me above $1,500. Never gambling. Weekdays only, for 30 days.", ms);
    expect(d).toMatchObject({
      perTxLimitUsd: 2000,
      dailyLimitUsd: 10000,
      approvalThresholdUsd: 1500,
      blockedCategories: ["gambling"],
      weekdaysOnly: true,
      expiresInDays: 30,
    });
    expect(d.allowedCategories?.sort()).toEqual(["api", "compute"]);
  });

  it("does not mistake a daily cap for a per-payment cap", () => {
    const d = heuristicDraft("Spend up to $6,000 a day on travel.", ms);
    expect(d.dailyLimitUsd).toBe(6000);
    expect(d.perTxLimitUsd).toBe(6000);
  });

  it("parses windows and blocked merchants, and records assumptions", () => {
    const d = heuristicDraft("Book hotels between 9am and 5pm. Never Lucky Tiger.", ms);
    expect(d.activeHoursUtc).toEqual({ start: 9, end: 17 });
    expect(d.blockedMerchantIds).toEqual(["m_tiger"]);
    expect(d.assumptions.length).toBeGreaterThan(0);
  });
});
