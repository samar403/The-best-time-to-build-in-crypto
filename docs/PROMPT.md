# The prompt — what Clearance is, and why now

This is the brief the product was built from. Use it as the elevator pitch, as a
spec for contributors, or as a system prompt when you want an AI to reason about
the product.

---

## The idea in one paragraph

> **The best time to build in crypto: clearer regulation, crypto inside fintech,
> and AI agents that make payments.**
>
> For ten years these were three separate stories. Regulators wrote the rules
> for stablecoins (MiCA in the EU, the GENIUS Act in the US, the Travel Rule
> everywhere). Fintechs quietly moved money onto stablecoin rails (Stripe +
> Bridge, card networks settling in USDC). And AI agents learned to act — and
> now to pay (x402, AP2, Visa Intelligent Commerce, Mastercard Agent Pay). The
> three converge on one missing layer: **when software spends money on its own,
> somebody has to be the control tower.** Clearance is that tower.

## The problem

An AI agent can hold a stablecoin wallet today. The wallet will sign anything
its key is asked to sign. Nothing in that stack knows:

1. **Who** the agent is and which legal entity answers for it.
2. **What** it is allowed to spend — how much, on what, with whom, when, and
   above which amount a human must decide.
3. **Which laws** apply to *this* transfer — sanctions, the Travel Rule at the
   right threshold for the right jurisdiction, whether the stablecoin is even a
   permitted asset there.
4. **What happened** — a record an auditor or regulator can verify without a
   forensic project.

Banks solve this for humans with KYC, card limits and statements. Nothing
solves it for agents.

## The product

Clearance is air traffic control for agent payments. Every payment is a flight:

| Aviation | Clearance |
| --- | --- |
| Pilot licence | **Know-Your-Agent identity** — an ed25519 key bound to an operator, a model, a jurisdiction (KYA levels 1–3) |
| Flight plan | **Mandate** — per-payment, daily and monthly caps; allowed / blocked categories and merchants; time windows; expiry; human-approval threshold. Written in plain English, compiled to an enforceable policy (Claude, with a deterministic fallback) |
| Approach control | **Compliance rulepacks** per jurisdiction — sanctions screening (exact + fuzzy), Travel Rule with IVMS101 payloads, stablecoin registry (GENIUS Act / MiCA), velocity and anomaly detection |
| Holding pattern | **Human-in-the-loop** — payments above the threshold or with unresolved risk wait for a controller to clear or divert them |
| Squawk codes | 1200 normal · 4000 holding · 7500 sanctions hit · 7600 mandate breach · 7700 compliance emergency |
| Flight recorder | **Double-entry, hash-chained ledger** — every block commits to the previous one; tampering is detectable by re-hashing |
| Radio | Every decision comes with a plain-language "callout" that says exactly why |

Agents integrate in two ways:

- **Signed API** — `agent.pay({ merchantId, amount })` with every request
  signed by the agent's key (timestamp window + replay protection).
- **x402** — any HTTP endpoint can answer `402 Payment Required`; the SDK signs
  an exact-amount authorization and retries, and the resource server clears it
  through Clearance before releasing the response.

## Who it is for

- **Fintechs** shipping "let your assistant pay" features without building a
  compliance department.
- **AI companies** whose agents buy compute, data and APIs and need hard caps,
  checkpoints and a kill switch instead of a shared corporate card.
- **API sellers** that want per-request revenue (x402) from payers that arrive
  pre-identified, screened and inside a mandate.

## Business model

Basis points on cleared volume (the sandbox charges 5 bps into a fee account),
plus seats for the humans in the tower, plus merchant acceptance for x402.

## Why it wins

- **Regulation turned from a risk into a spec.** Rules that are clear can be
  compiled. Clearance makes the compliant path the default path.
- **Mandates are the unit that agent-payment protocols are converging on**
  (AP2 is built around signed mandates). Owning the mandate layer is owning
  the control point.
- **Neutral to rails.** Base, Solana, x402 — the tower doesn't care which
  runway you land on.

## Guardrails on the claims

Clearance is a working sandbox. Rulepacks model the *shape* of real obligations
for building and demos; they are not legal advice. Settlement is simulated on an
internal double-entry ledger. The x402 flow follows the v1 wire format, using
sandbox ed25519 signatures in place of on-chain EIP-3009 authorizations.

---

## As a system prompt

```text
You are the product lead for Clearance, "air traffic control for agent payments".
Clearance gives every AI agent a verifiable identity (KYA), a mandate written in
plain English and enforced as code, per-jurisdiction compliance screening
(sanctions, Travel Rule, stablecoin eligibility, velocity), a human approval
queue, and a double-entry hash-chained ledger. Agents pay through a signed API or
by answering HTTP 402 (x402). The thesis: clearer regulation (GENIUS Act, MiCA,
Travel Rule), stablecoins inside mainstream fintech, and agents that pay have
converged, and the missing layer is the control tower. Explain decisions in
aviation terms (clear / hold / divert, squawk codes) and always say *why* a
payment was refused. Never present the sandbox rulepacks as legal advice.
```
