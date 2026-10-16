import type { RawImport } from './parse.js';
import { dirname, joinPath, parseJsonc } from './util.js';

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts'];

interface PathConfig {
  dir: string;
  baseUrl: string | null;
  paths: [string, string[]][];
}

/**
 * Turns import specifiers into repo file paths. Anything that doesn't land on a
 * file in the repo (npm packages, stdlib) resolves to null.
 */
export class Resolver {
  private files: Set<string>;
  private pathConfigs: PathConfig[] = [];
  private packages = new Map<string, { dir: string; entry: string | null }>();
  /** Python: "a/b/c" suffix → files that end with it (c.py or c/__init__.py). */
  private pySuffix = new Map<string, string[]>();

  constructor(codePaths: string[], configs: Map<string, string>) {
    this.files = new Set(codePaths);

    for (const [path, text] of configs) {
      const base = path.slice(path.lastIndexOf('/') + 1);
      const json = parseJsonc(text);
      if (!json) continue;
      const dir = dirname(path);
      if (base === 'package.json' && typeof json.name === 'string') {
        const entry = [json.source, json.module, json.main, typeof json.exports === 'string' ? json.exports : json.exports?.['.']]
          .find((e) => typeof e === 'string') ?? null;
        if (!this.packages.has(json.name)) this.packages.set(json.name, { dir, entry });
      } else if (base === 'tsconfig.json' || base === 'jsconfig.json') {
        const co = this.compilerOptions(path, configs, 0);
        if (!co) continue;
        this.pathConfigs.push({
          dir,
          baseUrl: typeof co.baseUrl === 'string' ? joinPath(co.dir, co.baseUrl) : null,
          paths: Object.entries(co.paths ?? {}).filter((e): e is [string, string[]] => Array.isArray(e[1])),
        });
      }
    }
    // Deepest config wins.
    this.pathConfigs.sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1));

    for (const p of codePaths) {
      if (!p.endsWith('.py')) continue;
      let parts = p.slice(0, -3).split('/');
      if (parts[parts.length - 1] === '__init__') parts = parts.slice(0, -1);
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('/');
        const list = this.pySuffix.get(key) ?? [];
        list.push(p);
        this.pySuffix.set(key, list);
      }
    }
  }

  /** compilerOptions with `extends` followed (local files only) and paths relative to the right dir. */
  private compilerOptions(path: string, configs: Map<string, string>, depth: number): any {
    const json = parseJsonc(configs.get(path) ?? '');
    if (!json) return null;
    const dir = dirname(path);
    let inherited: any = {};
    if (typeof json.extends === 'string' && json.extends.startsWith('.') && depth < 5) {
      let parent = joinPath(dir, json.extends);
      if (!parent.endsWith('.json')) parent += '.json';
      inherited = this.compilerOptions(parent, configs, depth + 1) ?? {};
    }
    const own = json.compilerOptions ?? {};
    const merged = { ...inherited, ...own };
    // baseUrl/paths are relative to the config that declares them.
    merged.dir = own.baseUrl !== undefined || own.paths !== undefined ? dir : inherited.dir ?? dir;
    return merged;
  }

  resolve(from: string, imp: RawImport): string | null {
    return imp.kind === 'js' ? this.resolveJs(from, imp.spec) : this.resolvePy(from, imp);
  }

  private resolveJs(from: string, spec: string): string | null {
    spec = spec.split('?')[0];
    if (spec.startsWith('.')) return this.jsFile(joinPath(dirname(from), spec));
    if (spec.startsWith('/')) return this.jsFile(joinPath(spec));

    const cfg = this.pathConfigs.find((c) => c.dir === '' || from.startsWith(c.dir + '/'));
    if (cfg) {
      for (const [pattern, targets] of cfg.paths) {
        const star = pattern.indexOf('*');
        const prefix = star === -1 ? pattern : pattern.slice(0, star);
        const suffix = star === -1 ? '' : pattern.slice(star + 1);
        const match = star === -1 ? spec === pattern : spec.startsWith(prefix) && spec.endsWith(suffix);
        if (!match) continue;
        const captured = star === -1 ? '' : spec.slice(prefix.length, spec.length - suffix.length);
        for (const t of targets) {
          const hit = this.jsFile(joinPath(cfg.baseUrl ?? cfg.dir, t.replace('*', captured)));
          if (hit) return hit;
        }
      }
      if (cfg.baseUrl !== null) {
        const hit = this.jsFile(joinPath(cfg.baseUrl, spec));
        if (hit) return hit;
      }
    }

    // Workspace packages: "shared/utils" or "@scope/pkg/sub" living in this repo.
    const parts = spec.split('/');
    const nameLen = spec.startsWith('@') ? 2 : 1;
    const pkg = this.packages.get(parts.slice(0, nameLen).join('/'));
    if (pkg) {
      const sub = parts.slice(nameLen).join('/');
      if (sub) return this.jsFile(joinPath(pkg.dir, sub)) ?? this.jsFile(joinPath(pkg.dir, 'src', sub));
      for (const cand of [pkg.entry, 'src/index', 'index']) {
        if (!cand) continue;
        const hit = this.jsFile(joinPath(pkg.dir, cand)) ?? this.jsFile(joinPath(pkg.dir, cand.replace(/^(\.\/)?(dist|build|lib)\//, 'src/')));
        if (hit) return hit;
      }
    }
    return null;
  }

  private jsFile(base: string): string | null {
    if (this.files.has(base)) return base;
    // TS ESM style: "./foo.js" written for "./foo.ts".
    const stripped = base.replace(/\.(m|c)?jsx?$/, '');
    for (const b of stripped === base ? [base] : [stripped, base]) {
      for (const ext of JS_EXTS) if (this.files.has(b + ext)) return b + ext;
      for (const ext of JS_EXTS) if (this.files.has(b + '/index' + ext)) return b + '/index' + ext;
    }
    return null;
  }

  private resolvePy(from: string, imp: { module: string; level: number; names: string[] }): string | null {
    const modPath = imp.module.replace(/\./g, '/');
    if (imp.level > 0) {
      let dir = dirname(from);
      for (let i = 1; i < imp.level; i++) dir = dirname(dir);
      const base = joinPath(dir, modPath);
      // `from . import x` usually means the submodule x.
      for (const n of imp.names) {
        const hit = this.pyFile(joinPath(base, n));
        if (hit) return hit;
      }
      return this.pyFile(base);
    }
    for (const n of imp.names) {
      const hit = this.pyAbsolute(`${modPath}/${n}`, from);
      if (hit) return hit;
    }
    return this.pyAbsolute(modPath, from);
  }

  private pyFile(base: string): string | null {
    if (this.files.has(base + '.py')) return base + '.py';
    if (this.files.has(base + '/__init__.py')) return base + '/__init__.py';
    return null;
  }

  /** Absolute import: any file whose path ends with the module path. Closest to the importer wins. */
  private pyAbsolute(modPath: string, from: string): string | null {
    const hits = this.pySuffix.get(modPath);
    if (!hits) return null;
    const exact = hits.filter((h) => {
      const bare = h.replace(/(\/__init__)?\.py$/, '');
      return bare === modPath || bare.endsWith('/' + modPath);
    });
    if (exact.length === 0) return null;
    let best = exact[0];
    let bestScore = -1;
    for (const h of exact) {
      let common = 0;
      while (common < h.length && h[common] === from[common]) common++;
      if (common > bestScore || (common === bestScore && h.length < best.length)) {
        best = h;
        bestScore = common;
      }
    }
    return best;
  }
}
