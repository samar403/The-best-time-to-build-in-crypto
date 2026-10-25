import { useMemo, useState } from "react";
import { CATEGORIES, type Category, type Mandate, type RuleResult } from "../../../shared/types";
import { useToast } from "../App";
import { api, cx, formatAmount, fromUnits, toUnits } from "../lib";
import { useTower } from "../store";

type Draft = Omit<Mandate, "id" | "createdAt">;

interface CompileResult {
  draft: Draft;
  engine: "claude" | "heuristic";
  model: string | null;
  assumptions: string[];
}

const EXAMPLES = [
  "Only buy GPU compute and inference. Up to $2k per payment and $10k a day. Ask me above $1,500. Never gambling.",
  "Pay per call for data and APIs — never more than $3 a call or $100 a day, weekdays only, for the next 30 days.",
  "Book flights and hotels. $1,200 a booking, $6,000 a month, ask me above $700. No casinos, and never Lucky Tiger.",
  "Run ad spend between 8am and 8pm. €300 per payment, €1,500 daily. No p2p or gambling.",
];

const BLANK: Draft = {
  name: "New flight plan",
  source: "",
  perTxLimit: toUnits(100),
  dailyLimit: toUnits(500),
  monthlyLimit: toUnits(5000),
  allowedCategories: null,
  blockedCategories: [],
  allowedMerchants: null,
  blockedMerchants: [],
  approvalThreshold: null,
  activeHoursUtc: null,
  weekdaysOnly: false,
  expiresAt: null,
  createdBy: "human",
};

function Waypoints({ draft, merchantName }: { draft: Draft; merchantName: (id: string) => string }) {
  const points: { k: string; v: string; tone?: string }[] = [
    { k: "per payment", v: `≤ ${formatAmount(draft.perTxLimit)}` },
    { k: "per day", v: `≤ ${formatAmount(draft.dailyLimit)}` },
    { k: "per month", v: `≤ ${formatAmount(draft.monthlyLimit)}` },
  ];
  if (draft.allowedCategories) points.push({ k: "only", v: draft.allowedCategories.join(" · "), tone: "clear" });
  if (draft.blockedCategories.length) points.push({ k: "never", v: draft.blockedCategories.join(" · "), tone: "divert" });
  if (draft.allowedMerchants) points.push({ k: "only at", v: draft.allowedMerchants.map(merchantName).join(" · "), tone: "clear" });
  if (draft.blockedMerchants.length) points.push({ k: "never at", v: draft.blockedMerchants.map(merchantName).join(" · "), tone: "divert" });
  if (draft.approvalThreshold !== null) points.push({ k: "human above", v: formatAmount(draft.approvalThreshold), tone: "hold" });
  if (draft.activeHoursUtc) points.push({ k: "window", v: `${draft.activeHoursUtc.start}:00–${draft.activeHoursUtc.end}:00Z` });
  if (draft.weekdaysOnly) points.push({ k: "days", v: "Mon–Fri" });
  if (draft.expiresAt) points.push({ k: "expires", v: new Date(draft.expiresAt).toISOString().slice(0, 10) });
  return (
    <ol className="waypoints" aria-label="Compiled flight plan">
      <li className="wp wp-origin">
        <span className="wp-dot" />
        <span className="wp-k">dep</span>
        <span className="wp-v">agent</span>
      </li>
      {points.map((p) => (
        <li key={p.k} className={cx("wp", p.tone && `tone-${p.tone}`)}>
          <span className="wp-dot" />
          <span className="wp-k">{p.k}</span>
          <span className="wp-v">{p.v}</span>
        </li>
      ))}
      <li className="wp wp-origin">
        <span className="wp-dot" />
        <span className="wp-k">arr</span>
        <span className="wp-v">merchant</span>
      </li>
    </ol>
  );
}

function MoneyField({ label, value, onChange, nullable }: { label: string; value: number | null; onChange: (v: number | null) => void; nullable?: boolean }) {
  return (
    <label>
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={value === null ? "" : String(fromUnits(value))}
        placeholder={nullable ? "never" : "0"}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d.]/g, "");
          onChange(raw === "" ? (nullable ? null : 0) : toUnits(raw));
        }}
      />
    </label>
  );
}

export function FlightPlans() {
  const { mandates, merchants, agents, ai } = useTower();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [text, setText] = useState(EXAMPLES[0]);
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState({ agentId: "", merchantId: "", amount: "250" });
  const [testResult, setTestResult] = useState<{ verdict: string; results: RuleResult[] } | null>(null);
  const merchantName = useMemo(() => {
    const map = new Map(merchants.map((m) => [m.id, m.name]));
    return (id: string) => map.get(id) ?? id;
  }, [merchants]);

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setTestResult(null);
  };

  const compile = async () => {
    setBusy(true);
    try {
      const res = await api<CompileResult>("/api/mandates/compile", { body: { text } });
      setCompiled(res);
      setDraft(res.draft);
      setEditingId(null);
      setTestResult(null);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      const body = { ...draft, source: draft.source || text };
      const saved = editingId
        ? await api<Mandate>(`/api/mandates/${editingId}`, { method: "PUT", body })
        : await api<Mandate>("/api/mandates", { body });
      setEditingId(saved.id);
      toast(`Flight plan “${saved.name}” filed`, "ok");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const testFly = async () => {
    try {
      const merchantId = test.merchantId || merchants[0]?.id;
      const res = await api<{ verdict: string; results: RuleResult[] }>("/api/mandates/dry-run", {
        body: { mandate: { ...draft, source: draft.source || "" }, merchantId, amount: toUnits(test.amount || "0"), agentId: test.agentId || undefined },
      });
      setTestResult(res);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const cycleCategory = (c: Category) => {
    const allowed = draft.allowedCategories ?? [];
    const blocked = draft.blockedCategories;
    if (blocked.includes(c)) {
      patch({ blockedCategories: blocked.filter((x) => x !== c) });
    } else if (allowed.includes(c)) {
      const next = allowed.filter((x) => x !== c);
      patch({ allowedCategories: next.length ? next : null, blockedCategories: [...blocked, c] });
    } else {
      patch({ allowedCategories: [...allowed, c] });
    }
  };

  const used = (id: string) => agents.filter((a) => a.mandateId === id).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Flight plans · mandates</div>
          <h1 className="page-title">
            Say what an agent may spend. <em>Get a policy a machine can enforce.</em>
          </h1>
          <p className="lede">
            Write the rule the way you would tell a new hire. The composer compiles it into a mandate — caps, categories, counterparties, time windows and the line above which a
            human decides — then you test-fly it before it governs a single payment.
          </p>
        </div>
      </header>

      <div className="plans">
        <aside className="plan-list" aria-label="Filed flight plans">
          <button
            className={cx("plan-item", "plan-new", editingId === null && "active")}
            onClick={() => {
              setEditingId(null);
              setDraft(BLANK);
              setCompiled(null);
            }}
          >
            + New flight plan
          </button>
          {mandates.map((m) => (
            <button
              key={m.id}
              className={cx("plan-item", editingId === m.id && "active")}
              onClick={() => {
                setEditingId(m.id);
                const { id: _id, createdAt: _c, ...rest } = m;
                setDraft(rest);
                setText(m.source);
                setCompiled(null);
                setTestResult(null);
              }}
            >
              <span className="plan-name">{m.name}</span>
              <span className="plan-meta mono">
                ≤{formatAmount(m.perTxLimit)} · {used(m.id)} agent{used(m.id) === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </aside>

        <div className="plan-main">
          <section className="panel composer">
            <header className="panel-head">
              <h2>Composer</h2>
              <span className={cx("engine-badge", ai.enabled ? "ai" : "local")}>{ai.enabled ? `Claude · ${ai.model}` : "built-in parser · set ANTHROPIC_API_KEY for Claude"}</span>
            </header>
            <label className="sr-only" htmlFor="policy">
              Spending policy in plain English
            </label>
            <textarea id="policy" className="policy" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="examples">
              {EXAMPLES.map((ex, i) => (
                <button key={i} className="chip" onClick={() => setText(ex)}>
                  Example {i + 1}
                </button>
              ))}
              <button className="btn btn-primary push-right" onClick={compile} disabled={busy || text.trim().length < 3}>
                {busy ? "Compiling…" : "Compile flight plan →"}
              </button>
            </div>
            {compiled && (
              <div className="compiled-note">
                <span className="mono small">
                  compiled by {compiled.engine === "claude" ? compiled.model : "built-in parser"}
                </span>
                {compiled.assumptions.length > 0 && (
                  <ul>
                    {compiled.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>
                <input className="title-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Flight plan name" />
              </h2>
              <span className="eyebrow">{editingId ? "editing filed plan" : "unfiled draft"}</span>
            </header>
            <Waypoints draft={draft} merchantName={merchantName} />

            <div className="form-grid four">
              <MoneyField label="Per payment" value={draft.perTxLimit} onChange={(v) => patch({ perTxLimit: v ?? 0 })} />
              <MoneyField label="Per day" value={draft.dailyLimit} onChange={(v) => patch({ dailyLimit: v ?? 0 })} />
              <MoneyField label="Per month" value={draft.monthlyLimit} onChange={(v) => patch({ monthlyLimit: v ?? 0 })} />
              <MoneyField label="Human approval above" value={draft.approvalThreshold} onChange={(v) => patch({ approvalThreshold: v })} nullable />
            </div>

            <div className="cat-legend small muted">Categories — click to cycle: any → only → never</div>
            <div className="cats">
              {CATEGORIES.map((c) => {
                const state = draft.blockedCategories.includes(c) ? "never" : draft.allowedCategories?.includes(c) ? "only" : "any";
                return (
                  <button key={c} className={cx("cat", `cat-${state}`)} onClick={() => cycleCategory(c)} aria-label={`${c}: ${state}`}>
                    <span className="cat-state">{state === "only" ? "✓" : state === "never" ? "✕" : "·"}</span>
                    {c}
                  </button>
                );
              })}
            </div>

            <div className="row-wrap">
              <label className="check">
                <input type="checkbox" checked={draft.weekdaysOnly} onChange={(e) => patch({ weekdaysOnly: e.target.checked })} />
                <span>Weekdays only</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.activeHoursUtc !== null}
                  onChange={(e) => patch({ activeHoursUtc: e.target.checked ? { start: 8, end: 20 } : null })}
                />
                <span>UTC window</span>
              </label>
              {draft.activeHoursUtc && (
                <span className="hours">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={draft.activeHoursUtc.start}
                    onChange={(e) => patch({ activeHoursUtc: { ...draft.activeHoursUtc!, start: Number(e.target.value) } })}
                    aria-label="Window start hour"
                  />
                  –
                  <input
                    type="number"
                    min={0}
                    max={24}
                    value={draft.activeHoursUtc.end}
                    onChange={(e) => patch({ activeHoursUtc: { ...draft.activeHoursUtc!, end: Number(e.target.value) } })}
                    aria-label="Window end hour"
                  />
                  Z
                </span>
              )}
              <button className="btn btn-primary push-right" onClick={save}>
                {editingId ? "Update flight plan" : "File flight plan"}
              </button>
            </div>
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>Test flight</h2>
              <span className="eyebrow">dry run · nothing moves</span>
            </header>
            <div className="manual-grid">
              <label>
                <span>Agent (optional)</span>
                <select value={test.agentId} onChange={(e) => setTest({ ...test, agentId: e.target.value })}>
                  <option value="">Mandate only</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.callSign}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Merchant</span>
                <select value={test.merchantId} onChange={(e) => setTest({ ...test, merchantId: e.target.value })}>
                  {merchants.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.category}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Amount</span>
                <input inputMode="decimal" value={test.amount} onChange={(e) => setTest({ ...test, amount: e.target.value.replace(/[^\d.]/g, "") })} />
              </label>
              <button className="btn btn-ghost" onClick={testFly}>
                Run test flight
              </button>
            </div>
            {testResult && (
              <div className={cx("verdict", `verdict-${testResult.verdict}`)}>
                <div className="verdict-head">
                  {testResult.verdict === "pass" ? "Would clear" : testResult.verdict === "hold" ? "Would hold for a human" : "Would divert"}
                </div>
                <ul className="trace compact">
                  {testResult.results.map((r, i) => (
                    <li key={i} className={cx("trace-row", `out-${r.outcome}`)}>
                      <span className="trace-mark">{r.outcome === "pass" ? "✓" : r.outcome === "fail" ? "✕" : r.outcome === "hold" ? "◷" : "!"}</span>
                      <span className="trace-rule mono">{r.rule}</span>
                      <span className="trace-detail">{r.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
