import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

@Component({
  selector: 'app-executor',
  standalone: true,
  imports: [CommonModule, RouterLink, CodeBlockComponent],
  template: `
    <article class="px-6 py-12 lg:py-16 max-w-4xl mx-auto">
      <!-- Breadcrumb -->
      <nav class="flex items-center gap-2 text-sm text-zinc-500 mb-8">
        <a routerLink="/" class="hover:text-white transition-colors">Home</a>
        <span>/</span>
        <a routerLink="/quick-start" class="hover:text-white transition-colors">Docs</a>
        <span>/</span>
        <span class="text-zinc-300">Executor</span>
      </nav>

      <!-- Header -->
      <header class="mb-12">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium mb-4">
          💎 Core
        </div>
        <h1 class="text-4xl md:text-5xl font-bold text-white mb-4">Executor</h1>
        <p class="text-xl text-zinc-400">The LeavenExecutor is the heart of the execution engine.</p>
      </header>

      <!-- Overview -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Overview</h2>
        <p class="text-zinc-400 mb-4">The <code class="text-amber-400">LeavenExecutor</code> handles the complete GraphQL request lifecycle:</p>
        <div class="card p-6">
          <ul class="space-y-2 text-zinc-300">
            <li><strong class="text-white">Parsing</strong> - Parse GraphQL query strings into document ASTs</li>
            <li><strong class="text-white">Validation</strong> - Validate documents against your schema</li>
            <li><strong class="text-white">Compilation</strong> - Compile queries for efficient execution</li>
            <li><strong class="text-white">Execution</strong> - Execute queries and resolve fields</li>
            <li><strong class="text-white">Caching</strong> - Cache parsed documents and compiled queries</li>
          </ul>
        </div>
      </section>

      <!-- Basic Usage -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Basic Usage</h2>
        <p class="text-zinc-400 mb-4">Create an executor with your schema:</p>
        <app-code-block [code]="basicUsage" title="executor-example.ts" />
      </section>

      <!-- Configuration -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Configuration Options</h2>
        <p class="text-zinc-400 mb-4">The executor accepts several configuration options:</p>
        <app-code-block [code]="configCode" title="types.ts" />
      </section>

      <!-- Caching -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Document Caching</h2>
        <p class="text-zinc-400 mb-4">Enable caching to reuse parsed documents and compiled queries:</p>
        <app-code-block [code]="cachingCode" title="caching.ts" />
      </section>

      <!-- Hooks -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Lifecycle Hooks</h2>
        <p class="text-zinc-400 mb-4">Add hooks to intercept execution at various stages:</p>
        <app-code-block [code]="hooksCode" title="hooks.ts" />
      </section>

      <!-- Metrics -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Execution Metrics</h2>
        <p class="text-zinc-400 mb-4">Enable metrics to track performance:</p>
        <app-code-block [code]="metricsCode" title="metrics.ts" />
      </section>

      <!-- Execution error formatting -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Formatting Execution Errors</h2>
        <p class="text-zinc-400 mb-4">
          Execution errors are reported as <code class="text-amber-400">error.toJSON()</code>, which emits only
          <code class="text-amber-400">{{ '{' }} message, locations, path, extensions {{ '}' }}</code> and drops
          <code class="text-amber-400">originalError</code>. graphql-js falls back to
          <code class="text-amber-400">originalError.extensions</code>, so a
          <code class="text-amber-400">LeavenError</code> keeps its <code class="text-amber-400">code</code> —
          but a framework exception with no <code class="text-amber-400">extensions</code> of its own,
          such as a NestJS <code class="text-amber-400">HttpException</code>, arrives with
          <code class="text-amber-400">extensions: {{ '{}' }}</code> and is indistinguishable from a crash.
          <code class="text-amber-400">formatExecutionError</code> runs before
          <code class="text-amber-400">toJSON()</code>, so it is the only place such an error can still be
          recognised and mapped to an <code class="text-amber-400">ErrorCode</code>.
        </p>
        <app-code-block [code]="formatExecutionErrorCode" title="format-execution-error.ts" />
        <p class="text-zinc-400 mt-4">
          It applies to the errors of an execution result and of both subscription paths — where a
          resolver's <code class="text-amber-400">originalError</code> exists. It is deliberately not applied
          to parse, validation or complexity rejections, which Leaven synthesises, which never carry a
          framework <code class="text-amber-400">originalError</code>, and which already guarantee an
          <code class="text-amber-400">ErrorCode</code>.
        </p>
      </section>

      <!-- Navigation -->
      <nav class="flex items-center justify-between pt-8 border-t border-zinc-800">
        <a routerLink="/installation" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
          <svg class="w-5 h-5 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"/>
          </svg>
          <div class="text-right">
            <span class="text-xs text-zinc-500 block">Previous</span>
            <span class="font-medium">Installation</span>
          </div>
        </a>
        <a routerLink="/schema" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-right">
          <div>
            <span class="text-xs text-zinc-500 block">Next</span>
            <span class="font-medium">Schema Building</span>
          </div>
          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </a>
      </nav>
    </article>
  `,
})
export class ExecutorComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'Executor',
      description: 'The LeavenExecutor handles parsing, validation, compilation, caching, and execution of GraphQL operations on Bun.',
      keywords: ['GraphQL executor', 'query execution', 'document caching', 'execution hooks', 'Leaven'],
      canonical: '/executor',
      ogType: 'article'
    });
  }

  basicUsage = `import { LeavenExecutor } from '@leaven-graphql/core';
import { schema } from './schema';

const executor = new LeavenExecutor({
  schema,
  cache: true,
});

// Execute a query
const result = await executor.execute({
  query: '{ hello }',
});

console.log(result.response.data);
// { hello: "Hello, world!" }`;

  configCode = `interface ExecutorConfig {
  schema: GraphQLSchema;              // Your GraphQL schema
  rootValue?: unknown;                // Root resolver value
  cache?: DocumentCacheConfig         // Configure the in-memory cache,
    | boolean                         // enable/disable the default cache,
    | IDocumentCache;                 // or plug in a custom cache (e.g. Redis)
  parseOptions?: ParseOptions;        // Parser options
  compilerOptions?: CompilerOptions;  // Enables query compilation
  introspection?: boolean;            // Enable introspection queries (default: true)
  maxDepth?: number;                  // Query depth limit
  maxComplexity?: number;             // Query complexity limit
  hooks?: ExecutionHooks;             // Lifecycle hooks
  metrics?: boolean;                  // Enable execution metrics (execute() only)
  formatExecutionError?:              // Serialize an execution error while the
    (error: GraphQLError)             // graphql-js GraphQLError is still intact
      => GraphQLFormattedError;       // (default: error.toJSON())
}`;

  cachingCode = `const executor = new LeavenExecutor({
  schema,
  cache: {
    maxSize: 1000,      // Max cached documents
    maxBytes: 32 << 20, // Estimated memory budget (default: 32 MiB)
    ttl: 3600000,       // 1 hour TTL
  },
});

// Check cache stats (async - custom caches may be remote)
const stats = await executor.getCacheStats();
console.log(stats);
// { document: { size: 42, hits: 156, ... }, compiled: { size: 12, maxSize: 1000 } }`;

  hooksCode = `const executor = new LeavenExecutor({
  schema,
  hooks: {
    onParse(query) {
      console.log('Parsing:', query);
    },
    onValidated(result) {
      if (!result.valid) {
        console.error('Validation errors:', result.errors);
      }
    },
    async onExecute(context, document) {
      // Pre-execution logic
    },
    async onExecuted(result) {
      console.log('Completed with data:', result.data);
    },
    onError(error) {
      console.error('Execution error:', error);
    },
  },
});`;

  metricsCode = `const executor = new LeavenExecutor({
  schema,
  metrics: true,
});

const result = await executor.execute({ query: '{ users { name } }' });

console.log(result.metrics);
// {
//   timing: { parseTime: 0.5, validationTime: 1.2, executionTime: 3.8, totalTime: 5.5 },
//   documentCached: true,
//   validationCached: true,
//   queryCached: false,
//   complexity: 12
// }
//
// Note: ExecutionMetrics also declares resolverCount, but the executor does
// not track it and omits the field rather than reporting a wrong count.`;

  formatExecutionErrorCode = `import { LeavenExecutor } from '@leaven-graphql/core';

const executor = new LeavenExecutor({
  schema,
  formatExecutionError: (error) => {
    const cause = error.originalError;

    // The live GraphQLError is still in hand, so a framework exception is
    // still recognisable here.
    if (cause instanceof HttpException) {
      return {
        message: cause.message,
        path: error.path,
        locations: error.locations,
        extensions: { ...error.extensions, code: codeForStatus(cause.getStatus()) },
      };
    }

    return error.toJSON();
  },
});

// Not the same thing as a transport's formatError option (e.g.
// LeavenModuleOptions.formatError), which is a final, response-level pass over
// an already-serialized GraphQLFormattedError.`;
}
