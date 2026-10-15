/**
 * Verifies the built `dist/` output of every package.
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

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const packagesDir = join(root, 'packages');
const failures: string[] = [];

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

// 2. Smoke test: a schema built with the consumer's `graphql` must work with the built executor
//    and the built WebSocket subscription manager.
if (failures.length === 0) {
  const { GraphQLObjectType, GraphQLSchema, GraphQLString } = await import('graphql');
  const core = await import(join(packagesDir, 'core', 'dist', 'index.js'));
  const ws = await import(join(packagesDir, 'ws', 'dist', 'index.js'));

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
  } catch (error) {
    failures.push(`smoke test threw: ${(error as Error).message.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`dist check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('dist check passed');
