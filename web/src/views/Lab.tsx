import { useEffect, useRef, useState } from "react";
import type { X402PaymentRequirements } from "../../../shared/types";
import { useToast } from "../App";
import { api, cx, formatAmount } from "../lib";
import { useTower } from "../store";

interface Step {
  kind: "request" | "challenge" | "authorize" | "retry" | "settled" | "refused";
  title: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  at: number;
}

interface Run {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
  steps: Step[];
}

type Lane = 0 | 1 | 2;
interface Arrow {
  from: Lane;
  to: Lane;
  label: string;
  sub?: string;
  tone?: "clear" | "hold" | "divert";
  detail: unknown;
}

const LANES = ["Agent · SDK", "Resource server", "Clearance tower"];

function toArrows(run: Run): Arrow[] {
  const arrows: Arrow[] = [];
  for (const s of run.steps) {
    if (s.kind === "request") arrows.push({ from: 0, to: 1, label: s.title, sub: "no payment attached", detail: s });
    if (s.kind === "challenge") arrows.push({ from: 1, to: 0, label: "402 Payment Required", sub: "accepts: exact · base-sepolia · USDC", tone: "hold", detail: s.body });
    if (s.kind === "authorize") arrows.push({ from: 0, to: 0, label: "sign exact authorization", sub: "ed25519 KYA key · nonce · 60s window", detail: s.body });
    if (s.kind === "retry") {
      arrows.push({ from: 0, to: 1, label: "GET + X-PAYMENT", sub: "same request, base64 payment payload", detail: s.headers });
      arrows.push({ from: 1, to: 2, label: "verify & clear", sub: "signature · nonce · mandate · compliance", detail: { checks: ["payer = agent wallet", "payTo = merchant", "value = exact price", "valid time window", "ed25519 signature", "nonce unused", "mandate", "compliance rulepack", "ledger post"] } });
    }
    if (s.kind === "settled") {
      arrows.push({ from: 2, to: 1, label: "cleared · squawk 1200", sub: "block posted, receipt issued", tone: "clear", detail: s.body });
      arrows.push({ from: 1, to: 0, label: "200 OK + X-PAYMENT-RESPONSE", sub: "resource delivered", tone: "clear", detail: { receipt: s.body, resource: run.body } });
    }
    if (s.kind === "refused") {
      if (run.steps.some((x) => x.kind === "retry")) arrows.push({ from: 2, to: 1, label: "not cleared", sub: "held or diverted", tone: "divert", detail: s.body });
      arrows.push({ from: 1, to: 0, label: s.title, tone: "divert", detail: s.body });
    }
  }
  return arrows;
}

const SNIPPET = `import { ClearanceAgent } from "./sdk";

const agent = new ClearanceAgent({
  baseUrl: "https://clearance.example",
  agentId: process.env.AGENT_ID,
  privateKey: process.env.AGENT_KEY, // ed25519, never leaves the agent
});

// Any 402 is answered automatically — inside the agent's mandate.
const res = await agent.fetchWithPayment(
  "https://data.example/x402/v1/market-signal?ticker=ETH",
  {},
  { maxAmount: 10_000 }, // 0.01 USDC client-side cap
);`;

export function Lab() {
  const { agents } = useTower();
  const toast = useToast();
  const [resources, setResources] = useState<{ path: string; requirements: X402PaymentRequirements }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [path, setPath] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [shown, setShown] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api<{ path: string; requirements: X402PaymentRequirements }[]>("/api/x402/resources").then((r) => {
      setResources(r);
      setPath((p) => p || r[0]?.path || "");
    });
    return () => window.clearInterval(timer.current);
  }, []);

  const kite = agents.find((a) => a.callSign === "KITE-221");
  const chosen = agents.find((a) => a.id === agentId) ?? kite ?? agents[0];
  const arrows = run ? toArrows(run) : [];

  const fly = async () => {
    if (!chosen || !path) return;
    setBusy(true);
    setRun(null);
    setShown(0);
    setActive(null);
    window.clearInterval(timer.current);
    try {
      const result = await api<Run>("/api/lab/x402", { body: { agentId: chosen.id, path } });
      setRun(result);
      const total = toArrows(result).length;
      let n = 0;
      timer.current = window.setInterval(() => {
        n += 1;
        setShown(n);
        setActive(n - 1);
        if (n >= total) window.clearInterval(timer.current);
      }, 520);
      if (result.error) toast(result.error, "err");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const detail = active !== null ? arrows[active]?.detail : null;
  const resource = resources.find((r) => r.path === path);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">x402 Lab · HTTP 402 Payment Required</div>
          <h1 className="page-title">
            The status code the web reserved in 1997. <em>Agents finally use it.</em>
          </h1>
          <p className="lede">
            x402 lets any HTTP endpoint charge per request: answer with 402 and a price, and the client retries with a signed payment. Here a real handshake runs against this
            server — and the payment is cleared through the agent’s mandate and compliance rulepack before the resource is released.
          </p>
        </div>
      </header>

      <div className="lab">
        <section className="panel lab-controls">
          <header className="panel-head">
            <h2>Flight</h2>
          </header>
          <label className="stack">
            <span>Agent</span>
            <select value={chosen?.id ?? ""} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.callSign} · {a.name} {a.status === "grounded" ? "(grounded)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="resource-list" role="radiogroup" aria-label="Paid resource">
            {resources.map((r) => (
              <button key={r.path} role="radio" aria-checked={r.path === path} className={cx("resource", r.path === path && "active")} onClick={() => setPath(r.path)}>
                <span className="mono small">{r.path}</span>
                <span className="resource-desc">{r.requirements.description}</span>
                <span className="resource-price mono">
                  {formatAmount(Number(r.requirements.maxAmountRequired))} USDC · {String(r.requirements.extra.merchant)}
                </span>
              </button>
            ))}
          </div>
          <button className="btn btn-primary wide" onClick={fly} disabled={busy || !chosen || !resource}>
            {busy ? "Negotiating…" : "Run handshake"}
          </button>
          <p className="small muted">
            Tip: Research Scout (KITE-221) is filed for data and APIs. Try Travel Desk (OSPREY-090) to watch the tower refuse a payment its mandate doesn’t allow, or the grounded
            SWIFT-008.
          </p>
        </section>

        <section className="panel sequence" aria-label="Handshake sequence">
          <div className="lanes">
            {LANES.map((l) => (
              <div key={l} className="lane-head">
                {l}
              </div>
            ))}
          </div>
          <ol className="arrows">
            {arrows.slice(0, shown).map((a, i) => {
              const self = a.from === a.to;
              const left = Math.min(a.from, a.to);
              const span = Math.abs(a.to - a.from);
              return (
                <li key={i}>
                  <button
                    className={cx("arrow", a.tone && `tone-${a.tone}`, active === i && "active", self && "self", a.to < a.from && "rtl")}
                    style={{ ["--left" as string]: left, ["--span" as string]: span }}
                    onClick={() => setActive(i)}
                  >
                    <span className="arrow-label">
                      <span className="arrow-n mono">{String(i + 1).padStart(2, "0")}</span>
                      {a.label}
                    </span>
                    {a.sub && <span className="arrow-sub">{a.sub}</span>}
                    <span className="arrow-line" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
            {!run && <li className="sequence-empty">Pick an agent and a resource, then run the handshake.</li>}
          </ol>
          {run && shown >= arrows.length && (
            <div className={cx("sequence-result", run.ok ? "ok" : "bad")}>
              {run.ok ? "✓ Paid, cleared, delivered." : "✕ Payment not cleared — resource withheld."} <span className="mono small">HTTP {run.status ?? "—"}</span>
            </div>
          )}
        </section>

        <section className="panel lab-detail">
          <header className="panel-head">
            <h2>{active !== null && arrows[active] ? arrows[active].label : "Wire detail"}</h2>
          </header>
          <pre className="code tall">{detail ? JSON.stringify(detail, null, 2) : "Select a step to inspect what went over the wire."}</pre>
          <h3 className="section-label">Integrate</h3>
          <pre className="code">{SNIPPET}</pre>
        </section>
      </div>
    </div>
  );
}
