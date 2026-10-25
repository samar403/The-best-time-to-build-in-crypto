import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { PaymentIntent } from "../../../shared/types";
import { useToast } from "../App";
import { Dossier } from "../components/Dossier";
import { Radar } from "../components/Radar";
import { Strip } from "../components/Strip";
import { api, compact, cx, formatAmount, lookups, SQUAWK, STAGES, toUnits, zulu } from "../lib";
import { useTower } from "../store";

const TERMINAL_LIMIT = 14;

/** METAR-style one-line weather report for the tower. */
function Metar() {
  const { stats, rules, intents } = useTower();
  const now = new Date();
  const stamp = `${String(now.getUTCDate()).padStart(2, "0")}${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}Z`;
  const decided = stats.clearedCount + stats.divertedCount;
  const clearRate = decided ? Math.round((stats.clearedCount / decided) * 100) : 100;
  const sanctions = intents.filter((i) => i.squawk === "7500").length;
  const items: [string, string, string?][] = [
    ["VOL", compact(stats.clearedVolume)],
    ["CLR", String(stats.clearedCount), "clear"],
    ["DVT", String(stats.divertedCount), "divert"],
    ["HLD", String(stats.holdCount), stats.holdCount ? "hold" : undefined],
    ["RATE", `${clearRate}%`],
    ["P50", `${stats.p50DecisionMs}MS`],
    ["SQ7500", String(sanctions), sanctions ? "divert" : undefined],
    ["BLK", String(stats.blocks)],
    ["RULES", `${rules.filter((r) => r.enabled).length}/${rules.length}`],
  ];
  return (
    <div className="metar" aria-label="Tower summary">
      <span className="metar-station">CLR {stamp}</span>
      {items.map(([k, v, tone]) => (
        <span key={k} className={cx("metar-item", tone && `tone-${tone}`)}>
          <small>{k}</small>
          {v}
        </span>
      ))}
    </div>
  );
}

function Frequency({ intents, onSelect }: { intents: PaymentIntent[]; onSelect: (id: string) => void }) {
  const lines = useMemo(
    () =>
      intents
        .filter((i) => i.stage !== "inbound" && i.stage !== "screening")
        .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
        .slice(0, 12),
    [intents],
  );
  return (
    <section className="panel frequency">
      <header className="panel-head">
        <h2>
          Frequency <span className="muted">121.5</span>
        </h2>
        <span className="eyebrow">radio log</span>
      </header>
      <ol aria-live="polite" aria-relevant="additions">
        {lines.map((i, idx) => (
          <li key={`${i.id}-${i.stage}`} className={cx("freq-line", idx === 0 && "fresh")}>
            <button onClick={() => onSelect(i.id)}>
              <time className="mono">{zulu(i.decidedAt ?? i.createdAt)}</time>
              <span className={cx("freq-dot", `tone-${SQUAWK[i.squawk].tone}`)} aria-hidden="true" />
              <span className="freq-text">{i.callout}</span>
            </button>
          </li>
        ))}
        {!lines.length && <li className="muted small">Quiet on frequency. Turn on traffic or fly a payment.</li>}
      </ol>
    </section>
  );
}

function ManualContact() {
  const { agents, merchants } = useTower();
  const toast = useToast();
  const [agentId, setAgentId] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("250");
  const [busy, setBusy] = useState(false);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const merchant = merchants.find((m) => m.id === merchantId) ?? merchants[0];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !merchant) return;
    setBusy(true);
    try {
      const intent = await api<PaymentIntent>("/api/intents", { body: { agentId: agent.id, merchantId: merchant.id, amount: toUnits(amount), memo: "manual contact" } });
      toast(intent.callout, intent.stage === "cleared" ? "ok" : intent.stage === "hold" ? "info" : "err");
    } catch (err) {
      toast((err as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel manual" onSubmit={submit}>
      <header className="panel-head">
        <h2>Fly a payment</h2>
        <span className="eyebrow">manual contact</span>
      </header>
      <div className="manual-grid">
        <label>
          <span>Agent</span>
          <select value={agent?.id ?? ""} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.callSign} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Merchant</span>
          <select value={merchant?.id ?? ""} onChange={(e) => setMerchantId(e.target.value)}>
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.category}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Amount ({agent?.currency ?? "USDC"})</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
        </label>
        <button className="btn btn-primary" disabled={busy || !Number(amount)}>
          {busy ? "Screening…" : "Request clearance"}
        </button>
      </div>
    </form>
  );
}

export function Tower() {
  const tower = useTower();
  const [selected, setSelected] = useState<string | null>(null);
  const lookup = useMemo(() => lookups(tower.agents, tower.merchants), [tower.agents, tower.merchants]);

  const byStage = useMemo(() => {
    const groups: Record<string, PaymentIntent[]> = { inbound: [], screening: [], hold: [], cleared: [], diverted: [] };
    for (let i = tower.intents.length - 1; i >= 0; i--) {
      const intent = tower.intents[i];
      const list = groups[intent.stage];
      if ((intent.stage === "cleared" || intent.stage === "diverted") && list.length >= TERMINAL_LIMIT) continue;
      list.push(intent);
    }
    return groups;
  }, [tower.intents]);

  const selectedIntent = selected ? tower.intents.find((i) => i.id === selected) : undefined;
  const select = useCallback((id: string) => setSelected((cur) => (cur === id ? null : id)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key.toLowerCase() === "h") {
        const holds = byStage.hold;
        if (!holds.length) return;
        const idx = holds.findIndex((h) => h.id === selected);
        setSelected(holds[(idx + 1) % holds.length].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [byStage, selected]);

  return (
    <div className="tower">
      <Metar />
      <div className="tower-grid">
        <div className="tower-left">
          <section className="panel scope">
            <header className="panel-head">
              <h2>Approach radar</h2>
              <span className="legend">
                <i className="tone-clear" />
                cleared <i className="tone-hold" />
                holding <i className="tone-divert" />
                diverted
              </span>
            </header>
            <Radar agents={tower.agents} merchants={tower.merchants} intents={tower.intents} selectedId={selected} />
          </section>
          <Frequency intents={tower.intents} onSelect={select} />
          <ManualContact />
        </div>

        <section className="board" aria-label="Flight strip board">
          {STAGES.map((stage) => (
            <div key={stage.id} className={cx("bay", `bay-${stage.id}`)}>
              <header className="bay-head">
                <span className="bay-name">{stage.label}</span>
                <span className="bay-count">{byStage[stage.id].length}</span>
                <span className="bay-hint">{stage.hint}</span>
              </header>
              <div className="bay-strips">
                {byStage[stage.id].map((intent) => (
                  <Strip
                    key={intent.id}
                    intent={intent}
                    agent={lookup.agent(intent.agentId)}
                    merchant={lookup.merchant(intent.merchantId)}
                    selected={intent.id === selected}
                    onSelect={select}
                  />
                ))}
                {!byStage[stage.id].length && <div className="bay-empty">{stage.id === "hold" ? "No one waiting on you." : "—"}</div>}
              </div>
            </div>
          ))}
        </section>
      </div>
      <p className="hint-bar">
        <kbd>H</kbd> next hold · <kbd>A</kbd> clear · <kbd>D</kbd> divert · <kbd>Esc</kbd> close · <kbd>1</kbd>–<kbd>7</kbd> switch rooms ·{" "}
        {formatAmount(tower.stats.clearedVolume)} settled this session
      </p>
      {selectedIntent && <Dossier intent={selectedIntent} lookup={lookup} onClose={() => setSelected(null)} />}
    </div>
  );
}
