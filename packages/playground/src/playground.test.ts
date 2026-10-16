/**
 * @leaven-graphql/playground - Playground tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { renderPlayground, createPlaygroundHandler } from './playground';

describe('renderPlayground', () => {
  test('should load graphql-playground-react 1.7.28 (CVE-2021-41249 fix)', () => {
    const html = renderPlayground({ endpoint: '/graphql' });
    const versions = [...html.matchAll(/graphql-playground-react@([^/"]+)\//g)].map((m) => m[1]);

    expect(versions.length).toBe(3);
    expect(new Set(versions)).toEqual(new Set(['1.7.28']));
    expect(html).toContain(
      'https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.28/build/static/js/middleware.js'
    );
  });

  test('should render HTML with endpoint', () => {
    const html = renderPlayground({ endpoint: '/graphql' });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('/graphql');
    expect(html).toContain('GraphQLPlayground');
  });

  test('should include title', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      title: 'My GraphQL API',
    });

    expect(html).toContain('<title>My GraphQL API</title>');
  });

  test('should include subscription endpoint', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      subscriptionEndpoint: 'ws://localhost:4000/graphql',
    });

    expect(html).toContain('ws://localhost:4000/graphql');
  });

  test('should apply dark theme', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      theme: 'dark',
    });

    expect(html).toContain('#0f0f0f'); // Dark background
  });

  test('should apply light theme', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      theme: 'light',
    });

    expect(html).toContain('#f5f5f5'); // Light background
  });

  test('should include default query', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      defaultQuery: '{ hello }',
    });

    expect(html).toContain('{ hello }');
  });

  test('should include default variables', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      defaultVariables: '{ "id": "1" }',
    });

    expect(html).toContain('{ \\"id\\": \\"1\\" }');
  });

  test('should include headers', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      headers: { Authorization: 'Bearer token' },
    });

    expect(html).toContain('Authorization');
    expect(html).toContain('Bearer token');
  });

  test('should escape HTML in title', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      title: '<script>alert("xss")</script>',
    });

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('should not emit a literal </script> from the default query', () => {
    const html = renderPlayground({
      endpoint: '/graphql',
      defaultQuery: '</script><script>alert("pwn")</script>',
    });

    expect(html).not.toContain('</script><script>');
    expect(html).toContain('\\u003c/script\\u003e');
  });
});

describe('createPlaygroundHandler', () => {
  test('should create handler function', () => {
    const handler = createPlaygroundHandler({ endpoint: '/graphql' });

    expect(typeof handler).toBe('function');
  });

  test('should return HTML for GET request', () => {
    const handler = createPlaygroundHandler({ endpoint: '/graphql' });
    const request = new Request('http://localhost/playground', { method: 'GET' });

    const response = handler(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });

  test('should return 405 for non-GET request', () => {
    const handler = createPlaygroundHandler({ endpoint: '/graphql' });
    const request = new Request('http://localhost/playground', { method: 'POST' });

    const response = handler(request);

    expect(response.status).toBe(405);
  });

  test('should include no-store cache control', async () => {
    const handler = createPlaygroundHandler({ endpoint: '/graphql' });
    const request = new Request('http://localhost/playground', { method: 'GET' });

    const response = handler(request);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
