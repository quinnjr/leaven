import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [CommonModule, RouterLink, CodeBlockComponent],
  template: `
    <article class="px-6 py-12 lg:py-16 max-w-4xl mx-auto" itemscope itemtype="https://schema.org/TechArticle">
      <!-- Breadcrumb -->
      <nav class="flex items-center gap-2 text-sm text-zinc-500 mb-8" aria-label="Breadcrumb">
        <a routerLink="/" class="hover:text-white transition-colors">Home</a>
        <span>/</span>
        <span class="text-zinc-300">Plugin System</span>
      </nav>

      <!-- Header -->
      <header class="mb-12">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-medium mb-4">
          🧩 Extensibility
        </div>
        <h1 class="text-4xl md:text-5xl font-bold text-white mb-4" itemprop="headline">Plugin System</h1>
        <p class="text-xl text-zinc-400" itemprop="description">
          Extend Leaven with plugins for caching, logging, tracing, and more using &#64;leaven-graphql/plugins.
        </p>
      </header>

      <!-- Overview -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Overview</h2>
        <p class="text-zinc-400 mb-4">
          The plugin system allows you to hook into the GraphQL execution lifecycle.
          Plugins can transform queries, add caching, logging, tracing, and enforce limits.
        </p>
        <div class="card p-6">
          <ul class="space-y-2 text-zinc-300">
            <li><strong class="text-white">Lifecycle Hooks</strong> - beforeParse, afterParse, beforeExecute, afterExecute</li>
            <li><strong class="text-white">Built-in Plugins</strong> - Caching, logging, tracing, depth/complexity limits</li>
            <li><strong class="text-white">Plugin Composition</strong> - Combine multiple plugins easily</li>
            <li><strong class="text-white">Type Safety</strong> - Fully typed plugin interface</li>
          </ul>
        </div>
      </section>

      <!-- Installation -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Installation</h2>
        <app-code-block [code]="installCode" title="terminal" />
      </section>

      <!-- Built-in Plugins -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Built-in Plugins</h2>
        <p class="text-zinc-400 mb-4">Leaven provides several ready-to-use plugins:</p>

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Caching Plugin</h3>
        <p class="text-zinc-400 mb-4">
          A cache hit skips execution entirely, so resolvers — and any field-level authorization they
          perform — never run. <code class="text-purple-400">createCachingPlugin</code> therefore
          <strong class="text-white">throws</strong> unless you make the cache-identity decision explicit:
          pass a <code class="text-purple-400">keyFn</code> that folds the caller into the key, or set
          <code class="text-purple-400">allowSharedCache: true</code> to serve one response to everyone.
        </p>
        <app-code-block [code]="cachingCode" title="caching.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Logging Plugin</h3>
        <app-code-block [code]="loggingCode" title="logging.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Tracing Plugin</h3>
        <app-code-block [code]="tracingCode" title="tracing.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Depth Limit Plugin</h3>
        <app-code-block [code]="depthCode" title="depth-limit.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Complexity Plugin</h3>
        <app-code-block [code]="complexityCode" title="complexity.ts" />
      </section>

      <!-- Plugin Manager -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Plugin Manager</h2>
        <p class="text-zinc-400 mb-4">Manage and orchestrate multiple plugins:</p>
        <app-code-block [code]="managerCode" title="manager.ts" />
      </section>

      <!-- Creating Custom Plugins -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Creating Custom Plugins</h2>
        <p class="text-zinc-400 mb-4">Create your own plugins with the createPlugin helper:</p>
        <app-code-block [code]="customCode" title="custom-plugin.ts" />
      </section>

      <!-- Plugin Hooks -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Plugin Hooks</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-zinc-800">
                <th class="py-3 pr-4 text-zinc-300 font-semibold">Hook</th>
                <th class="py-3 text-zinc-300 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody class="text-zinc-400">
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-purple-400">beforeParse</code></td>
                <td class="py-3">Called before parsing the query string</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-purple-400">afterParse</code></td>
                <td class="py-3">Called after parsing, receives DocumentNode</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-purple-400">beforeValidate</code></td>
                <td class="py-3">Called before schema validation</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-purple-400">afterValidate</code></td>
                <td class="py-3">Called after validation with results</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-purple-400">beforeExecute</code></td>
                <td class="py-3">Called before resolver execution</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-purple-400">afterExecute</code></td>
                <td class="py-3">Called after execution with results</td>
              </tr>
              <tr>
                <td class="py-3 pr-4"><code class="text-purple-400">onError</code></td>
                <td class="py-3">Called when an error occurs</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Composing Plugins -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Composing Plugins</h2>
        <p class="text-zinc-400 mb-4">Combine multiple plugins into one:</p>
        <app-code-block [code]="composeCode" title="compose.ts" />
      </section>

      <!-- Navigation -->
      <nav class="flex items-center justify-between pt-8 border-t border-zinc-800">
        <a routerLink="/context" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
          <svg class="w-5 h-5 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"/>
          </svg>
          <div class="text-right">
            <span class="text-xs text-zinc-500 block">Previous</span>
            <span class="font-medium">Request Context</span>
          </div>
        </a>
        <a routerLink="/errors" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-right">
          <div>
            <span class="text-xs text-zinc-500 block">Next</span>
            <span class="font-medium">Error Handling</span>
          </div>
          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </a>
      </nav>
    </article>
  `,
})
export class PluginsComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'Plugin System',
      description: 'Extend Leaven with plugins for caching, logging, tracing, depth limiting, and complexity analysis.',
      keywords: ['GraphQL plugins', 'middleware', 'caching', 'logging', 'tracing', 'Leaven'],
      canonical: '/plugins',
      ogType: 'article'
    });

    // Emit the JSON-LD counterpart of this page's TechArticle microdata,
    // plus the breadcrumb trail rendered at the top of the article.
    this.seoService.updateStructuredData([
      this.seoService.generateTechArticleSchema({
        title: 'Plugin System',
        description: 'Extend Leaven with plugins for caching, logging, tracing, depth limiting, and complexity analysis.',
        url: '/plugins'
      }),
      this.seoService.generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'Plugin System', url: '/plugins' }
      ])
    ]);
  }

  // doc-check: skip - shell command, not TypeScript
  installCode = `bun add @leaven-graphql/plugins`;

  cachingCode = `import { createCachingPlugin } from '@leaven-graphql/plugins';

// Recommended: key on the caller so one user never sees another's response.
const cachingPlugin = createCachingPlugin({
  maxSize: 100,   // LRU entries (default: 100)
  ttl: 60_000,    // Entry lifetime in ms (default: 60000)
  // keyFn REPLACES the whole default key (query + operationName + variables),
  // so include operationName and variables yourself or distinct requests collide.
  keyFn: (ctx) =>
    JSON.stringify([
      (ctx.context as AppContext).userId,
      ctx.request.query,
      ctx.request.operationName ?? null,
      JSON.stringify(ctx.request.variables ?? null),
    ]),
});

// Only for data that is identical for every caller (fully public content):
const publicCachingPlugin = createCachingPlugin({ allowSharedCache: true });

// Omitting both throws — the plugin refuses to guess:
// createCachingPlugin();
// TypeError: createCachingPlugin requires an explicit cache-identity decision...

// Successful responses only; responses carrying errors are never cached.`;

  loggingCode = `import { createLoggingPlugin } from '@leaven-graphql/plugins';

const loggingPlugin = createLoggingPlugin({
  logger: console,  // Custom logger (defaults to console)
  level: 'info',    // 'debug' | 'info' | 'warn' | 'error'
});

// Output:
// GraphQL operation completed { operationName: 'getUser', duration: '15.00ms' }`;

  tracingCode = `import { createTracingPlugin } from '@leaven-graphql/plugins';

const tracingPlugin = createTracingPlugin();

// Adds Apollo Tracing-shaped info to response extensions:
// {
//   data: { ... },
//   extensions: {
//     tracing: {
//       version: 1,
//       startTime: "2026-01-01T12:00:00.000Z",
//       endTime: "2026-01-01T12:00:00.015Z",
//       duration: 15000000,
//       parsing: { ... },
//       validation: { ... },
//       execution: { ... }
//     }
//   }
// }`;

  depthCode = `import { createDepthLimitPlugin } from '@leaven-graphql/plugins';

const depthLimitPlugin = createDepthLimitPlugin(10);

// Rejects queries that are too deeply nested:
// query {
//   user {
//     posts {
//       comments {
//         author {
//           posts { ... } // Too deep!
//         }
//       }
//     }
//   }
// }`;

  complexityCode = `import { createComplexityPlugin } from '@leaven-graphql/plugins';

const complexityPlugin = createComplexityPlugin({
  maxComplexity: 1000,
  defaultComplexity: 1,     // Cost per field (list args like "first" multiply it)
  unknownMultiplier: 100,   // Page size assumed when first/last/limit is an
                            // unresolvable variable (default: 100). Deliberately
                            // pessimistic — the value is client-controlled, so
                            // assuming a small page would let an unbounded
                            // request score as a cheap one.
});

// Calculates and enforces query complexity, throwing ComplexityError
// (HTTP 400, extensions.code: 'COMPLEXITY_LIMIT') when the budget is exceeded.
// Prevents expensive queries from overwhelming your server`;

  managerCode = `import {
  createPluginManager,
  createLoggingPlugin,
  createTracingPlugin,
  createDepthLimitPlugin,
} from '@leaven-graphql/plugins';

// Create plugin manager with schema
const manager = createPluginManager({
  schema,
  plugins: [
    createLoggingPlugin({ logger: console }),
    createTracingPlugin(),
    createDepthLimitPlugin(10),
  ],
});

// Register additional plugins
await manager.register(myCustomPlugin);

// Unregister plugins
await manager.unregister('logging');

// Get registered plugin names
const plugins = manager.getPluginNames();
// ['tracing', 'depth-limit', 'my-custom-plugin']`;

  customCode = `import { createPlugin } from '@leaven-graphql/plugins';

// createPlugin(metadata, hooks) - metadata and hooks are separate arguments
const metricsPlugin = createPlugin(
  { name: 'metrics', version: '1.0.0' },
  {
    beforeExecute: async (document, context) => {
      // Share data between hooks via context.state
      context.state.set('startTime', performance.now());
    },

    afterExecute: async (response, context) => {
      // beforeExecute is skipped when an earlier plugin short-circuits
      const startTime = context.state.get('startTime') as number | undefined;
      if (startTime === undefined) return response;
      const duration = performance.now() - startTime;

      // Record metrics
      metrics.record({
        operation: context.request.operationName,
        duration,
        errors: response.errors?.length ?? 0,
      });

      return response;
    },

    onError: async (error, context) => {
      metrics.recordError({
        operation: context.request.operationName,
        error: error.message,
      });
      return error;
    },
  }
);`;

  composeCode = `import {
  composePlugins,
  createPluginManager,
  createLoggingPlugin,
  createTracingPlugin,
  createDepthLimitPlugin,
  createComplexityPlugin,
} from '@leaven-graphql/plugins';
import { LeavenExecutor, type GraphQLRequest } from '@leaven-graphql/core';
import { parse } from 'graphql';

// Combine multiple plugins into one: composePlugins(name, ...plugins)
const combinedPlugin = composePlugins(
  'observability',
  createLoggingPlugin({ logger: console }),
  createTracingPlugin(),
  createDepthLimitPlugin(10),
  createComplexityPlugin({ maxComplexity: 500 })
);

// Plugins attach to execution through a PluginManager
// (ExecutorConfig has no 'plugins' option)
const manager = createPluginManager({
  schema,
  plugins: [combinedPlugin],
});

const executor = new LeavenExecutor({ schema });

// Run the plugin pipeline around execution
async function handle(graphqlRequest: GraphQLRequest, contextValue: unknown) {
  const pluginContext = manager.createContext(graphqlRequest, contextValue);

  const query = await manager.beforeParse(graphqlRequest.query, pluginContext);

  // maxTokens bounds the parser so client input cannot be unbounded;
  // afterParse runs the depth and complexity guardrails (they throw on violation)
  const document = await manager.afterParse(parse(query, { maxTokens: 10_000 }), pluginContext);

  // A beforeExecute hook may short-circuit (e.g. a cached response)
  const cached = await manager.beforeExecute(document, pluginContext);
  if (cached) {
    return manager.afterExecute(cached, pluginContext);
  }

  const result = await executor.execute({ ...graphqlRequest, query }, contextValue);

  const response = await manager.afterExecute(result.response, pluginContext);
  return response;
}`;
}
