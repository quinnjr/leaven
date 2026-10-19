/**
 * Verifies the built `dist/` output and publish metadata of every package.
 *
 * Published packages must import their dependencies instead of inlining them.
 * An inlined copy of `graphql` makes every schema built with the consumer's
 * `graphql` fail with "Cannot use GraphQLSchema ... from another module or
 * realm", because graphql-js relies on `instanceof` across the whole program.
 *
 * Run after `pnpm build`: `bun run scripts/check-dist.ts`
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const packagesDir = join(root, 'packages');
const failures: string[] = [];
const REPOSITORY_URL = 'https://github.com/quinnjr/leaven.git';

// 0. npm provenance (trusted publishing) rejects a package whose repository.url does not match the
//    GitHub repository that built it, so every package must declare it.
for (const name of readdirSync(packagesDir)) {
  const manifest = Bun.file(join(packagesDir, name, 'package.json'));
  if (!(await manifest.exists())) continue;
  const { repository } = (await manifest.json()) as { repository?: { url?: string; directory?: string } };
  if (repository?.url !== REPOSITORY_URL || repository.directory !== `packages/${name}`) {
    failures.push(
      `${name}: package.json repository must be { "url": "${REPOSITORY_URL}", "directory": "packages/${name}" }, got ${JSON.stringify(repository)}`,
    );
  }
}

// 1. No package may inline a dependency (bun marks inlined modules with their node_modules path).
for (const name of readdirSync(packagesDir)) {
  const entry = Bun.file(join(packagesDir, name, 'dist', 'index.js'));
  if (!(await entry.exists())) {
    failures.push(`${name}: dist/index.js is missing (run pnpm build first)`);
    continue;
  }
  const source = await entry.text();
  const inlined = new Set<string>();
  // Inlined third-party modules: `// ../../node_modules/.pnpm/graphql@16.12.0/node_modules/graphql/...`
  for (const match of source.matchAll(/^\/\/ .*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)) {
    inlined.add(match[1] ?? '');
  }
  // Inlined sibling workspace packages: `// ../core/src/executor.ts`
  for (const match of source.matchAll(/^\/\/ \.\.\/([^/\s]+)\/src\//gm)) {
    inlined.add(`@leaven-graphql/${match[1]}`);
  }
  if (inlined.size > 0) {
    failures.push(`${name}: dist/index.js inlines dependencies: ${[...inlined].sort().join(', ')}`);
  }
}

// 1b. No test helpers or test files may ship in a package's dist.
for (const name of readdirSync(packagesDir)) {
  const dist = join(packagesDir, name, 'dist');
  if (!existsSync(dist)) continue;
  const stray = (readdirSync(dist, { recursive: true }) as string[]).filter(
    (entry) => /(^|[\\/])test-utils([\\/]|$)/.test(entry) || /\.test\.[^\\/]+$/.test(entry),
  );
  if (stray.length > 0) {
    failures.push(`${name}: dist contains test files: ${stray.sort().join(', ')}`);
  }
}

// 2. Smoke test: a schema built with the consumer's `graphql` must work with the built executor
//    and the built WebSocket subscription manager, and the built SSE package must encode a stream.
if (failures.length === 0) {
  const { GraphQLObjectType, GraphQLSchema, GraphQLString } = await import('graphql');
  const core = await import(join(packagesDir, 'core', 'dist', 'index.js'));
  const ws = await import(join(packagesDir, 'ws', 'dist', 'index.js'));
  const sse = await import(join(packagesDir, 'sse', 'dist', 'index.js'));
  const plugins = await import(join(packagesDir, 'plugins', 'dist', 'index.js'));
  const schemaPkg = await import(join(packagesDir, 'schema', 'dist', 'index.js'));
  const playground = await import(join(packagesDir, 'playground', 'dist', 'index.js'));

  for (const [pkg, mod, key] of [
    ['plugins', plugins, 'createDepthLimitPlugin'],
    ['schema', schemaPkg, 'mergeSchemas'],
    ['playground', playground, 'renderGraphiQL'],
  ] as const) {
    if (typeof (mod as Record<string, unknown>)[key] !== 'function') {
      failures.push(`${pkg}: dist export ${key} is not a function`);
    }
  }

  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { hello: { type: GraphQLString, resolve: (_p: unknown, _a: unknown, ctx: { who: string }) => `hi ${ctx.who}` } },
    }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        tick: {
          type: GraphQLString,
          subscribe: async function* () {
            yield { tick: 'one' };
          },
        },
      },
    }),
  });

  try {
    const executor = core.createExecutor({ schema });
    const { response } = await executor.execute({ query: '{ hello }' }, { who: 'ada' });
    if (response.data?.hello !== 'hi ada') {
      failures.push(`core: executor returned ${JSON.stringify(response)}`);
    }

    const manager = ws.createSubscriptionManager({ schema });
    const received = await new Promise<unknown>((resolve, reject) => {
      manager
        .subscribe('conn', 'sub', { query: 'subscription { tick }' }, {}, resolve, () => {}, reject)
        .catch(reject);
    });
    if ((received as { data?: { tick?: string } }).data?.tick !== 'one') {
      failures.push(`ws: subscription returned ${JSON.stringify(received)}`);
    }
    manager.clear();

    const stream: ReadableStream<Uint8Array> = sse.createEventStream(
      { data: { ok: true } },
      { keepAliveInterval: 0 },
    );
    const frames = await new Response(stream).text();
    const expected = 'event: next\ndata: {"data":{"ok":true}}\n\nevent: complete\ndata:\n\n';
    if (frames !== expected) {
      failures.push(`sse: event stream yielded ${JSON.stringify(frames)}`);
    }
  } catch (error) {
    failures.push(`smoke test threw: ${(error as Error).message.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`dist check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('dist check passed');
