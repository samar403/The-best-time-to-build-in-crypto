import { useState, type FormEvent } from "react";
import type { Agent, Currency, Jurisdiction } from "../../../shared/types";
import { useToast } from "../App";
import { Identicon } from "../components/Glyph";
import { api, cx, formatAmount, short, toUnits, zulu } from "../lib";
import { useTower } from "../store";

function FuelGauge({ used, limit }: { used: number; limit: number }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const segments = 20;
  const lit = Math.round((pct / 100) * segments);
  return (
    <div className="fuel" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Daily mandate used">
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className={cx(i < lit && (pct > 85 ? "hot" : pct > 60 ? "warm" : "on"))} />
      ))}
    </div>
  );
}

function Licence({ agent }: { agent: Agent }) {
  const { mandates, balances, spend } = useTower();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const mandate = mandates.find((m) => m.id === agent.mandateId);
  const balance = balances[`agent:${agent.id}`] ?? 0;
  const used = spend[agent.id]?.day ?? 0;
  const grounded = agent.status === "grounded";

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body });
      toast(msg, "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const topUp = async (amount: number) => {
    try {
      await api(`/api/agents/${agent.id}/topup`, { body: { amount: toUnits(amount) } });
      toast(`${agent.callSign} refuelled +${amount.toLocaleString()} ${agent.currency}`, "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  return (
    <article className={cx("licence", grounded && "grounded")}>
      <header className="licence-band">
        <span>Agent pilot licence</span>
        <span>KYA · L{agent.kyaLevel}</span>
      </header>
      <div className="licence-body">
        <Identicon seed={agent.fingerprint} size={64} />
        <div className="licence-id">
          <h3 className="mono">{agent.callSign}</h3>
          <p>{agent.name}</p>
          <p className="muted small">{agent.purpose}</p>
        </div>
        {grounded && <span className="stamp">Grounded</span>}
      </div>
      <dl className="licence-fields">
        <div>
          <dt>Operator</dt>
          <dd>{agent.owner}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono">{agent.model}</dd>
        </div>
        <div>
          <dt>Jurisdiction</dt>
          <dd>
            {agent.jurisdiction} · {agent.currency}
          </dd>
        </div>
        <div>
          <dt>Wallet</dt>
          <dd className="mono" title={agent.walletAddress}>
            {short(agent.walletAddress, 5)}
          </dd>
        </div>
        <div className="span-2">
          <dt>Key fingerprint</dt>
          <dd className="mono">{agent.fingerprint}</dd>
        </div>
      </dl>
      <div className="licence-fuel">
        <div className="row-between small">
          <span>
            Today <b className="mono">{formatAmount(used)}</b> of {mandate ? formatAmount(mandate.dailyLimit) : "—"}
          </span>
          <span>
            Wallet <b className="mono">{formatAmount(balance)}</b>
          </span>
        </div>
        <FuelGauge used={used} limit={mandate?.dailyLimit ?? 0} />
      </div>
      <div className="licence-controls">
        <label className="field-inline grow">
          <span>Flight plan</span>
          <select value={agent.mandateId} onChange={(e) => patch({ mandateId: e.target.value }, `${agent.callSign} re-filed on new flight plan`)}>
            {mandates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => topUp(100)}>
            +100
          </button>
          <button className="btn btn-ghost" onClick={() => topUp(1000)}>
            +1,000
          </button>
          {grounded ? (
            <button className="btn btn-clear" onClick={() => patch({ status: "active" }, `${agent.callSign} released — cleared to operate`)}>
              Release
            </button>
          ) : confirming ? (
            <button
              className="btn btn-divert"
              onClick={() => {
                setConfirming(false);
                void patch({ status: "grounded" }, `${agent.callSign} grounded — all payments will divert`);
              }}
              onBlur={() => setConfirming(false)}
              autoFocus
            >
              Confirm ground
            </button>
          ) : (
            <button className="btn btn-outline-divert" onClick={() => setConfirming(true)} title="Kill switch: every payment from this agent diverts">
              Ground
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function Commission({ onClose }: { onClose: () => void }) {
  const { mandates } = useTower();
  const toast = useToast();
  const [form, setForm] = useState({
    name: "",
    owner: "Northwind Labs",
    model: "claude-sonnet-5-5",
    purpose: "",
    jurisdiction: "US" as Jurisdiction,
    currency: "USDC" as Currency,
    kyaLevel: 2,
    mandateId: mandates[0]?.id ?? "",
    funding: "500",
    custodial: true,
  });
  const [issued, setIssued] = useState<{ agent: Agent; privateKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ agent: Agent; privateKey: string }>("/api/agents", {
        body: {
          name: form.name,
          owner: form.owner,
          model: form.model,
          purpose: form.purpose,
          jurisdiction: form.jurisdiction,
          currency: form.currency,
          kyaLevel: form.kyaLevel,
          mandateId: form.mandateId,
          initialFunding: Number(form.funding) > 0 ? toUnits(form.funding) : undefined,
          custodial: form.custodial,
        },
      });
      setIssued(res);
      toast(`${res.agent.callSign} commissioned`, "ok");
    } catch (err) {
      toast((err as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Commission an agent" onClick={(e) => e.stopPropagation()}>
        {issued ? (
          <div className="issued">
            <div className="eyebrow">Licence issued</div>
            <h2 className="serif-title">
              {issued.agent.callSign} <span className="muted">is cleared to fly.</span>
            </h2>
            <p className="small">
              This is the agent’s private signing key. It is shown <b>once</b>. Put it in the agent’s secret store; Clearance keeps only the public key
              {form.custodial ? " (and, because you chose custodial mode, a sandbox copy for the x402 lab)" : ""}.
            </p>
            <pre className="code key">{issued.privateKey}</pre>
            <dl className="facts">
              <div className="span-2">
                <dt>Agent id</dt>
                <dd className="mono">{issued.agent.id}</dd>
              </div>
              <div className="span-2">
                <dt>Fingerprint</dt>
                <dd className="mono">{issued.agent.fingerprint}</dd>
              </div>
            </dl>
            <div className="btn-row">
              <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(issued.privateKey).then(() => toast("Key copied", "ok"))}>
                Copy key
              </button>
              <button className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="form">
            <div className="eyebrow">Know your agent</div>
            <h2 className="serif-title">Commission an agent</h2>
            <div className="form-grid">
              <label>
                <span>Name</span>
                <input required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Invoice Clerk" />
              </label>
              <label>
                <span>Operator (legal entity)</span>
                <input required value={form.owner} onChange={(e) => set("owner", e.target.value)} />
              </label>
              <label>
                <span>Model</span>
                <input required value={form.model} onChange={(e) => set("model", e.target.value)} />
              </label>
              <label>
                <span>Flight plan</span>
                <select value={form.mandateId} onChange={(e) => set("mandateId", e.target.value)}>
                  {mandates.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="span-2">
                <span>Purpose</span>
                <input value={form.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="What this agent is for, in one line" />
              </label>
              <label>
                <span>Jurisdiction</span>
                <select value={form.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)}>
                  {["US", "EU", "UK", "SG"].map((j) => (
                    <option key={j}>{j}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Settlement asset</span>
                <select value={form.currency} onChange={(e) => set("currency", e.target.value)}>
                  {["USDC", "EURC", "USDT"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>KYA level</span>
                <select value={form.kyaLevel} onChange={(e) => set("kyaLevel", Number(e.target.value))}>
                  <option value={1}>L1 · key only</option>
                  <option value={2}>L2 · operator verified</option>
                  <option value={3}>L3 · operator + model attested</option>
                </select>
              </label>
              <label>
                <span>Initial fuel from treasury</span>
                <input inputMode="decimal" value={form.funding} onChange={(e) => set("funding", e.target.value.replace(/[^\d.]/g, ""))} />
              </label>
              <label className="check span-2">
                <input type="checkbox" checked={form.custodial} onChange={(e) => set("custodial", e.target.checked)} />
                <span>Custodial sandbox key (lets the x402 Lab fly this agent)</span>
              </label>
            </div>
            <div className="btn-row end">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Issuing…" : "Issue licence"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function Hangar() {
  const { agents, simulator } = useTower();
  const [open, setOpen] = useState(false);
  const active = agents.filter((a) => a.status === "active").length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Hangar · identity registry</div>
          <h1 className="page-title">
            Every agent carries a licence. <em>Nobody flies anonymous.</em>
          </h1>
          <p className="lede">
            {active} of {agents.length} agents active. Each one holds an ed25519 key bound to a legal operator, a model, a jurisdiction and exactly one flight plan. Grounding an agent
            is a kill switch: its next payment diverts.
          </p>
          {simulator.periodStartedAt && (
            <p className="small muted mono period-note">
              Sandbox day began {zulu(simulator.periodStartedAt, false)} · sandbox days last 15 minutes so limits refill while you watch.
            </p>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          + Commission agent
        </button>
      </header>
      <div className="licence-grid">
        {agents.map((a) => (
          <Licence key={a.id} agent={a} />
        ))}
      </div>
      {open && <Commission onClose={() => setOpen(false)} />}
    </div>
  );
}
