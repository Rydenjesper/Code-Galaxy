import { Parser, Language as TSLanguage, type Node, type Tree } from 'web-tree-sitter';
import type { Language } from './types.js';

export type Grammar = 'javascript' | 'typescript' | 'tsx' | 'python';
export const GRAMMARS: Grammar[] = ['javascript', 'typescript', 'tsx', 'python'];

export interface InitOptions {
  /** Returns the bytes of `tree-sitter-<grammar>.wasm` (shipped in @code-galaxy/core/grammars). */
  loadGrammar: (grammar: Grammar) => Promise<Uint8Array>;
  /** Passed to web-tree-sitter's Parser.init, e.g. `{ locateFile }` in the browser. */
  treeSitter?: Record<string, unknown>;
}

export type RawImport =
  | { kind: 'js'; spec: string }
  | { kind: 'py'; module: string; level: number; names: string[] };

export interface ParsedFile {
  imports: RawImport[];
  units: number;
  complexity: number;
  maxNesting: number;
}

export function grammarFor(path: string): Grammar | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'tsx') return 'tsx';
  if (ext === 'py') return 'python';
  return null;
}

export function languageOf(grammar: Grammar): Language {
  if (grammar === 'python') return 'Python';
  if (grammar === 'javascript') return 'JavaScript';
  return 'TypeScript';
}

interface Rules {
  functions: Set<string>;
  decisions: Set<string>;
  nesting: Set<string>;
  /** Node type whose `operator` (&&, ||, ??, and, or) counts as a decision. */
  logical: string;
}

const JS: Rules = {
  functions: new Set([
    'function_declaration', 'function_expression', 'function', 'arrow_function',
    'method_definition', 'generator_function_declaration', 'generator_function',
  ]),
  decisions: new Set([
    'if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
    'switch_case', 'catch_clause', 'ternary_expression',
  ]),
  nesting: new Set([
    'if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
    'switch_statement', 'try_statement',
  ]),
  logical: 'binary_expression',
};

const PY: Rules = {
  functions: new Set(['function_definition', 'lambda']),
  decisions: new Set([
    'if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause',
    'conditional_expression', 'for_in_clause', 'if_clause', 'case_clause',
  ]),
  nesting: new Set([
    'if_statement', 'for_statement', 'while_statement', 'try_statement', 'with_statement',
    'match_statement',
  ]),
  logical: 'boolean_operator',
};

const LOGICAL_OPS = new Set(['&&', '||', '??', 'and', 'or']);

export class CodeParser {
  private constructor(private parsers: Map<Grammar, Parser>) {}

  static async create(opts: InitOptions): Promise<CodeParser> {
    await Parser.init(opts.treeSitter);
    const parsers = new Map<Grammar, Parser>();
    for (const g of GRAMMARS) {
      const lang = await TSLanguage.load(await opts.loadGrammar(g));
      const p = new Parser();
      p.setLanguage(lang);
      parsers.set(g, p);
    }
    return new CodeParser(parsers);
  }

  parse(grammar: Grammar, content: string): ParsedFile {
    const tree = this.parsers.get(grammar)!.parse(content);
    if (!tree) return { imports: [], units: 0, complexity: 0, maxNesting: 0 };
    try {
      return grammar === 'python' ? scan(tree, PY, pyImport) : scan(tree, JS, jsImport);
    } finally {
      tree.delete();
    }
  }
}

/** One pass over the tree: imports, cyclomatic complexity per function, nesting depth. */
function scan(tree: Tree, rules: Rules, importOf: (type: string, node: () => Node, out: RawImport[]) => void): ParsedFile {
  const imports: RawImport[] = [];
  // Each frame is a function (index 0 = top-level code): [decisions, nesting depth].
  const frames: [number, number][] = [[0, 0]];
  const types: string[] = [];
  let units = 0;
  let complexity = 0;
  let maxNesting = 0;

  const c = tree.walk();
  const enter = () => {
    // Anonymous nodes are keywords and punctuation (`function`, `if`): skip them.
    const type = c.nodeIsNamed ? c.nodeType : '';
    const parent = types[types.length - 1];
    types.push(type);
    if (!type) return;
    importOf(type, () => c.currentNode, imports);
    if (rules.functions.has(type)) {
      frames.push([0, 0]);
      return;
    }
    const f = frames[frames.length - 1];
    if (rules.decisions.has(type)) f[0]++;
    else if (type === rules.logical) {
      const op = c.currentNode.childForFieldName('operator')?.type;
      if (op && LOGICAL_OPS.has(op)) f[0]++;
    }
    // `else if` reads as a flat chain, not one level deeper.
    if (rules.nesting.has(type) && parent !== 'else_clause') {
      f[1]++;
      if (f[1] > maxNesting) maxNesting = f[1];
    }
  };
  const exit = () => {
    const type = types.pop()!;
    if (rules.functions.has(type)) {
      const [d] = frames.pop()!;
      units++;
      complexity += 1 + d;
    } else if (rules.nesting.has(type) && types[types.length - 1] !== 'else_clause') {
      frames[frames.length - 1][1]--;
    }
  };

  for (;;) {
    enter();
    if (c.gotoFirstChild()) continue;
    exit();
    let done = false;
    while (!c.gotoNextSibling()) {
      if (!c.gotoParent()) { done = true; break; }
      exit();
    }
    if (done) break;
  }
  c.delete();

  const top = frames[0][0];
  if (top > 0) {
    units++;
    complexity += 1 + top;
  }
  return { imports, units, complexity, maxNesting };
}

function stringValue(node: Node | null | undefined): string | null {
  if (!node || node.type !== 'string') return null;
  return node.text.slice(1, -1);
}

function jsImport(type: string, node: () => Node, out: RawImport[]) {
  if (type === 'import_statement' || type === 'export_statement' || type === 'import_require_clause') {
    const spec = stringValue(node().childForFieldName('source'));
    if (spec) out.push({ kind: 'js', spec });
  } else if (type === 'call_expression') {
    const n = node();
    const fn = n.childForFieldName('function');
    if (!fn || !(fn.type === 'import' || (fn.type === 'identifier' && fn.text === 'require'))) return;
    const spec = stringValue(n.childForFieldName('arguments')?.namedChildren[0]);
    if (spec) out.push({ kind: 'js', spec });
  }
}

function pyImport(type: string, node: () => Node, out: RawImport[]) {
  if (type === 'import_statement') {
    for (const name of node().childrenForFieldName('name')) {
      const dotted = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
      if (dotted) out.push({ kind: 'py', module: dotted.text, level: 0, names: [] });
    }
  } else if (type === 'import_from_statement') {
    const n = node();
    const mod = n.childForFieldName('module_name');
    if (!mod) return;
    let level = 0;
    let module = mod.text;
    if (mod.type === 'relative_import') {
      const prefix = mod.namedChildren.find((ch) => ch?.type === 'import_prefix');
      level = prefix ? prefix.text.length : 0;
      module = mod.namedChildren.find((ch) => ch?.type === 'dotted_name')?.text ?? '';
    }
    const names = n.childrenForFieldName('name').map((nm) =>
      (nm.type === 'aliased_import' ? nm.childForFieldName('name')?.text : nm.text) ?? '',
    );
    out.push({ kind: 'py', module, level, names: names.filter(Boolean) });
  }
}
