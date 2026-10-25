/**
 * Shared domain model for Clearance.
 *
 * Amounts are integers in token base units with 6 decimals (the precision of
 * USDC and EURC), so 1_000_000 === 1.00 token. Integers keep the ledger exact.
 */

export const DECIMALS = 6;
export const UNIT = 10 ** DECIMALS;

export type Jurisdiction = "US" | "EU" | "UK" | "SG";
export type Currency = "USDC" | "EURC" | "USDT";
export type Rail = "base" | "solana" | "x402";

export type Category =
  | "compute"
  | "data"
  | "api"
  | "saas"
  | "travel"
  | "ads"
  | "commerce"
  | "payroll"
  | "exchange"
  | "gambling"
  | "p2p";

export const CATEGORIES: Category[] = [
  "compute",
  "data",
  "api",
  "saas",
  "travel",
  "ads",
  "commerce",
  "payroll",
  "exchange",
  "gambling",
  "p2p",
];

/** Know-Your-Agent assurance level. */
export type KyaLevel = 1 | 2 | 3;

export interface Agent {
  id: string;
  callSign: string;
  name: string;
  owner: string;
  model: string;
  purpose: string;
  jurisdiction: Jurisdiction;
  currency: Currency;
  /** base64url raw ed25519 public key */
  publicKey: string;
  fingerprint: string;
  walletAddress: string;
  kyaLevel: KyaLevel;
  status: "active" | "grounded";
  mandateId: string;
  createdAt: number;
}

export interface Mandate {
  id: string;
  name: string;
  /** Natural-language source the mandate was compiled from, if any. */
  source: string;
  perTxLimit: number;
  dailyLimit: number;
  monthlyLimit: number;
  /** null = any category allowed (minus blocked) */
  allowedCategories: Category[] | null;
  blockedCategories: Category[];
  /** null = any merchant allowed (minus blocked) */
  allowedMerchants: string[] | null;
  blockedMerchants: string[];
  /** Payments strictly above this amount wait for a human. null = never. */
  approvalThreshold: number | null;
  /** UTC hours [start, end) during which the agent may pay. null = always. */
  activeHoursUtc: { start: number; end: number } | null;
  weekdaysOnly: boolean;
  expiresAt: number | null;
  createdBy: "human" | "composer" | "seed";
  createdAt: number;
}

export interface Merchant {
  id: string;
  name: string;
  category: Category;
  address: string;
  jurisdiction: Jurisdiction;
  /** Merchant is itself a VASP / CASP (exchange, OTC desk) — Travel Rule applies. */
  vasp: boolean;
  kyb: "verified" | "unverified";
  x402: boolean;
}

export type Stage = "inbound" | "screening" | "hold" | "cleared" | "diverted";

/**
 * Squawk codes borrowed from aviation transponders:
 * 1200 normal · 4000 holding for a human · 7500 sanctions hit ·
 * 7600 mandate breach · 7700 anomaly / compliance emergency.
 */
export type Squawk = "1200" | "4000" | "7500" | "7600" | "7700";

export interface RuleResult {
  layer: "identity" | "mandate" | "compliance" | "settlement" | "human";
  rule: string;
  outcome: "pass" | "fail" | "hold" | "warn";
  detail: string;
}

export interface TravelRulePayload {
  standard: "IVMS101";
  originator: { name: string; agent: string; wallet: string; jurisdiction: Jurisdiction };
  beneficiary: { name: string; wallet: string; jurisdiction: Jurisdiction };
  amount: string;
  asset: Currency;
}

export interface Receipt {
  blockHeight: number;
  blockHash: string;
  txRef: string;
  fee: number;
  settledAt: number;
  rail: Rail;
}

export interface PaymentIntent {
  id: string;
  agentId: string;
  merchantId: string;
  amount: number;
  currency: Currency;
  rail: Rail;
  memo: string;
  source: "api" | "x402" | "simulator" | "console";
  stage: Stage;
  squawk: Squawk;
  riskScore: number;
  trace: RuleResult[];
  travelRule: TravelRulePayload | null;
  receipt: Receipt | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  /** Short, radio-style one-liner describing the outcome. */
  callout: string;
}

export interface LedgerEntry {
  account: string;
  debit: number;
  credit: number;
}

export interface Block {
  height: number;
  prevHash: string;
  hash: string;
  timestamp: number;
  intentId: string | null;
  memo: string;
  entries: LedgerEntry[];
}

export interface SanctionEntry {
  id: string;
  name: string;
  address: string | null;
  list: string;
  addedAt: number;
}

export interface RuleToggle {
  id: string;
  jurisdiction: Jurisdiction | "GLOBAL";
  title: string;
  citation: string;
  summary: string;
  enabled: boolean;
}

export interface Stats {
  clearedVolume: number;
  clearedCount: number;
  divertedCount: number;
  holdCount: number;
  inFlight: number;
  p50DecisionMs: number;
  blocks: number;
}

export interface Snapshot {
  agents: Agent[];
  mandates: Mandate[];
  merchants: Merchant[];
  intents: PaymentIntent[];
  blocks: Block[];
  balances: Record<string, number>;
  spend: Record<string, { day: number; month: number }>;
  rules: RuleToggle[];
  sanctions: SanctionEntry[];
  stats: Stats;
  simulator: SimulatorState;
  ai: { enabled: boolean; model: string };
}

export type ServerEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "intent"; data: PaymentIntent }
  | { type: "block"; data: Block }
  | { type: "agent"; data: Agent }
  | { type: "mandate"; data: Mandate }
  | { type: "balances"; data: { balances: Record<string, number>; spend: Snapshot["spend"] } }
  | { type: "stats"; data: Stats }
  | { type: "rules"; data: RuleToggle[] }
  | { type: "sanctions"; data: SanctionEntry[] }
  | { type: "simulator"; data: SimulatorState };

export interface SimulatorState {
  running: boolean;
  /** Start of the current sandbox spending period, if the sandbox has started one. */
  periodStartedAt: number | null;
}

/** x402 (HTTP 402 Payment Required) wire types, v1 shape. */
export interface X402PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
}

export interface X402Challenge {
  x402Version: 1;
  error: string;
  accepts: X402PaymentRequirements[];
}

export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: {
    agentId: string;
    signature: string;
    authorization: X402Authorization;
  };
}

export function formatAmount(units: number, currency: Currency | "" = ""): string {
  const value = units / UNIT;
  const digits = Math.abs(value) < 1 && value !== 0 ? 4 : 2;
  const s = value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency ? `${s} ${currency}` : s;
}

export function toUnits(amount: number): number {
  return Math.round(amount * UNIT);
}
