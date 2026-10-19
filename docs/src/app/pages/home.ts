import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faBolt,
  faFire,
  faShieldHalved,
  faPuzzlePiece,
  faTowerBroadcast,
  faCakeCandles,
  faGem,
  faGlobe,
  faLayerGroup,
  faLink,
  faBell,
  faPlug,
  faBreadSlice,
  faBookOpen,
  faArrowRight,
  faWheatAwn,
  faMugHot,
  faHeart,
} from '@fortawesome/free-solid-svg-icons';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

interface Feature {
  icon: IconDefinition;
  title: string;
  description: string;
}

interface Package {
  icon: IconDefinition;
  name: string;
  description: string;
  link: string;
}

interface FAQ {
  question: string;
  answer: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink, CodeBlockComponent, FontAwesomeModule],
  template: `
    <div class="relative overflow-hidden">
      <!-- Animated Background - Warm bakery glow -->
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="grid-pattern absolute inset-0 opacity-20"></div>
      </div>

      <!-- Hero Section -->
      <section class="relative min-h-[90vh] flex flex-col items-center justify-center px-6 py-20" itemscope itemtype="https://schema.org/SoftwareApplication">
        <meta itemprop="name" content="Leaven">
        <meta itemprop="applicationCategory" content="DeveloperApplication">

        <div class="max-w-5xl mx-auto text-center">
          <!-- Bakery Badge -->
          <div class="fade-in-up inline-flex items-center gap-3 px-5 py-2.5 rounded-full bg-gradient-to-r from-amber-900/30 to-orange-900/20 border border-amber-700/30 text-amber-300 text-sm font-medium mb-8">
            <fa-icon [icon]="faBreadSlice" class="text-amber-400"></fa-icon>
            <span>Fresh from the Bun Oven</span>
            <fa-icon [icon]="faBolt" class="text-amber-400"></fa-icon>
          </div>

          <!-- Bakery Logo -->
          <div class="fade-in-up delay-50 mb-6">
            <div class="inline-flex items-center justify-center w-24 h-24 rounded-2xl bg-gradient-to-br from-amber-500 via-orange-400 to-yellow-500 shadow-2xl glow-honey">
              <fa-icon [icon]="faBreadSlice" class="text-5xl text-amber-900"></fa-icon>
            </div>
          </div>

          <!-- Main Heading - Bakery style -->
          <h1 class="fade-in-up delay-100 text-5xl md:text-7xl lg:text-8xl font-extrabold tracking-tight mb-6" style="font-family: 'Fraunces', serif;" itemprop="headline">
            <span class="gradient-text">Leaven</span>
            <br />
            <span class="text-amber-100/90 text-4xl md:text-5xl lg:text-6xl font-medium">Artisan GraphQL</span>
          </h1>

          <!-- Tagline -->
          <p class="fade-in-up delay-200 text-xl md:text-2xl text-amber-200/70 max-w-2xl mx-auto mb-4 leading-relaxed" itemprop="description">
            Hand-crafted with care,
            <span class="text-amber-400 font-semibold">risen to perfection</span>
            for the Bun runtime.
          </p>

          <p class="fade-in-up delay-250 text-lg text-amber-300/50 max-w-xl mx-auto mb-10 flex items-center justify-center gap-4">
            <span class="flex items-center gap-1"><fa-icon [icon]="faWheatAwn" class="text-amber-500/60"></fa-icon> Type-safe</span>
            <span class="text-amber-600">•</span>
            <span class="flex items-center gap-1"><fa-icon [icon]="faShieldHalved" class="text-amber-500/60"></fa-icon> Secure</span>
            <span class="text-amber-600">•</span>
            <span class="flex items-center gap-1"><fa-icon [icon]="faPuzzlePiece" class="text-amber-500/60"></fa-icon> Modular</span>
          </p>

          <!-- CTA Buttons -->
          <div class="fade-in-up delay-300 flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <a routerLink="/quick-start" class="btn-primary text-lg px-8 py-4 inline-flex items-center gap-3" aria-label="Get started with Leaven GraphQL">
              <fa-icon [icon]="faFire"></fa-icon>
              Start Baking
              <fa-icon [icon]="faArrowRight" class="text-sm"></fa-icon>
            </a>
            <a
              href="https://github.com/quinnjr/leaven"
              target="_blank"
              rel="noopener noreferrer"
              class="btn-secondary text-lg px-8 py-4 inline-flex items-center gap-3"
              aria-label="View Leaven source code on GitHub"
              itemprop="codeRepository"
            >
              <fa-icon [icon]="faBookOpen"></fa-icon>
              View Recipe Book
            </a>
          </div>

          <!-- Code Preview - Recipe Card Style -->
          <div class="fade-in-up delay-400 max-w-3xl mx-auto">
            <div class="relative">
              <div class="absolute -top-3 left-6 px-4 py-1 bg-amber-600/90 text-amber-100 text-xs font-semibold rounded-full shadow-lg flex items-center gap-2">
                <fa-icon [icon]="faBookOpen" class="text-xs"></fa-icon>
                Today's Recipe
              </div>
              <app-code-block [code]="heroCode" title="server.ts" />
            </div>
          </div>
        </div>
      </section>

      <!-- Features Section - Menu Board Style -->
      <section class="relative px-6 py-24" aria-labelledby="features-heading">
        <div class="max-w-6xl mx-auto">
          <div class="text-center mb-16">
            <div class="inline-flex items-center gap-2 text-amber-500/60 mb-4">
              <fa-icon [icon]="faWheatAwn"></fa-icon>
              <span class="h-px w-12 bg-amber-500/30"></span>
              <span class="text-xs uppercase tracking-widest">Our Specialties</span>
              <span class="h-px w-12 bg-amber-500/30"></span>
              <fa-icon [icon]="faWheatAwn"></fa-icon>
            </div>
            <h2 id="features-heading" class="text-3xl md:text-4xl font-bold text-amber-100 mb-4" style="font-family: 'Fraunces', serif;">
              What's in the Oven?
            </h2>
            <p class="text-lg text-amber-300/60 max-w-2xl mx-auto">
              Every feature carefully kneaded and proofed for the perfect developer experience
            </p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" role="list">
            @for (feature of features; track feature.title; let i = $index) {
              <article
                class="card p-8 fade-in-up group"
                [style.animation-delay]="(i * 100) + 'ms'"
                role="listitem"
              >
                <div class="w-14 h-14 rounded-xl bg-gradient-to-br from-amber-600/20 to-orange-600/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                  <fa-icon [icon]="feature.icon" class="text-2xl text-amber-400"></fa-icon>
                </div>
                <h3 class="text-xl font-semibold text-amber-100 mb-3" style="font-family: 'Fraunces', serif;">{{ feature.title }}</h3>
                <p class="text-amber-300/60 leading-relaxed">{{ feature.description }}</p>
              </article>
            }
          </div>
        </div>
      </section>

      <!-- Packages Section - Bakery Display Case -->
      <section class="relative px-6 py-24 bg-gradient-to-b from-transparent via-amber-950/10 to-transparent" aria-labelledby="packages-heading">
        <div class="max-w-6xl mx-auto">
          <div class="text-center mb-16">
            <div class="inline-flex items-center gap-2 text-amber-500/60 mb-4">
              <fa-icon [icon]="faCakeCandles"></fa-icon>
              <span class="h-px w-12 bg-amber-500/30"></span>
              <span class="text-xs uppercase tracking-widest">Fresh Daily</span>
              <span class="h-px w-12 bg-amber-500/30"></span>
              <fa-icon [icon]="faCakeCandles"></fa-icon>
            </div>
            <h2 id="packages-heading" class="text-3xl md:text-4xl font-bold text-amber-100 mb-4" style="font-family: 'Fraunces', serif;">
              The Pastry Case
            </h2>
            <p class="text-lg text-amber-300/60 max-w-2xl mx-auto">
              Pick your favorites. Each package baked separately for freshness.
            </p>
          </div>

          <nav class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" aria-label="Package navigation">
            @for (pkg of packages; track pkg.name) {
              <a
                [routerLink]="pkg.link"
                class="group p-6 rounded-2xl bg-gradient-to-br from-amber-950/40 to-orange-950/20 border border-amber-800/30 hover:border-amber-600/50 transition-all hover:-translate-y-2 hover:shadow-2xl"
                [attr.aria-label]="pkg.name + ' - ' + pkg.description"
              >
                <div class="w-12 h-12 rounded-lg bg-gradient-to-br from-amber-600/20 to-orange-600/10 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                  <fa-icon [icon]="pkg.icon" class="text-xl text-amber-400"></fa-icon>
                </div>
                <h3 class="text-lg font-semibold text-amber-200 mb-1 group-hover:text-amber-100 transition-colors" style="font-family: 'Fraunces', serif;">
                  {{ pkg.name }}
                </h3>
                <p class="text-sm text-amber-400/50">{{ pkg.description }}</p>
              </a>
            }
          </nav>
        </div>
      </section>

      <!-- FAQ Section - Recipe Tips -->
      <section class="relative px-6 py-24" aria-labelledby="faq-heading" itemscope itemtype="https://schema.org/FAQPage">
        <div class="max-w-4xl mx-auto">
          <div class="text-center mb-16">
            <div class="inline-flex items-center gap-2 text-amber-500/60 mb-4">
              <fa-icon [icon]="faBolt"></fa-icon>
              <span class="h-px w-12 bg-amber-500/30"></span>
              <span class="text-xs uppercase tracking-widest">Baker's Tips</span>
              <span class="h-px w-12 bg-amber-500/30"></span>
              <fa-icon [icon]="faBolt"></fa-icon>
            </div>
            <h2 id="faq-heading" class="text-3xl md:text-4xl font-bold text-amber-100 mb-4" style="font-family: 'Fraunces', serif;">
              Frequently Asked Questions
            </h2>
            <p class="text-lg text-amber-300/60 max-w-2xl mx-auto">
              Quick answers from the master baker
            </p>
          </div>

          <div class="space-y-4">
            @for (faq of faqs; track faq.question) {
              <div
                class="p-6 rounded-2xl bg-gradient-to-br from-amber-950/30 to-orange-950/20 border border-amber-800/20 hover:border-amber-700/40 transition-colors"
                itemscope
                itemprop="mainEntity"
                itemtype="https://schema.org/Question"
              >
                <h3 class="text-lg font-semibold text-amber-200 mb-3 flex items-center gap-3" itemprop="name">
                  <fa-icon [icon]="faBreadSlice" class="text-amber-500/60"></fa-icon>
                  {{ faq.question }}
                </h3>
                <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
                  <p class="text-amber-300/60 leading-relaxed pl-9" itemprop="text">{{ faq.answer }}</p>
                </div>
              </div>
            }
          </div>
        </div>
      </section>

      <!-- CTA Section - Order Now -->
      <section class="relative px-6 py-24" aria-labelledby="cta-heading">
        <div class="max-w-4xl mx-auto text-center">
          <div class="relative p-12 rounded-3xl bg-gradient-to-br from-amber-900/30 via-orange-900/20 to-yellow-900/10 border border-amber-700/30 overflow-hidden">
            <!-- Decorative wheat -->
            <div class="absolute top-4 left-4 text-4xl opacity-20">
              <fa-icon [icon]="faWheatAwn"></fa-icon>
            </div>
            <div class="absolute bottom-4 right-4 text-4xl opacity-20">
              <fa-icon [icon]="faWheatAwn"></fa-icon>
            </div>

            <div class="w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-400 flex items-center justify-center mx-auto mb-6 shadow-xl">
              <fa-icon [icon]="faBreadSlice" class="text-4xl text-amber-900"></fa-icon>
            </div>
            <h2 id="cta-heading" class="text-3xl md:text-4xl font-bold text-amber-100 mb-4" style="font-family: 'Fraunces', serif;">
              Ready to Rise?
            </h2>
            <p class="text-lg text-amber-300/60 mb-8">
              Start baking your GraphQL API today. The dough is proofed and ready!
            </p>
            <a routerLink="/quick-start" class="btn-primary text-lg px-10 py-4 inline-flex items-center gap-3" aria-label="Read the Leaven documentation">
              <fa-icon [icon]="faBookOpen"></fa-icon>
              Get the Recipe
              <fa-icon [icon]="faArrowRight" class="text-sm"></fa-icon>
            </a>
          </div>
        </div>
      </section>

      <!-- Footer - Bakery Sign Off -->
      <footer class="px-6 py-12 border-t border-amber-900/30" role="contentinfo">
        <div class="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-amber-500/50 text-sm">
          <div class="flex items-center gap-3">
            <fa-icon [icon]="faBreadSlice" class="text-xl text-amber-600/40"></fa-icon>
            <span>Leaven © 2026 <span itemscope itemtype="https://schema.org/Person"><span itemprop="name">Joseph Quinn</span></span></span>
          </div>
          <div class="flex items-center gap-2 text-amber-600/40">
            <span>Baked with</span>
            <fa-icon [icon]="faHeart" class="text-red-400/60"></fa-icon>
            <span>and</span>
            <fa-icon [icon]="faMugHot" class="text-amber-400/60"></fa-icon>
          </div>
          <nav class="flex items-center gap-6" aria-label="Footer navigation">
            <a href="https://github.com/quinnjr/leaven" class="hover:text-amber-400 transition-colors flex items-center gap-2" rel="noopener noreferrer">
              <fa-icon [icon]="faGithub"></fa-icon>
              GitHub
            </a>
            <span class="text-amber-800">•</span>
            <span>Apache-2.0 License</span>
          </nav>
        </div>
      </footer>
    </div>
  `,
})
export class HomeComponent implements OnInit {
  // Icons
  protected readonly faBreadSlice = faBreadSlice;
  protected readonly faBolt = faBolt;
  protected readonly faFire = faFire;
  protected readonly faArrowRight = faArrowRight;
  protected readonly faBookOpen = faBookOpen;
  protected readonly faWheatAwn = faWheatAwn;
  protected readonly faShieldHalved = faShieldHalved;
  protected readonly faPuzzlePiece = faPuzzlePiece;
  protected readonly faCakeCandles = faCakeCandles;
  protected readonly faGithub = faGithub;
  protected readonly faHeart = faHeart;
  protected readonly faMugHot = faMugHot;

  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'Artisan GraphQL Library for Bun Runtime',
      description: 'Leaven is a hand-crafted, high-performance GraphQL library baked fresh for Bun. Features include document caching, real-time subscriptions, NestJS integration, and buttery smooth developer experience.',
      keywords: [
        'GraphQL',
        'Bun',
        'TypeScript',
        'GraphQL library',
        'GraphQL server',
        'real-time subscriptions',
        'WebSocket',
        'NestJS',
        'high-performance',
        'API'
      ],
      canonical: '/',
      ogType: 'website'
    });

    this.seoService.updateStructuredData(
      this.seoService.generateFAQSchema(this.faqs)
    );
  }

  heroCode = `import { createServer } from '@leaven-graphql/http';
import { schema } from './schema';

// 🧑‍🍳 Preheat your GraphQL oven
const server = createServer({
  schema,
  port: 4000,
  playground: true,  // The tasting counter (serves GraphiQL)
});

server.start();
// 🥖 Fresh API served at http://localhost:4000/graphql`;

  features: Feature[] = [
    {
      icon: faFire,
      title: 'Blazing Hot Performance',
      description: 'Fresh from the Bun oven! Native APIs, document caching, and query analysis and complexity scoring for the crispiest execution.',
    },
    {
      icon: faShieldHalved,
      title: 'Buttery Type Safety',
      description: 'Smooth TypeScript support that melts in your development flow. Catch errors before they burn!',
    },
    {
      icon: faPuzzlePiece,
      title: 'Flaky Modularity',
      description: 'Layer by layer, package by package. Take only what you need for the perfect pastry... err, project.',
    },
    {
      icon: faPlug,
      title: 'Plugin Proofing',
      description: 'Let your API rise with plugins for caching, logging, tracing, and more. Patient proofing for perfect results.',
    },
    {
      icon: faTowerBroadcast,
      title: 'Fresh Subscriptions',
      description: 'Real-time updates hot out of the WebSocket oven. Using the graphql-ws protocol for that artisan touch.',
    },
    {
      icon: faCakeCandles,
      title: 'Playground Patisserie',
      description: 'Built-in GraphiQL for decorating and testing your API creations, with GraphQL Playground one handler away.',
    },
  ];

  packages: Package[] = [
    { icon: faGem, name: '@leaven-graphql/core', description: 'The sourdough starter', link: '/executor' },
    { icon: faGlobe, name: '@leaven-graphql/http', description: 'The serving counter', link: '/http' },
    { icon: faTowerBroadcast, name: '@leaven-graphql/ws', description: 'Hot & fresh delivery', link: '/websockets' },
    { icon: faLayerGroup, name: '@leaven-graphql/schema', description: 'Recipe blueprints', link: '/schema' },
    { icon: faLink, name: '@leaven-graphql/context', description: 'Kitchen prep station', link: '/context' },
    { icon: faBell, name: '@leaven-graphql/errors', description: 'Burnt batch handler', link: '/errors' },
    { icon: faPuzzlePiece, name: '@leaven-graphql/plugins', description: 'Secret ingredients', link: '/plugins' },
    { icon: faCakeCandles, name: '@leaven-graphql/playground', description: 'Tasting room', link: '/playground' },
  ];

  faqs: FAQ[] = [
    {
      question: 'What is Leaven?',
      answer: 'Leaven is a high-performance GraphQL library hand-crafted for the Bun runtime. Like the best bread, it\'s risen to perfection with document caching, real-time subscriptions, and a delightful developer experience.'
    },
    {
      question: 'How do I start baking with Leaven?',
      answer: 'Simply run "bun add @leaven-graphql/core graphql" to get started. For the full bakery experience, install "@leaven-graphql/leaven" which includes all our specialty packages.'
    },
    {
      question: 'Does Leaven work with NestJS?',
      answer: 'Absolutely! Our @leaven-graphql/nestjs package provides first-class integration with decorators, guards, and interceptors - all the tools a professional kitchen needs.'
    },
    {
      question: 'Can I get fresh updates in real-time?',
      answer: 'Yes! The @leaven-graphql/ws package delivers hot-out-of-the-oven updates via WebSocket using the graphql-ws protocol. Subscriptions are our specialty!'
    },
    {
      question: 'What makes Leaven so fast?',
      answer: 'We\'ve optimized for Bun\'s oven with native APIs, LRU document caching, cached query plans, and zero bloat. Your API will rise faster than ever!'
    },
    {
      question: 'Is Leaven ready for production?',
      answer: 'Our recipes are thoroughly tested with 90%+ coverage. We include all the safety features: query limits, error handling, and enterprise-grade ingredients.'
    }
  ];
}
