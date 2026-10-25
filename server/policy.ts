import { formatAmount, type Mandate, type Merchant, type RuleResult } from "../shared/types.js";

export type Verdict = "pass" | "hold" | "fail";

export interface PolicyInput {
  mandate: Mandate;
  merchant: Merchant;
  amount: number;
  spentToday: number;
  spentThisMonth: number;
  now: number;
}

export interface PolicyOutcome {
  verdict: Verdict;
  results: RuleResult[];
}

const fmt = (n: number) => formatAmount(n);

/**
 * Evaluate a payment against an agent's mandate. Every rule is evaluated
 * (no short-circuit) so operators get the complete trace, not just the
 * first failure.
 */
export function evaluateMandate({ mandate, merchant, amount, spentToday, spentThisMonth, now }: PolicyInput): PolicyOutcome {
  const results: RuleResult[] = [];
  const add = (rule: string, ok: boolean, detail: string, failOutcome: RuleResult["outcome"] = "fail") =>
    results.push({ layer: "mandate", rule, outcome: ok ? "pass" : failOutcome, detail });

  add(
    "mandate.active",
    mandate.expiresAt === null || now < mandate.expiresAt,
    mandate.expiresAt === null ? "no expiry" : `expires ${new Date(mandate.expiresAt).toISOString()}`,
  );

  add("limit.per_tx", amount <= mandate.perTxLimit, `${fmt(amount)} vs cap ${fmt(mandate.perTxLimit)}`);
  add(
    "limit.daily",
    spentToday + amount <= mandate.dailyLimit,
    `${fmt(spentToday)} spent today + ${fmt(amount)} vs ${fmt(mandate.dailyLimit)}`,
  );
  add(
    "limit.monthly",
    spentThisMonth + amount <= mandate.monthlyLimit,
    `${fmt(spentThisMonth)} this month + ${fmt(amount)} vs ${fmt(mandate.monthlyLimit)}`,
  );

  if (mandate.allowedCategories) {
    add(
      "category.allowlist",
      mandate.allowedCategories.includes(merchant.category),
      `${merchant.category} ∈ {${mandate.allowedCategories.join(", ")}}`,
    );
  }
  if (mandate.blockedCategories.length) {
    add(
      "category.blocklist",
      !mandate.blockedCategories.includes(merchant.category),
      `${merchant.category} ∉ {${mandate.blockedCategories.join(", ")}}`,
    );
  }
  if (mandate.allowedMerchants) {
    add("merchant.allowlist", mandate.allowedMerchants.includes(merchant.id), `${merchant.name} on allowlist`);
  }
  if (mandate.blockedMerchants.length) {
    add("merchant.blocklist", !mandate.blockedMerchants.includes(merchant.id), `${merchant.name} not blocked`);
  }

  if (mandate.activeHoursUtc) {
    const hour = new Date(now).getUTCHours();
    const { start, end } = mandate.activeHoursUtc;
    const inside = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
    add("window.hours", inside, `${String(hour).padStart(2, "0")}:00Z within ${start}:00–${end}:00Z`);
  }
  if (mandate.weekdaysOnly) {
    const day = new Date(now).getUTCDay();
    add("window.weekdays", day !== 0 && day !== 6, `UTC day ${day} (Mon–Fri only)`);
  }

  const hasFailure = results.some((r) => r.outcome === "fail");
  if (!hasFailure && mandate.approvalThreshold !== null) {
    add(
      "approval.threshold",
      amount <= mandate.approvalThreshold,
      `${fmt(amount)} vs auto-approve ceiling ${fmt(mandate.approvalThreshold)}`,
      "hold",
    );
  }

  const verdict: Verdict = results.some((r) => r.outcome === "fail")
    ? "fail"
    : results.some((r) => r.outcome === "hold")
      ? "hold"
      : "pass";
  return { verdict, results };
}

/** One-line human summary of a mandate, used across the UI and the composer. */
export function describeMandate(m: Mandate, merchantName: (id: string) => string = (id) => id): string[] {
  const lines = [
    `≤ ${fmt(m.perTxLimit)} per payment`,
    `≤ ${fmt(m.dailyLimit)} per day`,
    `≤ ${fmt(m.monthlyLimit)} per month`,
  ];
  if (m.allowedCategories) lines.push(`only ${m.allowedCategories.join(", ")}`);
  if (m.blockedCategories.length) lines.push(`never ${m.blockedCategories.join(", ")}`);
  if (m.allowedMerchants) lines.push(`only at ${m.allowedMerchants.map(merchantName).join(", ")}`);
  if (m.blockedMerchants.length) lines.push(`never at ${m.blockedMerchants.map(merchantName).join(", ")}`);
  if (m.approvalThreshold !== null) lines.push(`human approval above ${fmt(m.approvalThreshold)}`);
  if (m.activeHoursUtc) lines.push(`between ${m.activeHoursUtc.start}:00 and ${m.activeHoursUtc.end}:00 UTC`);
  if (m.weekdaysOnly) lines.push("weekdays only");
  if (m.expiresAt) lines.push(`expires ${new Date(m.expiresAt).toISOString().slice(0, 10)}`);
  return lines;
}
