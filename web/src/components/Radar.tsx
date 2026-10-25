import { useEffect, useRef } from "react";
import type { Agent, Merchant, PaymentIntent, Stage } from "../../../shared/types";

/**
 * The scope. Agents orbit the inner ring, merchants the outer ring, and every
 * payment is a contact: it flies in to the tower, holds in a circuit while a
 * human decides, then either streaks out to the merchant or is shot down.
 */

const AMBER = "255,181,71";
const CLEAR = "139,227,155";
const HOLD = "124,200,255";
const DIVERT = "255,97,80";

interface Track {
  stage: Stage;
  since: number;
  seed: number;
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export function Radar({
  agents,
  merchants,
  intents,
  selectedId,
}: {
  agents: Agent[];
  merchants: Merchant[];
  intents: PaymentIntent[];
  selectedId: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tracks = useRef(new Map<string, Track>());
  const data = useRef({ agents, merchants, intents, selectedId });
  data.current = { agents, merchants, intents, selectedId };

  // Record when each contact changed stage, so motion is continuous across renders.
  useEffect(() => {
    const now = Date.now();
    const live = new Set<string>();
    for (const i of intents.slice(-80)) {
      live.add(i.id);
      const t = tracks.current.get(i.id);
      if (!t) tracks.current.set(i.id, { stage: i.stage, since: now, seed: Math.random() * Math.PI * 2 });
      else if (t.stage !== i.stage) tracks.current.set(i.id, { ...t, stage: i.stage, since: now });
    }
    for (const id of tracks.current.keys()) if (!live.has(id)) tracks.current.delete(id);
  }, [intents]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let size = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      size = Math.max(240, Math.min(wrap.clientWidth, 640));
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const frame = () => {
      const { agents, merchants, intents, selectedId } = data.current;
      const now = Date.now();
      const c = size / 2;
      const R = c - 10;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // Scope face
      const bg = ctx.createRadialGradient(c, c, 0, c, c, R);
      bg.addColorStop(0, "rgba(40,30,12,0.55)");
      bg.addColorStop(1, "rgba(8,9,8,0.9)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(c, c, R, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = 1;
      for (const f of [0.25, 0.5, 0.75, 1]) {
        ctx.strokeStyle = `rgba(${AMBER},${f === 1 ? 0.35 : 0.12})`;
        ctx.beginPath();
        ctx.arc(c, c, R * f, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(${AMBER},0.08)`;
      ctx.beginPath();
      ctx.moveTo(c - R, c);
      ctx.lineTo(c + R, c);
      ctx.moveTo(c, c - R);
      ctx.lineTo(c, c + R);
      ctx.stroke();
      for (let d = 0; d < 360; d += 10) {
        const a = (d * Math.PI) / 180;
        const inner = d % 30 === 0 ? R - 9 : R - 4;
        ctx.strokeStyle = `rgba(${AMBER},${d % 30 === 0 ? 0.45 : 0.2})`;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
        ctx.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
        ctx.stroke();
      }

      // Sweep with phosphor trail
      const sweep = ((now / (reduced ? 16000 : 4200)) * Math.PI * 2) % (Math.PI * 2);
      const trail = 1.1;
      const steps = 36;
      for (let s = 0; s < steps; s++) {
        const a0 = sweep - (trail * (s + 1)) / steps;
        const a1 = sweep - (trail * s) / steps;
        ctx.fillStyle = `rgba(${AMBER},${0.16 * (1 - s / steps) ** 2})`;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.arc(c, c, R, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = `rgba(${AMBER},0.8)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(sweep) * R, c + Math.sin(sweep) * R);
      ctx.stroke();

      const persistence = (angle: number) => {
        const diff = (((sweep - angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        return 0.32 + 0.68 * Math.exp(-diff * 1.15);
      };

      // Positions
      const agentPos = new Map<string, { x: number; y: number; a: number }>();
      agents.forEach((ag, i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, agents.length) + 0.35;
        agentPos.set(ag.id, { x: c + Math.cos(a) * R * 0.5, y: c + Math.sin(a) * R * 0.5, a });
      });
      const merchantPos = new Map<string, { x: number; y: number; a: number }>();
      merchants.forEach((m, i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, merchants.length);
        merchantPos.set(m.id, { x: c + Math.cos(a) * R * 0.86, y: c + Math.sin(a) * R * 0.86, a });
      });

      // Merchants
      ctx.font = `500 ${size < 420 ? 8.5 : 10}px "JetBrains Mono", monospace`;
      ctx.textAlign = "center";
      const recentHits = new Map<string, number>();
      for (const i of intents) {
        if (i.stage === "cleared" && i.decidedAt && now - i.decidedAt < 1800) recentHits.set(i.merchantId, now - i.decidedAt);
      }
      for (const m of merchants) {
        const p = merchantPos.get(m.id)!;
        const glow = recentHits.has(m.id) ? 1 - recentHits.get(m.id)! / 1800 : 0;
        const alpha = persistence(p.a) * 0.75;
        ctx.fillStyle = glow ? `rgba(${CLEAR},${0.5 + glow / 2})` : `rgba(${AMBER},${alpha})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x + 4, p.y);
        ctx.lineTo(p.x, p.y + 4);
        ctx.lineTo(p.x - 4, p.y);
        ctx.closePath();
        ctx.fill();
        if (glow) {
          ctx.strokeStyle = `rgba(${CLEAR},${glow * 0.8})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6 + (1 - glow) * 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        const label = m.name.split(" ")[0].toUpperCase();
        const ly = p.y + (Math.sin(p.a) > 0.2 ? 15 : -9);
        ctx.fillStyle = `rgba(236,230,214,${0.25 + alpha * 0.45})`;
        ctx.fillText(label, p.x, ly);
      }

      // Agents
      for (const ag of agents) {
        const p = agentPos.get(ag.id)!;
        const alpha = persistence(p.a);
        const grounded = ag.status === "grounded";
        ctx.fillStyle = grounded ? `rgba(143,141,130,${alpha * 0.7})` : `rgba(${AMBER},${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        if (!grounded) {
          ctx.strokeStyle = `rgba(${AMBER},${alpha * 0.35})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.strokeStyle = `rgba(${DIVERT},0.6)`;
          ctx.beginPath();
          ctx.moveTo(p.x - 7, p.y - 7);
          ctx.lineTo(p.x + 7, p.y + 7);
          ctx.moveTo(p.x + 7, p.y - 7);
          ctx.lineTo(p.x - 7, p.y + 7);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(236,230,214,${0.45 + alpha * 0.5})`;
        ctx.font = `700 ${size < 420 ? 9 : 11}px "JetBrains Mono", monospace`;
        ctx.fillText(ag.callSign, p.x, p.y - 14);
      }

      // Contacts
      const holdR = R * 0.17;
      for (const i of intents.slice(-80)) {
        const track = tracks.current.get(i.id);
        if (!track) continue;
        const from = agentPos.get(i.agentId);
        const to = merchantPos.get(i.merchantId);
        if (!from || !to) continue;
        const t = now - track.since;
        const selected = i.id === selectedId;
        let x = c;
        let y = c;
        let color = AMBER;
        let alpha = 1;
        let tail: { x: number; y: number } | null = null;

        if (i.stage === "inbound" || i.stage === "screening") {
          const k = ease(t / (i.stage === "inbound" ? 650 : 900));
          const sx = i.stage === "inbound" ? from.x : c + (from.x - c) * 0.35;
          const sy = i.stage === "inbound" ? from.y : c + (from.y - c) * 0.35;
          const tx = i.stage === "inbound" ? c + (from.x - c) * 0.35 : c + Math.cos(track.seed) * 10;
          const ty = i.stage === "inbound" ? c + (from.y - c) * 0.35 : c + Math.sin(track.seed) * 10;
          x = sx + (tx - sx) * k;
          y = sy + (ty - sy) * k;
          tail = { x: sx, y: sy };
        } else if (i.stage === "hold") {
          const a = track.seed + t / 1400;
          x = c + Math.cos(a) * holdR;
          y = c + Math.sin(a) * holdR;
          color = HOLD;
          ctx.strokeStyle = `rgba(${HOLD},0.18)`;
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.arc(c, c, holdR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (i.stage === "cleared") {
          if (t > 2200) continue;
          const k = ease(t / 1300);
          x = c + (to.x - c) * k;
          y = c + (to.y - c) * k;
          color = CLEAR;
          alpha = t > 1500 ? 1 - (t - 1500) / 700 : 1;
          tail = { x: c, y: c };
        } else if (i.stage === "diverted") {
          if (t > 1600) continue;
          const k = t / 1600;
          color = DIVERT;
          ctx.strokeStyle = `rgba(${DIVERT},${0.9 * (1 - k)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(c, c, 8 + k * R * 0.32, 0, Math.PI * 2);
          ctx.stroke();
          const s = 6 * (1 - k) + 3;
          x = c + (from.x - c) * 0.2;
          y = c + (from.y - c) * 0.2;
          ctx.beginPath();
          ctx.moveTo(x - s, y - s);
          ctx.lineTo(x + s, y + s);
          ctx.moveTo(x + s, y - s);
          ctx.lineTo(x - s, y + s);
          ctx.stroke();
          ctx.lineWidth = 1;
          continue;
        }

        if (tail) {
          const grad = ctx.createLinearGradient(tail.x, tail.y, x, y);
          grad.addColorStop(0, `rgba(${color},0)`);
          grad.addColorStop(1, `rgba(${color},${0.55 * alpha})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = `rgba(${color},${alpha})`;
        ctx.shadowColor = `rgba(${color},0.9)`;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, selected ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (selected) {
          ctx.strokeStyle = `rgba(${color},0.9)`;
          ctx.strokeRect(x - 9, y - 9, 18, 18);
        }
      }

      // Tower
      ctx.fillStyle = "#0c0e0d";
      ctx.strokeStyle = `rgba(${AMBER},0.95)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(c - 15, c - 9, 30, 18);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = `rgba(${AMBER},1)`;
      ctx.font = `700 10px "JetBrains Mono", monospace`;
      ctx.textBaseline = "middle";
      ctx.fillText("CLR", c, c + 0.5);
      ctx.textBaseline = "alphabetic";

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="radar">
      <canvas ref={canvasRef} role="img" aria-label="Radar scope: agents on the inner ring, merchants on the outer ring, payments moving through the tower" />
    </div>
  );
}
