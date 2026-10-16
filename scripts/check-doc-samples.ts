/**
 * leaven-monorepo - documentation sample type checker
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/**
 * Type-checks the TypeScript samples embedded in the documentation.
 *
 * Every docs sample in this repo lives either in a markdown fence or in a
 * TypeScript template literal on an Angular component, so neither `tsc` nor
 * `ng build` ever looks inside one. That is the structural reason the same
 * snippet drifted from the implementation twice in one day. This script
 * extracts them, writes them to a scratch directory as real files, and runs
 * `tsc --noEmit` over the result with the workspace `paths` mapping in place,
 * so `@leaven-graphql/*` resolves to the real source and a documented symbol
 * that does not exist is a compile error.
 *
 * ## Samples are not all the same kind of thing
 *
 * Checking them uniformly is category-wrong: an API-reference block listing
 * `subscribe(request: GraphQLRequest): Subscription;` is signature
 * documentation, not an implementation, and compiling it as one yields nothing
 * but noise. Each sample is therefore classified:
 *
 * - **runnable** — carries its own `import` statements. Compiled as a `.ts`
 *   module under `strict`. This is where the value is: a renamed method, a
 *   removed option or a changed signature fails the build.
 * - **declaration** — a signature-only `interface` / `type` / `class` /
 *   function listing with no bodies. Compiled as a `.d.ts`, the dialect it is
 *   already written in, where a member without an implementation is legal,
 *   with an `import type` preamble generated for the names it references. A
 *   referenced type that nothing exports still fails.
 * - **fragment** — neither: a continuation of an earlier sample, or an excerpt
 *   leaning on names defined outside it. Skipped, counted and listed.
 *
 * Names a sample was never meant to define (`schema`, a domain `User`) come
 * from `scripts/doc-samples/preamble.d.ts`, a finite, readable list. Nothing
 * from `@leaven-graphql/*` is ever declared there — see
 * `assertPreambleDoesNotShadowLeaven()`, which fails the run if a placeholder
 * ever collides with a real export and starts masking drift. Modules a sample
 * imports that this repo does not depend on are stubbed as `any`, and every
 * stubbed specifier is printed.
 *
 * A sample can also opt out explicitly with a `doc-check: skip <reason>` marker
 * (an HTML comment before a markdown fence, a line comment before a docs-page
 * property). Every skip is printed with its reason, so the check cannot pass
 * vacuously without that being visible.
 *
 * Usage: `pnpm check:docs` (or `bun run scripts/check-doc-samples.ts`).
 * Pass `--keep` to leave the generated scratch directory in place.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRATCH_DIR = join(REPO_ROOT, 'node_modules', '.doc-samples');
const PREAMBLE_SRC = join(REPO_ROOT, 'scripts', 'doc-samples', 'preamble.d.ts');
const KEEP = process.argv.includes('--keep');

/** Workspace `paths` entries, read from the real tsconfig so they cannot drift. */
const WORKSPACE_PATHS: Record<string, string[]> = (() => {
  const raw = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8');
  const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!paths || Object.keys(paths).length === 0) {
    throw new Error('No compilerOptions.paths found in tsconfig.json');
  }
  return paths;
})();

const SKIP_MARKER = /doc-check:\s*skip\b[ \t-]*(.*?)(?:\s*-->)?$/;

type Kind = 'runnable' | 'declaration';

interface Sample {
  /** Stable identifier, also the generated file name. */
  id: string;
  /** Where it came from, for the report. */
  origin: string;
  code: string;
  kind: Kind;
  /**
   * Lines of preceding-sample context prepended to `code` (see
   * {@link record}). Subtracted from tsc line numbers so diagnostics point at
   * the line the reader actually sees in the document.
   */
  offset: number;
}

interface Skipped {
  origin: string;
  reason: string;
}

const extracted: Sample[] = [];
const skipped: Skipped[] = [];

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const HAS_IMPORT = /^\s*import\s[\s\S]*?from\s*['"][^'"]+['"]|^\s*import\s*['"][^'"]+['"]/m;

/**
 * A signature-only listing: declarations all the way down, no statements and no
 * bodies. This is what an "API Reference" section is made of, and `.d.ts` is
 * exactly the dialect such a listing is already written in.
 */
function isDeclarationListing(code: string): boolean {
  const lines = code
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('/*'));
  if (lines.length === 0) return false;

  const startsWithDeclaration =
    /^(export\s+)?(declare\s+)?(abstract\s+)?(interface|class|type|function|enum|namespace)\s/.test(
      lines[0] ?? ''
    );
  if (!startsWithDeclaration) return false;

  // An initializer, a statement or a function body means it is real code.
  return !lines.some((line) =>
    /^(const|let|var)\s+\w+\s*=|^return\b|^await\b|console\.|^if\s*\(|^for\s*\(|=>\s*\{/.test(line)
  );
}

function classify(code: string): Kind | 'fragment' {
  if (HAS_IMPORT.test(code)) return 'runnable';
  if (isDeclarationListing(code)) return 'declaration';
  return 'fragment';
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Per-document running context: the code of every runnable sample seen so far
 * in the current file, which a later fragment is written to continue.
 */
const preludes = new Map<string, string[]>();

interface SplitSample {
  /** Whole `import ... from '...'` statements, each on one line. */
  imports: string[];
  /** Everything else, with the import statements blanked out in place so
   *  line numbers within the block are preserved. */
  body: string;
}

const IMPORT_STATEMENT =
  /^[ \t]*import\b(?:[\s\S]*?\bfrom[ \t]*)?['"][^'"]+['"][ \t]*;?/gm;

/** Separate a sample's import statements from the rest of its code. */
function splitImports(code: string): SplitSample {
  const imports: string[] = [];
  const body = code.replace(IMPORT_STATEMENT, (statement) => {
    imports.push(statement.trim().replace(/;?$/, ';'));
    // Preserve the line count so offsets stay meaningful.
    return statement.replace(/[^\n]/g, '');
  });
  return { imports, body };
}

/** The local name an import clause binds: `type Foo as Bar` -> `Bar`. */
function clauseName(clause: string): string | undefined {
  const parts = clause.replace(/\btype\b/g, '').trim().split(/\s+as\s+/);
  const name = (parts[parts.length - 1] ?? '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/**
 * Accumulates the import statements of several stitched blocks into one set of
 * non-conflicting statements, deduplicating by bound local name and grouping
 * named clauses by module specifier. Blocks are added nearest-first, so the
 * binding closest to the fragment wins any conflict.
 */
class ImportMerger {
  /** specifier -> local name -> original clause text. */
  private readonly named = new Map<string, Map<string, string>>();
  /** Whole statements for default / namespace / side-effect imports. */
  private readonly other: Array<{ name?: string; statement: string }> = [];

  add(statement: string): void {
    const specifier = /['"]([^'"]+)['"]/.exec(statement)?.[1];
    if (!specifier) return;

    const braced = /\{([\s\S]*?)\}/.exec(statement)?.[1];
    if (braced !== undefined) {
      let clauses = this.named.get(specifier);
      if (!clauses) this.named.set(specifier, (clauses = new Map()));
      for (const clause of braced.split(',')) {
        const name = clauseName(clause);
        if (name && !clauses.has(name)) clauses.set(name, clause.trim());
      }
    }

    const bare = /^import\s+(?:type\s+)?(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(
      statement
    )?.[1];
    if (bare) this.other.push({ name: bare, statement: `import ${statement.slice(statement.indexOf(bare))}` });
    else if (braced === undefined) this.other.push({ statement });
  }

  /** Emit statements, skipping any binding whose name is already `taken`. */
  statements(taken: Set<string>): string[] {
    const lines: string[] = [];
    for (const { name, statement } of this.other) {
      if (name && taken.has(name)) continue;
      if (name) taken.add(name);
      lines.push(statement);
    }
    for (const [specifier, clauses] of this.named) {
      const usable: string[] = [];
      for (const [name, clause] of clauses) {
        if (taken.has(name)) continue;
        taken.add(name);
        usable.push(clause);
      }
      if (usable.length > 0) lines.push(`import { ${usable.join(', ')} } from '${specifier}';`);
    }
    return lines;
  }
}

/** Every name a block introduces into the shared scope: imported or declared. */
function declaredNames(block: SplitSample): Set<string> {
  const names = locallyDeclared(block.body);
  for (const statement of block.imports) {
    const braced = /\{([\s\S]*?)\}/.exec(statement)?.[1] ?? '';
    for (const clause of braced.split(',')) {
      // `type Foo as Bar` -> Bar; `Foo` -> Foo.
      const parts = clause.replace(/\btype\b/g, '').trim().split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
    // Default and namespace imports: `import X from`, `import * as X from`.
    const bare = /^import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(statement)?.[1];
    if (bare) names.add(bare);
  }
  return names;
}

function record(id: string, origin: string, code: string, marker: RegExpExecArray | null): void {
  if (marker) {
    skipped.push({ origin, reason: `marked: ${marker[1]?.trim() || 'no reason given'}` });
    return;
  }

  const document = id.slice(0, id.lastIndexOf('--'));
  const kind = classify(code);

  if (kind === 'runnable') {
    const prelude = preludes.get(document);
    if (prelude) prelude.push(code);
    else preludes.set(document, [code]);
    extracted.push({ id, origin, code, kind, offset: 0 });
    return;
  }

  if (kind === 'declaration') {
    extracted.push({ id, origin, code, kind, offset: 0 });
    return;
  }

  // A fragment continues the document's earlier examples — `executor` and
  // friends come from a setup block further up the page. Stitch the preceding
  // runnable samples on so the fragment can be typed at all; without this the
  // most common README shape (one setup block, many usage snippets) went
  // entirely unchecked.
  const prelude = preludes.get(document);
  if (!prelude || prelude.length === 0) {
    skipped.push({ origin, reason: 'fragment: no imports and no preceding example to continue' });
    return;
  }

  // Concatenation puts everything in one scope, so any name declared twice —
  // `const ctx` opening three consecutive snippets, or the same symbol
  // imported by two blocks — would be a spurious TS2451/TS2300 the reader
  // never wrote. Walk from the block nearest the fragment outwards, keeping a
  // block only while every name it introduces is still free. Nearest wins,
  // because that is the setup the fragment is actually continuing.
  // Seeded from the fragment's *body* only — its imports are handled by the
  // merger below, which would otherwise see them as already taken and drop
  // them.
  const fragment = splitImports(code);
  const taken = new Set<string>(locallyDeclared(fragment.body));

  // Imports and bodies are kept independently: a block whose *body* collides
  // may still be the only place a symbol the fragment calls was imported, so
  // dropping the whole block would turn a name collision into a bogus
  // "cannot find name".
  //
  // Imports are merged per specifier rather than kept as whole statements —
  // two blocks importing overlapping sets from `@nestjs/graphql` must not
  // cause the second statement to be discarded wholesale and take the names
  // only it introduced (`Mutation`) down with it.
  const merged = new ImportMerger();
  for (const statement of fragment.imports) merged.add(statement);

  const bodies: string[] = [];
  for (let i = prelude.length - 1; i >= 0; i--) {
    const block = splitImports(prelude[i] ?? '');
    for (const statement of block.imports) merged.add(statement);

    const bodyNames = locallyDeclared(block.body);
    if ([...bodyNames].some((name) => taken.has(name))) continue;
    for (const name of bodyNames) taken.add(name);
    bodies.unshift(block.body);
  }

  // Imports must lead the file, so they are hoisted out of the blocks they
  // came from.
  const context = [...merged.statements(taken), ...bodies].join('\n');
  extracted.push({
    id,
    origin,
    code: `${context}\n${fragment.body}`,
    kind: 'runnable',
    offset: context.split('\n').length,
  });
}

/** Pull fenced TypeScript blocks out of a markdown file. */
function extractMarkdown(file: string): void {
  const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
  let index = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^```(ts|typescript)\s*$/.test(lines[i] ?? '')) continue;

    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^```\s*$/.test(lines[j] ?? '')) break;
      body.push(lines[j] ?? '');
    }

    index += 1;

    // Look back past blank lines for a skip marker.
    let marker: RegExpExecArray | null = null;
    for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
      const line = (lines[k] ?? '').trim();
      if (line === '') continue;
      marker = SKIP_MARKER.exec(line);
      break;
    }

    record(`${slug(file)}--${index}`, `${file}:${i + 1}`, body.join('\n'), marker);
    i = j;
  }
}

/** Pull the `xxxCode = \`...\`` class properties out of a docs page component. */
function extractDocsPage(file: string): void {
  const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const open = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*=\s*`/.exec(lines[i] ?? '');
    if (!open) continue;

    const collected: string[] = [];
    let rest = (lines[i] ?? '').slice((lines[i] ?? '').indexOf('`') + 1);
    let j = i;
    for (;;) {
      const end = findUnescapedBacktick(rest);
      if (end !== -1) {
        collected.push(rest.slice(0, end));
        break;
      }
      collected.push(rest);
      j += 1;
      if (j >= lines.length) break;
      rest = lines[j] ?? '';
    }

    const marker = SKIP_MARKER.exec((lines[i - 1] ?? '').trim());
    record(
      `${slug(file)}--${open[1]}`,
      `${file}:${i + 1}`,
      unescapeTemplate(collected.join('\n')),
      marker
    );
    i = j;
  }
}

function findUnescapedBacktick(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`') continue;
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) backslashes += 1;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/** Reverse the escaping a template literal imposes on the source it carries. */
function unescapeTemplate(value: string): string {
  return value.replace(/\\`/g, '`').replace(/\\\$\{/g, '${').replace(/\\\\/g, '\\');
}

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

const workspaceSpecifiers = new Set(Object.keys(WORKSPACE_PATHS));

/**
 * Extra `paths` entries for packages installed in a workspace package's own
 * `node_modules` (`@nestjs/*` lives under `packages/nestjs/`). The scratch
 * directory sits at the repo root, so plain node resolution would never walk
 * into them and every such import would be stubbed as `any` — losing exactly
 * the checking that makes a NestJS sample worth compiling.
 */
const nestedPackagePaths: Record<string, string[]> = {};

function packageNameOf(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
}

function isResolvable(specifier: string): boolean {
  if (specifier.startsWith('.')) return false;
  if (workspaceSpecifiers.has(specifier)) return true;
  const pkg = packageNameOf(specifier);
  if (existsSync(join(REPO_ROOT, 'node_modules', pkg))) return true;
  if (nestedPackagePaths[pkg]) return true;
  // `readdirSync`, not `Glob`: with pnpm these are symlinks into the store and
  // Bun's glob does not walk through them.
  for (const workspace of readdirSync(join(REPO_ROOT, 'packages'))) {
    const location = join(REPO_ROOT, 'packages', workspace, 'node_modules', pkg);
    if (!existsSync(join(location, 'package.json'))) continue;
    nestedPackagePaths[pkg] = [location];
    nestedPackagePaths[`${pkg}/*`] = [join(location, '*')];
    return true;
  }
  return false;
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
/** `import <clause> from '<specifier>'`, capturing the clause so a stub can name its exports. */
const IMPORT_CLAUSE = /(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;

function specifiersOf(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(IMPORT_SPECIFIER)) if (match[1]) found.push(match[1]);
  for (const match of code.matchAll(BARE_IMPORT)) if (match[1]) found.push(match[1]);
  return found;
}

// ---------------------------------------------------------------------------
// Symbol index: which module exports a given name
// ---------------------------------------------------------------------------

function exportedNames(file: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(file) || !existsSync(file)) return names;
  seen.add(file);
  const source = readFileSync(file, 'utf8');

  for (const match of source.matchAll(
    /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:default\s+)?(?:const|let|var|function|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    if (match[1]) names.add(match[1]);
  }

  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const clause of (match[1] ?? '').split(',')) {
      const parts = clause.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  for (const match of source.matchAll(/export\s*\*\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1] ?? '');
    for (const candidate of [`${target}.ts`, join(target, 'index.ts')]) {
      for (const name of exportedNames(candidate, seen)) names.add(name);
    }
  }

  return names;
}

/**
 * name -> every module specifier exporting it, for generating a declaration
 * listing's imports.
 *
 * Several packages export the same name with genuinely different signatures —
 * `@leaven-graphql/schema` and `@leaven-graphql/core` both export `ResolverFn`,
 * `@leaven-graphql/http`, `/context` and `/nestjs` all export `ContextFactory`.
 * Resolving to a single arbitrary winner made every listing in the *other*
 * packages' READMEs fail against a signature they never claimed, so the choice
 * is deferred to {@link importsForListing}, which knows which README the
 * listing came from.
 */
const symbolIndex = new Map<string, string[]>();

function indexModule(specifier: string, entry: string): void {
  for (const name of exportedNames(entry)) {
    const specifiers = symbolIndex.get(name);
    if (specifiers) {
      if (!specifiers.includes(specifier)) specifiers.push(specifier);
    } else {
      symbolIndex.set(name, [specifier]);
    }
  }
}

for (const [specifier, targets] of Object.entries(WORKSPACE_PATHS)) {
  const target = targets[0];
  if (target) indexModule(specifier, join(REPO_ROOT, target, 'index.ts'));
}
// graphql-js types (`GraphQLSchema`, `DocumentNode`, ...) appear constantly in
// the API-reference listings.
const graphqlEntry = join(REPO_ROOT, 'node_modules', 'graphql', 'index.d.ts');
if (existsSync(graphqlEntry)) indexModule('graphql', graphqlEntry);

// Bun runtime types the transport packages expose in their public signatures.
// Indexed by name rather than by walking `bun-types`, whose entry re-exports
// thousands of DOM globals and would shadow real Leaven exports.
for (const name of ['Server', 'ServerWebSocket', 'WebSocketHandler', 'Subprocess', 'BunFile']) {
  const specifiers = symbolIndex.get(name);
  if (specifiers) specifiers.push('bun');
  else symbolIndex.set(name, ['bun']);
}

/** TypeScript built-ins and lib types a listing may reference without importing. */
const BUILTIN_TYPES = new Set([
  'Array', 'Awaited', 'Boolean', 'Date', 'Error', 'Exclude', 'Extract', 'Function', 'Map',
  'Number', 'Object', 'Omit', 'Partial', 'Pick', 'Promise', 'Readonly', 'Record', 'RegExp',
  'Request', 'Required', 'Response', 'Set', 'String', 'Symbol', 'WeakMap', 'AsyncIterator',
  'AsyncIterable', 'AsyncIterableIterator', 'Iterator', 'Iterable', 'IteratorResult', 'JSON',
  'Math', 'Uint8Array', 'ArrayBuffer', 'Headers', 'URL', 'AbortSignal', 'WebSocket', 'Buffer',
  'NodeJS', 'ReadableStream', 'Blob', 'FormData', 'InstanceType', 'ReturnType', 'NonNullable',
  'Parameters', 'ThisType', 'Uppercase', 'Lowercase',
]);

/**
 * Names a declaration listing introduces itself: the things it declares, plus
 * their type parameters.
 */
function locallyDeclared(code: string): Set<string> {
  const local = new Set<string>();
  for (const match of code.matchAll(
    /\b(?:interface|class|type|enum|namespace|function|const|let|var)\s+([A-Za-z_$][\w$]*)\s*(<[^=;{]*?>)?/g
  )) {
    if (match[1]) local.add(match[1]);
    for (const param of (match[2] ?? '').replace(/^<|>$/g, '').split(',')) {
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(param)?.[1];
      if (name) local.add(name);
    }
  }
  // Method-level type parameters, e.g. `run<T>(...)`. The same shape also
  // matches a *call* that passes type arguments — `builder.withInput<Foo>(…)`
  // — so a name a workspace package actually exports is never treated as a
  // locally-introduced parameter. Otherwise the real type would be shadowed
  // and its import suppressed.
  for (const match of code.matchAll(/\b[a-z][\w$]*\s*<([^<>()=;]*)>\s*\(/g)) {
    for (const param of (match[1] ?? '').split(',')) {
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(param)?.[1];
      if (name && !symbolIndex.has(name)) local.add(name);
    }
  }
  return local;
}

/**
 * `import type { ... }` lines resolving the types a declaration listing names.
 *
 * A referenced type that no workspace package (and not graphql-js) exports is
 * deliberately left unresolved: that is a type the docs claim exists and the
 * implementation does not have, and it should fail.
 */
/**
 * The workspace specifier whose source tree contains `origin`, or `undefined`
 * for docs-site pages and root markdown that belong to no single package.
 */
function owningSpecifier(origin: string): string | undefined {
  const dir = /^(packages\/[^/]+)\//.exec(origin)?.[1];
  if (!dir) return undefined;
  for (const [specifier, targets] of Object.entries(WORKSPACE_PATHS)) {
    const target = targets[0];
    if (target && (target === dir || target.startsWith(`${dir}/`))) return specifier;
  }
  return undefined;
}

function importsForListing(code: string, origin: string): string {
  const owner = owningSpecifier(origin);
  const local = locallyDeclared(code);
  const wanted = new Map<string, Set<string>>();
  for (const match of code.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
    const name = match[1] ?? '';
    if (local.has(name) || BUILTIN_TYPES.has(name)) continue;
    const candidates = symbolIndex.get(name);
    if (!candidates || candidates.length === 0) continue;
    // A README documents its own package's version of a name. Only when the
    // owning package does not export it do we fall back to the first indexed
    // definition, which is how graphql-js and `bun` types resolve.
    const specifier =
      (owner && candidates.includes(owner) ? owner : undefined) ?? candidates[0];
    if (!specifier) continue;
    if (!wanted.has(specifier)) wanted.set(specifier, new Set());
    wanted.get(specifier)!.add(name);
  }
  return [...wanted]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([specifier, names]) =>
        `import type { ${[...names].sort().join(', ')} } from '${specifier}';`
    )
    .join('\n');
}

/**
 * Prefix each top-level declaration with `declare`.
 *
 * The generated `import type` header makes the file a module, and inside a
 * module declaration file every top-level declaration needs an explicit
 * `declare` or `export` modifier (TS1046). Only column-0 lines are touched, so
 * members nested inside an interface or class body are left alone.
 */
function ambientize(code: string): string {
  return code
    .split('\n')
    .map((line) =>
      /^(interface|class|type|function|enum|namespace|abstract\s+class|const|let|var)\s/.test(line)
        ? `declare ${line}`
        : line
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Honesty guard: the preamble must never shadow a real Leaven export
// ---------------------------------------------------------------------------

function assertPreambleDoesNotShadowLeaven(preamble: string): void {
  const declared = new Set<string>();
  for (const match of preamble.matchAll(
    /^declare\s+(?:const|function|class|type|interface|enum|namespace|var|let)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
  )) {
    if (match[1]) declared.add(match[1]);
  }

  const collisions: string[] = [];
  for (const [specifier, targets] of Object.entries(WORKSPACE_PATHS)) {
    const target = targets[0];
    if (!target) continue;
    const exported = exportedNames(join(REPO_ROOT, target, 'index.ts'));
    for (const name of declared) {
      if (exported.has(name)) collisions.push(`${name} (also exported by ${specifier})`);
    }
  }

  if (collisions.length > 0) {
    console.error(
      'Preamble placeholders collide with real @leaven-graphql exports; they would\n' +
        'mask a missing import in a sample. Rename them in scripts/doc-samples/preamble.d.ts:\n' +
        collisions.map((entry) => `  - ${entry}`).join('\n')
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const markdownFiles = [
  'README.md',
  ...[...new Glob('packages/*/README.md').scanSync(REPO_ROOT)].sort(),
];
const docsFiles = [...new Glob('docs/src/app/pages/*.ts').scanSync(REPO_ROOT)]
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

for (const file of markdownFiles) extractMarkdown(file);
for (const file of docsFiles) extractDocsPage(file);

const preamble = readFileSync(PREAMBLE_SRC, 'utf8');
assertPreambleDoesNotShadowLeaven(preamble);

/**
 * Unresolvable specifier -> the names the samples import from it.
 *
 * The names matter: a shorthand `declare module 'x';` makes every import from
 * it a *value* of type `any`, so a sample using an imported name in type
 * position still fails with "Cannot use namespace as a type". Declaring each
 * name as both a value and a type is what makes an `any` stub actually inert.
 */
const stubbed = new Map<string, Set<string>>();
for (const sample of extracted) {
  for (const specifier of specifiersOf(sample.code)) {
    if (isResolvable(specifier)) continue;
    if (!stubbed.has(specifier)) stubbed.set(specifier, new Set());
  }
  for (const match of sample.code.matchAll(IMPORT_CLAUSE)) {
    const names = stubbed.get(match[2] ?? '');
    if (!names) continue;
    const clause = match[1] ?? '';
    for (const part of (/\{([\s\S]*)\}/.exec(clause)?.[1] ?? '').split(',')) {
      const parts = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
    const bare = clause.replace(/\{[\s\S]*\}/, '').replace(/^type\s+/, '').split(',')[0]?.trim();
    if ((bare && /^[A-Za-z_$][\w$]*$/.test(bare)) || /\*\s+as\s+[A-Za-z_$][\w$]*/.test(clause)) {
      names.add('default');
    }
  }
}

/** `export`-style declarations giving each imported name an `any` value *and* type. */
function stubBody(names: Set<string>, indent: string): string {
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    if (name === 'default') {
      lines.push(`${indent}const _default: any;`, `${indent}export default _default;`);
    } else {
      lines.push(`${indent}export const ${name}: any;`, `${indent}export type ${name} = any;`);
    }
  }
  lines.push(`${indent}export {};`);
  return lines.join('\n');
}

rmSync(SCRATCH_DIR, { recursive: true, force: true });
mkdirSync(join(SCRATCH_DIR, 'samples'), { recursive: true });
writeFileSync(join(SCRATCH_DIR, 'preamble.d.ts'), preamble);

const ambient = ['// Generated. Modules the samples import that this repo does not depend on.'];
for (const [specifier, names] of [...stubbed].sort(([a], [b]) => (a < b ? -1 : 1))) {
  if (specifier.startsWith('.')) {
    const target = join(SCRATCH_DIR, 'samples', `${specifier.replace(/^\.\//, '')}.d.ts`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${stubBody(names, '')}\n`);
  } else {
    ambient.push(`declare module '${specifier}' {`, stubBody(names, '  '), '}');
  }
}
writeFileSync(join(SCRATCH_DIR, 'stubs.d.ts'), `${ambient.join('\n')}\n`);

for (const sample of extracted) {
  if (sample.kind === 'declaration') {
    const header = importsForListing(sample.code, sample.origin);
    // Emitted as `.ts`, not `.d.ts`: `declare` is legal in a normal module,
    // and `skipLibCheck` (needed for bun-types, below) would otherwise
    // silence every diagnostic in these listings and make the check vacuous.
    writeFileSync(
      join(SCRATCH_DIR, 'samples', `${sample.id}.ts`),
      `${header}\n${ambientize(sample.code)}\nexport {};\n`
    );
  } else {
    writeFileSync(join(SCRATCH_DIR, 'samples', `${sample.id}.ts`), `${sample.code}\nexport {};\n`);
  }
}

const tsconfig = {
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ESNext'],
    types: ['bun-types'],
    strict: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    // `bun-types` is reachable twice in this program (via `types` and via the
    // workspace `paths` that pull real package source in) and self-conflicts
    // with TS2300/TS6200 — library packaging noise, not documentation drift.
    // Safe because every sample, including declaration listings, is emitted
    // as `.ts`; the only `.d.ts` files here are the generated stubs.
    skipLibCheck: true,
    noEmit: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    // Samples are prose. An unused import, or a callback parameter left
    // untyped for brevity, is a presentation choice rather than drift —
    // `strict` minus `noImplicitAny` still checks every call signature,
    // property access and import against the real source, which is the part
    // that catches drift.
    noImplicitAny: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    // No `baseUrl`: TypeScript 6 deprecates it and 7 drops it. The targets are
    // made absolute instead, which is what `baseUrl` was resolving them
    // against anyway — `paths` here would otherwise resolve relative to this
    // generated tsconfig, which lives under `node_modules`.
    paths: Object.fromEntries(
      Object.entries({ ...WORKSPACE_PATHS, ...nestedPackagePaths }).map(([specifier, targets]) => [
        specifier,
        targets.map((target) => (isAbsolute(target) ? target : join(REPO_ROOT, target))),
      ])
    ),
  },
  include: ['preamble.d.ts', 'stubs.d.ts', 'samples/**/*.ts', 'samples/**/*.d.ts'],
};
writeFileSync(join(SCRATCH_DIR, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);

function runTsc(): string[] {
  const tsc = Bun.spawnSync({
    cmd: [join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), '-p', join(SCRATCH_DIR, 'tsconfig.json')],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${tsc.stdout.toString()}${tsc.stderr.toString()}`.trim();
  return output.split('\n').filter((line) => /error TS\d+/.test(line));
}

const byId = new Map(extracted.map((sample) => [sample.id, sample]));
const idOf = (line: string): string =>
  (/^(.*?)\(/.exec(line)?.[1] ?? '').replace(/^.*samples\//, '').replace(/\.d\.ts$|\.ts$/, '');

let errorLines = runTsc();

// Second pass: prose placeholders.
//
// A stitched fragment is a snippet the docs wrote as a continuation ("now
// format the error"), so it freely names variables the surrounding prose
// established but no code block ever declared — `gqlError`, `userInput`.
// Those are presentation, not drift. They are forgiven only when *all* of:
// the sample is stitched, the name is unresolved, it is lower-case, and no
// workspace package or graphql-js exports it. A PascalCase unknown — where a
// renamed or deleted export would show up — still fails, which is what keeps
// this from quietly excusing real drift.
const placeholders = new Set<string>();
for (const line of errorLines) {
  const sample = byId.get(idOf(line));
  if (!sample || sample.offset === 0) continue;
  const name = /error TS(?:2304|2552): Cannot find name '([^']+)'/.exec(line)?.[1];
  if (!name || !/^[a-z]/.test(name) || symbolIndex.has(name)) continue;
  placeholders.add(name);
}

if (placeholders.size > 0) {
  writeFileSync(
    join(SCRATCH_DIR, 'placeholders.d.ts'),
    `// Prose variables named by stitched fragments; see check-doc-samples.ts.\n${[...placeholders]
      .sort()
      .map((name) => `declare const ${name}: any;`)
      .join('\n')}\n`
  );
  tsconfig.include.push('placeholders.d.ts');
  writeFileSync(join(SCRATCH_DIR, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
  errorLines = runTsc();
}

const failing = new Set<string>();
const diagnostics: string[] = [];
for (const line of errorLines) {
  const match = /^(.*?)\((\d+),(\d+)\):\s*(.*)$/.exec(line);
  const sample = byId.get(idOf(line));
  if (sample && match) {
    failing.add(sample.id);
    const line = Number(match[2]) - sample.offset;
    diagnostics.push(
      line > 0
        ? `${sample.origin}  (${sample.kind}) line ${line}: ${match[4]}`
        : // Inside the stitched-on context, i.e. an earlier example on the
          // same page is what is actually broken.
          `${sample.origin}  (${sample.kind}) in preceding example: ${match[4]}`
    );
  } else {
    diagnostics.push(match ? `${relative(REPO_ROOT, match[1] ?? '')}: ${match[4]}` : line);
  }
}

const counts = { runnable: 0, declaration: 0 };
for (const sample of extracted) counts[sample.kind] += 1;
const failedByKind = { runnable: 0, declaration: 0 };
for (const id of failing) {
  const sample = byId.get(id);
  if (sample) failedByKind[sample.kind] += 1;
}

console.log('Documentation sample type check');
console.log('===============================');
console.log(`  sources : ${markdownFiles.length} markdown, ${docsFiles.length} docs pages`);
console.log(`  samples : ${extracted.length + skipped.length} extracted`);
console.log(
  `  checked : ${extracted.length}  ` +
    `(${counts.runnable} runnable, ${counts.declaration} declaration listings)`
);
console.log(
  `  failed  : ${failing.size}  ` +
    `(${failedByKind.runnable} runnable, ${failedByKind.declaration} declaration)`
);
console.log(`  skipped : ${skipped.length}`);
for (const entry of skipped) console.log(`      - ${entry.origin}  ${entry.reason}`);
console.log(`  stubbed modules: ${stubbed.size} (imports resolved to \`any\`)`);
for (const specifier of [...stubbed.keys()].sort()) console.log(`      - ${specifier}`);
console.log(
  '  @leaven-graphql/* imports resolve to real source via tsconfig paths, so a\n' +
    '  documented symbol that does not exist is an error.'
);

if (!KEEP) rmSync(SCRATCH_DIR, { recursive: true, force: true });

if (diagnostics.length > 0) {
  console.log('');
  console.log(`FAIL: ${diagnostics.length} error(s) in ${failing.size} sample(s)`);
  console.log('');
  for (const line of diagnostics) console.log(`  ${line}`);
  process.exit(1);
}

console.log('');
console.log('PASS: every checked sample type-checks against the real source.');
