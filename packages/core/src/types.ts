/** A file handed to the analyzer. `path` is POSIX-style, relative to the repo root. */
export interface SourceFile {
  path: string;
  content: string;
}

export type Language = 'JavaScript' | 'TypeScript' | 'Python';

export interface FileMetrics {
  path: string;
  module: string;
  language: Language;
  /** Non-blank lines. */
  loc: number;
  /** Functions (plus one unit for top-level code that has branches). */
  units: number;
  /** Sum of cyclomatic complexity over all units. */
  complexity: number;
  /** Deepest control-flow nesting inside any single function. */
  maxNesting: number;
  /** Repo files this file imports (resolved paths). */
  imports: string[];
  /** Import statements that point outside the repo (packages, stdlib). */
  externalImports: number;
  /** Number of distinct repo files that import this file. */
  fanIn: number;
  /** Why this file is allowed to have no importers, or null. */
  entryReason: string | null;
  /** Nothing imports it and it is not an entry point. */
  dead: boolean;
}

export interface ModuleMetrics {
  name: string;
  files: string[];
  loc: number;
  /** Dominant language by lines of code. */
  language: Language;
  /** Average cyclomatic complexity per function. */
  avgComplexity: number;
  /** LOC-weighted average of each file's deepest nesting. */
  avgNesting: number;
  /** Import links from files in other modules into this one. */
  fanIn: number;
  /** Hops from the core module in the import graph; null = not connected. */
  distance: number | null;
}

export interface ModuleEdge {
  from: string;
  to: string;
  /** Distinct file→file import links between the two modules. */
  count: number;
}

export interface Galaxy {
  name: string;
  /** The module with the highest fan-in. */
  core: string;
  /** Directory the planets were taken from ('' = repo root). */
  moduleRoot: string;
  modules: ModuleMetrics[];
  files: FileMetrics[];
  edges: ModuleEdge[];
  stats: {
    files: number;
    loc: number;
    modules: number;
    deadFiles: number;
    deadLoc: number;
    languages: Partial<Record<Language, number>>;
  };
}
