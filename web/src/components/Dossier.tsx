import { useEffect, useRef, useState } from "react";
import type { PaymentIntent, RuleResult } from "../../../shared/types";
import { useToast } from "../App";
import { api, cx, formatAmount, getOperator, setOperator, short, SQUAWK, zulu, type Lookup } from "../lib";

const LAYERS: RuleResult["layer"][] = ["identity", "mandate", "compliance", "human", "settlement"];
const MARK: Record<RuleResult["outcome"], string> = { pass: "✓", fail: "✕", hold: "◷", warn: "!" };

/** The full flight dossier for one payment: every checkpoint, the receipt, and the human controls. */
export function Dossier({ intent, lookup, onClose }: { intent: PaymentIntent; lookup: Lookup; onClose: () => void }) {
  const agent = lookup.agent(intent.agentId);
  const merchant = lookup.merchant(intent.merchantId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [operator, setOp] = useState(getOperator);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sq = SQUAWK[intent.squawk];
  const isHold = intent.stage === "hold";

  const decide = async (action: "approve" | "deny") => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<PaymentIntent>(`/api/intents/${intent.id}/${action}`, { body: { by: operator || "controller" } });
      toast(result.callout, result.stage === "cleared" ? "ok" : "err");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
  }, [intent.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "Escape") onClose();
      if (isHold && e.key.toLowerCase() === "a") void decide("approve");
      if (isHold && e.key.toLowerCase() === "d") void decide("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <aside className="dossier" role="dialog" aria-label="Payment dossier">
      <header className="dossier-head">
        <div>
          <div className="eyebrow">Flight dossier · {intent.id}</div>
          <h2 className="dossier-title">
            <span className="mono">{agent?.callSign}</span> <span className="muted">→</span> {merchant?.name}
          </h2>
        </div>
        <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close dossier">
          ✕
        </button>
      </header>

      <div className="dossier-amount">
        <span className="serif">{formatAmount(intent.amount)}</span>
        <span className="mono muted">{intent.currency}</span>
        <span className={cx("squawk", `tone-${sq.tone}`)} title={sq.label}>
          <small>squawk</small> {intent.squawk}
        </span>
      </div>
      <p className="callout">“{intent.callout}”</p>

      <dl className="facts">
        <div>
          <dt>Stage</dt>
          <dd className={`stage-text stage-${intent.stage}`}>{intent.stage}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>
            <span className="risk">
              <span style={{ width: `${intent.riskScore}%` }} />
            </span>
            {intent.riskScore}
          </dd>
        </div>
        <div>
          <dt>Filed</dt>
          <dd className="mono">{zulu(intent.createdAt)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd className="mono">
            {intent.source} · {intent.rail}
          </dd>
        </div>
        {intent.memo && (
          <div className="span-2">
            <dt>Memo</dt>
            <dd>{intent.memo}</dd>
          </div>
        )}
      </dl>

      {isHold && (
        <section className="decision">
          <div className="decision-head">
            <span className="pulse-dot" /> A human must decide
          </div>
          <label className="field-inline">
            <span>Signed as</span>
            <input
              value={operator}
              onChange={(e) => {
                setOp(e.target.value);
                setOperator(e.target.value);
              }}
              maxLength={40}
            />
          </label>
          <div className="decision-actions">
            <button className="btn btn-clear" disabled={busy} onClick={() => decide("approve")}>
              Clear for payment <kbd>A</kbd>
            </button>
            <button className="btn btn-divert" disabled={busy} onClick={() => decide("deny")}>
              Divert <kbd>D</kbd>
            </button>
          </div>
        </section>
      )}

      <section>
        <h3 className="section-label">Checkpoints</h3>
        <ol className="trace">
          {LAYERS.flatMap((layer) =>
            intent.trace
              .filter((r) => r.layer === layer)
              .map((r, idx) => (
                <li key={`${layer}-${r.rule}-${idx}`} className={cx("trace-row", `out-${r.outcome}`)}>
                  <span className="trace-mark" aria-label={r.outcome}>
                    {MARK[r.outcome]}
                  </span>
                  <span className="trace-layer">{layer}</span>
                  <span className="trace-rule mono">{r.rule}</span>
                  <span className="trace-detail">{r.detail}</span>
                </li>
              )),
          )}
        </ol>
      </section>

      {intent.travelRule && (
        <section>
          <h3 className="section-label">Travel Rule payload · IVMS101</h3>
          <pre className="code">{JSON.stringify(intent.travelRule, null, 2)}</pre>
        </section>
      )}

      {intent.receipt && (
        <section>
          <h3 className="section-label">Receipt</h3>
          <dl className="facts">
            <div>
              <dt>Block</dt>
              <dd className="mono">#{intent.receipt.blockHeight}</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd className="mono">{formatAmount(intent.receipt.fee)}</dd>
            </div>
            <div className="span-2">
              <dt>Block hash</dt>
              <dd className="mono hash">{intent.receipt.blockHash}</dd>
            </div>
            <div className="span-2">
              <dt>Tx ref</dt>
              <dd className="mono hash">{short(intent.receipt.txRef, 14)}</dd>
            </div>
            <div className="span-2">
              <dt>Decided by</dt>
              <dd className="mono">{intent.decidedBy}</dd>
            </div>
          </dl>
        </section>
      )}

      {agent && (
        <section>
          <h3 className="section-label">Pilot</h3>
          <p className="small muted">
            {agent.name} · {agent.model} · KYA L{agent.kyaLevel} · {agent.jurisdiction} · key <span className="mono">{agent.fingerprint.slice(0, 23)}</span>
          </p>
        </section>
      )}
    </aside>
  );
}
