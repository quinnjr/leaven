import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

@Component({
  selector: 'app-errors',
  standalone: true,
  imports: [CommonModule, RouterLink, CodeBlockComponent],
  template: `
    <article class="px-6 py-12 lg:py-16 max-w-4xl mx-auto" itemscope itemtype="https://schema.org/TechArticle">
      <!-- Breadcrumb -->
      <nav class="flex items-center gap-2 text-sm text-zinc-500 mb-8" aria-label="Breadcrumb">
        <a routerLink="/" class="hover:text-white transition-colors">Home</a>
        <span>/</span>
        <span class="text-zinc-300">Error Handling</span>
      </nav>

      <!-- Header -->
      <header class="mb-12">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium mb-4">
          🚨 Core Package
        </div>
        <h1 class="text-4xl md:text-5xl font-bold text-white mb-4" itemprop="headline">Error Handling</h1>
        <p class="text-xl text-zinc-400" itemprop="description">
          Handle and format GraphQL errors with &#64;leaven-graphql/errors. Custom error types, masking, and production-safe responses.
        </p>
      </header>

      <!-- Overview -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Overview</h2>
        <p class="text-zinc-400 mb-4">
          The <code class="text-red-400">&#64;leaven-graphql/errors</code> package provides a comprehensive error handling
          system with custom error types, formatting, and masking for production safety.
        </p>
        <div class="card p-6">
          <ul class="space-y-2 text-zinc-300">
            <li><strong class="text-white">Custom Error Types</strong> - Authentication, authorization, validation, etc.</li>
            <li><strong class="text-white">Error Codes</strong> - Standardized error codes for client handling</li>
            <li><strong class="text-white">Error Masking</strong> - Hide internal details in production</li>
            <li><strong class="text-white">Error Formatting</strong> - Consistent error response format</li>
          </ul>
        </div>
      </section>

      <!-- Installation -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Installation</h2>
        <app-code-block [code]="installCode" title="terminal" />
      </section>

      <!-- Error Types -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Error Types</h2>
        <p class="text-zinc-400 mb-4">Leaven provides several built-in error types:</p>
        <app-code-block [code]="typesCode" title="error-types.ts" />
      </section>

      <!-- Using Errors in Resolvers -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Using Errors in Resolvers</h2>
        <p class="text-zinc-400 mb-4">Throw custom errors in your resolvers:</p>
        <app-code-block [code]="resolverCode" title="resolvers.ts" />
      </section>

      <!-- Error Formatting -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Error Formatting</h2>
        <p class="text-zinc-400 mb-4">Format errors for GraphQL responses:</p>
        <app-code-block [code]="formatCode" title="format.ts" />
      </section>

      <!-- Error Masking -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Error Masking</h2>
        <p class="text-zinc-400 mb-4">Mask internal error details in production:</p>
        <app-code-block [code]="maskCode" title="masking.ts" />
      </section>

      <!-- Error Codes -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Error Codes</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-zinc-800">
                <th class="py-3 pr-4 text-zinc-300 font-semibold">Error Type</th>
                <th class="py-3 pr-4 text-zinc-300 font-semibold">Code</th>
                <th class="py-3 text-zinc-300 font-semibold">HTTP Status</th>
              </tr>
            </thead>
            <tbody class="text-zinc-400">
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-red-400">ValidationError</code></td>
                <td class="py-3 pr-4"><code>VALIDATION_ERROR</code></td>
                <td class="py-3">400</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-red-400">AuthenticationError</code></td>
                <td class="py-3 pr-4"><code>UNAUTHENTICATED</code></td>
                <td class="py-3">401</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-red-400">AuthorizationError</code></td>
                <td class="py-3 pr-4"><code>FORBIDDEN</code></td>
                <td class="py-3">403</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-red-400">NotFoundError</code></td>
                <td class="py-3 pr-4"><code>NOT_FOUND</code></td>
                <td class="py-3">404</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-red-400">RateLimitError</code></td>
                <td class="py-3 pr-4"><code>RATE_LIMITED</code></td>
                <td class="py-3">429</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-red-400">ComplexityError</code></td>
                <td class="py-3 pr-4"><code>COMPLEXITY_LIMIT</code></td>
                <td class="py-3">400</td>
              </tr>
              <tr>
                <td class="py-3 pr-4"><code class="text-red-400">DepthLimitError</code></td>
                <td class="py-3 pr-4"><code>DEPTH_LIMIT</code></td>
                <td class="py-3">400</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Integration -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Integration with HTTP</h2>
        <p class="text-zinc-400 mb-4">Configure error handling with &#64;leaven-graphql/http:</p>
        <app-code-block [code]="integrationCode" title="server.ts" />
      </section>

      <!-- Navigation -->
      <nav class="flex items-center justify-between pt-8 border-t border-zinc-800">
        <a routerLink="/plugins" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
          <svg class="w-5 h-5 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"/>
          </svg>
          <div class="text-right">
            <span class="text-xs text-zinc-500 block">Previous</span>
            <span class="font-medium">Plugin System</span>
          </div>
        </a>
        <a routerLink="/http" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-right">
          <div>
            <span class="text-xs text-zinc-500 block">Next</span>
            <span class="font-medium">HTTP Server</span>
          </div>
          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </a>
      </nav>
    </article>
  `,
})
export class ErrorsComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'Error Handling',
      description: 'Handle and format GraphQL errors with @leaven-graphql/errors. Custom error types, error masking, and production-safe responses.',
      keywords: ['GraphQL errors', 'error handling', 'error formatting', 'error masking', 'Leaven'],
      canonical: '/errors',
      ogType: 'article'
    });

    // Emit the JSON-LD counterpart of this page's TechArticle microdata,
    // plus the breadcrumb trail rendered at the top of the article.
    this.seoService.updateStructuredData([
      this.seoService.generateTechArticleSchema({
        title: 'Error Handling',
        description: 'Handle and format GraphQL errors with @leaven-graphql/errors. Custom error types, error masking, and production-safe responses.',
        url: '/errors'
      }),
      this.seoService.generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'Error Handling', url: '/errors' }
      ])
    ]);
  }

  // doc-check: skip - shell command, not TypeScript
  installCode = `bun add @leaven-graphql/errors`;

  typesCode = `import {
  LeavenError,
  ErrorCode,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ComplexityError,
  DepthLimitError,
  InputError,
} from '@leaven-graphql/errors';

// Base error - the code is a positional second argument
throw new LeavenError('Something went wrong', ErrorCode.INTERNAL_ERROR, {
  statusCode: 500,
});

// Authentication required
throw new AuthenticationError('Please log in to continue');

// Permission denied
throw new AuthorizationError('You do not have permission');

// Resource not found
throw new NotFoundError('User not found', {
  resourceType: 'User',
  resourceId: '123',
});

// Input validation failed - second argument is an array of field errors
throw new ValidationError('Invalid input', [
  { field: 'email', message: 'Invalid email format' },
]);`;

  resolverCode = `import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '@leaven-graphql/errors';

const resolvers = {
  Query: {
    me: async (_, __, context) => {
      if (!context.user) {
        throw new AuthenticationError('Authentication required');
      }
      return context.user;
    },

    user: async (_, { id }, context) => {
      const user = await context.db.users.findById(id);
      if (!user) {
        throw new NotFoundError(\`User \${id} not found\`);
      }
      return user;
    },
  },

  Mutation: {
    deleteUser: async (_, { id }, context) => {
      if (context.user.role !== 'admin') {
        throw new AuthorizationError('Admin access required');
      }
      return context.db.users.delete(id);
    },

    createUser: async (_, { input }, context) => {
      if (!isValidEmail(input.email)) {
        throw new ValidationError('Invalid input', [
          { field: 'email', message: 'Invalid email format' },
        ]);
      }
      return context.db.users.create(input);
    },
  },
};`;

  formatCode = `import {
  formatError,
  formatErrors,
  errorToGraphQL,
  fromFormattedError,
} from '@leaven-graphql/errors';

// Format a single error
const formatted = formatError(error, {
  maskErrors: false,
  includeStackTrace: false,
});

// Result:
// {
//   message: "User not found",
//   extensions: {
//     code: "NOT_FOUND",
//     resourceType: "User",
//     resourceId: "123"
//   }
// }

// Format multiple errors
const formattedErrors = formatErrors(errors, options);

// Convert any error to a GraphQLError
const graphqlError = errorToGraphQL(error);

// Executor output is already formatted (GraphQLFormattedError): rebuild it
// first, or formatError would stringify it to "[object Object]"
const reformatted = result.response.errors?.map((e) =>
  formatError(fromFormattedError(e), { maskErrors: true })
);`;

  maskCode = `import { createServer } from '@leaven-graphql/http';
import { maskError } from '@leaven-graphql/errors';

// Mask unexpected errors. Leaven errors (validation, auth, not-found, ...)
// are recognized as intentional and are never masked.
const maskedError = maskError(error, {
  maskErrors: true,
  maskedMessage: 'An unexpected error occurred',
});

// Or decide yourself with a custom predicate
const customMasked = maskError(error, {
  shouldMask: (err) => err.extensions?.code === undefined,
});

// Configure with HTTP server
const server = createServer({
  schema,
  errorFormatting: {
    maskErrors: process.env.NODE_ENV === 'production',
    includeStackTrace: process.env.NODE_ENV !== 'production',
  },
});`;

  integrationCode = `import { createServer } from '@leaven-graphql/http';

const server = createServer({
  schema,

  // Error formatting configuration (ErrorMaskingOptions)
  errorFormatting: {
    // Mask unexpected errors in production.
    // Leaven errors (validation, auth, not-found, ...) stay visible.
    maskErrors: process.env.NODE_ENV === 'production',

    // Include stack traces in development
    includeStackTrace: process.env.NODE_ENV !== 'production',

    // Custom formatter - receives the error and whether it should be masked
    formatter: (error, masked) => {
      // Log all errors
      console.error('GraphQL Error:', error);

      if (masked) {
        return {
          message: 'An unexpected error occurred',
          extensions: { code: 'INTERNAL_ERROR' },
        };
      }

      return {
        message: error.message,
        locations: error.locations,
        path: error.path,
        extensions: error.extensions,
      };
    },
  },
});

server.start();`;
}
