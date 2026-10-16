import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

@Component({
  selector: 'app-nestjs',
  standalone: true,
  imports: [CommonModule, RouterLink, CodeBlockComponent],
  template: `
    <article class="px-6 py-12 lg:py-16 max-w-4xl mx-auto" itemscope itemtype="https://schema.org/TechArticle">
      <!-- Breadcrumb -->
      <nav class="flex items-center gap-2 text-sm text-zinc-500 mb-8" aria-label="Breadcrumb">
        <a routerLink="/" class="hover:text-white transition-colors">Home</a>
        <span>/</span>
        <span class="text-zinc-300">NestJS Integration</span>
      </nav>

      <!-- Header -->
      <header class="mb-12">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-pink-500/10 border border-pink-500/20 text-pink-400 text-xs font-medium mb-4">
          🏛️ Framework
        </div>
        <h1 class="text-4xl md:text-5xl font-bold text-white mb-4" itemprop="headline">NestJS Integration</h1>
        <p class="text-xl text-zinc-400" itemprop="description">
          Seamlessly integrate Leaven with NestJS using &#64;leaven-graphql/nestjs. Guards, decorators, and interceptors included.
        </p>
      </header>

      <!-- Overview -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Overview</h2>
        <p class="text-zinc-400 mb-4">
          The <code class="text-pink-400">&#64;leaven-graphql/nestjs</code> package provides full NestJS integration
          with all the decorators, guards, and interceptors you need.
        </p>
        <div class="card p-4 mb-4 border-amber-500/20 bg-amber-500/5">
          <p class="text-zinc-300 text-sm">
            <strong class="text-amber-400">⚡ Bun Runtime:</strong> This package requires
            <code class="text-amber-400">&#64;lexmata/nestjs-platform-bun</code>
            as the NestJS HTTP adapter for Bun support.
          </p>
        </div>
        <div class="card p-4 mb-4 border-red-500/20 bg-red-500/5">
          <p class="text-zinc-300 text-sm mb-2">
            <strong class="text-red-400">⚠️ Two paths, and only one of them runs the NestJS pipeline.</strong>
            Which one you pick decides whether the guards, interceptors and parameter decorators
            documented on this page execute.
          </p>
          <p class="text-zinc-300 text-sm mb-2">
            <strong class="text-white">
              <code class="text-pink-400">GraphQLModule.forRoot({{ '{' }} driver: LeavenGraphQLDriver {{ '}' }})</code>
              — the pipeline runs.
            </strong>
            &#64;nestjs/graphql builds the schema from your <code class="text-pink-400">&#64;Resolver()</code>
            classes and wraps every field resolver in NestJS's
            <code class="text-pink-400">ExternalContextCreator</code>, so
            <code class="text-pink-400">&#64;UseGuards</code>,
            <code class="text-pink-400">&#64;UseInterceptors</code>, pipes, filters and parameter decorators
            all fire; Leaven executes the finished schema.
          </p>
          <p class="text-zinc-300 text-sm">
            <strong class="text-white">
              <code class="text-pink-400">LeavenModule.forRoot({{ '{' }} schema {{ '}' }})</code> or
              <code class="text-pink-400">{{ '{' }} typeDefs, resolvers {{ '}' }}</code> — it does not.
            </strong>
            There your resolvers are plain functions invoked directly by graphql-js. They are not NestJS
            handlers, so nothing wraps them: guards and interceptors never fire, and parameter decorators
            are not applied — the resolver receives the raw
            <code class="text-pink-400">(root, args, context, info)</code> positional arguments instead. Put
            authorization and argument handling inside the resolver functions or in the
            <code class="text-pink-400">context</code> factory on that path, or switch to the driver.
          </p>
        </div>
        <div class="card p-6">
          <ul class="space-y-2 text-zinc-300">
            <li><strong class="text-white">LeavenGraphQLDriver</strong> - &#64;nestjs/graphql driver; the path where the NestJS pipeline runs</li>
            <li><strong class="text-white">LeavenModule</strong> - Easy module registration</li>
            <li><strong class="text-white">Decorators</strong> - &#64;Context, &#64;Args, &#64;Info, and more</li>
            <li><strong class="text-white">Guards</strong> - Authentication, roles, permissions</li>
            <li><strong class="text-white">Interceptors</strong> - Logging, caching, metrics</li>
            <li><strong class="text-white">GqlExecutionContext</strong> - Access GraphQL context</li>
            <li><strong class="text-white">Subscriptions</strong> - graphql-ws over WebSocket with a shared PubSub</li>
          </ul>
        </div>
      </section>

      <!-- Installation -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Installation</h2>
        <app-code-block [code]="installCode" title="terminal" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Required TypeScript configuration</h3>
        <p class="text-zinc-400 mb-4">
          NestJS reads its metadata through <code class="text-pink-400">reflect-metadata</code>, and Bun only
          emits that metadata when both decorator flags are on:
        </p>
        <app-code-block [code]="tsconfigCode" title="tsconfig.json" />
        <p class="text-zinc-400 mt-4">
          Without them Bun fails at <em>import</em> time with an error that names neither decorators nor
          NestJS — <code class="text-pink-400">TypeError: undefined is not an object (evaluating
          'descriptor.value')</code>. If you see that, check these two flags before anything else.
        </p>
      </section>

      <!-- Bootstrap -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Bootstrap with Bun</h2>
        <p class="text-zinc-400 mb-4">Bootstrap your NestJS app with the Bun HTTP adapter:</p>
        <app-code-block [code]="bootstrapCode" title="main.ts" />
      </section>

      <!-- Driver -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Driver Setup (&#64;nestjs/graphql)</h2>
        <p class="text-zinc-400 mb-4">
          <code class="text-pink-400">LeavenGraphQLDriver</code> is a real &#64;nestjs/graphql driver: it
          extends <code class="text-pink-400">AbstractGraphQLDriver</code> and implements
          <code class="text-pink-400">start()</code> and <code class="text-pink-400">stop()</code>. Pass it to
          <code class="text-pink-400">GraphQLModule.forRoot()</code> and your
          <code class="text-pink-400">&#64;Resolver()</code> classes become NestJS handlers, executed by
          Leaven. <strong class="text-white">On this path guards, interceptors, pipes, filters and parameter
          decorators all execute.</strong>
        </p>
        <app-code-block [code]="driverModuleCode" title="app.module.ts" />
        <p class="text-zinc-400 mt-4 mb-4">The resolver is an ordinary NestJS handler:</p>
        <app-code-block [code]="driverResolverCode" title="user.resolver.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Why it works</h3>
        <p class="text-zinc-400 mb-4">
          <code class="text-pink-400">GraphQLModule.onModuleInit</code> calls
          <code class="text-pink-400">generateSchema()</code> before
          <code class="text-pink-400">start()</code>. <code class="text-pink-400">generateSchema()</code> is
          inherited from <code class="text-pink-400">AbstractGraphQLDriver</code> and delegates to
          <code class="text-pink-400">GraphQLFactory</code>, which builds the schema from your
          <code class="text-pink-400">&#64;Resolver()</code> classes and wraps every field resolver in
          NestJS's <code class="text-pink-400">ExternalContextCreator</code> — the wrapper that runs the
          execution pipeline. By the time <code class="text-pink-400">start()</code> receives
          <code class="text-pink-400">options.schema</code>, that pipeline is already part of the schema; the
          driver constructs a <code class="text-pink-400">LeavenExecutor</code> over it and serves
          <code class="text-pink-400">POST &lt;path&gt;</code> (plus
          <code class="text-pink-400">GET &lt;path&gt;</code> for GraphiQL when
          <code class="text-pink-400">playground</code> is enabled).
        </p>

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Driver options</h3>
        <p class="text-zinc-400 mb-4">
          <code class="text-pink-400">LeavenDriverConfig</code> accepts everything
          <code class="text-pink-400">GqlModuleOptions</code> does, plus:
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-zinc-800">
                <th class="py-3 pr-4 text-zinc-300 font-semibold">Option</th>
                <th class="py-3 pr-4 text-zinc-300 font-semibold">Type</th>
                <th class="py-3 text-zinc-300 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody class="text-zinc-400">
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">cache</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">DocumentCacheConfig | boolean | IDocumentCache</code></td>
                <td class="py-3">Document/validation cache passed to the executor</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">metrics</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">boolean</code></td>
                <td class="py-3">Collect per-operation metrics and expose them under <code class="text-pink-400">extensions.metrics</code></td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">maxComplexity</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">number</code></td>
                <td class="py-3">Rejected by the executor before any resolver runs</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">maxDepth</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">number</code></td>
                <td class="py-3">Rejected by the executor at parse time</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">parseOptions</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">ParseOptions</code></td>
                <td class="py-3">Parser limits; <code class="text-pink-400">maxTokens</code> defaults to 10000 (<code class="text-pink-400">Infinity</code> opts out)</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">playground</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">boolean</code></td>
                <td class="py-3">Serve GraphiQL on <code class="text-pink-400">GET &lt;path&gt;</code></td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">subscriptionEndpoint</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">string</code></td>
                <td class="py-3">WebSocket endpoint advertised to GraphiQL</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">formatError</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">(error) =&gt; error</code></td>
                <td class="py-3">Final transformation applied to every response error</td>
              </tr>
              <tr>
                <td class="py-3 pr-4"><code class="text-pink-400">includeStacktraceInErrorResponses</code></td>
                <td class="py-3 pr-4"><code class="text-pink-400">boolean</code></td>
                <td class="py-3">Include stack traces; also disables production masking</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Errors and HTTP status</h3>
        <p class="text-zinc-400">
          Every error leaves the driver carrying an <code class="text-pink-400">ErrorCode</code>, and the
          status is derived from it (400 validation/complexity/depth/input, 401 authentication,
          403 authorization, 404 not found, 429 rate limit, 500 otherwise) — but only for a total failure.
          A response carrying <code class="text-pink-400">data</code> alongside
          <code class="text-pink-400">errors</code> is a spec-conformant partial success and stays 200.
          NestJS <code class="text-pink-400">HttpException</code>s — what guards, pipes and filters throw —
          are translated to the equivalent Leaven error, so
          <code class="text-pink-400">UnauthorizedException</code> reaches the client as
          <code class="text-pink-400">401 UNAUTHENTICATED</code> rather than as a masked 500.
        </p>
      </section>

      <!-- Module Setup -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Module Setup (LeavenModule)</h2>
        <p class="text-zinc-400 mb-4">
          <code class="text-pink-400">LeavenModule.forRoot()</code> is the lighter option when you do not
          want the NestJS pipeline: it serves a schema built from plain resolver functions. Guards,
          interceptors and parameter decorators <strong class="text-white">do not run</strong> on this path —
          put authorization in the resolver or in the <code class="text-pink-400">context</code> factory.
          One limit does not depend on the path: <code class="text-pink-400">maxComplexity</code> is enforced
          by the executor itself, before any resolver runs. <code class="text-pink-400">maxDepth</code> under
          <code class="text-pink-400">LeavenModule</code> is only recorded on the context for
          <code class="text-pink-400">DepthGuard</code>, so there it needs the driver like every other guard.
        </p>
        <app-code-block [code]="moduleCode" title="app.module.ts" />
      </section>

      <!-- Async Configuration -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Async Configuration</h2>
        <p class="text-zinc-400 mb-4">Configure asynchronously with dependency injection:</p>
        <app-code-block [code]="asyncCode" title="app.module.ts" />
      </section>

      <!-- Decorators -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Decorators</h2>
        <p class="text-zinc-400 mb-4">Use decorators in your resolvers:</p>
        <app-code-block [code]="decoratorsCode" title="user.resolver.ts" />
      </section>

      <!-- Guards -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Authentication & Authorization</h2>
        <p class="text-zinc-400 mb-4">Protect resolvers with guards:</p>
        <app-code-block [code]="guardsCode" title="admin.resolver.ts" />
      </section>

      <!-- Interceptors -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Interceptors</h2>
        <p class="text-zinc-400 mb-4">Add logging, caching, and metrics:</p>
        <app-code-block [code]="interceptorsCode" title="post.resolver.ts" />
      </section>

      <!-- Subscriptions -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Subscriptions</h2>
        <div class="card p-4 mb-4 border-amber-500/20 bg-amber-500/5">
          <p class="text-zinc-300 text-sm">
            <strong class="text-amber-400">⚠️ You wire the transport:</strong>
            <code class="text-amber-400">SubscriptionManager</code> speaks the graphql-ws protocol but
            does <strong class="text-white">not</strong> own a server. Importing
            <code class="text-amber-400">LeavenModule</code> registers the manager; nothing calls
            <code class="text-amber-400">server.upgrade()</code>, so configuring
            <code class="text-amber-400">subscriptions</code> alone gets you a configured object and no
            listening socket.
          </p>
        </div>

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Module configuration</h3>
        <app-code-block [code]="subscriptionsModuleCode" title="app.module.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Wiring the WebSocket transport</h3>
        <p class="text-zinc-400 mb-4">
          Register the upgrade route yourself and hand each socket to the manager.
          <code class="text-pink-400">getPath()</code> reports the configured path
          (<code class="text-pink-400">subscriptions.path</code>, falling back to
          <code class="text-pink-400">options.path</code>, then <code class="text-pink-400">/graphql</code>),
          so route against that rather than a duplicated constant.
        </p>
        <app-code-block [code]="subscriptionsTransportCode" title="main.ts" />

        <h3 class="text-lg font-semibold text-white mt-6 mb-3">Resolvers and PubSub</h3>
        <p class="text-zinc-400 mb-4">
          Inject the module's shared <code class="text-pink-400">PubSub</code> with
          <code class="text-pink-400">&#64;InjectPubSub()</code> (the
          <code class="text-pink-400">LEAVEN_PUBSUB</code> provider), so a publisher and a subscriber in
          different providers share the same topics:
        </p>
        <app-code-block [code]="subscriptionsResolverCode" title="message.resolver.ts" />
      </section>

      <!-- GqlExecutionContext -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">GqlExecutionContext</h2>
        <p class="text-zinc-400 mb-4">Access GraphQL-specific context in guards and interceptors:</p>
        <app-code-block [code]="contextCode" title="custom.guard.ts" />
      </section>

      <!-- API Reference -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">API Reference</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-zinc-800">
                <th class="py-3 pr-4 text-zinc-300 font-semibold">Export</th>
                <th class="py-3 text-zinc-300 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody class="text-zinc-400">
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">LeavenGraphQLDriver</code></td>
                <td class="py-3">
                  &#64;nestjs/graphql driver for
                  <code class="text-pink-400">GraphQLModule.forRoot()</code>; the path on which guards,
                  interceptors and parameter decorators execute
                </td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">LeavenDriverConfig</code></td>
                <td class="py-3">Driver options: <code class="text-pink-400">GqlModuleOptions</code> plus Leaven executor options</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">LeavenModule</code></td>
                <td class="py-3">Main module with forRoot/forRootAsync (no NestJS pipeline)</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">&#64;Context()</code></td>
                <td class="py-3">Inject GraphQL context</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">&#64;Args()</code></td>
                <td class="py-3">Inject resolver arguments</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">AuthGuard</code></td>
                <td class="py-3">Authentication guard</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">RolesGuard</code></td>
                <td class="py-3">Role-based authorization</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">LoggingInterceptor</code></td>
                <td class="py-3">Log resolver execution</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">GqlExecutionContext</code></td>
                <td class="py-3">Access GraphQL context in guards</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">SubscriptionManager</code></td>
                <td class="py-3">
                  graphql-ws protocol handler; <code class="text-pink-400">getPath()</code>,
                  <code class="text-pink-400">getWebSocketConfig()</code>,
                  <code class="text-pink-400">publishToTopic()</code>
                </td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">&#64;Subscription()</code></td>
                <td class="py-3">Record subscription metadata, optionally with a filter</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-pink-400">&#64;SubscriptionFilter()</code></td>
                <td class="py-3">Standalone event filter for a subscription method</td>
              </tr>
              <tr>
                <td class="py-3 pr-4"><code class="text-pink-400">&#64;InjectPubSub()</code></td>
                <td class="py-3">Inject the module's shared PubSub (<code class="text-pink-400">LEAVEN_PUBSUB</code>)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Navigation -->
      <nav class="flex items-center justify-between pt-8 border-t border-zinc-800">
        <a routerLink="/websockets" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
          <svg class="w-5 h-5 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"/>
          </svg>
          <div class="text-right">
            <span class="text-xs text-zinc-500 block">Previous</span>
            <span class="font-medium">WebSocket Subscriptions</span>
          </div>
        </a>
        <a routerLink="/playground" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-right">
          <div>
            <span class="text-xs text-zinc-500 block">Next</span>
            <span class="font-medium">GraphQL Playground</span>
          </div>
          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </a>
      </nav>
    </article>
  `,
})
export class NestjsComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'NestJS Integration',
      description: 'Seamlessly integrate Leaven with NestJS using @leaven-graphql/nestjs. Guards, decorators, interceptors, and graphql-ws subscriptions.',
      keywords: ['NestJS GraphQL', 'NestJS integration', 'GraphQL decorators', 'NestJS guards', 'NestJS subscriptions', 'Leaven'],
      canonical: '/nestjs',
      ogType: 'article'
    });

    // Emit the JSON-LD counterpart of this page's TechArticle microdata,
    // plus the breadcrumb trail rendered at the top of the article.
    this.seoService.updateStructuredData([
      this.seoService.generateTechArticleSchema({
        title: 'NestJS Integration',
        description: 'Seamlessly integrate Leaven with NestJS using @leaven-graphql/nestjs. Guards, decorators, interceptors, and graphql-ws subscriptions.',
        url: '/nestjs'
      }),
      this.seoService.generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'NestJS Integration', url: '/nestjs' }
      ])
    ]);
  }

  // doc-check: skip - shell command, not TypeScript
  installCode = `bun add @leaven-graphql/nestjs @leaven-graphql/core @leaven-graphql/context @leaven-graphql/errors @lexmata/nestjs-platform-bun graphql`;

  bootstrapCode = `import { NestFactory } from '@nestjs/core';
import { BunAdapter } from '@lexmata/nestjs-platform-bun';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new BunAdapter());

  await app.listen(3000);
  console.log('🚀 Server running at http://localhost:3000/graphql');
}

bootstrap();`;

  // doc-check: skip - JSON, not TypeScript
  tsconfigCode = `{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}`;

  driverModuleCode = `import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { LeavenGraphQLDriver, type LeavenDriverConfig } from '@leaven-graphql/nestjs';
import { UserResolver } from './user.resolver';

@Module({
  imports: [
    GraphQLModule.forRoot<LeavenDriverConfig>({
      driver: LeavenGraphQLDriver,
      // Code-first. \`true\` keeps the generated schema in memory; pass a path
      // to also write it to disk.
      autoSchemaFile: true,
      playground: true,
      path: '/graphql',
      // Leaven executor options
      cache: { maxSize: 1000 },
      metrics: true,
      maxComplexity: 1000,
      maxDepth: 10,
      // Runs once per request; merged over the built-in { req, res }
      context: ({ req }) => ({ req, user: req.user ?? null }),
    }),
  ],
  providers: [UserResolver],
})
export class AppModule {}`;

  driverResolverCode = `import { Resolver, Query, Args } from '@nestjs/graphql';
import { UseGuards, UseInterceptors } from '@nestjs/common';
import {
  AuthGuard,
  RolesGuard,
  Roles,
  LoggingInterceptor,
  Context,
} from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard, RolesGuard)
@UseInterceptors(LoggingInterceptor)
export class UserResolver {
  @Query(() => String)
  @Roles('admin')
  public adminReport(
    @Args('id', { type: () => String }) id: string,
    @Context() ctx: { user: { id: string } },
  ): string {
    // The guards ran before this body. \`id\` and \`ctx\` were injected by the
    // parameter decorators.
    return \`\${id} for \${ctx.user.id}\`;
  }
}`;

  moduleCode = `import { Module } from '@nestjs/common';
import { LeavenModule } from '@leaven-graphql/nestjs';
import { schema } from './schema';

@Module({
  imports: [
    LeavenModule.forRoot({
      schema,
      playground: true,
      introspection: true,
      cache: { maxSize: 1000 },
    }),
  ],
})
export class AppModule {}`;

  asyncCode = `import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LeavenModule } from '@leaven-graphql/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    LeavenModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        schema,
        playground: config.get('GRAPHQL_PLAYGROUND') === 'true',
        introspection: config.get('GRAPHQL_INTROSPECTION') === 'true',
        maxComplexity: config.get('GRAPHQL_MAX_COMPLEXITY', 1000),
        maxDepth: config.get('GRAPHQL_MAX_DEPTH', 10),
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}`;

  decoratorsCode = `import { Resolver, Query, Mutation } from '@nestjs/graphql';
import {
  Context,
  Args,
  Info,
  Root,
  Complexity,
  CacheHint,
  Description,
  type GqlContext,
} from '@leaven-graphql/nestjs';

@Resolver(() => User)
export class UserResolver {
  constructor(
    private readonly userService: UserService,
    private readonly statsService: StatsService,
  ) {}

  // Inject GraphQL context
  @Query(() => User)
  async me(@Context() ctx: GqlContext) {
    return ctx.user;
  }

  // Inject specific context property
  @Query(() => User)
  async user(@Context('db') db: Database, @Args('id') id: string) {
    return db.users.findById(id);
  }

  // Add complexity cost
  @Query(() => [User])
  @Complexity(10)
  @Description('Fetch all users with pagination')
  async users(@Args('limit') limit: number) {
    return this.userService.findAll({ limit });
  }

  // Add cache hints
  @Query(() => UserStats)
  @CacheHint({ maxAge: 3600, scope: 'PUBLIC' })
  async userStats() {
    return this.statsService.getUserStats();
  }
}`;

  guardsCode = `import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation } from '@nestjs/graphql';
import {
  AuthGuard,
  RolesGuard,
  PermissionsGuard,
  Args,
  Public,
  Roles,
  Permissions,
} from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard, RolesGuard)
export class AdminResolver {
  constructor(private readonly userService: UserService) {}

  // Public endpoint (no auth required)
  @Query(() => String)
  @Public()
  health() {
    return 'OK';
  }

  // Requires admin role
  @Query(() => [User])
  @Roles('admin')
  async users() {
    return this.userService.findAll();
  }

  // Requires specific permissions
  @Mutation(() => User)
  @Permissions('users:delete')
  async deleteUser(@Args('id') id: string) {
    return this.userService.delete(id);
  }

  // Multiple roles (any match)
  @Mutation(() => User)
  @Roles('admin', 'moderator')
  async banUser(@Args('id') id: string) {
    return this.userService.ban(id);
  }
}`;

  interceptorsCode = `import { UseInterceptors } from '@nestjs/common';
import { Resolver, Query, Mutation } from '@nestjs/graphql';
import {
  LoggingInterceptor,
  CachingInterceptor,
  MetricsInterceptor,
  ErrorFormattingInterceptor,
  Args,
  CacheHint,
} from '@leaven-graphql/nestjs';

// Apply to all resolvers in class
@Resolver(() => Post)
@UseInterceptors(LoggingInterceptor, MetricsInterceptor)
export class PostResolver {
  constructor(private readonly postService: PostService) {}

  // Logs: [GraphQL] PostResolver.posts - 15ms
  @Query(() => [Post])
  async posts() {
    return this.postService.findAll();
  }

  // Add caching
  @Query(() => Post)
  @UseInterceptors(CachingInterceptor)
  @CacheHint({ maxAge: 60 })
  async post(@Args('id') id: string) {
    return this.postService.findById(id);
  }

  // Format errors consistently
  @Mutation(() => Post)
  @UseInterceptors(ErrorFormattingInterceptor)
  async createPost(@Args('input') input: CreatePostInput) {
    return this.postService.create(input);
  }
}`;

  subscriptionsModuleCode = `import { Module } from '@nestjs/common';
import { LeavenModule } from '@leaven-graphql/nestjs';
import { createPubSub } from '@leaven-graphql/ws';
import { schema } from './schema';

@Module({
  imports: [
    LeavenModule.forRoot({
      schema,
      subscriptions: {
        path: '/graphql',                    // Default: options.path, then '/graphql'
        keepAlive: 12000,                    // Default: 12000ms
        connectionInitWaitTimeout: 3000,     // Default: 3000ms
        maxSubscriptionsPerConnection: 100,  // Default: 100

        // Returning false rejects the connection
        onConnect: (ctx) => Boolean(ctx.connectionParams?.token),
        onDisconnect: (ctx) => console.log('Client disconnected'),
      },

      // Optional: supply your own PubSub (e.g. a distributed engine) so events
      // published on one instance reach subscribers on another. Defaults to a
      // per-module in-memory instance.
      pubSub: createPubSub(),
    }),
  ],
})
export class AppModule {}`;

  subscriptionsTransportCode = `import { NestFactory } from '@nestjs/core';
import { BunAdapter } from '@lexmata/nestjs-platform-bun';
import { SubscriptionManager } from '@leaven-graphql/nestjs';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new BunAdapter());
  await app.init();

  const subscriptions = app.get(SubscriptionManager);

  Bun.serve({
    port: 3000,
    // The upgrade route. The manager never calls server.upgrade() itself.
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (
        pathname === subscriptions.getPath() &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        // Bun requires the \`data\` option whenever the socket's data type is
        // not \`undefined\`; nothing is stashed here.
        return server.upgrade(request, { data: undefined })
          ? undefined
          : new Response('Upgrade failed', { status: 400 });
      }
      // Everything else stays on the Nest HTTP pipeline.
      return app.getHttpAdapter().getInstance().fetch(request);
    },
    // Bun ServerWebSockets: open/message/close already bound to the manager
    websocket: subscriptions.getWebSocketConfig(),
  });
}

bootstrap();

// The upgrade request is NOT threaded through getWebSocketConfig(), so
// ctx.request is undefined in onConnect/context. If a hook needs it, stash it
// at upgrade time (server.upgrade(request, { data: { request } })) and call
// handleOpen yourself:
//
//   websocket: {
//     open: (socket) => subscriptions.handleOpen(socket, socket.data.request),
//     message: (socket, message) => void subscriptions.handleMessage(socket, message),
//     close: (socket) => void subscriptions.handleClose(socket),
//   }
//
// DOM-shaped WebSockets (a ws-style server or a test harness) go to
// handleConnection instead, which attaches its own listeners:
//
//   await subscriptions.handleConnection(socket, request);`;

  subscriptionsResolverCode = `import { Resolver, Query, Mutation } from '@nestjs/graphql';
import { Args, InjectPubSub, Subscription, SubscriptionFilter } from '@leaven-graphql/nestjs';
import type { PubSub } from '@leaven-graphql/ws';

@Resolver()
export class MessageResolver {
  constructor(
    @InjectPubSub() private readonly pubSub: PubSub,
    private readonly messages: MessageService,
  ) {}

  // The filter option narrows the streamed events
  @Subscription(() => Message, {
    filter: (payload, variables) =>
      (payload as { roomId: string }).roomId === (variables as { roomId: string }).roomId,
  })
  messageAdded() {
    return this.pubSub.asyncIterator('MESSAGE_ADDED');
  }

  // @SubscriptionFilter is the standalone equivalent, and preserves the
  // method's return kind — a method returning an async iterable still does,
  // so "for await (const e of resolver.commentAdded())" works in tests.
  @Subscription(() => Comment)
  @SubscriptionFilter(
    (payload, variables) =>
      (payload as { postId: string }).postId === (variables as { postId: string }).postId,
  )
  commentAdded() {
    return this.pubSub.asyncIterator('COMMENT_ADDED');
  }

  @Mutation(() => Message)
  async sendMessage(@Args('roomId') roomId: string, @Args('body') body: string) {
    const message = await this.messages.create({ roomId, body });
    this.pubSub.publish('MESSAGE_ADDED', { messageAdded: message });
    return message;
  }
}

// @Subscription only RECORDS metadata: code-first schema construction is not
// implemented, so a decorated method still needs a matching subscribe field in
// the schema you hand to LeavenModule. The filter is the part that always
// takes effect, because it wraps the method itself.

// Server-side, topic-keyed delivery driven by an external engine is available
// on the manager directly:
//   subscriptions.registerSubscription(...);
//   subscriptions.publishToTopic('MESSAGE_ADDED', payload);`;

  contextCode = `import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@leaven-graphql/nestjs';

@Injectable()
export class CustomGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Create GqlExecutionContext from NestJS context
    const gqlContext = GqlExecutionContext.create(context);

    // Access GraphQL-specific data
    const ctx = gqlContext.getContext<{ user: User }>(); // GraphQL context
    const args = gqlContext.getArgs();        // Resolver arguments
    const info = gqlContext.getInfo();        // GraphQL resolve info
    const root = gqlContext.getRoot();        // Parent value

    // Helper methods
    const fieldName = gqlContext.getFieldName();
    const operationType = gqlContext.getOperationType();
    const selectedFields = gqlContext.getSelectedFields();
    const operationName = gqlContext.getOperationName();

    // Field path. getFullPath() keeps list indices, so users[3].email yields
    // ['users', 3, 'email'] and one element is distinguishable from a field.
    const path = gqlContext.getFullPath();
    // getPath() drops the indices (['users', 'email']) and is deprecated;
    // it remains stable as a metric label or cache key.

    // Your authorization logic
    return this.checkPermission(ctx.user, fieldName ?? '');
  }

  private checkPermission(user: User, field: string): boolean {
    // Custom logic
    return true;
  }
}`;
}
