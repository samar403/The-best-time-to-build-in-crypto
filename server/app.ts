import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { aiConfigured, COMPOSER_MODEL } from "./composer.js";
import { Clearance, ClearanceError, type EngineOptions } from "./engine.js";
import { apiRouter } from "./routes.js";
import { seed } from "./seed.js";
import { Simulator } from "./simulator.js";
import { x402Router } from "./x402.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface AppOptions extends EngineOptions {
  seed?: boolean;
  simulator?: { minMs: number; maxMs: number };
}

export function createApp(opts: AppOptions = {}) {
  const clearance = new Clearance(opts);
  clearance.ai = { enabled: aiConfigured(), model: COMPOSER_MODEL };
  if (opts.seed !== false) seed(clearance);
  const simulator = new Simulator(clearance, opts.simulator);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(
    express.json({
      limit: "100kb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  app.use("/api", apiRouter(clearance, simulator));
  app.use("/x402", x402Router(clearance));

  const webDist = path.resolve(here, "../dist/web");
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { maxAge: "1h", index: false }));
    app.get(/^\/(?!api|x402).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    }
    if (err instanceof ClearanceError) return res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: "malformed JSON" });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return { app, clearance, simulator };
}
