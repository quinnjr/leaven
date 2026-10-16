/**
 * @leaven-graphql/playground - GraphiQL rendering
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { escapeHtml, toScriptJson } from './escape';

/**
 * GraphiQL configuration
 */
export interface GraphiQLConfig {
  /** GraphQL endpoint URL */
  endpoint: string;
  /** Subscription WebSocket endpoint */
  subscriptionEndpoint?: string;
  /** Page title */
  title?: string;
  /** Default query */
  defaultQuery?: string;
  /** Default variables */
  defaultVariables?: string;
  /** Default headers */
  headers?: Record<string, string>;
  /** GraphiQL version */
  version?: string;
  /** Enable Explorer plugin */
  explorer?: boolean;
}

/**
 * Render GraphiQL HTML
 */
export function renderGraphiQL(config: GraphiQLConfig): string {
  const {
    endpoint,
    subscriptionEndpoint,
    title = 'Leaven GraphiQL',
    defaultQuery = `# Welcome to Leaven GraphiQL
#
# GraphiQL is an in-browser tool for writing, validating, and
# testing GraphQL queries.
#
# Type queries into this side of the screen, and you will see
# intelligent typeaheads aware of the current GraphQL type schema
# and live syntax and validation errors highlighted within the text.
#
# GraphQL queries typically start with a "{" character. Lines that
# start with a # are ignored.
#
# An example GraphQL query might look like:
#
#     {
#       users {
#         id
#         name
#       }
#     }
#
`,
    defaultVariables = '',
    headers = {},
    version = '3.0.10',
    explorer = true,
  } = config;

  const fetcherCode = subscriptionEndpoint
    ? `
    const fetcher = GraphiQL.createFetcher({
      url: ${toScriptJson(endpoint)},
      subscriptionUrl: ${toScriptJson(subscriptionEndpoint)},
      headers: ${toScriptJson(headers)},
    });`
    : `
    const fetcher = GraphiQL.createFetcher({
      url: ${toScriptJson(endpoint)},
      headers: ${toScriptJson(headers)},
    });`;

  const explorerPlugin = explorer
    ? `
    <script src="https://unpkg.com/@graphiql/plugin-explorer@1.0.3/dist/index.umd.js" crossorigin></script>
    <link rel="stylesheet" href="https://unpkg.com/@graphiql/plugin-explorer@1.0.3/dist/style.css" />`
    : '';

  const explorerInit = explorer
    ? `
    const explorerPlugin = GraphiQLPluginExplorer.explorerPlugin();`
    : '';

  const explorerProps = explorer ? `plugins: [explorerPlugin],` : '';

  // `version` lands inside double-quoted `href`/`src` attributes. Without
  // escaping, a value containing `"` closes the attribute early and the rest
  // becomes markup (e.g. an `onerror` handler on the script tag).
  const versionAttr = escapeHtml(version);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/graphiql@${versionAttr}/graphiql.min.css"
  />
  <link
    rel="shortcut icon"
    href="https://graphql.org/favicon.ico"
  />
  ${explorerPlugin}
  <style>
    html, body, #graphiql {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="graphiql">Loading...</div>
  <script
    src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"
    crossorigin
  ></script>
  <script
    src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"
    crossorigin
  ></script>
  <script
    src="https://unpkg.com/graphiql@${versionAttr}/graphiql.min.js"
    crossorigin
  ></script>
  <script>
    ${fetcherCode}
    ${explorerInit}
    const root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(
      React.createElement(GraphiQL, {
        fetcher,
        defaultQuery: ${toScriptJson(defaultQuery)},
        variables: ${toScriptJson(defaultVariables)},
        ${explorerProps}
      })
    );
  </script>
</body>
</html>`;
}

/**
 * Create a Bun request handler for GraphiQL
 */
export function createGraphiQLHandler(config: GraphiQLConfig): (request: Request) => Response {
  const html = renderGraphiQL(config);

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
