import { CodeParser, grammarFor, languageOf, type InitOptions } from './parse.js';
import { Resolver } from './resolve.js';
import type { FileMetrics, Galaxy, Language, ModuleEdge, ModuleMetrics, SourceFile } from './types.js';
import { basename, byString, countLoc, dirname, joinPath, parseJsonc } from './util.js';

const CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json']);
const isHtml = (path: string) => /\.html?$/i.test(path);

/** Files the analyzer wants: code it can parse, configs that drive import resolution, and HTML (script entry points). */
export function isWanted(path: string): boolean {
  return grammarFor(path) !== null || CONFIG_FILES.has(basename(path)) || isHtml(path);
}

export interface AnalyzeOptions extends InitOptions {
  /** Shown in the legend, e.g. "facebook/react". */
  name: string;
}

let parserPromise: Promise<CodeParser> | null = null;

export async function analyze(input: SourceFile[], opts: AnalyzeOptions): Promise<Galaxy> {
  parserPromise ??= CodeParser.create(opts);
  const parser = await parserPromise;

  const sorted = [...input].sort((a, b) => byString(a.path, b.path));
  const code = sorted.filter((f) => grammarFor(f.path) !== null && !/\.min\.js$/.test(f.path));
  const configs = new Map(sorted.filter((f) => CONFIG_FILES.has(basename(f.path))).map((f) => [f.path, f.content]));
  if (code.length === 0) throw new Error('No JavaScript, TypeScript or Python files found.');

  const resolver = new Resolver(code.map((f) => f.path), configs);
  const packageEntries = packageEntryFiles(configs, resolver);
  for (const html of sorted.filter((f) => isHtml(f.path))) {
    for (const [, src] of html.content.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      if (/^(https?:)?\/\//.test(src)) continue;
      const hit = resolver.resolve(html.path, { kind: 'js', spec: src.startsWith('/') ? '.' + src : src.startsWith('.') ? src : './' + src });
      if (hit) packageEntries.add(hit);
    }
  }

  const files: FileMetrics[] = code.map((f) => {
    const grammar = grammarFor(f.path)!;
    const parsed = parser.parse(grammar, f.content);
    const imports = new Set<string>();
    let externalImports = 0;
    for (const imp of parsed.imports) {
      const target = resolver.resolve(f.path, imp);
      if (target === null) externalImports++;
      else if (target !== f.path) imports.add(target);
    }
    return {
      path: f.path,
      module: '',
      language: languageOf(grammar),
      loc: countLoc(f.content),
      units: parsed.units,
      complexity: parsed.complexity,
      maxNesting: parsed.maxNesting,
      imports: [...imports].sort(byString),
      externalImports,
      fanIn: 0,
      entryReason: entryReason(f, packageEntries),
      dead: false,
    };
  });

  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files) for (const t of f.imports) byPath.get(t)!.fanIn++;
  for (const f of files) f.dead = f.fanIn === 0 && f.entryReason === null;

  // Tests, examples and config are drawn like everything else, but they don't get
  // to decide the architecture: thousands of tests importing `react` doesn't
  // make `react` the core of the React repo.
  const product = files.filter((f) => !isSupport(f));
  const chain = findModuleChain(product.length ? product : files);
  const moduleRoot = chain[chain.length - 1];
  for (const f of files) f.module = moduleOf(f.path, chain);

  // Module graph (product code only).
  const edgeMap = new Map<string, ModuleEdge>();
  for (const f of product) {
    for (const t of f.imports) {
      if (isSupport(byPath.get(t)!)) continue;
      const to = byPath.get(t)!.module;
      if (to === f.module) continue;
      const key = f.module + '\0' + to;
      const e = edgeMap.get(key) ?? { from: f.module, to, count: 0 };
      e.count++;
      edgeMap.set(key, e);
    }
  }
  const edges = [...edgeMap.values()].sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to));

  const modules = new Map<string, ModuleMetrics>();
  const langLoc = new Map<string, Map<Language, number>>();
  const nestSum = new Map<string, number>();
  const units = new Map<string, [number, number]>();
  for (const f of files) {
    const m = modules.get(f.module) ?? {
      name: f.module, files: [], loc: 0, language: f.language,
      avgComplexity: 0, avgNesting: 0, fanIn: 0, distance: null,
    };
    m.files.push(f.path);
    m.loc += f.loc;
    modules.set(f.module, m);
    const ll = langLoc.get(f.module) ?? new Map<Language, number>();
    ll.set(f.language, (ll.get(f.language) ?? 0) + f.loc);
    langLoc.set(f.module, ll);
    nestSum.set(f.module, (nestSum.get(f.module) ?? 0) + f.maxNesting * f.loc);
    const u = units.get(f.module) ?? [0, 0];
    u[0] += f.units;
    u[1] += f.complexity;
    units.set(f.module, u);
  }
  for (const m of modules.values()) {
    m.language = [...langLoc.get(m.name)!].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0][0];
    const [u, c] = units.get(m.name)!;
    m.avgComplexity = round(u === 0 ? 1 : c / u);
    m.avgNesting = round(m.loc === 0 ? 0 : nestSum.get(m.name)! / m.loc);
  }
  for (const e of edges) modules.get(e.to)!.fanIn += e.count;

  const moduleList = [...modules.values()].sort((a, b) => byString(a.name, b.name));
  const core = [...moduleList].sort((a, b) => b.fanIn - a.fanIn || b.loc - a.loc || byString(a.name, b.name))[0];

  // Hops from the core, ignoring import direction.
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  core.distance = 0;
  const queue = [core.name];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = modules.get(cur)!.distance!;
    for (const n of [...(adj.get(cur) ?? [])].sort(byString)) {
      const m = modules.get(n)!;
      if (m.distance === null) {
        m.distance = d + 1;
        queue.push(n);
      }
    }
  }

  const languages: Partial<Record<Language, number>> = {};
  for (const f of files) languages[f.language] = (languages[f.language] ?? 0) + f.loc;
  const dead = files.filter((f) => f.dead);

  return {
    name: opts.name,
    core: core.name,
    moduleRoot,
    modules: moduleList,
    files,
    edges,
    stats: {
      files: files.length,
      loc: files.reduce((s, f) => s + f.loc, 0),
      modules: moduleList.length,
      deadFiles: dead.length,
      deadLoc: dead.reduce((s, f) => s + f.loc, 0),
      languages,
    },
  };
}

const SUPPORT = new Set(['test', 'script or example', 'config']);
function isSupport(f: FileMetrics): boolean {
  return f.entryReason !== null && SUPPORT.has(f.entryReason);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Where the planets come from. Most repos keep the bulk of their code in one
 * folder (packages/, src/, src/mylib/), and "one planet called src" says
 * nothing, so we follow the folder holding the majority of the code down until
 * no single folder dominates. Returns that path, from the repo root down.
 */
function findModuleChain(files: FileMetrics[]): string[] {
  const chain = [''];
  for (;;) {
    const root = chain[chain.length - 1];
    const prefix = root ? root + '/' : '';
    const inside = files.filter((f) => f.path.startsWith(prefix));
    const total = inside.reduce((s, f) => s + f.loc, 0);
    const childLoc = new Map<string, number>();
    for (const f of inside) {
      const rest = f.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash !== -1) childLoc.set(rest.slice(0, slash), (childLoc.get(rest.slice(0, slash)) ?? 0) + f.loc);
    }
    const [top] = [...childLoc].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]));
    if (!top || top[1] <= total * 0.5) return chain;
    const next = prefix + top[0];
    // A folder with fewer than 3 files would make too few planets.
    if (inside.filter((f) => f.path.startsWith(next + '/')).length < 3) return chain;
    chain.push(next);
  }
}

/**
 * Planets are the parts of the main code folder: each sub-folder, and each loose
 * file (in Python, a file *is* a module). Code outside the main folder becomes a
 * planet at the level where it branches off; loose files there are grouped.
 */
function moduleOf(path: string, chain: string[]): string {
  for (let i = chain.length - 1; i >= 0; i--) {
    const prefix = chain[i] ? chain[i] + '/' : '';
    if (prefix && !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) return prefix + rest.slice(0, slash);
    if (i === chain.length - 1) return path;
    return chain[i] ? chain[i] + '/*' : '(root)';
  }
  return '(root)';
}

/** Files named by package.json main/module/bin/exports — entry points by definition. */
function packageEntryFiles(configs: Map<string, string>, resolver: Resolver): Set<string> {
  const out = new Set<string>();
  for (const [path, text] of configs) {
    if (basename(path) !== 'package.json') continue;
    const json = parseJsonc(text);
    if (!json) continue;
    const dir = dirname(path);
    const targets: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === 'string') targets.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(json.main);
    collect(json.module);
    collect(json.source);
    collect(json.bin);
    collect(json.exports);
    for (const t of targets) {
      const from = joinPath(dir, '__pkg__.js');
      for (const spec of [t, t.replace(/^(\.\/)?(dist|build|lib|out)\//, './src/')]) {
        const rel = spec.startsWith('.') ? spec : './' + spec;
        const hit = resolver.resolve(from, { kind: 'js', spec: rel });
        if (hit) out.add(hit);
      }
    }
  }
  return out;
}

/** Files that are allowed to have no importers. Anything else with fan-in 0 is dead. */
function entryReason(f: SourceFile, packageEntries: Set<string>): string | null {
  const p = f.path;
  const base = basename(p).toLowerCase();
  if (packageEntries.has(p)) return 'package or page entry';
  if (/\.d\.[cm]?ts$/.test(base)) return 'type declarations';
  if (
    /(^|\/)(__\w*tests?\w*__|__mocks__|tests?|spec|specs|e2e|cypress|fixtures?|__fixtures__|testing)\//.test(p) ||
    /\.(test|spec|stories|story|bench|e2e)\.[^.]+$/.test(base) ||
    /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py'
  ) return 'test';
  if (/\.config\.[cm]?[jt]s$/.test(base) || base.startsWith('.') || /^(gruntfile|gulpfile|jakefile)\./.test(base) || base === 'setup.py' || base === 'noxfile.py' || base === 'manage.py')
    return 'config';
  if (/(^|\/)(scripts?|bin|tools|examples?|demos?|docs?|benchmarks?|fixtures|playgrounds?|sandbox)\//.test(p)) return 'script or example';
  if (/^(index|main|cli|server|app|__main__|__init__|wsgi|asgi|mod)\.[^.]+$/.test(base)) return 'entry point';
  if (/(^|\/)pages\//.test(p) || /^(page|layout|route|loading|error|not-found|template|middleware|default)\.[jt]sx?$/.test(base))
    return 'framework route';
  if (f.content.startsWith('#!')) return 'script';
  if (base.endsWith('.py') && /__name__\s*==\s*['"]__main__['"]/.test(f.content)) return 'script';
  return null;
}
