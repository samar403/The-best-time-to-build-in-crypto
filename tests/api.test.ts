import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";
import { ClearanceAgent, units } from "../sdk/index";
import { requestSigningPayload, signMessage } from "../shared/crypto";
import type { Agent, PaymentIntent } from "../shared/types";

let server: Server;
let base: string;
const { app, clearance } = createApp({ stageDelayMs: 0 });

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function commission(patch: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name: "Test Agent",
      owner: "Northwind Labs",
      model: "claude-sonnet-5-5",
      jurisdiction: "US",
      currency: "USDC",
      kyaLevel: 2,
      mandateId: "mnd_research",
      initialFunding: units("20"),
      ...patch,
    })
    .expect(201);
  return res.body as { agent: Agent; privateKey: string };
}

describe("operator API", () => {
  it("serves a seeded snapshot", async () => {
    const res = await request(app).get("/api/snapshot").expect(200);
    expect(res.body.agents.length).toBeGreaterThanOrEqual(6);
    expect(res.body.merchants.length).toBeGreaterThan(10);
    expect(res.body.rules.length).toBe(9);
  });

  it("validates input with useful errors", async () => {
    const res = await request(app).post("/api/intents").send({ agentId: "x", merchantId: "m_helios", amount: -5 }).expect(400);
    expect(res.body.error).toMatch(/amount/);
  });

  it("holds above the approval threshold until a human clears it", async () => {
    const heron = [...clearance.agents.values()].find((a) => a.callSign === "HERON-417")!;
    const held = await request(app).post("/api/intents").send({ agentId: heron.id, merchantId: "m_helios", amount: units("1200") }).expect(201);
    expect(held.body.stage).toBe("hold");
    expect(held.body.squawk).toBe("4000");
    const cleared = await request(app).post(`/api/intents/${held.body.id}/approve`).send({ by: "tester" }).expect(200);
    expect(cleared.body.stage).toBe("cleared");
    expect(cleared.body.decidedBy).toBe("human:tester");
    await request(app).post(`/api/intents/${held.body.id}/deny`).send({}).expect(409);
  });

  it("diverts every payment from a grounded agent", async () => {
    const { agent } = await commission();
    await request(app).patch(`/api/agents/${agent.id}`).send({ status: "grounded" }).expect(200);
    const res = await request(app).post("/api/intents").send({ agentId: agent.id, merchantId: "m_signal", amount: 100 }).expect(201);
    expect(res.body.stage).toBe("diverted");
  });

  it("compiles a mandate from English with the built-in parser when no key is configured", async () => {
    const res = await request(app).post("/api/mandates/compile").send({ text: "Only data. $3 per call, $90 a day." }).expect(200);
    expect(res.body.engine).toBe("heuristic");
    expect(res.body.draft.perTxLimit).toBe(units("3"));
    expect(res.body.draft.allowedCategories).toEqual(["data"]);
  });

  it("keeps the ledger chain verifiable and detects a tampered copy", async () => {
    expect((await request(app).get("/api/ledger/verify").expect(200)).body.valid).toBe(true);
    const tampered = await request(app).get("/api/ledger/verify?tamper=2").expect(200);
    expect(tampered.body).toMatchObject({ valid: false, brokenAt: 2 });
    expect((await request(app).get("/api/ledger/verify").expect(200)).body.valid).toBe(true);
  });
});

describe("agent SDK (signed requests)", () => {
  it("pays inside its mandate and is refused outside it", async () => {
    const { agent, privateKey } = await commission();
    const client = new ClearanceAgent({ baseUrl: base, agentId: agent.id, privateKey });
    const me = await client.me();
    expect(me.balance).toBe(units("20"));

    const ok = await client.pay({ merchantId: "m_tidewater", amount: units("2.50"), memo: "feed" });
    expect(ok.stage).toBe("cleared");
    expect(ok.receipt?.blockHash).toMatch(/^[0-9a-f]{64}$/);

    const refused = await client.pay({ merchantId: "m_tidewater", amount: units("9") }).catch((e) => e);
    expect(refused.status).toBe(402);
    expect((refused.body as PaymentIntent).squawk).toBe("7600");
  });

  it("rejects bad signatures and replays", async () => {
    const { agent, privateKey } = await commission();
    const body = JSON.stringify({ merchantId: "m_signal", amount: 100 });
    const ts = String(Date.now());
    const sig = signMessage(privateKey, requestSigningPayload(ts, "POST", "/api/agent/pay", body));
    const send = (signature: string) =>
      request(app)
        .post("/api/agent/pay")
        .set("content-type", "application/json")
        .set("x-clearance-agent", agent.id)
        .set("x-clearance-timestamp", ts)
        .set("x-clearance-signature", signature)
        .send(body);
    await send(sig).expect(200);
    expect((await send(sig).expect(401)).body.error).toMatch(/replay/);
    const other = signMessage(privateKey, requestSigningPayload(ts, "POST", "/api/agent/pay", body.replace("100", "999")));
    expect((await send(other).expect(401)).body.error).toMatch(/signature/);
  });
});

describe("x402", () => {
  it("challenges unpaid requests with v1 payment requirements", async () => {
    const res = await request(app).get("/x402/v1/market-signal").expect(402);
    expect(res.body.x402Version).toBe(1);
    expect(res.body.accepts[0]).toMatchObject({ scheme: "exact", network: "base-sepolia", maxAmountRequired: "2000" });
  });

  it("pays, clears and delivers through the SDK", async () => {
    const { agent, privateKey } = await commission();
    const client = new ClearanceAgent({ baseUrl: base, agentId: agent.id, privateKey });
    const kinds: string[] = [];
    const res = await client.fetchWithPayment(`${base}/x402/v1/market-signal?ticker=ETH`, {}, { onStep: (s) => kinds.push(s.kind) });
    expect(res.status).toBe(200);
    expect((await res.json()).ticker).toBe("ETH");
    const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString());
    expect(receipt).toMatchObject({ success: true, network: "base-sepolia", payer: agent.walletAddress });
    expect(kinds).toEqual(["request", "challenge", "authorize", "retry", "settled"]);
  });

  it("withholds the resource when the mandate forbids the purchase", async () => {
    const { agent, privateKey } = await commission({ mandateId: "mnd_travel" });
    const client = new ClearanceAgent({ baseUrl: base, agentId: agent.id, privateKey });
    const res = await client.fetchWithPayment(`${base}/x402/v1/inference`);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("payment_declined");
  });

  it("refuses a reused x402 nonce", async () => {
    const { agent, privateKey } = await commission();
    const client = new ClearanceAgent({ baseUrl: base, agentId: agent.id, privateKey });
    let header = "";
    const spy: typeof fetch = async (input, init) => {
      const h = new Headers(init?.headers).get("X-PAYMENT");
      if (h) header = h;
      return fetch(input, init);
    };
    const spying = new ClearanceAgent({ baseUrl: base, agentId: agent.id, privateKey, fetch: spy });
    await client.me();
    expect((await spying.fetchWithPayment(`${base}/x402/v1/market-signal`)).status).toBe(200);
    const replay = await fetch(`${base}/x402/v1/market-signal`, { headers: { "X-PAYMENT": header } });
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toMatch(/nonce/);
  });

  it("refuses to pay more than the client cap", async () => {
    const { agent, privateKey } = await commission();
    const client = new ClearanceAgent({ baseUrl: base, agentId: agent.id, privateKey });
    await expect(client.fetchWithPayment(`${base}/x402/v1/dataset/shipping-lanes`, {}, { maxAmount: units("0.10") })).rejects.toThrow(/maxAmount/);
  });
});
