/**
 * A minimal autonomous agent that pays its own way through Clearance.
 *
 *   npm start                 # in one terminal (tower on :8787)
 *   npm run example:agent     # in another
 *
 * It commissions itself (operator API), then — as the agent — buys market
 * signals over x402 and pays a data vendor directly. Watch it appear on the
 * Tower's radar and strip board while it runs.
 */
import { ClearanceAgent, units } from "../sdk/index.js";
import type { Agent } from "../shared/types.js";

const BASE = process.env.CLEARANCE_URL ?? "http://localhost:8787";

async function operator<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json as T;
}

// 1. The operator commissions the agent and gets its private key exactly once.
const { agent, privateKey } = await operator<{ agent: Agent; privateKey: string }>("/api/agents", {
  name: "Example Researcher",
  owner: "Northwind Labs",
  model: "claude-sonnet-5-5",
  purpose: "Example script from examples/research-agent.ts",
  jurisdiction: "US",
  currency: "USDC",
  kyaLevel: 2,
  mandateId: "mnd_research",
  initialFunding: units("25"),
});
console.log(`commissioned ${agent.callSign} · key ${agent.fingerprint} · wallet ${agent.walletAddress}`);

// 2. From here on we are the agent, holding only its own key.
const client = new ClearanceAgent({ baseUrl: BASE, agentId: agent.id, privateKey });
const me = await client.me();
console.log(`mandate: ${me.mandate?.name} · balance ${me.balance / 1e6} USDC`);

for (const ticker of ["ETH", "SOL", "BTC"]) {
  const res = await client.fetchWithPayment(`${BASE}/x402/v1/market-signal?ticker=${ticker}`, {}, {
    maxAmount: units("0.01"),
    onStep: (s) => console.log(`  x402 · ${s.kind.padEnd(9)} ${s.title}`),
  });
  console.log(`  ${ticker}:`, await res.json());
}

// 3. A direct payment inside the mandate, then one that breaks it.
const ok = await client.pay({ merchantId: "m_tidewater", amount: units("2.40"), memo: "port congestion feed" });
console.log(`\n${ok.stage.toUpperCase()} · ${ok.callout}`);

const tooBig = await client.pay({ merchantId: "m_tidewater", amount: units("40"), memo: "full archive" }).catch((e) => e.body);
console.log(`${tooBig.stage.toUpperCase()} · ${tooBig.callout}`);
