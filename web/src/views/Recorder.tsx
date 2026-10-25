import { useState } from "react";
import { useToast } from "../App";
import { api, cx, formatAmount, short, zulu } from "../lib";
import { useTower } from "../store";

interface Verification {
  valid: boolean;
  checked: number;
  brokenAt: number | null;
  reason: string | null;
  tampered: number | null;
}

function accountLabel(account: string, names: Map<string, string>): string {
  const [kind, id] = account.split(":");
  if (kind === "agent" || kind === "merchant") return names.get(id) ?? account;
  if (kind === "treasury") return `treasury · ${id}`;
  if (kind === "external") return "fiat on-ramp";
  if (kind === "clearance") return "Clearance network fee";
  return account;
}

export function Recorder() {
  const { blocks, agents, merchants, balances } = useTower();
  const toast = useToast();
  const [verification, setVerification] = useState<Verification | null>(null);
  const [checking, setChecking] = useState(false);
  const [tamper, setTamper] = useState("3");
  const names = new Map<string, string>([...agents.map((a) => [a.id, a.callSign] as const), ...merchants.map((m) => [m.id, m.name] as const)]);
  const recent = [...blocks].reverse().slice(0, 60);
  const fees = balances["clearance:fees"] ?? 0;
  const treasury = Object.entries(balances)
    .filter(([k]) => k.startsWith("treasury:"))
    .reduce((s, [, v]) => s + v, 0);

  const verify = async (tamperAt?: number) => {
    setChecking(true);
    setVerification(null);
    try {
      const res = await api<Verification>(`/api/ledger/verify${tamperAt !== undefined ? `?tamper=${tamperAt}` : ""}`);
      // Give the check a beat so the result reads as a check, not a flash.
      await new Promise((r) => setTimeout(r, 650));
      setVerification(res);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Flight recorder · ledger</div>
          <h1 className="page-title">
            Every cent, double-entry. <em>Every block, chained.</em>
          </h1>
          <p className="lede">
            Each posting balances debits against credits and commits to the hash of the block before it. Change one number after the fact and the chain breaks at that block —
            try it on a copy below.
          </p>
        </div>
        <a className="btn btn-ghost" href="/api/ledger/export.csv" download>
          Export CSV
        </a>
      </header>

      <div className="recorder-stats">
        <div className="stat">
          <small>Blocks</small>
          <b>{blocks.length ? blocks[blocks.length - 1].height + 1 : 0}</b>
        </div>
        <div className="stat">
          <small>Treasury</small>
          <b>{formatAmount(treasury)}</b>
        </div>
        <div className="stat">
          <small>Network fees (5 bps)</small>
          <b>{formatAmount(fees)}</b>
        </div>
        <div className="stat verify-box">
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => verify()} disabled={checking}>
              {checking ? "Re-hashing…" : "Verify chain"}
            </button>
            <label className="field-inline">
              <span>Tamper block</span>
              <input value={tamper} onChange={(e) => setTamper(e.target.value.replace(/\D/g, ""))} style={{ width: "4.5em" }} />
            </label>
            <button className="btn btn-outline-divert" onClick={() => verify(Number(tamper))} disabled={checking || tamper === ""}>
              Tamper test
            </button>
          </div>
          {verification && (
            <p className={cx("verify-result", verification.valid ? "ok" : "bad")} role="status">
              {verification.valid
                ? `✓ Chain intact — ${verification.checked} blocks re-hashed, every link and balance checks out.`
                : `✕ Broken at block #${verification.brokenAt}: ${verification.reason}.${verification.tampered !== null ? " (Tampered copy — the real journal is untouched.)" : ""}`}
            </p>
          )}
        </div>
      </div>

      <ol className="tape" aria-label="Recent blocks, newest first">
        {recent.map((b) => (
          <li key={b.height} className={cx("block", verification && !verification.valid && verification.brokenAt === b.height && "broken")}>
            <div className="block-rail" aria-hidden="true">
              <span className="block-node" />
            </div>
            <div className="block-card">
              <header>
                <span className="block-height mono">#{b.height}</span>
                <span className="block-memo">{b.memo}</span>
                <time className="mono muted small">{zulu(b.timestamp)}</time>
              </header>
              <table className="entries">
                <tbody>
                  {b.entries.map((e, i) => (
                    <tr key={i}>
                      <td>{accountLabel(e.account, names)}</td>
                      <td className="mono num debit">{e.debit ? formatAmount(e.debit) : ""}</td>
                      <td className="mono num credit">{e.credit ? formatAmount(e.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <footer className="mono small">
                <span title={b.hash}>hash {short(b.hash, 8)}</span>
                <span className="muted" title={b.prevHash}>
                  prev {short(b.prevHash, 8)}
                </span>
              </footer>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
