import { layout, type PlacedModule, type Scene } from './layout.js';
import type { Galaxy, Language } from './types.js';
import { hash, rng } from './util.js';

const LANG: Record<Language, { base: string; light: string; dark: string }> = {
  TypeScript: { base: '#4f8fea', light: '#b9d6ff', dark: '#13274d' },
  JavaScript: { base: '#efb03f', light: '#ffe6ad', dark: '#4d2f07' },
  Python: { base: '#37bf95', light: '#b0f2dc', dark: '#0b3d30' },
};

const n = (v: number) => String(Math.round(v * 100) / 100);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export interface RenderOptions {
  size?: number;
  /** Animate the SVG (moons orbit, imports pulse). Off for PNG, which can't move. Default true. */
  animate?: boolean;
}

/** Fallback (no JavaScript, e.g. inside a GitHub README): the system turns as one body. */
const SYSTEM_PERIOD = 300;
const BELT_PERIOD = 720;
/** With JavaScript, each planet follows Kepler: period (s) = KEPLER_T * (r / KEPLER_R)^1.5. */
const KEPLER_T = 240;
const KEPLER_R = 300;
/** Pixels per second for import pulses. */
const PULSE_SPEED = 55;
const MAX_PULSING_LINKS = 200;

const CSS = `
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes unspin { to { transform: rotate(-360deg) } }
.sys, .belt, .orb, .up { animation-timing-function: linear; animation-iteration-count: infinite }
.sys { animation-name: spin; animation-duration: ${SYSTEM_PERIOD}s }
.belt { animation-name: spin; animation-duration: ${BELT_PERIOD}s }
.orb { animation-name: spin }
.up { animation-name: unspin; animation-duration: ${SYSTEM_PERIOD}s }
@media (prefers-reduced-motion: reduce) { .sys, .belt, .orb, .up { animation: none } }
`;

/**
 * Real orbits. Runs only where SVG scripts run (opened directly in a browser, or inlined).
 * Every planet circles the core at its own Kepler speed, so inner planets overtake outer
 * ones; import lines and pulses are redrawn every frame to stay attached.
 */
const PHYSICS = `(function () {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var D = __DATA__, NS = 'http://www.w3.org/2000/svg', cx = D.c[0], cy = D.c[1];
  var sys = document.getElementById('cg-sys');
  if (!sys) return;
  sys.classList.remove('sys');
  var planets = D.p.map(function (_, i) { return document.getElementById('cg-p' + i); });
  // Labels: drop the CSS fallback (class + transform-origin) so the script's transform is the only one.
  Array.prototype.forEach.call(sys.querySelectorAll('text.up'), function (t) { t.classList.remove('up'); t.removeAttribute('style'); });
  var labels = planets.map(function (g) { return g.querySelector('text'); });
  var paths = Array.prototype.slice.call(document.getElementById('cg-links').children);
  var old = document.getElementById('cg-pulses');
  var layer = document.createElementNS(NS, 'g');
  layer.setAttribute('fill', '#fff6dc');
  old.parentNode.replaceChild(layer, old);
  var dots = [];
  D.l.forEach(function (l, i) {
    for (var k = 0; k < l[3]; k++) {
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', l[5]);
      layer.appendChild(c);
      dots.push([i, (l[4] + k * l[2] / l[3]) % l[2], c]);
    }
  });
  var t0 = null, pos = [];
  function at(i) { return i < 0 ? [cx, cy] : pos[i]; }
  function frame(now) {
    if (t0 === null) t0 = now;
    var t = (now - t0) / 1000;
    D.p.forEach(function (p, i) {
      var turn = 2 * Math.PI * t / p[2], a = p[1] + turn, deg = turn * 180 / Math.PI;
      pos[i] = [cx + Math.cos(a) * p[0], cy + Math.sin(a) * p[0]];
      planets[i].setAttribute('transform', 'rotate(' + deg.toFixed(3) + ' ' + cx + ' ' + cy + ')');
      if (labels[i]) labels[i].setAttribute('transform', 'rotate(' + (-deg).toFixed(3) + ' ' + p[3] + ' ' + p[4] + ')');
    });
    var ctrl = D.l.map(function (l, i) {
      var A = at(l[0]), B = at(l[1]), mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
      var C = [mx + (cx - mx) * 0.35, my + (cy - my) * 0.35];
      paths[i].setAttribute('d', 'M' + A[0].toFixed(1) + ' ' + A[1].toFixed(1) + 'Q' + C[0].toFixed(1) + ' ' + C[1].toFixed(1) + ' ' + B[0].toFixed(1) + ' ' + B[1].toFixed(1));
      return [A, C, B];
    });
    dots.forEach(function (d) {
      var l = D.l[d[0]], q = ctrl[d[0]], u = ((t + d[1]) % l[2]) / l[2], v = 1 - u;
      d[2].setAttribute('cx', (v * v * q[0][0] + 2 * v * u * q[1][0] + u * u * q[2][0]).toFixed(1));
      d[2].setAttribute('cy', (v * v * q[0][1] + 2 * v * u * q[1][1] + u * u * q[2][1]).toFixed(1));
      d[2].setAttribute('opacity', (u < 0.15 ? u / 0.15 * 0.9 : u > 0.8 ? (1 - u) / 0.2 * 0.9 : 0.9).toFixed(2));
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();`;

export function renderSvg(g: Galaxy, opts: RenderOptions = {}): string {
  const s = layout(g, opts.size ?? 1200);
  const animate = opts.animate ?? true;
  const out: string[] = [];
  const defs: string[] = [];
  const W = s.size;
  const origin = (x: number, y: number) => `transform-origin:${n(x)}px ${n(y)}px`;

  defs.push(
    `<radialGradient id="bg" cx="50%" cy="50%" r="72%"><stop offset="0" stop-color="#0d1226"/><stop offset="0.6" stop-color="#070a17"/><stop offset="1" stop-color="#03040a"/></radialGradient>`,
  );
  out.push(`<rect width="${W}" height="${W}" fill="url(#bg)"/>`);

  // Each planet's orbit. Dashed: not linked to the core.
  const drawn = new Set<string>();
  for (const o of s.orbits) {
    const key = n(o.r);
    if (drawn.has(key)) continue;
    drawn.add(key);
    const dash = o.distance === null ? ' stroke-dasharray="2 6"' : '';
    out.push(`<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${key}" fill="none" stroke="#9fb4ff" stroke-opacity="0.05" stroke-width="1"${dash}/>`);
  }

  // Dead code: cold, dark, outer belt, drifting slower than everything else.
  out.push(`<g class="belt" style="${origin(s.cx, s.cy)}" fill="#3a4357" stroke="#7d8aa8" stroke-opacity="0.55" stroke-width="0.6">`);
  for (const d of s.dead) out.push(`<circle cx="${n(d.x)}" cy="${n(d.y)}" r="${n(d.r)}"/>`);
  out.push('</g>');

  out.push(`<g id="cg-sys" class="sys" style="${origin(s.cx, s.cy)}">`);

  // Gravity lines: thicker and brighter the more imports they carry.
  const index = new Map<string, number>([[s.core.module.name, -1], ...s.planets.map((p, i) => [p.module.name, i] as const)]);
  const maxCount = Math.max(1, ...g.edges.map((e) => e.count));
  const path = (l: (typeof s.links)[number]) => `M${n(l.x1)} ${n(l.y1)}Q${n(l.cx)} ${n(l.cy)} ${n(l.x2)} ${n(l.y2)}`;
  out.push('<g id="cg-links" fill="none" stroke="#c9d6ff" stroke-linecap="round">');
  for (const l of s.links) {
    out.push(`<path d="${path(l)}" stroke-width="${n(l.width)}" stroke-opacity="${n(0.05 + 0.1 * Math.sqrt(l.edge.count / maxCount))}"/>`);
  }
  out.push('</g>');

  // Import pulses: light travels from the importer to what it imports. More imports, more pulses.
  // SMIL here is the fallback; the physics script replaces it. Invisible if nothing runs.
  const busiest = new Set(
    [...s.links].sort((a, b) => b.edge.count - a.edge.count || (a.edge.from + a.edge.to < b.edge.from + b.edge.to ? -1 : 1))
      .slice(0, MAX_PULSING_LINKS),
  );
  const linkData: number[][] = [];
  out.push('<g id="cg-pulses" fill="#fff6dc">');
  for (const l of s.links) {
    const chord = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    const poly = Math.hypot(l.cx - l.x1, l.cy - l.y1) + Math.hypot(l.x2 - l.cx, l.y2 - l.cy);
    const dur = Math.max(2, (chord + poly) / 2 / PULSE_SPEED);
    const pulses = busiest.has(l) ? Math.min(4, 1 + Math.floor(Math.log2(l.edge.count))) : 0;
    const phase = (hash(l.edge.from + '>' + l.edge.to) / 2 ** 32) * dur;
    const r = Math.min(2.2, 0.9 + l.width * 0.4);
    linkData.push([index.get(l.edge.from)!, index.get(l.edge.to)!, +n(dur), pulses, +n(phase), +n(r)]);
    if (!animate) continue;
    for (let k = 0; k < pulses; k++) {
      const begin = `-${n(phase + (k * dur) / pulses)}s`;
      out.push(
        `<circle r="${n(r)}" opacity="0">` +
        `<animateMotion dur="${n(dur)}s" begin="${begin}" repeatCount="indefinite" path="${path(l)}"/>` +
        `<animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.15;0.8;1" dur="${n(dur)}s" begin="${begin}" repeatCount="indefinite"/>` +
        `</circle>`,
      );
    }
  }
  out.push('</g>');

  // Moons, colored by the file's own language, grouped per shell. Each shell circles its
  // planet by Kepler's law (period ∝ r^1.5): inner shells, the most-imported files, run fastest.
  const shells = new Map<string, typeof s.moons>();
  for (const m of s.moons) {
    const key = `${m.home!.module.name}\0${m.shellR}`;
    const list = shells.get(key) ?? [];
    list.push(m);
    shells.set(key, list);
  }
  const moonsOf = (name: string) => {
    const parts: string[] = [];
    for (const list of shells.values()) {
      const { home, shellR } = list[0];
      if (home!.module.name !== name) continue;
      const period = Math.max(10, 8 * Math.pow(shellR! / 10, 1.5));
      parts.push(`<g class="orb" style="${origin(home!.x, home!.y)};animation-duration:${n(period)}s" fill-opacity="0.8">`);
      for (const m of list) parts.push(`<circle cx="${n(m.x)}" cy="${n(m.y)}" r="${n(m.r)}" fill="${LANG[m.file.language].light}"/>`);
      parts.push('</g>');
    }
    return parts.join('');
  };
  const label = labels(s, g);

  // Core star: corona size follows fan-in.
  const core = s.core;
  const cl = LANG[core.module.language];
  defs.push(
    `<radialGradient id="corona"><stop offset="0" stop-color="#fff8e7" stop-opacity="0.85"/><stop offset="0.25" stop-color="${cl.light}" stop-opacity="0.35"/><stop offset="1" stop-color="${cl.base}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="star"><stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#fff4da"/><stop offset="1" stop-color="${cl.light}"/></radialGradient>`,
  );
  out.push(moonsOf(core.module.name));
  out.push(`<circle cx="${n(core.x)}" cy="${n(core.y)}" r="${n(s.coronaR)}" fill="url(#corona)"/>`);
  out.push(`<circle cx="${n(core.x)}" cy="${n(core.y)}" r="${n(core.r)}" fill="url(#star)"/>`);
  out.push(`<g text-anchor="middle" fill="#e8edff">${label.get(-1) ?? ''}</g>`);

  // One group per planet (moons, body, label) so the physics can move it as a whole.
  s.planets.forEach((p, i) => {
    out.push(`<g id="cg-p${i}">${moonsOf(p.module.name)}${planet(p, i, s, defs)}<g text-anchor="middle" fill="#e8edff">${label.get(i) ?? ''}</g></g>`);
  });
  out.push('</g>');
  out.push(legend(s, g));

  const data = JSON.stringify({
    c: [+n(s.cx), +n(s.cy)],
    p: s.planets.map((p) => [+n(p.orbitR), +p.angle.toFixed(4), +n(KEPLER_T * Math.pow(p.orbitR / KEPLER_R, 1.5)), +n(p.x), +n(p.y)]),
    l: linkData,
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif">`,
    `<title>${esc(g.name)} — code galaxy</title>`,
    animate ? `<style>${CSS}</style>` : '',
    `<defs>${defs.join('')}</defs>`,
    ...out,
    animate ? `<script><![CDATA[${PHYSICS.replace('__DATA__', data)}]]></script>` : '',
    '</svg>',
  ].filter(Boolean).join('\n');
}

/** A planet: lit from the core, atmosphere = language, craters = complexity, bands = nesting. */
function planet(p: PlacedModule, i: number, s: Scene, defs: string[]): string {
  const c = LANG[p.module.language];
  // Light comes from the core: put the gradient's focal point on the side facing it.
  const toCore = Math.atan2(s.cy - p.y, s.cx - p.x);
  const fx = 0.5 + Math.cos(toCore) * 0.32;
  const fy = 0.5 + Math.sin(toCore) * 0.32;
  defs.push(
    `<radialGradient id="p${i}" fx="${n(fx)}" fy="${n(fy)}" r="0.75"><stop offset="0" stop-color="${c.light}"/><stop offset="0.45" stop-color="${c.base}"/><stop offset="1" stop-color="${c.dark}"/></radialGradient>`,
    `<clipPath id="c${i}"><circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.r)}"/></clipPath>`,
  );
  const parts: string[] = [];
  parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.r * 1.22)}" fill="${c.base}" fill-opacity="0.12"/>`);
  parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.r)}" fill="url(#p${i})"/>`);

  if (p.r >= 5) {
    const rand = rng(hash(p.module.name));
    const surface: string[] = [];
    const bands = Math.max(0, Math.min(5, Math.round(p.module.avgNesting - 1)));
    const tilt = (rand() - 0.5) * 40;
    for (let b = 0; b < bands; b++) {
      const y = p.y + ((b + 0.5) / bands - 0.5) * p.r * 1.6;
      surface.push(`<ellipse cx="${n(p.x)}" cy="${n(y)}" rx="${n(p.r * 1.3)}" ry="${n(p.r * (0.06 + rand() * 0.06))}" fill="${c.light}" fill-opacity="0.16" transform="rotate(${n(tilt)} ${n(p.x)} ${n(p.y)})"/>`);
    }
    const craters = Math.max(0, Math.min(18, Math.round((p.module.avgComplexity - 1.5) * 3)));
    for (let k = 0; k < craters; k++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * p.r * 0.85;
      const cr = p.r * (0.07 + rand() * 0.12);
      const x = p.x + Math.cos(a) * d;
      const y = p.y + Math.sin(a) * d;
      surface.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(cr)}" fill="${c.dark}" fill-opacity="0.45"/>`);
      surface.push(`<circle cx="${n(x + Math.cos(toCore) * cr * 0.25)}" cy="${n(y + Math.sin(toCore) * cr * 0.25)}" r="${n(cr * 0.7)}" fill="${c.base}" fill-opacity="0.35"/>`);
    }
    if (surface.length) parts.push(`<g clip-path="url(#c${i})">${surface.join('')}</g>`);
  }
  return parts.join('');
}

/** Label without the folders it shares with the main code folder: "packages/react" → "react". */
function shortName(name: string, root: string): string {
  const a = name.split('/');
  const b = root.split('/');
  let i = 0;
  while (i < a.length - 1 && i < b.length && a[i] === b[i]) i++;
  if (a[a.length - 1] === '*' && i === a.length - 1) i--;
  return a.slice(i).join('/');
}

/** Label markup per planet index (-1 = the core). Biggest first; overlapping labels are dropped. */
function labels(s: Scene, g: Galaxy): Map<number, string> {
  const ranked = s.planets.map((p, i) => [p, i] as const).sort((a, b) => b[0].module.loc - a[0].module.loc);
  const shown = ranked.slice(0, s.planets.length <= 14 ? 14 : 10);
  const out = new Map<number, string>();
  const boxes: [number, number, number, number][] = [];
  const place = (key: number, x: number, y: number, text: string, size: number, attrs: string, ox: number, oy: number) => {
    const w = text.length * size * 0.56;
    const box: [number, number, number, number] = [x - w / 2, y - size, x + w / 2, y + 3];
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
    boxes.push(box);
    // Counter-rotates around its planet: stays upright and below it while the system turns.
    out.set(key, `<text class="up" style="transform-origin:${n(ox)}px ${n(oy)}px" x="${n(x)}" y="${n(y)}" font-size="${size}" ${attrs}>${esc(text)}</text>`);
  };
  const core = s.core;
  place(-1, core.x, core.y + Math.max(core.extent, s.coronaR * 0.6) + 16, shortName(core.module.name, g.moduleRoot), 13, 'font-weight="600" fill-opacity="0.9"', core.x, core.y);
  for (const [p, i] of shown) place(i, p.x, p.y + p.extent + 13, shortName(p.module.name, g.moduleRoot), 11, 'fill-opacity="0.7"', p.x, p.y);
  return out;
}

function legend(s: Scene, g: Galaxy): string {
  const W = s.size;
  const out: string[] = [];
  out.push(`<g fill="#e8edff">`);
  out.push(`<text x="36" y="${W - 62}" font-size="24" font-weight="700">${esc(g.name)}</text>`);
  out.push(`<text x="36" y="${W - 38}" font-size="14" fill-opacity="0.7">${fmt(g.stats.loc)} lines · ${fmt(g.stats.files)} files · ${fmt(g.stats.deadFiles)} unused</text>`);
  out.push('</g>');

  const key = [
    'size = lines of code',
    'orbit = import hops from the core, then ties to it',
    'craters = complexity · bands = nesting',
    'dark belt = files nothing imports',
  ];
  out.push(`<g text-anchor="end" fill="#e8edff" fill-opacity="0.5" font-size="11">`);
  key.forEach((k, i) => out.push(`<text x="${W - 36}" y="${W - 96 + i * 15}">${k}</text>`));
  const langs = (Object.keys(LANG) as Language[]).filter((l) => g.stats.languages[l]);
  let x = W - 36;
  for (const l of [...langs].reverse()) {
    out.push(`<text x="${x}" y="${W - 30}">${l}</text>`);
    x -= l.length * 6.2 + 4;
    out.push(`<circle cx="${n(x - 4)}" cy="${W - 34}" r="4" fill="${LANG[l].base}" fill-opacity="1"/>`);
    x -= 18;
  }
  out.push('</g>');
  return out.join('');
}
