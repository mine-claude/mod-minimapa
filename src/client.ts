// @ts-check
import { ClientModInitializer } from './mineclaude-sdk.js';

// A round minimap built only from public APIs: ctx.client reads the world around the player, ctx.ui.canvas draws it.
// The terrain is sampled a few columns per frame into a small cache, so the cost stays flat however fast you walk.
const ZOOMS = [40, 24, 64];  // blocks shown from the center to the rim; N cycles them
const MAX_RADIUS = 64;
let RADIUS = ZOOMS[0];
const SIZE = 176;           // diameter of the map on screen (CSS px)
const PER_FRAME = 420;      // columns sampled per frame
const STALE_MS = 6000;      // a column is sampled again after this long
const SCAN_ABOVE = 24;      // look for the ground this far above the player (caves: no ceiling on the map)

// The look of the common blocks; anything else takes the average color of its own texture (ctx.client.blockColor).
const PALETTE = {
  'mineclaude:grass': '#5f9d48', 'mineclaude:leaves': '#3f7a35', 'mineclaude:water': '#2f6fb8',
  'mineclaude:sand': '#d9c98a', 'mineclaude:snow': '#eef4f7', 'mineclaude:dirt': '#7a5636',
  'mineclaude:stone': '#7d8186', 'mineclaude:gravel': '#8d8a86', 'mineclaude:log': '#6d4f2e',
};

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb = ([r, g, b], k = 1) => `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`;
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 360; };

export default class MinimapaClient extends ClientModInitializer {
  /** @param {import('../../packages/cli/types/mineclaude-mod').ClientModContext} ctx */
  onInitializeClient(ctx) {
    const columns = new Map(); // "x,z" -> { y, color:[r,g,b], water, at }
    const colorOf = new Map();
    const tile = document.createElement('canvas');
    tile.width = tile.height = RADIUS * 2 + 1;
    let zoom = 0, hidden = false;
    ctx.client.keys.register({ id: 'zoom', name: 'Minimapa: zoom', key: 'KeyN' }).onPress(() => {
      zoom = (zoom + 1) % ZOOMS.length; RADIUS = ZOOMS[zoom]; tile.width = tile.height = RADIUS * 2 + 1; lastCenter = '';
    });
    ctx.client.keys.register({ id: 'toggle', name: 'Minimapa: mostrar/esconder', key: 'KeyJ' }).onPress(() => { hidden = !hidden; });
    const tileCtx = tile.getContext('2d');
    let cursor = 0, lastCenter = '';

    const baseColor = (name) => {
      if (!colorOf.has(name)) colorOf.set(name, hexRgb(PALETTE[name] ?? ctx.client.blockColor(name) ?? '#808080'));
      return colorOf.get(name);
    };

    // Sample one column: the first solid ground below the player's head, and for water its depth.
    const sample = (x, z, py, now) => {
      const top = ctx.client.topBlock(x, z, Math.floor(py) + SCAN_ABOVE);
      if (!top) return null;
      let depth = 0;
      if (top.block === 'mineclaude:water') {
        while (depth < 8 && ctx.client.getBlock({ x, y: top.y - depth - 1, z }) === 'mineclaude:water') depth++;
      }
      const c = { y: top.y, color: baseColor(top.block), water: top.block === 'mineclaude:water', depth, at: now };
      columns.set(`${x},${z}`, c);
      return c;
    };

    // Paints the cached columns around (cx, cz) into the tile, 1 px per block, with light from the north-west.
    const paintTile = (cx, cz) => {
      const img = tileCtx.createImageData(tile.width, tile.height), d = img.data;
      for (let v = 0; v < tile.height; v++) for (let u = 0; u < tile.width; u++) {
        const x = cx - RADIUS + u, z = cz - RADIUS + v, c = columns.get(`${x},${z}`);
        const i = (v * tile.width + u) * 4;
        if (!c) { d[i] = 22; d[i + 1] = 28; d[i + 2] = 36; d[i + 3] = 255; continue; }
        let k;
        if (c.water) k = 1.15 - c.depth * 0.07;
        else {
          const n = columns.get(`${x},${z - 1}`) ?? c, w = columns.get(`${x - 1},${z}`) ?? c;
          k = 1 + Math.max(-0.28, Math.min(0.28, ((c.y - n.y) + (c.y - w.y)) * 0.09));
          k *= 0.92 + ((x * 73856093 ^ z * 19349663) & 7) / 70; // a little grain, fixed per column
        }
        d[i] = Math.min(255, c.color[0] * k); d[i + 1] = Math.min(255, c.color[1] * k); d[i + 2] = Math.min(255, c.color[2] * k); d[i + 3] = 255;
      }
      tileCtx.putImageData(img, 0, 0);
    };

    const update = (me, now) => {
      const cx = Math.floor(me.x), cz = Math.floor(me.z), span = RADIUS * 2 + 1, total = span * span;
      if (`${cx},${cz}` !== lastCenter) { lastCenter = `${cx},${cz}`; cursor = 0; }
      // nearest columns first: walk the square in rings from the center, skipping fresh ones
      for (let n = 0, tries = 0; n < PER_FRAME && tries < total; tries++) {
        const [du, dv] = ring(cursor++ % total);
        const x = cx + du, z = cz + dv, c = columns.get(`${x},${z}`);
        if (c && now - c.at < STALE_MS) continue;
        sample(x, z, me.y, now); n++;
      }
      if (columns.size > 60000) for (const [k, c] of columns) if (now - c.at > STALE_MS * 4) columns.delete(k);
      paintTile(cx, cz);
    };

    ctx.ui.canvas({
      id: 'minimapa', mode: 'hud', corner: 'top-right', width: SIZE + 16, height: SIZE + 40, label: 'Minimapa',
      draw(c, { width, time }) {
        const me = ctx.client.player();
        c.clearRect(0, 0, width, SIZE + 40);
        if (!me || hidden) return;
        const now = time * 1000;
        update(me, now);
        const R = SIZE / 2, cx = width / 2, cy = R + 8, scale = R / RADIUS;

        // frame: soft shadow, metal ring
        c.save();
        c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 10; c.shadowOffsetY = 3;
        c.beginPath(); c.arc(cx, cy, R + 4, 0, Math.PI * 2); c.fillStyle = '#1b2533'; c.fill();
        c.restore();

        // terrain, rotated so the way you look is up
        c.save();
        c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
        c.translate(cx, cy); c.rotate(me.yaw);
        c.imageSmoothingEnabled = false;
        const fx = me.x - Math.floor(me.x) - 0.5, fz = me.z - Math.floor(me.z) - 0.5;
        c.drawImage(tile, (-RADIUS - 0.5 - fx) * scale, (-RADIUS - 0.5 - fz) * scale, tile.width * scale, tile.height * scale);

        // mobs and other players, in the same rotated frame
        for (const m of ctx.client.mobs()) {
          const dx = (m.x - me.x) * scale, dz = (m.z - me.z) * scale;
          if (dx * dx + dz * dz > (R - 4) ** 2) continue;
          c.beginPath(); c.arc(dx, dz, 2.6, 0, Math.PI * 2);
          c.fillStyle = `hsl(${hue(m.type)} 75% 60%)`; c.fill();
          c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,.6)'; c.stroke();
        }
        for (const p of ctx.client.players()) {
          let dx = (p.x - me.x) * scale, dz = (p.z - me.z) * scale;
          const far = Math.hypot(dx, dz) > R - 6;
          if (far) { const k = (R - 6) / Math.hypot(dx, dz); dx *= k; dz *= k; } // pinned to the rim, still pointing at them
          c.beginPath(); c.arc(dx, dz, far ? 3 : 4, 0, Math.PI * 2);
          c.fillStyle = p.color || '#fff'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.stroke();
        }
        c.restore();

        // night falls over the map too
        const dark = 1 - Math.max(0, Math.min(1, ctx.client.daylight()));
        if (dark > 0.02) { c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fillStyle = `rgba(10,16,40,${dark * 0.45})`; c.fill(); }

        // inner vignette and ring
        const g = c.createRadialGradient(cx, cy, R * 0.7, cx, cy, R);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
        c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fillStyle = g; c.fill();
        const ring = c.createLinearGradient(0, cy - R, 0, cy + R);
        ring.addColorStop(0, '#c9d6e3'); ring.addColorStop(0.5, '#6f8296'); ring.addColorStop(1, '#3a4756');
        c.lineWidth = 4; c.strokeStyle = ring; c.beginPath(); c.arc(cx, cy, R + 1, 0, Math.PI * 2); c.stroke();

        // compass letters ride the rim
        c.font = 'bold 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        for (const [label, ax, az] of /** @type {[string, number, number][]} */ ([['N', 0, -1], ['L', 1, 0], ['S', 0, 1], ['O', -1, 0]])) {
          const a = me.yaw, x = (ax as any) * Math.cos(a) - (az as any) * Math.sin(a), y = (ax as any) * Math.sin(a) + (az as any) * Math.cos(a);
          const px = cx + x * (R + 1), py = cy + y * (R + 1);
          c.beginPath(); c.arc(px, py, 8, 0, Math.PI * 2); c.fillStyle = label === 'N' ? '#c0392b' : '#243142'; c.fill();
          c.lineWidth = 1.5; c.strokeStyle = '#d7e1ea'; c.stroke();
          c.fillStyle = '#fff'; c.fillText(label, px, py + 0.5);
        }

        // the player: an arrow, always pointing up
        c.save(); c.translate(cx, cy);
        c.beginPath(); c.moveTo(0, -8); c.lineTo(6, 6); c.lineTo(0, 3); c.lineTo(-6, 6); c.closePath();
        c.fillStyle = '#fff'; c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 4; c.fill();
        c.lineWidth = 1.2; c.strokeStyle = '#1b2533'; c.stroke();
        c.restore();

        // coordinates on a pill under the map
        const text = `${Math.floor(me.x)}  ${Math.floor(me.y)}  ${Math.floor(me.z)}`;
        c.font = '600 12px ui-monospace, Consolas, monospace';
        const w = c.measureText(text).width + 18, y0 = cy + R + 10;
        c.beginPath(); c.roundRect(cx - w / 2, y0, w, 20, 10); c.fillStyle = 'rgba(20,28,40,.82)'; c.fill();
        c.lineWidth = 1; c.strokeStyle = 'rgba(201,214,227,.5)'; c.stroke();
        c.fillStyle = '#e8eef4'; c.fillText(text, cx, y0 + 10.5);
      },
    });
  }
}

// The i-th cell of a square spiral around (0, 0): 0 is the center, then ring 1, ring 2... The first (2r+1)² cells
// are exactly the square of radius r, so one list serves every zoom.
const RING_CACHE = [];
function ring(i) {
  if (RING_CACHE.length === 0) {
    const cells = [];
    for (let v = -MAX_RADIUS; v <= MAX_RADIUS; v++) for (let u = -MAX_RADIUS; u <= MAX_RADIUS; u++) cells.push([u, v]);
    cells.sort((a, b) => Math.max(Math.abs(a[0]), Math.abs(a[1])) - Math.max(Math.abs(b[0]), Math.abs(b[1])) || (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2));
    RING_CACHE.push(...cells);
  }
  return RING_CACHE[i];
}
