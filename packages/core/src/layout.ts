import type { FileMetrics, Galaxy, ModuleEdge, ModuleMetrics } from './types.js';
import { byString, hash, rng } from './util.js';

export interface PlacedModule {
  module: ModuleMetrics;
  x: number;
  y: number;
  r: number;
  /** Radius including its moons. */
  extent: number;
  /** Angle around the core (radians); the lit side faces the core. */
  angle: number;
  /** Distance from the core. */
  orbitR: number;
}
export interface PlacedFile {
  file: FileMetrics;
  x: number;
  y: number;
  r: number;
  /** Moons only: the planet it circles and its shell radius (for animation). */
  home?: PlacedModule;
  shellR?: number;
}
export interface Orbit { r: number; distance: number | null }
export interface Link { edge: ModuleEdge; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; width: number }

export interface Scene {
  size: number;
  cx: number;
  cy: number;
  core: PlacedModule;
  coronaR: number;
  planets: PlacedModule[];
  moons: PlacedFile[];
  dead: PlacedFile[];
  orbits: Orbit[];
  beltR: number | null;
  links: Link[];
}

const MAX_PLANET_R = 40;
const MIN_PLANET_R = 4;
const MIN_CORE_R = 12;
const MAX_MOON_R = 6;
const MIN_MOON_R = 0.9;
const GAP = 14;

/**
 * Pure geometry. Every number here comes from a metric:
 *   planet radius ∝ √LOC (area ∝ lines), moon radius ∝ √file LOC,
 *   orbit index = import hops from the core, moon shell = rank by fan-in,
 *   angles are seeded from paths so they never move between runs.
 */
export function layout(g: Galaxy, size = 1200): Scene {
  const maxModLoc = Math.max(1, ...g.modules.map((m) => m.loc));
  const maxFileLoc = Math.max(1, ...g.files.map((f) => f.loc));
  const planetR = (loc: number, min: number) => Math.max(min, MAX_PLANET_R * Math.sqrt(loc / maxModLoc));
  const moonR = (loc: number) => Math.max(MIN_MOON_R, MAX_MOON_R * Math.sqrt(loc / maxFileLoc));
  const byPath = new Map(g.files.map((f) => [f.path, f]));

  // Moons in local coordinates around their planet: most-imported files on the inner shells.
  const localMoons = new Map<string, { file: FileMetrics; dx: number; dy: number; r: number; shellR: number }[]>();
  const extents = new Map<string, number>();
  const radii = new Map<string, number>();
  for (const m of g.modules) {
    const r = planetR(m.loc, m.name === g.core ? MIN_CORE_R : MIN_PLANET_R);
    radii.set(m.name, r);
    // A one-file module (a Python file at the top level) *is* the planet: no moons.
    const live = m.files.length === 1 && m.files[0] === m.name ? [] : m.files.map((p) => byPath.get(p)!).filter((f) => !f.dead)
      .sort((a, b) => b.fanIn - a.fanIn || byString(a.path, b.path));
    const placed: { file: FileMetrics; dx: number; dy: number; r: number; shellR: number }[] = [];
    let shellR = r + 5;
    let i = 0;
    let shell = 0;
    while (i < live.length) {
      const circ = 2 * Math.PI * shellR;
      const members: FileMetrics[] = [];
      let used = 0;
      while (i < live.length) {
        const need = 2 * moonR(live[i].loc) + 1.4;
        if (members.length > 0 && used + need > circ) break;
        members.push(live[i]);
        used += need;
        i++;
      }
      const spread = circ / used; // >1 on a shell that isn't full: spread evenly
      let a = (hash(m.name + '#' + shell) / 2 ** 32) * Math.PI * 2;
      let maxR = 0;
      for (const f of members) {
        const fr = moonR(f.loc);
        const arc = ((2 * fr + 1.4) * spread) / shellR;
        a += arc / 2;
        placed.push({ file: f, dx: Math.cos(a) * shellR, dy: Math.sin(a) * shellR, r: fr, shellR });
        a += arc / 2;
        maxR = Math.max(maxR, fr);
      }
      shellR += 2 * maxR + 1.6;
      shell++;
    }
    localMoons.set(m.name, placed);
    extents.set(m.name, placed.length ? shellR : r);
  }

  // Every planet gets its own orbit, far enough from its neighbours that the planets never
  // collide as they overtake each other (moon clouds may pass through each other). Order from the core outward: hop count first, then how hard
  // the planet is tied to the zone inside it (import links either way) — the pull of gravity.
  // Modules not connected to the core at all orbit outermost.
  const core = g.modules.find((m) => m.name === g.core)!;
  const others = g.modules.filter((m) => m !== core);
  const distOf = new Map(g.modules.map((m) => [m.name, m.distance ?? Infinity]));
  const coupling = new Map<string, number>();
  for (const e of g.edges) {
    const [a, b] = [distOf.get(e.from)!, distOf.get(e.to)!];
    if (a === b + 1) coupling.set(e.from, (coupling.get(e.from) ?? 0) + e.count);
    if (b === a + 1) coupling.set(e.to, (coupling.get(e.to) ?? 0) + e.count);
  }
  const order = [...others].sort((a, b) =>
    distOf.get(a.name)! - distOf.get(b.name)! ||
    (coupling.get(b.name) ?? 0) - (coupling.get(a.name) ?? 0) ||
    b.loc - a.loc || byString(a.name, b.name));
  const orbits: Orbit[] = [];
  const planets: PlacedModule[] = [];
  let prevR = 0;
  let prevBody = extents.get(core.name)!;
  let prevDist = 0;
  let outerMost = extents.get(core.name)!;
  for (const m of order) {
    const ext = extents.get(m.name)!;
    const body = radii.get(m.name)!;
    const dist = distOf.get(m.name)!;
    // The first orbit clears the core's own moons; a wider gap where a new zone starts.
    const r = prevR + prevBody + body + (dist !== prevDist ? GAP * 2 : GAP * 0.4);
    const a = (hash(m.name) / 2 ** 32) * Math.PI * 2;
    orbits.push({ r, distance: dist === Infinity ? null : dist });
    planets.push({ module: m, x: Math.cos(a) * r, y: Math.sin(a) * r, r: body, extent: ext, angle: a, orbitR: r });
    prevR = r;
    prevBody = body;
    prevDist = dist;
    outerMost = Math.max(outerMost, r + ext);
  }

  const placedCore: PlacedModule = { module: core, x: 0, y: 0, r: radii.get(core.name)!, extent: extents.get(core.name)!, angle: 0, orbitR: 0 };
  const where = new Map<string, PlacedModule>([[core.name, placedCore], ...planets.map((p) => [p.module.name, p] as const)]);

  // Dead files: an outer belt, each one drifting near the planet it came from.
  const deadFiles = g.files.filter((f) => f.dead);
  const beltR = deadFiles.length ? outerMost + GAP * 2 : null;
  const beltW = 24;
  const deadLocal = deadFiles.map((f) => {
    const rand = rng(hash(f.path));
    const home = where.get(f.module)!;
    const base = home === placedCore ? rand() * Math.PI * 2 : home.angle;
    const a = base + (rand() - 0.5) * 0.6;
    const rr = beltR! + (rand() - 0.5) * beltW;
    return { file: f, x: Math.cos(a) * rr, y: Math.sin(a) * rr, r: moonR(f.loc) };
  });

  // Fit to the canvas.
  const outer = beltR !== null ? beltR + beltW / 2 + 8 : outerMost;
  const scale = (size / 2 - 72) / Math.max(outer, extents.get(core.name)!);
  const cx = size / 2;
  const cy = size / 2;
  const S = (p: PlacedModule): PlacedModule => ({
    ...p, x: cx + p.x * scale, y: cy + p.y * scale, r: Math.max(2.5, p.r * scale), extent: p.extent * scale, orbitR: p.orbitR * scale,
  });
  const sCore = S(placedCore);
  const sPlanets = planets.map(S);
  const sWhere = new Map([[core.name, sCore], ...sPlanets.map((p) => [p.module.name, p] as const)]);

  const moons: PlacedFile[] = [];
  for (const [name, list] of localMoons) {
    const home = sWhere.get(name)!;
    for (const m of list) moons.push({ file: m.file, x: home.x + m.dx * scale, y: home.y + m.dy * scale, r: Math.max(0.6, m.r * scale), home, shellR: m.shellR * scale });
  }
  const dead = deadLocal.map((d) => ({ file: d.file, x: cx + d.x * scale, y: cy + d.y * scale, r: Math.max(0.8, d.r * scale) }));

  const maxCount = Math.max(1, ...g.edges.map((e) => e.count));
  const links: Link[] = g.edges.map((edge) => {
    const a = sWhere.get(edge.from)!;
    const b = sWhere.get(edge.to)!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return {
      edge, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      // Bend toward the core: the pull of gravity.
      cx: mx + (cx - mx) * 0.35, cy: my + (cy - my) * 0.35,
      width: 0.4 + 2.6 * Math.sqrt(edge.count / maxCount),
    };
  });

  return {
    size, cx, cy,
    core: sCore,
    coronaR: sCore.r * Math.min(5, 1.4 + 0.45 * Math.log2(1 + core.fanIn)),
    planets: sPlanets,
    moons,
    dead,
    orbits: orbits.map((o) => ({ ...o, r: o.r * scale })),
    beltR: beltR !== null ? beltR * scale : null,
    links,
  };
}
