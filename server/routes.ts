import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CATEGORIES, formatAmount, type Category, type ServerEvent } from "../shared/types.js";
import { requestSigningPayload, verifyMessage } from "../shared/crypto.js";
import { ClearanceAgent, type X402Step } from "../sdk/index.js";
import { compileMandate } from "./composer.js";
import { STABLECOIN_REGISTRY, TRAVEL_RULE_THRESHOLD_USD } from "./compliance.js";
import { agentAccount, ClearanceError, type Clearance } from "./engine.js";
import type { Simulator } from "./simulator.js";
import { RESOURCES, requirementsFor } from "./x402.js";

const amountSchema = z.number().int().positive().max(1e15);
const CategoryEnum = z.enum(CATEGORIES as [Category, ...Category[]]);

const MandateBody = z.object({
  name: z.string().min(1).max(80),
  source: z.string().max(2000).default(""),
  perTxLimit: amountSchema,
  dailyLimit: amountSchema,
  monthlyLimit: amountSchema,
  allowedCategories: z.array(CategoryEnum).nullable(),
  blockedCategories: z.array(CategoryEnum),
  allowedMerchants: z.array(z.string()).nullable(),
  blockedMerchants: z.array(z.string()),
  approvalThreshold: amountSchema.nullable(),
  activeHoursUtc: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(24) }).nullable(),
  weekdaysOnly: z.boolean(),
  expiresAt: z.number().nullable(),
  createdBy: z.enum(["human", "composer", "seed"]).default("human"),
});

const AgentBody = z.object({
  name: z.string().min(1).max(60),
  callSign: z.string().regex(/^[A-Za-z]{3,8}-\d{3}$/, "call sign looks like HERON-417").optional(),
  owner: z.string().min(1).max(80),
  model: z.string().min(1).max(60),
  purpose: z.string().max(200).default(""),
  jurisdiction: z.enum(["US", "EU", "UK", "SG"]),
  currency: z.enum(["USDC", "EURC", "USDT"]),
  kyaLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mandateId: z.string(),
  initialFunding: amountSchema.optional(),
  custodial: z.boolean().default(false),
});

const PayBody = z.object({ merchantId: z.string(), amount: amountSchema, memo: z.string().max(140).optional() });

const SIGNATURE_WINDOW_MS = 5 * 60_000;

interface SignedRequest extends Request {
  agentId?: string;
  rawBody?: string;
}

export function apiRouter(clearance: Clearance, simulator: Simulator) {
  const r = Router();

  /** Verify an ed25519-signed agent request (see sdk/index.ts). */
  const signedAgent = (req: SignedRequest, _res: Response, next: NextFunction) => {
    const agentId = req.get("x-clearance-agent");
    const timestamp = req.get("x-clearance-timestamp");
    const signature = req.get("x-clearance-signature");
    if (!agentId || !timestamp || !signature) throw new ClearanceError("missing signature headers", 401);
    const agent = clearance.agents.get(agentId);
    if (!agent) throw new ClearanceError("unknown agent", 401);
    if (Math.abs(clearance.now() - Number(timestamp)) > SIGNATURE_WINDOW_MS) throw new ClearanceError("stale timestamp", 401);
    const payload = requestSigningPayload(timestamp, req.method, req.originalUrl, req.rawBody ?? "");
    if (!verifyMessage(agent.publicKey, payload, signature)) throw new ClearanceError("bad signature", 401);
    if (!clearance.claimNonce(`sig:${signature}`, SIGNATURE_WINDOW_MS * 2)) throw new ClearanceError("replayed request", 401);
    req.agentId = agent.id;
    next();
  };

  r.get("/health", (_req, res) => {
    res.json({ ok: true, blocks: clearance.ledger.blocks.length, agents: clearance.agents.size });
  });

  r.get("/snapshot", (_req, res) => {
    res.json(clearance.snapshot());
  });

  // Server-sent events: one snapshot, then a live stream of domain events.
  r.get("/stream", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: ServerEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    send({ type: "snapshot", data: clearance.snapshot() });
    clearance.events.on("event", send);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      clearance.events.off("event", send);
    });
  });

  // ── Agents (KYA registry) ──
  r.get("/agents", (_req, res) => {
    res.json([...clearance.agents.values()]);
  });

  r.post("/agents", (req, res) => {
    const { initialFunding, custodial, ...input } = AgentBody.parse(req.body);
    const { agent, privateKey } = clearance.createAgent(input, { custodial });
    if (initialFunding) clearance.topUp(agent.id, initialFunding);
    // The private key is returned exactly once; Clearance keeps only the public key
    // unless the operator chose custodial keys.
    res.status(201).json({ agent, privateKey });
  });

  r.patch("/agents/:id", (req, res) => {
    const patch = z
      .object({
        status: z.enum(["active", "grounded"]).optional(),
        mandateId: z.string().optional(),
        kyaLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      })
      .parse(req.body);
    res.json(clearance.updateAgent(req.params.id, patch));
  });

  r.post("/agents/:id/topup", (req, res) => {
    const { amount } = z.object({ amount: amountSchema }).parse(req.body);
    const block = clearance.topUp(req.params.id, amount);
    res.json({ block, balance: clearance.ledger.balance(agentAccount(req.params.id)) });
  });

  // ── Mandates (flight plans) ──
  r.get("/mandates", (_req, res) => {
    res.json([...clearance.mandates.values()]);
  });

  r.post("/mandates", (req, res) => {
    res.status(201).json(clearance.saveMandate(MandateBody.parse(req.body)));
  });

  r.put("/mandates/:id", (req, res) => {
    if (!clearance.mandates.has(req.params.id)) throw new ClearanceError("unknown mandate", 404);
    res.json(clearance.saveMandate({ ...MandateBody.parse(req.body), id: req.params.id }));
  });

  r.post("/mandates/compile", async (req, res) => {
    const { text } = z.object({ text: z.string().min(3).max(2000) }).parse(req.body);
    res.json(await compileMandate(text, [...clearance.merchants.values()], clearance.now()));
  });

  r.post("/mandates/dry-run", (req, res) => {
    const body = z
      .object({ mandate: MandateBody, merchantId: z.string(), amount: amountSchema, agentId: z.string().optional() })
      .parse(req.body);
    const mandate = { ...body.mandate, id: "dry-run", createdAt: clearance.now() };
    res.json(clearance.dryRun(mandate, body.merchantId, body.amount, body.agentId));
  });

  r.get("/merchants", (_req, res) => {
    res.json([...clearance.merchants.values()]);
  });

  // ── Payments ──
  r.get("/intents", (req, res) => {
    const stage = typeof req.query.stage === "string" ? req.query.stage : undefined;
    const list = [...clearance.intents.values()].filter((i) => !stage || i.stage === stage);
    res.json(list.slice(-200).reverse());
  });

  r.get("/intents/:id", (req, res) => {
    const intent = clearance.intents.get(req.params.id);
    if (!intent) throw new ClearanceError("unknown payment", 404);
    res.json(intent);
  });

  // Operator-initiated payment on behalf of an agent (console "file a flight plan").
  r.post("/intents", async (req, res) => {
    const body = PayBody.extend({ agentId: z.string() }).parse(req.body);
    res.status(201).json(await clearance.submit({ ...body, source: "console" }));
  });

  r.post("/intents/:id/approve", async (req, res) => {
    const { by } = z.object({ by: z.string().min(1).max(60).default("operator") }).parse(req.body ?? {});
    res.json(await clearance.approve(req.params.id, by));
  });

  r.post("/intents/:id/deny", (req, res) => {
    const { by, reason } = z
      .object({ by: z.string().min(1).max(60).default("operator"), reason: z.string().max(140).default("denied by operator") })
      .parse(req.body ?? {});
    res.json(clearance.deny(req.params.id, by, reason));
  });

  // ── Agent-facing API (signed) ──
  r.get("/agent/me", signedAgent, (req: SignedRequest, res) => {
    const agent = clearance.requireAgent(req.agentId!);
    res.json({
      agent,
      mandate: clearance.mandates.get(agent.mandateId) ?? null,
      balance: clearance.ledger.balance(agentAccount(agent.id)),
      spend: clearance.spend(agent.id),
    });
  });

  r.post("/agent/pay", signedAgent, async (req: SignedRequest, res) => {
    const body = PayBody.parse(req.body);
    const intent = await clearance.submit({ ...body, agentId: req.agentId!, source: "api" });
    res.status(intent.stage === "diverted" ? 402 : intent.stage === "hold" ? 202 : 200).json(intent);
  });

  // ── Flight recorder ──
  r.get("/ledger", (req, res) => {
    const limit = Math.min(500, Number(req.query.limit ?? 100));
    res.json(clearance.ledger.blocks.slice(-limit).reverse());
  });

  r.get("/ledger/verify", (req, res) => {
    const tamper = req.query.tamper === undefined ? undefined : Number(req.query.tamper);
    res.json(clearance.verifyLedger(Number.isInteger(tamper) ? tamper : undefined));
  });

  r.get("/ledger/export.csv", (_req, res) => {
    const rows = [["height", "timestamp", "hash", "prev_hash", "intent_id", "account", "debit", "credit", "memo"]];
    for (const b of clearance.ledger.blocks) {
      for (const e of b.entries) {
        rows.push([String(b.height), new Date(b.timestamp).toISOString(), b.hash, b.prevHash, b.intentId ?? "", e.account, formatAmount(e.debit), formatAmount(e.credit), b.memo]);
      }
    }
    const csv = rows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    res.type("text/csv").attachment("clearance-ledger.csv").send(csv);
  });

  // ── Rulebook ──
  r.get("/rules", (_req, res) => {
    res.json(clearance.rules);
  });

  r.patch("/rules/:id", (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(clearance.setRule(req.params.id, enabled));
  });

  r.get("/registry", (_req, res) => {
    res.json({ stablecoins: STABLECOIN_REGISTRY, travelRuleThresholdUsd: TRAVEL_RULE_THRESHOLD_USD });
  });

  r.get("/sanctions", (_req, res) => {
    res.json(clearance.sanctions);
  });

  r.post("/sanctions", (req, res) => {
    const { name, address } = z
      .object({ name: z.string().min(2).max(120), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable().default(null) })
      .parse(req.body);
    res.status(201).json(clearance.addSanction(name, address));
  });

  r.delete("/sanctions/:id", (req, res) => {
    clearance.removeSanction(req.params.id);
    res.status(204).end();
  });

  r.get("/reports/compliance", (_req, res) => {
    const intents = [...clearance.intents.values()];
    const byRule: Record<string, { fail: number; hold: number }> = {};
    for (const i of intents) {
      for (const t of i.trace) {
        if (t.outcome !== "fail" && t.outcome !== "hold") continue;
        byRule[t.rule] ??= { fail: 0, hold: 0 };
        byRule[t.rule][t.outcome]++;
      }
    }
    res.json({
      generatedAt: new Date(clearance.now()).toISOString(),
      window: { intents: intents.length },
      stats: clearance.stats(),
      byRule,
      travelRuleTransfers: intents.filter((i) => i.travelRule).map((i) => ({ id: i.id, ...i.travelRule, stage: i.stage })),
      sanctionsHits: intents.filter((i) => i.squawk === "7500").map((i) => ({ id: i.id, agentId: i.agentId, merchantId: i.merchantId, amount: i.amount })),
      ledger: clearance.verifyLedger(),
    });
  });

  // ── Simulator ──
  r.post("/simulator", (req, res) => {
    const { running } = z.object({ running: z.boolean() }).parse(req.body);
    if (running) simulator.start();
    else simulator.stop();
    res.json({ running: simulator.running });
  });

  // ── x402 lab: drive a real x402 handshake against this server with a custodial agent ──
  r.get("/x402/resources", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res.json(RESOURCES.map((resource) => ({ path: `/x402${resource.path}`, requirements: requirementsFor(clearance, resource, origin) })));
  });

  r.post("/lab/x402", async (req, res) => {
    const { agentId, path } = z.object({ agentId: z.string(), path: z.string().startsWith("/x402/") }).parse(req.body);
    const privateKey = clearance.custodialKey(agentId);
    if (!privateKey) throw new ClearanceError("the lab can only fly agents whose keys Clearance custodies", 409);
    const base = `http://127.0.0.1:${req.socket.localPort}`;
    const steps: X402Step[] = [];
    const agent = new ClearanceAgent({ baseUrl: base, agentId, privateKey });
    const response = await agent.fetchWithPayment(`${base}${path}`, {}, { onStep: (s) => steps.push(s), maxAmount: 5_000_000 }).catch((err: Error) => err);
    if (response instanceof Error) return res.json({ ok: false, error: response.message, steps });
    const body = await response.json().catch(() => null);
    res.json({ ok: response.ok, status: response.status, body, steps });
  });

  return r;
}
