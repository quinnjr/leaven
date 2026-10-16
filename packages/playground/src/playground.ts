/**
 * @leaven-graphql/playground - GraphQL Playground rendering
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { escapeHtml, toScriptJson } from './escape';

/**
 * Playground theme
 */
export type PlaygroundTheme = 'dark' | 'light';

/**
 * Playground configuration
 */
export interface PlaygroundConfig {
  /** GraphQL endpoint URL */
  endpoint: string;
  /** Subscription WebSocket endpoint */
  subscriptionEndpoint?: string;
  /** Page title */
  title?: string;
  /** Theme */
  theme?: PlaygroundTheme;
  /** Default query */
  defaultQuery?: string;
  /** Default variables */
  defaultVariables?: string;
  /** Default headers */
  headers?: Record<string, string>;
  /** Enable settings */
  settings?: {
    'editor.theme'?: PlaygroundTheme;
    'editor.fontSize'?: number;
    'editor.fontFamily'?: string;
    'request.credentials'?: 'include' | 'omit' | 'same-origin';
    'tracing.hideTracingResponse'?: boolean;
  };
}

/**
 * Render GraphQL Playground HTML
 */
export function renderPlayground(config: PlaygroundConfig): string {
  const {
    endpoint,
    subscriptionEndpoint,
    title = 'Leaven GraphQL Playground',
    theme = 'dark',
    defaultQuery = '',
    defaultVariables = '',
    headers = {},
    settings = {},
  } = config;

  const playgroundSettings = {
    'editor.theme': theme,
    'editor.fontSize': 14,
    'editor.fontFamily': "'Source Code Pro', 'Consolas', 'Monaco', monospace",
    'request.credentials': 'include',
    ...settings,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/static/css/index.css"
  />
  <link
    rel="shortcut icon"
    href="https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/favicon.png"
  />
  <script src="https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/static/js/middleware.js"></script>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
    }
    #root {
      height: 100%;
    }
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: ${theme === 'dark' ? '#0f0f0f' : '#f5f5f5'};
      color: ${theme === 'dark' ? '#fff' : '#333'};
    }
  </style>
</head>
<body>
  <div id="root">
    <div class="loading">Loading Playground...</div>
  </div>
  <script>
    window.addEventListener('load', function() {
      GraphQLPlayground.init(document.getElementById('root'), {
        endpoint: ${toScriptJson(endpoint)},
        ${subscriptionEndpoint ? `subscriptionEndpoint: ${toScriptJson(subscriptionEndpoint)},` : ''}
        settings: ${toScriptJson(playgroundSettings)},
        tabs: [{
          endpoint: ${toScriptJson(endpoint)},
          ${subscriptionEndpoint ? `subscriptionEndpoint: ${toScriptJson(subscriptionEndpoint)},` : ''}
          query: ${toScriptJson(defaultQuery)},
          variables: ${toScriptJson(defaultVariables)},
          headers: ${toScriptJson(headers)},
        }],
      });
    });
  </script>
</body>
</html>`;
}

/**
 * Create a Bun request handler for the playground
 */
export function createPlaygroundHandler(config: PlaygroundConfig): (request: Request) => Response {
  const html = renderPlayground(config);

  return (request: Request): Response => {
    // Only serve on GET requests
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  };
}
