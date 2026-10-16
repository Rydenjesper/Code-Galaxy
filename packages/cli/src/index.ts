#!/usr/bin/env node
import { analyze, isWanted, renderSvg, type SourceFile } from '@code-galaxy/core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'site-packages', 'third_party', 'bower_components',
]);
const MAX_FILE_BYTES = 1_000_000;

const HELP = `code-galaxy — point it at your code, get a galaxy back.

Usage:
  code-galaxy [path | github.com/owner/repo] [options]

Options:
  --png          also write galaxy.png (1200x1200)
  --still        don't animate the SVG
  --name <n>     name in the legend (default: folder or owner/repo)
  --json         write galaxy.json with every metric (no image)
  -o, --out <f>  output file for the SVG (default: galaxy.svg)
  -h, --help     show this help
`;

async function main() {
  const args = process.argv.slice(2);
  let target = '.';
  let png = false;
  let json = false;
  let still = false;
  let nameArg: string | null = null;
  let out = 'galaxy.svg';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') return void process.stdout.write(HELP);
    else if (a === '--png') png = true;
    else if (a === '--json') json = true;
    else if (a === '--still') still = true;
    else if (a === '--name') nameArg = args[++i];
    else if (a === '-o' || a === '--out') out = args[++i];
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else target = a;
  }

  const gh = target.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  let dir = resolve(target);
  let name = basename(dir);
  let cleanup: string | null = null;
  if (gh) {
    name = `${gh[1]}/${gh[2]}`;
    cleanup = mkdtempSync(join(tmpdir(), 'code-galaxy-'));
    dir = join(cleanup, 'repo');
    log(`Cloning ${name} (shallow)…`);
    execFileSync('git', ['clone', '--depth', '1', '--quiet', `https://github.com/${name}.git`, dir], { stdio: 'inherit' });
  } else if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Not a folder or GitHub URL: ${target}`);
  }

  if (nameArg) name = nameArg;
  try {
    const paths = listFiles(dir).filter(isWanted);
    const files: SourceFile[] = [];
    for (const p of paths) {
      const abs = join(dir, p);
      try {
        if (statSync(abs).size > MAX_FILE_BYTES) continue;
        files.push({ path: p, content: readFileSync(abs, 'utf8') });
      } catch { /* broken symlink etc. */ }
    }
    log(`Analyzing ${files.length} files…`);

    const grammarDir = fileURLToPath(new URL('../grammars/', import.meta.resolve('@code-galaxy/core')));
    const galaxy = await analyze(files, {
      name,
      loadGrammar: async (g) => readFileSync(join(grammarDir, `tree-sitter-${g}.wasm`)),
    });

    if (json) {
      const file = out === 'galaxy.svg' ? 'galaxy.json' : out;
      writeFileSync(file, JSON.stringify(galaxy, null, 2));
      log(`Wrote ${file}`);
    } else {
      const svg = renderSvg(galaxy, { animate: !still });
      writeFileSync(out, svg);
      log(`Wrote ${out}`);
      if (png) {
        const { Resvg } = await import('@resvg/resvg-js');
        const pngFile = out.replace(/\.svg$/, '') + '.png';
        const img = new Resvg(renderSvg(galaxy, { animate: false }), { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render().asPng();
        writeFileSync(pngFile, img);
        log(`Wrote ${pngFile}`);
      }
    }
    const s = galaxy.stats;
    log(`${s.modules} planets · ${s.files} files · ${s.loc} lines · core: ${galaxy.core} · ${s.deadFiles} unused files`);
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

/** Repo files, respecting .gitignore. Uses git when available, else walks the tree. */
function listFiles(dir: string): string[] {
  try {
    const outp = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Paths come back relative to `dir`, even when it's a subfolder of the repo.
    return outp.split('\0').filter(Boolean).filter((p) => !p.split('/').some((seg) => SKIP_DIRS.has(seg)) && existsSync(join(dir, p)));
  } catch { /* not a git repo */ }

  const result: string[] = [];
  const walk = (abs: string, ig: ReturnType<typeof ignore>) => {
    let local = ig;
    const gi = join(abs, '.gitignore');
    if (existsSync(gi)) {
      const prefix = relative(dir, abs).split(sep).join('/');
      const rules = readFileSync(gi, 'utf8').split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const neg = l.startsWith('!');
          const body = neg ? l.slice(1) : l;
          const anchored = body.startsWith('/') || body.slice(0, -1).includes('/');
          const scoped = prefix ? `${prefix}/${anchored ? body.replace(/^\//, '') : '**/' + body}` : body;
          return (neg ? '!' : '') + scoped;
        });
      local = ignore().add(ig).add(rules);
    }
    for (const ent of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(abs, ent.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || local.ignores(rel + '/')) continue;
        walk(full, local);
      } else if (ent.isFile() && !local.ignores(rel)) {
        result.push(rel);
      }
    }
  };
  walk(dir, ignore());
  return result;
}

function log(msg: string) {
  process.stderr.write(msg + '\n');
}

main().catch((err) => {
  log(`code-galaxy: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
