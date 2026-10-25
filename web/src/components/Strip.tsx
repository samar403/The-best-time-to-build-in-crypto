import { memo } from "react";
import type { Agent, Merchant, PaymentIntent } from "../../../shared/types";
import { cx, formatAmount, zulu } from "../lib";

/** A flight progress strip — one payment, printed on buff card like a real tower strip. */
export const Strip = memo(function Strip({
  intent,
  agent,
  merchant,
  selected,
  onSelect,
}: {
  intent: PaymentIntent;
  agent?: Agent;
  merchant?: Merchant;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={cx("strip", `strip-${intent.stage}`, `sq-${intent.squawk}`, selected && "selected")}
      onClick={() => onSelect(intent.id)}
      aria-label={`${agent?.callSign ?? "agent"} paying ${merchant?.name ?? "merchant"} ${formatAmount(intent.amount, intent.currency)}, ${intent.stage}, squawk ${intent.squawk}`}
    >
      <span className="strip-band" aria-hidden="true" />
      <span className="strip-cs">{agent?.callSign ?? "—"}</span>
      <span className="strip-amt">
        {formatAmount(intent.amount)} <small>{intent.currency}</small>
      </span>
      <span className="strip-dest">
        <span aria-hidden="true">→ </span>
        {merchant?.name ?? intent.merchantId}
      </span>
      <span className="strip-meta">
        {merchant?.category} · {intent.rail}
        {intent.source === "x402" && <em className="strip-tag">402</em>}
      </span>
      <span className="strip-sq">
        <small>SQ</small>
        {intent.squawk}
      </span>
      <span className="strip-time">{zulu(intent.createdAt, false)}</span>
    </button>
  );
});
