import {
  UNIT,
  formatAmount,
  type Agent,
  type Currency,
  type Jurisdiction,
  type Merchant,
  type RuleResult,
  type RuleToggle,
  type SanctionEntry,
  type Squawk,
  type TravelRulePayload,
} from "../shared/types.js";

/**
 * Compliance rulepacks. These encode the *shape* of real obligations so the
 * engine behaves realistically; they are a sandbox model, not legal advice.
 */
export const DEFAULT_RULES: RuleToggle[] = [
  {
    id: "global.sanctions",
    jurisdiction: "GLOBAL",
    title: "Sanctions screening",
    citation: "OFAC SDN · EU consolidated list (sandbox list)",
    summary: "Exact address match or fuzzy name match against the screening list diverts the payment. Near-matches hold for review.",
    enabled: true,
  },
  {
    id: "global.velocity",
    jurisdiction: "GLOBAL",
    title: "Velocity & anomaly detection",
    citation: "FATF risk-based approach (Rec. 1, 15)",
    summary: "Bursts of payments from one agent, or amounts far outside its own history, are held for a human.",
    enabled: true,
  },
  {
    id: "global.kyb",
    jurisdiction: "GLOBAL",
    title: "Counterparty KYB",
    citation: "Customer due diligence",
    summary: "Payments over 1,000 to merchants without verified business identity are held.",
    enabled: true,
  },
  {
    id: "us.genius",
    jurisdiction: "US",
    title: "Permitted payment stablecoins",
    citation: "GENIUS Act, signed 18 Jul 2025",
    summary: "US agents settle only in stablecoins whose issuer is on the permitted-issuer registry (sandbox registry).",
    enabled: true,
  },
  {
    id: "us.travel",
    jurisdiction: "US",
    title: "Travel Rule ≥ $3,000",
    citation: "31 CFR 1010.410(f) · FinCEN",
    summary: "Transfers of $3,000 or more to another VASP carry originator and beneficiary information.",
    enabled: true,
  },
  {
    id: "eu.mica",
    jurisdiction: "EU",
    title: "MiCA-authorised e-money tokens",
    citation: "Regulation (EU) 2023/1114 (MiCA), Title IV",
    summary: "EU agents settle only in stablecoins issued by an authorised EMT issuer (sandbox registry).",
    enabled: true,
  },
  {
    id: "eu.tfr",
    jurisdiction: "EU",
    title: "Travel Rule — no de minimis",
    citation: "Regulation (EU) 2023/1113 (TFR)",
    summary: "Every crypto-asset transfer to another CASP carries originator and beneficiary information, regardless of amount.",
    enabled: true,
  },
  {
    id: "uk.travel",
    jurisdiction: "UK",
    title: "Travel Rule ≥ €1,000",
    citation: "Money Laundering Regulations 2017, Part 7A",
    summary: "Full originator/beneficiary information for transfers of €1,000 or more to another cryptoasset business.",
    enabled: true,
  },
  {
    id: "sg.travel",
    jurisdiction: "SG",
    title: "Travel Rule ≥ S$1,500",
    citation: "MAS Notice PSN02",
    summary: "Originator and beneficiary information for digital payment token transfers of S$1,500 or more.",
    enabled: true,
  },
];

/** Approximate USD value per token, for threshold comparisons only. */
export const FX_USD: Record<Currency, number> = { USDC: 1, USDT: 1, EURC: 1.08 };

/** Travel Rule thresholds, expressed in USD. */
export const TRAVEL_RULE_THRESHOLD_USD: Record<Jurisdiction, number> = {
  US: 3000,
  EU: 0,
  UK: 1000 * 1.08,
  SG: 1500 * 0.74,
};

/** Sandbox stablecoin registry — illustrative, not an official list. */
export const STABLECOIN_REGISTRY: Record<Currency, { issuer: string; usPermitted: boolean; euAuthorisedEmt: boolean }> = {
  USDC: { issuer: "Circle", usPermitted: true, euAuthorisedEmt: true },
  EURC: { issuer: "Circle", usPermitted: true, euAuthorisedEmt: true },
  USDT: { issuer: "Tether", usPermitted: false, euAuthorisedEmt: false },
};

export const SEED_SANCTIONS: Omit<SanctionEntry, "addedAt">[] = [
  { id: "sdn-001", name: "Nightjar Mixer", address: "0x9a1c0ffee0000000000000000000000000000bad", list: "sandbox-sdn" },
  { id: "sdn-002", name: "Kestrel Relay Holdings", address: null, list: "sandbox-sdn" },
  { id: "sdn-003", name: "Obsidian Bridge Services", address: "0x0b51d1a000000000000000000000000000000666", list: "sandbox-eu" },
];

const STOP_WORDS = new Set(["ltd", "llc", "inc", "co", "corp", "limited", "the", "services", "holdings", "group", "sa", "gmbh"]);

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t))
    .join(" ");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Similarity in [0, 1] combining edit distance and token overlap. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const edit = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  return Math.max(edit, jaccard);
}

export interface ScreeningHit {
  entry: SanctionEntry;
  score: number;
  by: "address" | "name";
}

export function screen(merchant: Pick<Merchant, "name" | "address">, list: SanctionEntry[]): ScreeningHit | null {
  let best: ScreeningHit | null = null;
  for (const entry of list) {
    if (entry.address && entry.address.toLowerCase() === merchant.address.toLowerCase()) {
      return { entry, score: 1, by: "address" };
    }
    const score = nameSimilarity(entry.name, merchant.name);
    if (!best || score > best.score) best = { entry, score, by: "name" };
  }
  return best && best.score >= 0.75 ? best : null;
}

export interface ComplianceInput {
  agent: Agent;
  merchant: Merchant;
  amount: number;
  currency: Currency;
  rules: RuleToggle[];
  sanctions: SanctionEntry[];
  /** This agent's recent payment attempts (time in ms, USD value). */
  recentAttempts: { at: number; usd: number }[];
  /** Amounts of this agent's recent cleared payments. */
  recentAmounts: number[];
  now: number;
}

export interface ComplianceOutcome {
  verdict: "pass" | "hold" | "fail";
  squawk: Squawk;
  results: RuleResult[];
  travelRule: TravelRulePayload | null;
  riskScore: number;
}

export function evaluateCompliance(input: ComplianceInput): ComplianceOutcome {
  const { agent, merchant, amount, currency, rules, sanctions, recentAttempts, recentAmounts, now } = input;
  const on = (ruleId: string) => rules.find((r) => r.id === ruleId)?.enabled ?? false;
  const results: RuleResult[] = [];
  let squawk: Squawk = "1200";
  let risk = 4;
  let travelRule: TravelRulePayload | null = null;
  const push = (rule: string, outcome: RuleResult["outcome"], detail: string) =>
    results.push({ layer: "compliance", rule, outcome, detail });
  const usd = (amount / UNIT) * FX_USD[currency];

  if (on("global.sanctions")) {
    const hit = screen(merchant, sanctions);
    if (hit && (hit.by === "address" || hit.score >= 0.88)) {
      push("sanctions.screen", "fail", `match on ${hit.by}: "${hit.entry.name}" (${hit.entry.list}, score ${hit.score.toFixed(2)})`);
      squawk = "7500";
      risk += 90;
    } else if (hit) {
      push("sanctions.screen", "hold", `possible match "${hit.entry.name}" (score ${hit.score.toFixed(2)}) — needs review`);
      squawk = "7700";
      risk += 45;
    } else {
      push("sanctions.screen", "pass", `${merchant.name} clear against ${sanctions.length} entries`);
    }
  }

  const registry = STABLECOIN_REGISTRY[currency];
  if (agent.jurisdiction === "US" && on("us.genius")) {
    push(
      "us.genius.permitted_issuer",
      registry.usPermitted ? "pass" : "fail",
      `${currency} (${registry.issuer}) ${registry.usPermitted ? "on" : "not on"} permitted-issuer registry`,
    );
    if (!registry.usPermitted) {
      squawk = squawk === "1200" ? "7700" : squawk;
      risk += 30;
    }
  }
  if (agent.jurisdiction === "EU" && on("eu.mica")) {
    push(
      "eu.mica.authorised_emt",
      registry.euAuthorisedEmt ? "pass" : "fail",
      `${currency} (${registry.issuer}) ${registry.euAuthorisedEmt ? "is" : "is not"} an authorised EMT`,
    );
    if (!registry.euAuthorisedEmt) {
      squawk = squawk === "1200" ? "7700" : squawk;
      risk += 30;
    }
  }

  const travelRuleId = { US: "us.travel", EU: "eu.tfr", UK: "uk.travel", SG: "sg.travel" }[agent.jurisdiction];
  if (merchant.vasp && on(travelRuleId)) {
    const threshold = TRAVEL_RULE_THRESHOLD_USD[agent.jurisdiction];
    if (usd >= threshold) {
      if (agent.kyaLevel >= 2) {
        travelRule = {
          standard: "IVMS101",
          originator: { name: agent.owner, agent: agent.callSign, wallet: agent.walletAddress, jurisdiction: agent.jurisdiction },
          beneficiary: { name: merchant.name, wallet: merchant.address, jurisdiction: merchant.jurisdiction },
          amount: formatAmount(amount),
          asset: currency,
        };
        push("travel_rule", "pass", `≥ $${threshold.toFixed(0)} to a VASP — IVMS101 payload attached`);
        risk += 6;
      } else {
        push("travel_rule", "hold", `originator info unverified (KYA L${agent.kyaLevel}) — cannot attach Travel Rule data`);
        squawk = squawk === "1200" ? "4000" : squawk;
        risk += 20;
      }
    } else {
      push("travel_rule", "pass", `below $${threshold.toFixed(0)} threshold`);
    }
  }

  if (on("global.kyb") && merchant.kyb === "unverified") {
    if (usd > 1000) {
      push("kyb.counterparty", "hold", `${merchant.name} has no verified business identity`);
      squawk = squawk === "1200" ? "4000" : squawk;
      risk += 15;
    } else {
      push("kyb.counterparty", "warn", "unverified counterparty, below review threshold");
      risk += 5;
    }
  }

  if (on("global.velocity")) {
    // Micropayments (< $1) are what pay-per-call agents do all day, so they get a far
    // higher burst ceiling than larger payments.
    const micro = usd < 1;
    const lastMinute = recentAttempts.filter((a) => now - a.at < 60_000 && (micro || a.usd >= 1)).length;
    const burstLimit = micro ? 120 : 8;
    const mean = recentAmounts.length ? recentAmounts.reduce((s, a) => s + a, 0) / recentAmounts.length : 0;
    const sd = recentAmounts.length > 4
      ? Math.sqrt(recentAmounts.reduce((s, a) => s + (a - mean) ** 2, 0) / recentAmounts.length)
      : 0;
    const z = sd > 0 ? (amount - mean) / sd : 0;
    if (lastMinute >= burstLimit) {
      push("velocity.burst", "hold", `${lastMinute} attempts in the last 60s`);
      squawk = squawk === "1200" ? "7700" : squawk;
      risk += 25;
    } else if (z > 4 && usd > 500) {
      push("velocity.outlier", "hold", `amount is ${z.toFixed(1)}σ above this agent's history`);
      squawk = squawk === "1200" ? "7700" : squawk;
      risk += 25;
    } else {
      push("velocity", "pass", `${lastMinute} attempts/60s · z=${z.toFixed(1)}`);
    }
  }

  const verdict = results.some((r) => r.outcome === "fail")
    ? "fail"
    : results.some((r) => r.outcome === "hold")
      ? "hold"
      : "pass";
  return { verdict, squawk, results, travelRule, riskScore: Math.min(100, risk) };
}
