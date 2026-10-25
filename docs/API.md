# API reference

All amounts are **integers in token base units with 6 decimals** (USDC/EURC
precision): `1_000_000` = 1.00. The SDK's `units("12.50")` converts for you.

Base URL in development: `http://localhost:8787`.

## Agent API (signed)

Every request carries three headers:

| Header | Value |
| --- | --- |
| `x-clearance-agent` | agent id (`agt_…`) |
| `x-clearance-timestamp` | milliseconds since epoch; must be within ±5 minutes |
| `x-clearance-signature` | base64url ed25519 signature over the payload below |

Signed payload (newline-separated):

```
clearance-v1
<timestamp>
<METHOD>
<path including query>
<sha256 hex of the raw body, or of "" when there is no body>
```

Each signature is accepted once (replay protection).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/agent/me` | The agent, its mandate, wallet balance and spend |
| `POST` | `/api/agent/pay` | `{ merchantId, amount, memo? }` → `PaymentIntent`. `200` cleared · `202` holding for a human · `402` diverted |

## x402

Paid resources live under `/x402/v1/*`:

| Path | Price | Merchant |
| --- | --- | --- |
| `/x402/v1/market-signal?ticker=ETH` | 0.002 USDC | Signal Desk API |
| `/x402/v1/dataset/shipping-lanes` | 0.75 USDC | Tidewater Data Co. |
| `/x402/v1/inference?text=…` | 0.04 USDC | Quanta Inference |

1. Request without payment → `402` with `{ x402Version: 1, error, accepts: [PaymentRequirements] }`
   (`scheme: "exact"`, `network: "base-sepolia"`, USDC asset address, `payTo`, `maxAmountRequired`, `maxTimeoutSeconds`).
2. Retry with `X-PAYMENT: base64(JSON)`:

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-sepolia",
  "payload": {
    "agentId": "agt_…",
    "signature": "<ed25519 over 'x402-exact\\n' + canonical JSON of authorization>",
    "authorization": {
      "from": "<agent wallet>", "to": "<payTo>", "value": "<exact price>",
      "validAfter": "<unix s>", "validBefore": "<unix s>", "nonce": "0x<32 bytes>"
    }
  }
}
```

3. The server verifies payer, recipient, exact amount, time window, signature and
   nonce, then runs the payment through the agent's mandate and compliance
   rulepack. On success: `200` with the resource and an `X-PAYMENT-RESPONSE`
   header (`base64({ success, transaction, network, payer, intentId })`).
   Held or diverted payments get `402` with `error: "payment_held_for_approval"`
   or `"payment_declined"` and the tower's callout.

## Operator API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/snapshot` | Full state for the console |
| `GET` | `/api/stream` | Server-sent events: `snapshot`, then `intent`, `block`, `agent`, `mandate`, `balances`, `stats`, `rules`, `sanctions`, `simulator` |
| `GET / POST` | `/api/agents` | List · commission (returns `privateKey` **once**; `initialFunding`, `custodial` optional) |
| `PATCH` | `/api/agents/:id` | `{ status: "active" \| "grounded", mandateId, kyaLevel }` |
| `POST` | `/api/agents/:id/topup` | `{ amount }` from the operator treasury |
| `GET / POST` | `/api/mandates` | List · create |
| `PUT` | `/api/mandates/:id` | Replace |
| `POST` | `/api/mandates/compile` | `{ text }` → `{ draft, engine: "claude" \| "heuristic", model, assumptions }` |
| `POST` | `/api/mandates/dry-run` | `{ mandate, merchantId, amount, agentId? }` → `{ verdict, results }` |
| `GET` | `/api/merchants` | Counterparties |
| `GET / POST` | `/api/intents` | List (`?stage=hold`) · operator-initiated payment `{ agentId, merchantId, amount }` |
| `POST` | `/api/intents/:id/approve` · `/deny` | Human decision on a hold `{ by, reason? }` |
| `GET` | `/api/ledger` | Recent blocks |
| `GET` | `/api/ledger/verify[?tamper=h]` | Re-hash the chain (optionally a doctored copy) |
| `GET` | `/api/ledger/export.csv` | Full journal |
| `GET / PATCH` | `/api/rules[/:id]` | Rulepack toggles `{ enabled }` |
| `GET / POST / DELETE` | `/api/sanctions[/:id]` | Screening list |
| `GET` | `/api/registry` | Stablecoin registry and Travel Rule thresholds |
| `GET` | `/api/reports/compliance` | Flags by rule, Travel Rule transfers, sanctions hits, chain status |
| `POST` | `/api/simulator` | `{ running }` sandbox traffic |
| `GET` | `/api/x402/resources` | Paid resources and their requirements |
| `POST` | `/api/lab/x402` | `{ agentId, path }` — run a real handshake with a custodial agent, returns each step |

## PaymentIntent

```ts
{
  id, agentId, merchantId, amount, currency, rail, memo,
  source: "api" | "x402" | "simulator" | "console",
  stage: "inbound" | "screening" | "hold" | "cleared" | "diverted",
  squawk: "1200" | "4000" | "7500" | "7600" | "7700",
  riskScore,            // 0–100
  trace: { layer, rule, outcome: "pass" | "fail" | "hold" | "warn", detail }[],
  travelRule,           // IVMS101-shaped payload when required
  receipt,              // { blockHeight, blockHash, txRef, fee, settledAt, rail }
  callout,              // radio-style explanation of the outcome
  createdAt, decidedAt, decidedBy
}
```
