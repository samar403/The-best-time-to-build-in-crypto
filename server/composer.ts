import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CATEGORIES, toUnits, type Category, type Mandate, type Merchant } from "../shared/types.js";

/**
 * Flight-plan composer: turns an operator's plain-English spending policy
 * into a structured mandate. Uses Claude when credentials are configured and
 * falls back to a deterministic parser otherwise, so the product always works.
 */

export type MandateDraft = Omit<Mandate, "id" | "createdAt">;

export interface CompileResult {
  draft: MandateDraft;
  engine: "claude" | "heuristic";
  model: string | null;
  assumptions: string[];
}

export const COMPOSER_MODEL = process.env.CLEARANCE_MODEL || "claude-opus-5-5";

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLEARANCE_AI === "1");
}

const CategoryEnum = z.enum(CATEGORIES as [Category, ...Category[]]);

const DraftSchema = z.object({
  name: z.string().describe("Short title for the mandate, 2-4 words"),
  perTxLimitUsd: z.number().describe("Maximum for a single payment, in USD"),
  dailyLimitUsd: z.number().describe("Maximum total per UTC day, in USD"),
  monthlyLimitUsd: z.number().describe("Maximum total per calendar month, in USD"),
  allowedCategories: z.array(CategoryEnum).nullable().describe("Only these categories; null when the operator did not restrict categories"),
  blockedCategories: z.array(CategoryEnum),
  allowedMerchantIds: z.array(z.string()).nullable().describe("Only these merchant ids; null when not restricted"),
  blockedMerchantIds: z.array(z.string()),
  approvalThresholdUsd: z.number().nullable().describe("Payments above this need human approval; null if never"),
  activeHoursUtc: z.object({ start: z.number(), end: z.number() }).nullable(),
  weekdaysOnly: z.boolean(),
  expiresInDays: z.number().nullable(),
  assumptions: z.array(z.string()).describe("Every default or interpretation you had to choose, one short sentence each"),
});

type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `You compile spending policies for autonomous AI agents into mandates for Clearance, a payments control tower.
An operator describes, in plain English, what one of their agents may spend money on. Produce the mandate.

Rules:
- Amounts are in USD (treat € and stablecoins as 1:1 for limits). "k" means thousand.
- If a limit is not stated, choose a conservative one consistent with the stated limits and record it in assumptions:
  daily defaults to 10x the per-payment cap, monthly to 20x daily. With no amounts at all use $100 / $500 / $5,000.
- Categories must come from the enum. Map plain words: GPUs → compute, datasets → data, inference or API calls → api,
  software subscriptions → saas, flights and hotels → travel, advertising → ads, shipping or supplies → commerce,
  salaries or contractors → payroll, OTC or exchanges → exchange, casinos or betting → gambling, mixers or peer-to-peer → p2p.
- Only set allowedCategories when the operator restricts the agent to certain kinds of spend ("only", "just", or a clear purpose).
- Merchant ids must come from the merchant list provided; ignore merchants that are not on it and say so in assumptions.
- Hours are UTC 0-23 with end exclusive. Never invent restrictions the operator did not ask for.`;

function merchantContext(merchants: Merchant[]): string {
  return merchants.map((m) => `${m.id}: ${m.name} (${m.category})`).join("\n");
}

function fromDraft(d: Draft, source: string, now: number): MandateDraft {
  const units = (usd: number) => toUnits(Math.max(0, usd));
  return {
    name: d.name.trim() || "Custom mandate",
    source,
    perTxLimit: units(d.perTxLimitUsd),
    dailyLimit: units(d.dailyLimitUsd),
    monthlyLimit: units(d.monthlyLimitUsd),
    allowedCategories: d.allowedCategories && d.allowedCategories.length ? d.allowedCategories : null,
    blockedCategories: d.blockedCategories,
    allowedMerchants: d.allowedMerchantIds && d.allowedMerchantIds.length ? d.allowedMerchantIds : null,
    blockedMerchants: d.blockedMerchantIds,
    approvalThreshold: d.approvalThresholdUsd === null ? null : units(d.approvalThresholdUsd),
    activeHoursUtc: d.activeHoursUtc
      ? { start: clampHour(d.activeHoursUtc.start), end: clampHour(d.activeHoursUtc.end) }
      : null,
    weekdaysOnly: d.weekdaysOnly,
    expiresAt: d.expiresInDays ? now + d.expiresInDays * 86_400_000 : null,
    createdBy: "composer",
  };
}

const clampHour = (h: number) => Math.min(23, Math.max(0, Math.round(h)));

let client: Anthropic | null = null;

async function compileWithClaude(text: string, merchants: Merchant[]): Promise<Draft> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: COMPOSER_MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(DraftSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `<merchants>\n${merchantContext(merchants)}\n</merchants>\n\n<policy>\n${text}\n</policy>`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("the model declined to compile this policy");
  if (!response.parsed_output) throw new Error(`no structured output (stop_reason: ${response.stop_reason})`);
  return response.parsed_output;
}

export async function compileMandate(text: string, merchants: Merchant[], now = Date.now()): Promise<CompileResult> {
  const source = text.trim();
  if (aiConfigured()) {
    try {
      const draft = await compileWithClaude(source, merchants);
      return { draft: fromDraft(draft, source, now), engine: "claude", model: COMPOSER_MODEL, assumptions: draft.assumptions };
    } catch (err) {
      const reason =
        err instanceof Anthropic.APIError ? `Claude API ${err.status ?? "error"}: ${err.message}` : err instanceof Error ? err.message : String(err);
      const fallback = heuristicDraft(source, merchants);
      return {
        draft: fromDraft(fallback, source, now),
        engine: "heuristic",
        model: null,
        assumptions: [`Claude unavailable (${reason}); used the built-in parser.`, ...fallback.assumptions],
      };
    }
  }
  const draft = heuristicDraft(source, merchants);
  return { draft: fromDraft(draft, source, now), engine: "heuristic", model: null, assumptions: draft.assumptions };
}

// ── Deterministic fallback parser ─────────────────────────────────────────

const MONEY = String.raw`[$€£]?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m)?\b\s?(?:usd|usdc|eur|eurc|dollars|euros|bucks)?`;

const CATEGORY_WORDS: Record<Category, RegExp> = {
  compute: /\b(gpu|gpus|compute|cloud hours?|training runs?)\b/,
  data: /\b(data|datasets?|feeds?)\b/,
  api: /\b(apis?|inference|api calls?|endpoints?)\b/,
  saas: /\b(saas|software|subscriptions?|tools|renewals?)\b/,
  travel: /\b(travel|flights?|hotels?|airfare|lodging)\b/,
  ads: /\b(ads|advertising|ad spend|campaigns?)\b/,
  commerce: /\b(freight|shipping|supplies|commerce|inventory|vendors?)\b/,
  payroll: /\b(payroll|salaries|salary|contractors?)\b/,
  exchange: /\b(exchanges?|otc|rebalanc\w*)\b/,
  gambling: /\b(gambling|casinos?|betting|bets?)\b/,
  p2p: /\b(p2p|peer[- ]to[- ]peer|mixers?|tumblers?)\b/,
};

const NEGATIVE = /\b(never|no|not|don't|do not|block|avoid|except|without|forbid\w*)\b/;
const RESTRICT = /\b(only|just|exclusively|solely|limited to|nothing but)\b/;

function amount(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const base = parseFloat(match[1].replace(/,/g, ""));
  const mult = match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return base * mult;
}

function to24h(h: number, ampm?: string): number {
  if (!ampm) return h;
  if (ampm === "am") return h === 12 ? 0 : h;
  return h === 12 ? 12 : h + 12;
}

export function heuristicDraft(text: string, merchants: Merchant[]): Draft {
  const lower = text.toLowerCase();
  const assumptions: string[] = [];
  const re = (pattern: string) => new RegExp(pattern, "i");

  const first = (...patterns: string[]) => {
    for (const p of patterns) {
      const value = amount(lower.match(re(p)));
      if (value !== null) return value;
    }
    return null;
  };
  const period = (unit: string, adverb: string) => [
    `${MONEY}\\s*(?:a|per|each|/)\\s*${unit}`,
    `${MONEY}\\s*${adverb}`,
    `${adverb} (?:limit|cap|budget|max)?\\s*(?:of|is|at)?\\s*${MONEY}`,
  ];

  let perTx = first(
    `${MONEY}\\s*(?:a|per|each|/|for (?:a|each|any))\\s*(?:single\\s+)?(?:payment|transaction|tx|purchase|call|request|booking|order|charge|invoice)`,
  );
  let daily = first(...period("day", "daily"));
  let monthly = first(...period("month", "monthly"));
  const approvalMatch = lower.match(re(`(?:ask|approv\\w*|check with|confirm|sign[- ]off|human)[^.;\\n]*?(?:above|over|more than|exceeding|>)\\s*${MONEY}`));
  const approval = amount(approvalMatch);

  // "up to $X" with no unit → per-payment cap
  if (perTx === null) {
    const loose = lower.match(re(`(?:up to|max(?:imum)?|no more than|never more than|at most|capped at|cap of)\\s*${MONEY}(?![\\d,.km])(?!\\s*(?:a|per|each|/)\\s*(?:day|month)|\\s*(?:daily|monthly))`));
    perTx = amount(loose);
  }

  if (perTx === null && daily === null && monthly === null) {
    perTx = 100;
    daily = 500;
    monthly = 5000;
    assumptions.push("No amounts given — defaulted to $100 per payment, $500 per day, $5,000 per month.");
  }
  if (perTx === null) {
    perTx = daily !== null ? daily : monthly! / 20;
    assumptions.push(`No per-payment cap stated — set to $${perTx.toLocaleString()}.`);
  }
  if (daily === null) {
    daily = monthly !== null ? Math.max(perTx, monthly / 20) : perTx * 10;
    assumptions.push(`No daily limit stated — set to $${daily.toLocaleString()}.`);
  }
  if (monthly === null) {
    monthly = daily * 20;
    assumptions.push(`No monthly limit stated — set to $${monthly.toLocaleString()}.`);
  }

  const allowed = new Set<Category>();
  const blocked = new Set<Category>();
  const allowedMerchants = new Set<string>();
  const blockedMerchants = new Set<string>();
  const clauses = lower.split(/[.;\n!]|\bbut\b/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const negative = NEGATIVE.test(clause);
    const restrictive = RESTRICT.test(clause) || /^(buy|pay for|book|run|purchase|spend on)\b/.test(clause);
    for (const [cat, pattern] of Object.entries(CATEGORY_WORDS) as [Category, RegExp][]) {
      if (!pattern.test(clause)) continue;
      if (negative) blocked.add(cat);
      else if (restrictive) allowed.add(cat);
    }
    for (const m of merchants) {
      const key = m.name.toLowerCase().split(/\s+/)[0];
      if (key.length < 4 || !new RegExp(`\\b${key}\\b`).test(clause)) continue;
      if (negative) blockedMerchants.add(m.id);
      else if (RESTRICT.test(clause)) allowedMerchants.add(m.id);
    }
  }
  for (const b of blocked) allowed.delete(b);

  let hours: Draft["activeHoursUtc"] = null;
  const between = lower.match(/between (\d{1,2})(?::00)?\s*(am|pm)?\s*(?:and|-|–|to)\s*(\d{1,2})(?::00)?\s*(am|pm)?/);
  if (between) {
    hours = { start: to24h(+between[1], between[2]), end: to24h(+between[3], between[4] ?? between[2]) };
    assumptions.push("Interpreted the time window as UTC.");
  }

  const weekdaysOnly = /\b(weekdays?|business days|mon(day)?\s*(?:-|–|to|through)\s*fri(day)?)\b/.test(lower);

  let expiresInDays: number | null = null;
  const span = lower.match(/\bfor (?:the next )?(\d+)\s*(days?|weeks?|months?)\b/);
  if (span) expiresInDays = +span[1] * (span[2].startsWith("week") ? 7 : span[2].startsWith("month") ? 30 : 1);
  const until = lower.match(/\buntil ([a-z]+ \d{1,2}(?:,? \d{4})?|\d{4}-\d{2}-\d{2})/);
  if (!expiresInDays && until) {
    const parsed = Date.parse(/\d{4}/.test(until[1]) ? until[1] : `${until[1]} ${new Date().getUTCFullYear()}`);
    if (!Number.isNaN(parsed)) expiresInDays = Math.max(1, Math.ceil((parsed - Date.now()) / 86_400_000));
  }

  const name = allowed.size
    ? `${[...allowed].slice(0, 2).map((c) => (c === "api" ? "API" : c[0].toUpperCase() + c.slice(1))).join(" & ")} mandate`
    : "Custom mandate";

  return {
    name,
    perTxLimitUsd: perTx,
    dailyLimitUsd: daily,
    monthlyLimitUsd: monthly,
    allowedCategories: allowed.size ? [...allowed] : null,
    blockedCategories: [...blocked],
    allowedMerchantIds: allowedMerchants.size ? [...allowedMerchants] : null,
    blockedMerchantIds: [...blockedMerchants],
    approvalThresholdUsd: approval,
    activeHoursUtc: hours,
    weekdaysOnly,
    expiresInDays,
    assumptions,
  };
}
