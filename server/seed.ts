import { toUnits, type Mandate, type Merchant } from "../shared/types.js";
import { treasuryAccount, type Clearance, type NewAgentInput } from "./engine.js";

export const OWNER = "Northwind Labs";
export const OWNER_EU = "Northwind Labs GmbH";

/** Fictional counterparties. Any resemblance to real businesses is coincidental. */
export const MERCHANTS: Merchant[] = [
  { id: "m_helios", name: "Helios GPU Cloud", category: "compute", address: "0x4e1105a1c0de000000000000000000000000c0de", jurisdiction: "US", vasp: false, kyb: "verified", x402: false },
  { id: "m_tidewater", name: "Tidewater Data Co.", category: "data", address: "0x71de0a7e00000000000000000000000000da7a01", jurisdiction: "US", vasp: false, kyb: "verified", x402: true },
  { id: "m_signal", name: "Signal Desk API", category: "api", address: "0x5197a1de5c000000000000000000000000000a91", jurisdiction: "US", vasp: false, kyb: "verified", x402: true },
  { id: "m_quanta", name: "Quanta Inference", category: "api", address: "0x9a7a1fe2e0000000000000000000000000000f00", jurisdiction: "SG", vasp: false, kyb: "verified", x402: true },
  { id: "m_cobalt", name: "Cobalt CRM", category: "saas", address: "0xc0ba17c4a00000000000000000000000000005a5", jurisdiction: "US", vasp: false, kyb: "verified", x402: false },
  { id: "m_northstar", name: "Northstar Air", category: "travel", address: "0xa1a1a1a1a1000000000000000000000000000a12", jurisdiction: "US", vasp: false, kyb: "verified", x402: false },
  { id: "m_lumen", name: "Lumen Hotels", category: "travel", address: "0x1ee7000000000000000000000000000000000107", jurisdiction: "EU", vasp: false, kyb: "verified", x402: false },
  { id: "m_pixelhaus", name: "Pixelhaus Ads", category: "ads", address: "0x9e1a00000000000000000000000000000000ad55", jurisdiction: "EU", vasp: false, kyb: "verified", x402: false },
  { id: "m_atlas", name: "Atlas Freight", category: "commerce", address: "0xa7a5f0000000000000000000000000000000f8e1", jurisdiction: "UK", vasp: false, kyb: "unverified", x402: false },
  { id: "m_meridian", name: "Meridian OTC Desk", category: "exchange", address: "0x3e81d1a0000000000000000000000000000000c1", jurisdiction: "US", vasp: true, kyb: "verified", x402: false },
  { id: "m_kestrelx", name: "Kestrel Exchange", category: "exchange", address: "0x6e57e1000000000000000000000000000000e0c5", jurisdiction: "EU", vasp: true, kyb: "verified", x402: false },
  { id: "m_tiger", name: "Lucky Tiger Casino", category: "gambling", address: "0x7193e40000000000000000000000000000000777", jurisdiction: "SG", vasp: false, kyb: "unverified", x402: false },
  { id: "m_nightjar", name: "Night Jar Mixer Ltd", category: "p2p", address: "0x9a1c0ffee0000000000000000000000000000bad", jurisdiction: "SG", vasp: false, kyb: "unverified", x402: false },
  { id: "m_kestrelrelay", name: "Kestrel Relay", category: "p2p", address: "0x4e1a7000000000000000000000000000000004e1", jurisdiction: "UK", vasp: false, kyb: "unverified", x402: false },
];

const days = (n: number) => n * 86_400_000;

type MandateSeed = Omit<Mandate, "id" | "createdAt"> & { id: string };

export function seedMandates(now: number): MandateSeed[] {
  return [
    {
      id: "mnd_compute",
      name: "Compute procurement",
      source: "Buy GPU compute and inference only. Up to $1,500 a payment, $6,000 a day, $60k a month. Ask me above $1,000.",
      perTxLimit: toUnits(1500),
      dailyLimit: toUnits(6000),
      monthlyLimit: toUnits(60000),
      allowedCategories: ["compute", "api"],
      blockedCategories: [],
      allowedMerchants: null,
      blockedMerchants: [],
      approvalThreshold: toUnits(1000),
      activeHoursUtc: null,
      weekdaysOnly: false,
      expiresAt: null,
      createdBy: "seed",
    },
    {
      id: "mnd_research",
      name: "Research micropayments",
      source: "Pay per call for data and APIs. Never more than $5 a call or $150 a day.",
      perTxLimit: toUnits(5),
      dailyLimit: toUnits(150),
      monthlyLimit: toUnits(2500),
      allowedCategories: ["data", "api"],
      blockedCategories: [],
      allowedMerchants: null,
      blockedMerchants: [],
      approvalThreshold: null,
      activeHoursUtc: null,
      weekdaysOnly: false,
      expiresAt: null,
      createdBy: "seed",
    },
    {
      id: "mnd_travel",
      name: "Travel desk",
      source: "Book flights and hotels. Up to $2,500 a booking, $8,000 a month. Ask me above $800. No gambling, ever.",
      perTxLimit: toUnits(2500),
      dailyLimit: toUnits(5000),
      monthlyLimit: toUnits(8000),
      allowedCategories: ["travel"],
      blockedCategories: ["gambling"],
      allowedMerchants: null,
      blockedMerchants: [],
      approvalThreshold: toUnits(800),
      activeHoursUtc: null,
      weekdaysOnly: false,
      expiresAt: now + days(90),
      createdBy: "seed",
    },
    {
      id: "mnd_growth",
      name: "Growth ops (EU)",
      source: "Run ad spend and SaaS tools. €400 a payment, €2,000 a day. Never gambling or p2p.",
      perTxLimit: toUnits(400),
      dailyLimit: toUnits(2000),
      monthlyLimit: toUnits(20000),
      allowedCategories: null,
      blockedCategories: ["gambling", "p2p"],
      allowedMerchants: null,
      blockedMerchants: [],
      approvalThreshold: null,
      activeHoursUtc: null,
      weekdaysOnly: false,
      expiresAt: null,
      createdBy: "seed",
    },
    {
      id: "mnd_treasury",
      name: "Treasury & vendors",
      source: "Pay vendors and rebalance through OTC desks. Up to $25,000 a payment, $60,000 a day. Ask me above $5,000.",
      perTxLimit: toUnits(25000),
      dailyLimit: toUnits(60000),
      monthlyLimit: toUnits(400000),
      allowedCategories: ["exchange", "commerce", "saas", "payroll"],
      blockedCategories: ["gambling"],
      allowedMerchants: null,
      blockedMerchants: [],
      approvalThreshold: toUnits(5000),
      activeHoursUtc: null,
      weekdaysOnly: false,
      expiresAt: null,
      createdBy: "seed",
    },
  ];
}

export const FLEET: (NewAgentInput & { fund: number })[] = [
  { callSign: "HERON-417", name: "Procurement Pilot", owner: OWNER, model: "claude-opus-5-5", purpose: "Buys GPU hours and inference for the training team", jurisdiction: "US", currency: "USDC", kyaLevel: 3, mandateId: "mnd_compute", fund: 40000 },
  { callSign: "KITE-221", name: "Research Scout", owner: OWNER, model: "claude-sonnet-5-5", purpose: "Pays per request for market data and APIs over x402", jurisdiction: "US", currency: "USDC", kyaLevel: 2, mandateId: "mnd_research", fund: 900 },
  { callSign: "OSPREY-090", name: "Travel Desk", owner: OWNER, model: "claude-sonnet-5-5", purpose: "Books flights and hotels for the field team", jurisdiction: "US", currency: "USDC", kyaLevel: 2, mandateId: "mnd_travel", fund: 12000 },
  { callSign: "WREN-733", name: "Growth Ops", owner: OWNER_EU, model: "claude-haiku-5-5", purpose: "Runs paid acquisition and SaaS renewals in the EU", jurisdiction: "EU", currency: "EURC", kyaLevel: 1, mandateId: "mnd_growth", fund: 9000 },
  { callSign: "FALCON-512", name: "Treasury Sweeper", owner: OWNER, model: "claude-opus-5-5", purpose: "Pays vendors and rebalances through OTC desks", jurisdiction: "US", currency: "USDC", kyaLevel: 3, mandateId: "mnd_treasury", fund: 150000 },
];

export function seed(clearance: Clearance) {
  for (const m of MERCHANTS) clearance.addMerchant(m);
  for (const m of seedMandates(clearance.now())) clearance.saveMandate(m);

  clearance.fund(treasuryAccount(OWNER), toUnits(500_000), "treasury funded via USD on-ramp");
  clearance.fund(treasuryAccount(OWNER_EU), toUnits(60_000), "treasury funded via EUR on-ramp");

  for (const { fund, ...input } of FLEET) {
    const { agent } = clearance.createAgent(input, { custodial: true });
    clearance.topUp(agent.id, toUnits(fund));
  }

  // A retired agent the operator grounded — shows the kill switch in action.
  const { agent: grounded } = clearance.createAgent(
    { callSign: "SWIFT-008", name: "Legacy Scraper", owner: OWNER, model: "claude-haiku-4-5", purpose: "Deprecated data scraper, grounded pending review", jurisdiction: "US", currency: "USDC", kyaLevel: 1, mandateId: "mnd_research" },
    { custodial: true },
  );
  clearance.topUp(grounded.id, toUnits(50));
  clearance.updateAgent(grounded.id, { status: "grounded" });

}
