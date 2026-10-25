import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, cx, zulu } from "./lib";
import { connect, useTower } from "./store";
import { Thesis } from "./views/Thesis";
import { Tower } from "./views/Tower";
import { Hangar } from "./views/Hangar";
import { FlightPlans } from "./views/FlightPlans";
import { Recorder } from "./views/Recorder";
import { Rulebook } from "./views/Rulebook";
import { Lab } from "./views/Lab";
import { Glyph } from "./components/Glyph";

const ROUTES = [
  { id: "thesis", label: "Why now", key: "1" },
  { id: "tower", label: "Tower", key: "2" },
  { id: "hangar", label: "Hangar", key: "3" },
  { id: "plans", label: "Flight plans", key: "4" },
  { id: "recorder", label: "Recorder", key: "5" },
  { id: "rulebook", label: "Rulebook", key: "6" },
  { id: "lab", label: "x402 Lab", key: "7" },
] as const;
export type Route = (typeof ROUTES)[number]["id"];

function readRoute(): Route {
  const id = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES.find((r) => r.id === id)?.id ?? "thesis") as Route;
}

export function navigate(route: Route) {
  window.location.hash = `/${route}`;
}

// ── Toasts ──
type Toast = { id: number; tone: "ok" | "err" | "info"; text: string };
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("toast", `toast-${t.tone}`)}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="clock" title="Coordinated Universal Time">
      {zulu(now)}
    </span>
  );
}

function TrafficSwitch() {
  const { simulator } = useTower();
  const toast = useToast();
  const toggle = async () => {
    try {
      await api("/api/simulator", { body: { running: !simulator.running } });
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <button className={cx("switch", simulator.running && "on")} onClick={toggle} aria-pressed={simulator.running} title="Sandbox agent traffic">
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
      <span>Traffic</span>
    </button>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const tower = useTower();

  useEffect(() => {
    connect();
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || target.closest("input, textarea, select, [contenteditable]")) return;
      const r = ROUTES.find((x) => x.key === e.key);
      if (r) navigate(r.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const holds = tower.stats.holdCount;
  const daylight = route === "thesis";

  return (
    <ToastHost>
      <div className={cx("app", daylight ? "daylight" : "night")}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <a className="brand" href="#/thesis" aria-label="Clearance home">
            <Glyph />
            <span className="brand-word">Clearance</span>
          </a>
          <nav className="nav" aria-label="Primary">
            {ROUTES.map((r) => (
              <a key={r.id} href={`#/${r.id}`} className={cx("nav-link", route === r.id && "active")} aria-current={route === r.id ? "page" : undefined}>
                <kbd>{r.key}</kbd>
                {r.label}
                {r.id === "tower" && holds > 0 && <span className="nav-badge" aria-label={`${holds} holding`}>{holds}</span>}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            <TrafficSwitch />
            <span className={cx("link-state", tower.connected ? "live" : "lost")}>
              <i />
              {tower.connected ? "Live" : "Reconnecting"}
            </span>
            <Clock />
          </div>
        </header>
        <main id="main" className="main">
          {route === "thesis" && <Thesis />}
          {route === "tower" && <Tower />}
          {route === "hangar" && <Hangar />}
          {route === "plans" && <FlightPlans />}
          {route === "recorder" && <Recorder />}
          {route === "rulebook" && <Rulebook />}
          {route === "lab" && <Lab />}
        </main>
      </div>
    </ToastHost>
  );
}
