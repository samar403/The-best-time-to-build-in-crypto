import { Glyph } from "../components/Glyph";
import { compact } from "../lib";
import { useTower } from "../store";

const RUNWAYS = [
  {
    n: "01",
    title: "Regulation got clear",
    kicker: "Builders can finally know which dollars are legal to move — and what has to travel with them.",
    events: [
      { when: "Dec 2024", what: "MiCA applies in full across the EU; its stablecoin titles have applied since June." },
      { when: "Dec 2024", what: "The EU Transfer of Funds Regulation brings the Travel Rule to crypto transfers, with no minimum amount." },
      { when: "Jul 2025", what: "The GENIUS Act is signed — the first US federal framework for payment stablecoins: reserves, licensed issuers, disclosure." },
    ],
  },
  {
    n: "02",
    title: "Crypto moved inside fintech",
    kicker: "People won’t “use crypto”. They’ll use apps whose ledgers happen to be stablecoins.",
    events: [
      { when: "2023", what: "Visa extends USDC settlement to Solana — a card network settling on public rails." },
      { when: "Feb 2025", what: "Stripe completes its acquisition of Bridge, a stablecoin orchestration platform." },
      { when: "Mid 2025", what: "Stablecoins in circulation pass $250 billion." },
    ],
  },
  {
    n: "03",
    title: "Agents started to pay",
    kicker: "The next billion payers won’t have thumbs. They’ll have keys, budgets and goals.",
    events: [
      { when: "Apr 2025", what: "Visa Intelligent Commerce and Mastercard Agent Pay are announced for agent-initiated payments." },
      { when: "May 2025", what: "Coinbase introduces x402, reviving HTTP 402 so any endpoint can charge per request." },
      { when: "Sep 2025", what: "Google publishes AP2, an open Agent Payments Protocol built around signed mandates." },
    ],
  },
];

const PRIMITIVES = [
  { k: "Identity", t: "Know your agent", d: "A key bound to a legal operator, a model and a jurisdiction. Every request is signed; nobody flies anonymous." },
  { k: "Mandate", t: "A flight plan", d: "What it may spend, where, when — and the line above which a human decides. Written in English, enforced as code." },
  { k: "Screening", t: "Rules at wire speed", d: "Sanctions, Travel Rule and stablecoin eligibility for the agent’s jurisdiction, in the same millisecond pass as the mandate." },
  { k: "Record", t: "A flight recorder", d: "Double-entry, hash-chained receipts for every cent, so audit is a re-hash, not a forensic project." },
];

const FLIGHT = [
  { k: "Contact", d: "Agent signs a payment request, or answers an HTTP 402." },
  { k: "Identify", d: "Signature, key and operator verified. Grounded agents stop here." },
  { k: "Plan check", d: "Caps, categories, counterparties, hours — the whole mandate." },
  { k: "Screen", d: "Sanctions, Travel Rule, issuer registry, velocity." },
  { k: "Clear · Hold · Divert", d: "Settle and post a block, wait for a human, or refuse with a reason." },
];

function Convergence() {
  return (
    <svg className="convergence" viewBox="0 0 640 300" role="img" aria-label="Three lines — regulation, fintech, agents — converging on one point labelled now">
      <defs>
        <linearGradient id="fade" x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.15" />
          <stop offset="1" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>
      </defs>
      {[
        { y: 40, label: "01  regulation" },
        { y: 150, label: "02  fintech" },
        { y: 260, label: "03  agents" },
      ].map((l, i) => (
        <g key={l.label}>
          <path className="runway" style={{ animationDelay: `${i * 0.25}s` }} d={`M 20 ${l.y} C 260 ${l.y}, 360 150, 520 150`} fill="none" stroke="url(#fade)" strokeWidth="2.2" />
          <text x="20" y={l.y - 12} className="runway-label">
            {l.label}
          </text>
        </g>
      ))}
      <circle cx="560" cy="150" r="38" fill="none" stroke="currentColor" strokeOpacity="0.25" />
      <circle cx="560" cy="150" r="22" fill="none" stroke="currentColor" strokeOpacity="0.45" />
      <circle className="now-dot" cx="560" cy="150" r="7" />
      <text x="560" y="214" textAnchor="middle" className="runway-now">
        now
      </text>
    </svg>
  );
}

export function Thesis() {
  const { stats, agents, ready } = useTower();
  return (
    <article className="thesis">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow ink">Request for Startups · The best time to build in crypto</div>
          <h1 className="hero-title">
            Money is about to get <em>a new kind of customer.</em>
          </h1>
          <p className="hero-lede">
            Regulation has cleared the runway. Stablecoins now live inside the fintech apps people already use. And software agents have started paying for things on their own.
            Three stories that ran apart for a decade converge right now — and they share one missing piece of infrastructure.
          </p>
          <p className="hero-lede strong">Someone has to be the tower.</p>
          <div className="hero-cta">
            <a className="btn btn-ink" href="#/tower">
              Enter the tower →
            </a>
            <a className="btn btn-ink-ghost" href="#/lab">
              Watch an HTTP 402 handshake
            </a>
          </div>
          {ready && (
            <p className="live-line">
              <span className="pulse-dot" /> Live in this sandbox: {agents.length} agents, {stats.clearedCount} payments cleared ({compact(stats.clearedVolume)}),{" "}
              {stats.divertedCount} diverted, {stats.holdCount} waiting on a human.
            </p>
          )}
        </div>
        <div className="hero-art">
          <Convergence />
        </div>
      </section>

      <section className="runways">
        <h2 className="section-title">
          Three runways, <em>one approach.</em>
        </h2>
        <div className="runway-grid">
          {RUNWAYS.map((r) => (
            <div key={r.n} className="runway-col">
              <div className="runway-n">{r.n}</div>
              <h3>{r.title}</h3>
              <ol className="events">
                {r.events.map((e) => (
                  <li key={e.what}>
                    <time>{e.when}</time>
                    <span>{e.what}</span>
                  </li>
                ))}
              </ol>
              <p className="kicker">{r.kicker}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="gap">
        <div className="gap-intro">
          <h2 className="section-title">
            The gap: an agent can hold a wallet. <em>Nothing tells it no.</em>
          </h2>
          <p>
            A stablecoin wallet will sign anything its key is asked to sign. A bank account assumes a human with a phone. An AI agent with real money needs a layer in between —
            one that knows who the agent is, what it was allowed to do, which laws apply to this exact transfer, and that writes it all down. That layer is Clearance.
          </p>
        </div>
        <div className="primitives">
          {PRIMITIVES.map((p, i) => (
            <div key={p.k} className="primitive">
              <span className="primitive-n">0{i + 1}</span>
              <span className="primitive-k">{p.k}</span>
              <h3>{p.t}</h3>
              <p>{p.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flight">
        <h2 className="section-title">
          How a payment flies — <em>in about the time it takes to read this word.</em>
        </h2>
        <ol className="flight-strip">
          {FLIGHT.map((f, i) => (
            <li key={f.k}>
              <span className="flight-n">{i + 1}</span>
              <b>{f.k}</b>
              <span>{f.d}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="who">
        <div>
          <h3>For fintechs</h3>
          <p>Ship “let your assistant pay” without inventing a compliance department. Your users set mandates in plain English; you get receipts regulators can read.</p>
        </div>
        <div>
          <h3>For AI companies</h3>
          <p>Give agents budgets for compute, data and APIs with hard caps, human checkpoints and a kill switch — instead of a shared corporate card.</p>
        </div>
        <div>
          <h3>For API sellers</h3>
          <p>Charge per request with x402. Every payer arrives already identified, screened and inside a mandate, so there is nothing to chase.</p>
        </div>
        <div>
          <h3>Business model</h3>
          <p>A few basis points on cleared volume, plus seats for the humans in the tower. The sandbox charges 5 bps — watch the fee account grow in the Recorder.</p>
        </div>
      </section>

      <section className="closing">
        <Glyph size={44} />
        <blockquote>
          The best time to build in crypto is when it stops looking like crypto — when it looks like <em>a payment that simply cleared.</em>
        </blockquote>
        <a className="btn btn-ink" href="#/tower">
          Take the controls →
        </a>
        <p className="fine">
          Clearance is a working sandbox. Rulepacks model the shape of real obligations (GENIUS Act, MiCA, FinCEN and EU Travel Rules, MAS PSN02) for building and demos — not
          legal advice. Settlement is simulated on an internal ledger; the x402 flow follows the v1 wire format with sandbox ed25519 signatures.
        </p>
      </section>
    </article>
  );
}
