/**
 * @leaven-graphql/playground - GraphiQL tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { renderGraphiQL, createGraphiQLHandler } from './graphiql';

/**
 * Extract the body of the generated inline `<script>` block. External script
 * tags carry attributes (`<script src=...>`), so a bare `<script>` match
 * uniquely identifies the inline block.
 */
function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match || match[1] === undefined) {
    throw new Error('No inline <script> block found');
  }
  return match[1];
}

describe('renderGraphiQL', () => {
  test('should pin exact React versions instead of a floating major', () => {
    const html = renderGraphiQL({ endpoint: '/graphql' });

    expect(html).toContain('https://unpkg.com/react@18.3.1/umd/react.production.min.js');
    expect(html).toContain('https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js');
    expect(html).not.toMatch(/react(-dom)?@18\//);
  });

  test('should render HTML with endpoint', () => {
    const html = renderGraphiQL({ endpoint: '/graphql' });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('/graphql');
    expect(html).toContain('GraphiQL');
  });

  test('should include title', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      title: 'My GraphiQL',
    });

    expect(html).toContain('<title>My GraphiQL</title>');
  });

  test('should include subscription endpoint', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      subscriptionEndpoint: 'ws://localhost:4000/graphql',
    });

    expect(html).toContain('subscriptionUrl');
    expect(html).toContain('ws://localhost:4000/graphql');
  });

  test('should include default query', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      defaultQuery: '{ hello }',
    });

    expect(html).toContain('defaultQuery');
  });

  test('should include default variables', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      defaultVariables: '{ "id": "1" }',
    });

    expect(html).toContain('variables');
  });

  test('should include headers', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      headers: { Authorization: 'Bearer token' },
    });

    expect(html).toContain('Authorization');
  });

  test('should include specified version', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      version: '2.0.0',
    });

    expect(html).toContain('graphiql@2.0.0');
  });

  test('should include explorer plugin by default', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
    });

    expect(html).toContain('plugin-explorer');
  });

  test('should exclude explorer plugin when disabled', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      explorer: false,
    });

    expect(html).not.toContain('plugin-explorer');
  });

  test('should escape HTML in title', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      title: '<script>alert("xss")</script>',
    });

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('should escape HTML in version', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      version: '3.0.10" onerror="alert(1)',
    });

    // The quote must not close the src/href attribute and open an event handler
    expect(html).not.toContain('onerror="alert(1)');
    expect(html).toContain('graphiql@3.0.10&quot; onerror=&quot;alert(1)');
  });

  test('should escape the version in both the stylesheet and script URLs', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      version: '<">',
    });

    expect(html).toContain('graphiql@&lt;&quot;&gt;/graphiql.min.css');
    expect(html).toContain('graphiql@&lt;&quot;&gt;/graphiql.min.js');
  });

  test('should emit valid JavaScript with explorer enabled (default)', () => {
    const html = renderGraphiQL({ endpoint: '/graphql' });
    const script = extractInlineScript(html);

    expect(script).toContain('GraphiQLPluginExplorer.explorerPlugin()');
    expect(script).toContain('plugins: [explorerPlugin]');
    expect(() => new Function(script)).not.toThrow();
  });

  test('should emit valid JavaScript with explorer disabled', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      explorer: false,
    });
    const script = extractInlineScript(html);

    expect(script).not.toContain('explorerPlugin');
    expect(() => new Function(script)).not.toThrow();
  });

  test('should not emit a literal </script> from the default query', () => {
    const html = renderGraphiQL({
      endpoint: '/graphql',
      defaultQuery: '</script><script>alert("pwn")</script>',
    });

    expect(html).not.toContain('</script><script>');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(() => new Function(extractInlineScript(html))).not.toThrow();
  });
});

describe('createGraphiQLHandler', () => {
  test('should create handler function', () => {
    const handler = createGraphiQLHandler({ endpoint: '/graphql' });

    expect(typeof handler).toBe('function');
  });

  test('should return HTML for GET request', () => {
    const handler = createGraphiQLHandler({ endpoint: '/graphql' });
    const request = new Request('http://localhost/graphiql', { method: 'GET' });

    const response = handler(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });

  test('should return 405 for non-GET request', () => {
    const handler = createGraphiQLHandler({ endpoint: '/graphql' });
    const request = new Request('http://localhost/graphiql', { method: 'POST' });

    const response = handler(request);

    expect(response.status).toBe(405);
  });

  test('should include no-store cache control', () => {
    const handler = createGraphiQLHandler({ endpoint: '/graphql' });
    const request = new Request('http://localhost/graphiql', { method: 'GET' });

    const response = handler(request);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
