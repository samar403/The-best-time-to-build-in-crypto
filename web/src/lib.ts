import { UNIT, formatAmount, type Agent, type Merchant, type Squawk, type Stage } from "../../shared/types";

export { formatAmount, UNIT };

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Decimal string/number → integer base units. */
export function toUnits(value: string | number): number {
  return Math.round(Number(value) * UNIT);
}

export function fromUnits(units: number): number {
  return units / UNIT;
}

export function compact(units: number): string {
  const v = units / UNIT;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return formatAmount(units);
}

export function zulu(ts: number, seconds = true): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${seconds ? `:${p(d.getUTCSeconds())}` : ""}Z`;
}

export function short(hash: string, n = 6): string {
  if (hash.length <= n * 2 + 1) return hash;
  return `${hash.slice(0, n + (hash.startsWith("0x") ? 2 : 0))}…${hash.slice(-n)}`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const SQUAWK: Record<Squawk, { label: string; tone: "clear" | "hold" | "divert" | "warn" }> = {
  "1200": { label: "Normal", tone: "clear" },
  "4000": { label: "Holding for a human", tone: "hold" },
  "7500": { label: "Sanctions hit", tone: "divert" },
  "7600": { label: "Mandate breach", tone: "divert" },
  "7700": { label: "Compliance emergency", tone: "warn" },
};

export const STAGES: { id: Stage; label: string; hint: string }[] = [
  { id: "inbound", label: "Inbound", hint: "identity check" },
  { id: "screening", label: "Screening", hint: "mandate + compliance" },
  { id: "hold", label: "Holding pattern", hint: "awaiting a human" },
  { id: "cleared", label: "Cleared", hint: "settled on ledger" },
  { id: "diverted", label: "Diverted", hint: "refused" },
];

export type Lookup = { agent: (id: string) => Agent | undefined; merchant: (id: string) => Merchant | undefined };

export function lookups(agents: Agent[], merchants: Merchant[]): Lookup {
  const a = new Map(agents.map((x) => [x.id, x]));
  const m = new Map(merchants.map((x) => [x.id, x]));
  return { agent: (id) => a.get(id), merchant: (id) => m.get(id) };
}

export function getOperator(): string {
  try {
    return localStorage.getItem("clearance.operator") || "controller";
  } catch {
    return "controller";
  }
}

export function setOperator(name: string) {
  try {
    localStorage.setItem("clearance.operator", name);
  } catch {
    /* storage unavailable */
  }
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
