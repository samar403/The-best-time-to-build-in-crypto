import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const live = process.env.CLEARANCE_SIMULATOR !== "off";

const { app, clearance, simulator } = createApp({ stageDelayMs: Number(process.env.CLEARANCE_STAGE_DELAY_MS ?? 650) });

// Backfill a little history so the recorder and stats aren't empty on first load.
for (let i = 0; i < 36; i++) await simulator.tick({ instant: true, normalOnly: true });
// …then open a fresh sandbox period so the backfill doesn't eat today's limits.
clearance.startSandboxPeriod();

setInterval(() => clearance.expireHolds(), 5_000).unref();
if (live) simulator.start();

app.listen(port, () => {
  console.log(`\n  ◎ Clearance tower online  →  http://localhost:${port}`);
  console.log(`    ${clearance.agents.size} agents · ${clearance.ledger.blocks.length} blocks · simulator ${live ? "on" : "off"}`);
  console.log(`    flight-plan composer: ${clearance.ai.enabled ? `Claude (${clearance.ai.model})` : "built-in parser (set ANTHROPIC_API_KEY to use Claude)"}\n`);
});
