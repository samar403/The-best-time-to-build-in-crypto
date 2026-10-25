import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { toUnits, type X402Challenge, type X402PaymentRequirements } from "../shared/types.js";
import { sha256, verifyMessage, x402AuthorizationMessage } from "../shared/crypto.js";
import type { Clearance } from "./engine.js";

/** Base Sepolia testnet, with Circle's USDC contract on that network. */
export const X402_NETWORK = "base-sepolia";
export const X402_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface PaidResource {
  path: string;
  merchantId: string;
  price: number;
  description: string;
  serve: (req: Request) => unknown;
}

const seeded = (key: string) => parseInt(sha256(key).slice(0, 8), 16) / 0xffffffff;

export const RESOURCES: PaidResource[] = [
  {
    path: "/v1/market-signal",
    merchantId: "m_signal",
    price: toUnits(0.002),
    description: "Real-time momentum signal for one ticker",
    serve: (req) => {
      const ticker = String(req.query.ticker ?? "ETH").toUpperCase().slice(0, 8);
      const minute = Math.floor(Date.now() / 60_000);
      const r = seeded(`${ticker}:${minute}`);
      return { ticker, signal: r > 0.55 ? "accumulate" : r < 0.4 ? "reduce" : "hold", confidence: Number((0.5 + r / 2).toFixed(2)), asOf: new Date().toISOString() };
    },
  },
  {
    path: "/v1/dataset/shipping-lanes",
    merchantId: "m_tidewater",
    price: toUnits(0.75),
    description: "Weekly congestion index for 6 major shipping lanes",
    serve: () => {
      const week = Math.floor(Date.now() / (7 * 86_400_000));
      const lanes = ["Shanghai–Rotterdam", "Singapore–LA", "Busan–Long Beach", "Santos–Antwerp", "Jebel Ali–Mumbai", "Panama transit"];
      return { week, lanes: lanes.map((lane) => ({ lane, congestion: Number((seeded(`${lane}:${week}`) * 100).toFixed(1)) })) };
    },
  },
  {
    path: "/v1/inference",
    merchantId: "m_quanta",
    price: toUnits(0.04),
    description: "One sandbox inference call: summarize a short text",
    serve: (req) => {
      const text = String(req.query.text ?? "Agents that pay need mandates, screening and receipts.");
      const words = text.split(/\s+/).filter(Boolean);
      return { summary: words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : ""), tokens: words.length };
    },
  },
];

const PaymentHeader = z.object({
  x402Version: z.literal(1),
  scheme: z.literal("exact"),
  network: z.string(),
  payload: z.object({
    agentId: z.string(),
    signature: z.string(),
    authorization: z.object({
      from: z.string(),
      to: z.string(),
      value: z.string().regex(/^\d+$/),
      validAfter: z.string().regex(/^\d+$/),
      validBefore: z.string().regex(/^\d+$/),
      nonce: z.string().min(16),
    }),
  }),
});

export function requirementsFor(clearance: Clearance, resource: PaidResource, origin: string): X402PaymentRequirements {
  const merchant = clearance.merchants.get(resource.merchantId)!;
  return {
    scheme: "exact",
    network: X402_NETWORK,
    maxAmountRequired: String(resource.price),
    resource: `${origin}/x402${resource.path}`,
    description: resource.description,
    mimeType: "application/json",
    payTo: merchant.address,
    maxTimeoutSeconds: 60,
    asset: X402_ASSET,
    extra: { name: "USDC", version: "2", merchant: merchant.name, signing: "ed25519-kya (sandbox)" },
  };
}

/**
 * x402 paywall. Unpaid requests get HTTP 402 with payment requirements; a
 * retry carrying a signed X-PAYMENT header is verified and then cleared
 * through the same mandate + compliance pipeline as every other payment.
 */
export function x402Router(clearance: Clearance) {
  const router = Router();

  for (const resource of RESOURCES) {
    router.get(resource.path, async (req: Request, res: Response) => {
      const origin = `${req.protocol}://${req.get("host")}`;
      const requirements = requirementsFor(clearance, resource, origin);
      const challenge = (error: string, extra: Record<string, unknown> = {}) => {
        const body: X402Challenge & Record<string, unknown> = { x402Version: 1, error, accepts: [requirements], ...extra };
        res.status(402).json(body);
      };

      const header = req.get("X-PAYMENT");
      if (!header) return challenge("X-PAYMENT header is required");

      let decoded: z.infer<typeof PaymentHeader>;
      try {
        decoded = PaymentHeader.parse(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
      } catch {
        return challenge("invalid_payment: X-PAYMENT is not a valid base64 x402 payload");
      }

      const { payload } = decoded;
      const auth = payload.authorization;
      const agent = clearance.agents.get(payload.agentId);
      const nowSec = Math.floor(clearance.now() / 1000);

      if (decoded.network !== X402_NETWORK) return challenge("invalid_network");
      if (!agent) return challenge("invalid_payment: unknown agent");
      if (auth.from.toLowerCase() !== agent.walletAddress.toLowerCase()) return challenge("invalid_payment: payer does not match agent wallet");
      if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) return challenge("invalid_payment: wrong recipient");
      if (auth.value !== requirements.maxAmountRequired) return challenge("invalid_payment: exact scheme requires the exact amount");
      if (Number(auth.validAfter) > nowSec || Number(auth.validBefore) < nowSec) return challenge("invalid_payment: authorization expired or not yet valid");
      if (!verifyMessage(agent.publicKey, x402AuthorizationMessage(auth), payload.signature)) return challenge("invalid_signature");
      if (!clearance.claimNonce(`x402:${auth.nonce}`)) return challenge("invalid_payment: nonce already used");

      const intent = await clearance.submit({
        agentId: agent.id,
        merchantId: resource.merchantId,
        amount: resource.price,
        memo: `x402 ${resource.path}`,
        rail: "x402",
        source: "x402",
        instant: true,
      });

      if (intent.stage === "hold") return challenge("payment_held_for_approval", { intentId: intent.id, callout: intent.callout });
      if (intent.stage !== "cleared" || !intent.receipt) return challenge("payment_declined", { intentId: intent.id, callout: intent.callout });

      const settlement = { success: true, transaction: intent.receipt.txRef, network: X402_NETWORK, payer: agent.walletAddress, intentId: intent.id };
      res.set("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settlement)).toString("base64"));
      res.set("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
      res.json(resource.serve(req));
    });
  }

  return router;
}
