import { useEffect, useState, type FormEvent } from "react";
import type { RuleToggle } from "../../../shared/types";
import { useToast } from "../App";
import { api, cx, short } from "../lib";
import { useTower } from "../store";

interface Registry {
  stablecoins: Record<string, { issuer: string; usPermitted: boolean; euAuthorisedEmt: boolean }>;
  travelRuleThresholdUsd: Record<string, number>;
}

const REGIONS: { id: RuleToggle["jurisdiction"]; name: string; note: string }[] = [
  { id: "GLOBAL", name: "Everywhere", note: "Screening, anomaly and counterparty checks on every payment." },
  { id: "US", name: "United States", note: "Payment-stablecoin framework and the FinCEN Travel Rule." },
  { id: "EU", name: "European Union", note: "MiCA stablecoin rules and the Transfer of Funds Regulation." },
  { id: "UK", name: "United Kingdom", note: "Cryptoasset Travel Rule under the MLRs." },
  { id: "SG", name: "Singapore", note: "MAS digital payment token Travel Rule." },
];

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button className={cx("switch", on && "on")} onClick={onChange} aria-pressed={on} aria-label={label}>
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
    </button>
  );
}

export function Rulebook() {
  const { rules, sanctions, intents, agents } = useTower();
  const toast = useToast();
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [entry, setEntry] = useState({ name: "", address: "" });

  useEffect(() => {
    api<Registry>("/api/registry").then(setRegistry).catch(() => setRegistry(null));
  }, []);

  const toggle = async (r: RuleToggle) => {
    try {
      await api(`/api/rules/${r.id}`, { method: "PATCH", body: { enabled: !r.enabled } });
      toast(`${r.title} ${r.enabled ? "suspended" : "enforced"}`, r.enabled ? "info" : "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const addSanction = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/sanctions", { body: { name: entry.name, address: entry.address.trim() || null } });
      setEntry({ name: "", address: "" });
      toast("Added to screening list — takes effect on the next payment", "ok");
    } catch (err) {
      toast((err as Error).message, "err");
    }
  };

  // Map rulebook entries to the trace rule names the engine emits.
  const TRACE_PREFIX: Record<string, string> = {
    "global.sanctions": "sanctions",
    "global.velocity": "velocity",
    "global.kyb": "kyb",
    "us.genius": "us.genius",
    "eu.mica": "eu.mica",
  };
  const jurisdictionOf = new Map(agents.map((a) => [a.id, a.jurisdiction]));
  const hits = (rule: RuleToggle) => {
    const prefix = TRACE_PREFIX[rule.id] ?? "travel_rule";
    return intents.filter(
      (i) =>
        (prefix !== "travel_rule" || jurisdictionOf.get(i.agentId) === rule.jurisdiction) &&
        i.trace.some((t) => t.rule.startsWith(prefix) && t.outcome !== "pass"),
    ).length;
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Rulebook · compliance</div>
          <h1 className="page-title">
            Regulation is now a spec. <em>So we compile it.</em>
          </h1>
          <p className="lede">
            Each agent is screened against the rulepack for its jurisdiction, in the same pass as its mandate. Suspend a rule to see what it was catching. This is a sandbox model of
            real obligations — useful for building, not legal advice.
          </p>
        </div>
        <a className="btn btn-ghost" href="/api/reports/compliance" target="_blank" rel="noreferrer">
          Compliance report (JSON)
        </a>
      </header>

      <div className="regions">
        {REGIONS.map((region) => (
          <section key={region.id} className="panel region">
            <header className="region-head">
              <span className="region-code mono">{region.id === "GLOBAL" ? "◎" : region.id}</span>
              <div>
                <h2>{region.name}</h2>
                <p className="small muted">{region.note}</p>
              </div>
            </header>
            <ul className="rules">
              {rules
                .filter((r) => r.jurisdiction === region.id)
                .map((r) => (
                  <li key={r.id} className={cx("rule", !r.enabled && "off")}>
                    <div className="rule-text">
                      <div className="rule-title">{r.title}</div>
                      <div className="rule-cite mono">{r.citation}</div>
                      <p className="small">{r.summary}</p>
                    </div>
                    <div className="rule-side">
                      <Switch on={r.enabled} onChange={() => toggle(r)} label={`${r.title} ${r.enabled ? "enforced" : "suspended"}`} />
                      <span className="small muted mono">{hits(r)} flagged</span>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        ))}

        <section className="panel region">
          <header className="region-head">
            <span className="region-code mono">$</span>
            <div>
              <h2>Stablecoin registry</h2>
              <p className="small muted">Which settlement assets each regime accepts (sandbox registry).</p>
            </div>
          </header>
          {registry && (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Issuer</th>
                  <th>US permitted</th>
                  <th>EU EMT</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(registry.stablecoins).map(([asset, r]) => (
                  <tr key={asset}>
                    <td className="mono">{asset}</td>
                    <td>{r.issuer}</td>
                    <td className={r.usPermitted ? "tone-clear" : "tone-divert"}>{r.usPermitted ? "yes" : "no"}</td>
                    <td className={r.euAuthorisedEmt ? "tone-clear" : "tone-divert"}>{r.euAuthorisedEmt ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {registry && (
            <p className="small muted">
              Travel Rule thresholds (USD):{" "}
              {Object.entries(registry.travelRuleThresholdUsd)
                .map(([j, v]) => `${j} ${v === 0 ? "every transfer" : `≥ ${Math.round(v).toLocaleString()}`}`)
                .join(" · ")}
            </p>
          )}
        </section>
      </div>

      <section className="panel">
        <header className="panel-head">
          <h2>Screening list</h2>
          <span className="eyebrow">{sanctions.length} entries · exact address or fuzzy name match</span>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>List</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sanctions.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="mono">{s.address ? short(s.address, 6) : "—"}</td>
                <td className="mono small">{s.list}</td>
                <td className="right">
                  <button
                    className="link-btn"
                    onClick={() => api(`/api/sanctions/${s.id}`, { method: "DELETE" }).catch((e: Error) => toast(e.message, "err"))}
                    aria-label={`Remove ${s.name}`}
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="row-wrap" onSubmit={addSanction}>
          <input required placeholder="Entity name, e.g. Pixelhaus Ads" value={entry.name} onChange={(e) => setEntry({ ...entry, name: e.target.value })} />
          <input placeholder="0x address (optional)" value={entry.address} onChange={(e) => setEntry({ ...entry, address: e.target.value })} className="grow" />
          <button className="btn btn-primary">Add entry</button>
        </form>
      </section>
    </div>
  );
}
