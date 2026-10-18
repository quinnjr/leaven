import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

@Component({
  selector: 'app-installation',
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
        <span class="text-zinc-300">Installation</span>
      </nav>

      <!-- Header -->
      <header class="mb-12">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium mb-4">
          📦 Setup
        </div>
        <h1 class="text-4xl md:text-5xl font-bold text-white mb-4">Installation</h1>
        <p class="text-xl text-zinc-400">Learn how to install Leaven in your project.</p>
      </header>

      <!-- Requirements -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Requirements</h2>
        <div class="card p-6">
          <p class="text-zinc-400 mb-4">Before installing Leaven, ensure you have:</p>
          <ul class="space-y-2 text-zinc-300">
            <li class="flex items-center gap-2">
              <span class="text-green-400">✓</span>
              <strong>Bun</strong> v1.0 or later
            </li>
            <li class="flex items-center gap-2">
              <span class="text-green-400">✓</span>
              <strong>pnpm</strong> (recommended) or npm/yarn
            </li>
          </ul>
        </div>
      </section>

      <!-- Full Installation -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Full Installation</h2>
        <p class="text-zinc-400 mb-4">Install the meta-package to get all Leaven modules:</p>
        <app-code-block [code]="fullInstall" title="terminal" />
      </section>

      <!-- Minimal Installation -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Minimal Installation</h2>
        <p class="text-zinc-400 mb-4">For a minimal setup, install only the packages you need:</p>
        <app-code-block [code]="minimalInstall" title="terminal" />
      </section>

      <!-- Packages -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Available Packages</h2>
        <p class="text-zinc-400 mb-4">Leaven is composed of several modular packages:</p>
        <div class="card p-6">
          <ul class="space-y-3 text-zinc-300">
            <li><code class="text-amber-400">@leaven-graphql/core</code> - Execution engine, parsing, validation, caching</li>
            <li><code class="text-amber-400">@leaven-graphql/http</code> - Bun HTTP server integration</li>
            <li><code class="text-amber-400">@leaven-graphql/ws</code> - WebSocket support for subscriptions</li>
            <li><code class="text-amber-400">@leaven-graphql/sse</code> - GraphQL over Server-Sent Events (graphql-sse)</li>
            <li><code class="text-amber-400">@leaven-graphql/context</code> - Request context with AsyncLocalStorage</li>
            <li><code class="text-amber-400">@leaven-graphql/errors</code> - Error classes and formatting</li>
            <li><code class="text-amber-400">@leaven-graphql/schema</code> - Schema building utilities</li>
            <li><code class="text-amber-400">@leaven-graphql/plugins</code> - Plugin system and built-ins</li>
            <li><code class="text-amber-400">@leaven-graphql/playground</code> - GraphQL Playground/GraphiQL</li>
          </ul>
        </div>
      </section>

      <!-- TypeScript Configuration -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">TypeScript Configuration</h2>
        <p class="text-zinc-400 mb-4">Leaven is written in TypeScript with strict types. Recommended tsconfig.json:</p>
        <app-code-block [code]="tsconfigCode" title="tsconfig.json" />
      </section>

      <!-- Navigation -->
      <nav class="flex items-center justify-between pt-8 border-t border-zinc-800">
        <a routerLink="/quick-start" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
          <svg class="w-5 h-5 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"/>
          </svg>
          <div class="text-right">
            <span class="text-xs text-zinc-500 block">Previous</span>
            <span class="font-medium">Quick Start</span>
          </div>
        </a>
        <a routerLink="/executor" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-right">
          <div>
            <span class="text-xs text-zinc-500 block">Next</span>
            <span class="font-medium">Executor</span>
          </div>
          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </a>
      </nav>
    </article>
  `,
})
export class InstallationComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'Installation',
      description:
        'Learn how to install Leaven in your project. Full or minimal installation with Bun, available @leaven-graphql packages, and recommended TypeScript configuration.',
      keywords: [
        'Leaven installation',
        'install Leaven',
        'Bun GraphQL',
        '@leaven-graphql packages',
        'GraphQL setup',
      ],
      canonical: '/installation',
      ogType: 'article',
      structuredData: this.seoService.generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'Docs', url: '/quick-start' },
        { name: 'Installation', url: '/installation' },
      ]),
    });
  }

  // doc-check: skip - shell command, not TypeScript
  fullInstall = `bun add @leaven-graphql/leaven graphql`;

  // doc-check: skip - shell commands, not TypeScript
  minimalInstall = `# Core only (for programmatic use)
bun add @leaven-graphql/core graphql

# With HTTP server
bun add @leaven-graphql/core @leaven-graphql/http graphql

# With WebSocket subscriptions
bun add @leaven-graphql/core @leaven-graphql/http @leaven-graphql/ws graphql

# With Server-Sent Events subscriptions
bun add @leaven-graphql/core @leaven-graphql/http @leaven-graphql/sse graphql`;

  // doc-check: skip - JSON, not TypeScript
  tsconfigCode = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun-types"]
  }
}`;
}
