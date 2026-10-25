/**
 * @clearance/agent — the client an AI agent embeds to pay through Clearance.
 *
 *   const agent = new ClearanceAgent({ baseUrl, agentId, privateKey });
 *   await agent.pay({ merchantId: "m_helios", amount: units("412.50"), memo: "GPU hours" });
 *   const res = await agent.fetchWithPayment("https://api.example.com/x402/v1/market-signal");
 *
 * Every request is signed with the agent's ed25519 key (its KYA identity),
 * and HTTP 402 challenges are answered automatically within `maxAmount`.
 */
import { randomBytes } from "node:crypto";
import { requestSigningPayload, signMessage, x402AuthorizationMessage } from "../shared/crypto.js";
import { UNIT, type Agent, type Mandate, type PaymentIntent, type X402Challenge, type X402PaymentPayload } from "../shared/types.js";

export { UNIT };

/** Convert a decimal token amount ("12.50") to integer base units. */
export function units(value: string | number): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value).trim());
  if (!match) throw new RangeError(`not a non-negative amount with at most 6 decimals: ${value}`);
  return Number(match[1]) * UNIT + Number((match[2] ?? "").padEnd(6, "0"));
}

export interface ClearanceAgentOptions {
  baseUrl: string;
  agentId: string;
  /** base64url raw ed25519 private key, shown once when the agent is commissioned */
  privateKey: string;
  fetch?: typeof fetch;
}

export interface X402Step {
  kind: "request" | "challenge" | "authorize" | "retry" | "settled" | "refused";
  title: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  at: number;
}

export interface FetchWithPaymentOptions {
  /** Refuse to pay more than this many base units for one request (default 1.00 token). */
  maxAmount?: number;
  onStep?: (step: X402Step) => void;
}

export class ClearanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class ClearanceAgent {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private profile: { agent: Agent; mandate: Mandate | null; balance: number } | null = null;

  constructor(private readonly opts: ClearanceAgentOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Signed JSON request against the Clearance agent API. */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = signMessage(this.opts.privateKey, requestSigningPayload(timestamp, method, path, payload));
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-clearance-agent": this.opts.agentId,
        "x-clearance-timestamp": timestamp,
        "x-clearance-signature": signature,
      },
      body: payload || undefined,
    });
    const json = (await res.json().catch(() => null)) as T & { error?: string };
    if (!res.ok) throw new ClearanceApiError(json?.error ?? `HTTP ${res.status}`, res.status, json);
    return json;
  }

  /** The agent's own identity, active mandate, balance and spend. */
  async me() {
    this.profile = await this.request<{ agent: Agent; mandate: Mandate | null; balance: number }>("GET", "/api/agent/me");
    return this.profile;
  }

  /** Request a payment. Resolves when cleared, diverted, or parked for human approval. */
  pay(input: { merchantId: string; amount: number; memo?: string }): Promise<PaymentIntent> {
    return this.request<PaymentIntent>("POST", "/api/agent/pay", input);
  }

  /**
   * fetch() that understands HTTP 402. On a challenge it signs an `exact`
   * authorization for the quoted amount and retries with an X-PAYMENT header.
   */
  async fetchWithPayment(url: string, init: RequestInit = {}, options: FetchWithPaymentOptions = {}): Promise<Response> {
    const step = (s: Omit<X402Step, "at">) => options.onStep?.({ ...s, at: Date.now() });
    const maxAmount = options.maxAmount ?? UNIT;

    step({ kind: "request", title: `${init.method ?? "GET"} ${new URL(url).pathname}` });
    const first = await this.fetchImpl(url, init);
    if (first.status !== 402) return first;

    const challenge = (await first.json()) as X402Challenge;
    step({ kind: "challenge", title: "402 Payment Required", status: 402, body: challenge });

    const req = challenge.accepts.find((a) => a.scheme === "exact");
    if (!req) throw new ClearanceApiError("no supported x402 payment scheme offered", 402, challenge);
    if (Number(req.maxAmountRequired) > maxAmount) {
      step({ kind: "refused", title: `price ${req.maxAmountRequired} exceeds client cap ${maxAmount}` });
      throw new ClearanceApiError("x402 price exceeds maxAmount", 402, challenge);
    }

    const profile = this.profile ?? (await this.me());
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: profile.agent.walletAddress,
      to: req.payTo,
      value: req.maxAmountRequired,
      validAfter: String(now - 5),
      validBefore: String(now + req.maxTimeoutSeconds),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const payment: X402PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: req.network,
      payload: {
        agentId: this.opts.agentId,
        signature: signMessage(this.opts.privateKey, x402AuthorizationMessage(authorization)),
        authorization,
      },
    };
    const header = Buffer.from(JSON.stringify(payment)).toString("base64");
    step({ kind: "authorize", title: "Signed exact-amount authorization", body: payment });

    const headers = new Headers(init.headers);
    headers.set("X-PAYMENT", header);
    step({ kind: "retry", title: "Retry with X-PAYMENT", headers: { "X-PAYMENT": `${header.slice(0, 48)}…` } });
    const paid = await this.fetchImpl(url, { ...init, headers });

    const receipt = paid.headers.get("X-PAYMENT-RESPONSE");
    if (paid.ok && receipt) {
      step({
        kind: "settled",
        title: `${paid.status} OK — settled`,
        status: paid.status,
        headers: { "X-PAYMENT-RESPONSE": receipt },
        body: JSON.parse(Buffer.from(receipt, "base64").toString("utf8")),
      });
    } else if (paid.status === 402) {
      step({ kind: "refused", title: "402 — Clearance did not clear the payment", status: 402, body: await paid.clone().json() });
    }
    return paid;
  }
}
