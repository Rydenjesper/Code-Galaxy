import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { analyze, isWanted, renderSvg } from '@code-galaxy/core';

const grammars = new URL('../packages/core/grammars/', import.meta.url);
const loadGrammar = async (g) => readFileSync(new URL(`tree-sitter-${g}.wasm`, grammars));

function load(dir) {
  const root = new URL(`fixtures/${dir}/`, import.meta.url).pathname;
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const path = relative(root, full).split(sep).join('/');
        if (isWanted(path)) out.push({ path, content: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}

const run = (files, name = 'mini') => analyze(files, { name, loadGrammar });

test('resolves relative, tsconfig-alias and .js-for-.ts imports', async () => {
  const g = await run(load('mini'));
  const f = g.files.find((x) => x.path === 'src/app/run.ts');
  assert.deepEqual(f.imports, ['src/ui/draw.tsx', 'src/utils/log.ts', 'src/utils/math.ts']);
  assert.equal(f.complexity, 1 + 3); // run(): for, if, &&
});

test('fan-in, dead code and entry points', async () => {
  const g = await run(load('mini'));
  const byPath = Object.fromEntries(g.files.map((f) => [f.path, f]));
  assert.equal(byPath['src/utils/log.ts'].fanIn, 2);
  assert.equal(byPath['src/ui/orphan.ts'].dead, true);
  assert.equal(byPath['src/index.ts'].dead, false);
  assert.equal(byPath['tests/run.test.ts'].entryReason, 'test');
  assert.equal(g.stats.deadFiles, 1);
});

test('modules come from the main code folder; tests do not pick the core', async () => {
  const g = await run(load('mini'));
  assert.equal(g.moduleRoot, 'src');
  assert.deepEqual(g.modules.map((m) => m.name), ['src/app', 'src/index.ts', 'src/ui', 'src/utils', 'tests']);
  assert.equal(g.core, 'src/utils');
  const tests = g.modules.find((m) => m.name === 'tests');
  assert.equal(tests.distance, null);
});

test('python: relative, absolute and submodule imports', async () => {
  const g = await run(load('py'), 'py');
  const byPath = Object.fromEntries(g.files.map((f) => [f.path, f]));
  assert.deepEqual(byPath['pkg/core.py'].imports, ['pkg/sub/helpers.py']);
  assert.deepEqual(byPath['pkg/api.py'].imports, ['pkg/core.py', 'pkg/sub/helpers.py']);
  assert.equal(byPath['pkg/sub/helpers.py'].externalImports, 1);
  assert.equal(byPath['pkg/unused.py'].dead, true);
  // f(): 1 + if + and + for + while
  assert.equal(byPath['pkg/core.py'].complexity, 5);
  assert.equal(byPath['pkg/core.py'].maxNesting, 3);
});

test('deterministic: same code, same picture, regardless of input order', async () => {
  const files = load('mini');
  const a = renderSvg(await run(files));
  const b = renderSvg(await run([...files].reverse()));
  assert.equal(a, b);
  assert.match(a, /^<svg/);
});
