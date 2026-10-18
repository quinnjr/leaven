import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { CodeBlockComponent } from '../components/code-block';
import { SeoService } from '../services/seo.service';

@Component({
  selector: 'app-websockets',
  standalone: true,
  imports: [CommonModule, RouterLink, CodeBlockComponent],
  template: `
    <article class="px-6 py-12 lg:py-16 max-w-4xl mx-auto" itemscope itemtype="https://schema.org/TechArticle">
      <!-- Breadcrumb -->
      <nav class="flex items-center gap-2 text-sm text-zinc-500 mb-8" aria-label="Breadcrumb">
        <a routerLink="/" class="hover:text-white transition-colors">Home</a>
        <span>/</span>
        <span class="text-zinc-300">WebSocket Subscriptions</span>
      </nav>

      <!-- Header -->
      <header class="mb-12">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium mb-4">
          📡 Real-time
        </div>
        <h1 class="text-4xl md:text-5xl font-bold text-white mb-4" itemprop="headline">WebSocket Subscriptions</h1>
        <p class="text-xl text-zinc-400" itemprop="description">
          Implement real-time GraphQL subscriptions with &#64;leaven-graphql/ws using the graphql-ws protocol.
        </p>
      </header>

      <!-- Overview -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Overview</h2>
        <p class="text-zinc-400 mb-4">
          The <code class="text-green-400">&#64;leaven-graphql/ws</code> package provides WebSocket support for
          GraphQL subscriptions using the standard graphql-ws protocol.
        </p>
        <div class="card p-6">
          <ul class="space-y-2 text-zinc-300">
            <li><strong class="text-white">graphql-ws Protocol</strong> - Industry-standard subscription protocol</li>
            <li><strong class="text-white">Built-in PubSub</strong> - Simple event publishing system</li>
            <li><strong class="text-white">Connection Management</strong> - Automatic keep-alive and cleanup</li>
            <li><strong class="text-white">Authentication</strong> - Secure connection initialization</li>
          </ul>
        </div>
      </section>

      <!-- Installation -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Installation</h2>
        <app-code-block [code]="installCode" title="terminal" />
      </section>

      <!-- Quick Start -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Quick Start</h2>
        <p class="text-zinc-400 mb-4">Set up subscriptions with PubSub:</p>
        <app-code-block [code]="quickStartCode" title="subscriptions.ts" />
      </section>

      <!-- PubSub -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Using PubSub</h2>
        <p class="text-zinc-400 mb-4">The built-in PubSub for publishing events:</p>
        <app-code-block [code]="pubsubCode" title="pubsub.ts" />
      </section>

      <!-- Subscription Resolvers -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Subscription Resolvers</h2>
        <p class="text-zinc-400 mb-4">Create subscription resolvers with filters:</p>
        <app-code-block [code]="resolversCode" title="resolvers.ts" />
      </section>

      <!-- Authentication -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Authentication</h2>
        <p class="text-zinc-400 mb-4">
          Authenticate WebSocket connections in the <code class="text-green-400">onConnect</code> hook —
          returning <code class="text-green-400">false</code> rejects the connection:
        </p>
        <app-code-block [code]="authCode" title="auth.ts" />
      </section>

      <!-- Error masking -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Error Formatting</h2>
        <p class="text-zinc-400 mb-4">
          <code class="text-green-400">errorFormatting</code> takes the same options as the HTTP
          transport. Errors thrown by <code class="text-green-400">onSubscribe</code>, the context
          factory or a source stream always go through <code class="text-green-400">formatError</code>,
          so coded errors keep their <code class="text-green-400">extensions.code</code>; execution
          errors in <code class="text-green-400">next</code> payloads are re-formatted when the option
          is set. Turn on <code class="text-green-400">maskErrors</code> in production so a failing
          context factory never sends its raw message to the client:
        </p>
        <app-code-block [code]="errorFormattingCode" title="masking.ts" />
      </section>

      <!-- Protocol Messages -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Protocol Messages</h2>
        <p class="text-zinc-400 mb-4">
          If you drive the protocol yourself, the message helpers are exported directly. The
          <code class="text-green-400">create*</code> factories return message
          <strong class="text-white">objects</strong>, so pass them through
          <code class="text-green-400">formatMessage</code> before sending:
        </p>
        <app-code-block [code]="protocolCode" title="protocol.ts" />
      </section>

      <!-- Schema -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Subscription Schema</h2>
        <p class="text-zinc-400 mb-4">Define subscriptions in your schema:</p>
        <app-code-block [code]="schemaCode" title="schema.graphql" language="graphql" />
      </section>

      <!-- Client Usage -->
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Client Usage</h2>
        <p class="text-zinc-400 mb-4">Connect from a client using graphql-ws:</p>
        <app-code-block [code]="clientCode" title="client.ts" />
      </section>

      <!-- Server-Sent Events -->
      <section id="server-sent-events" class="mb-12">
        <h2 class="text-2xl font-semibold text-white mb-4">Server-Sent Events</h2>
        <p class="text-zinc-400 mb-4">
          Prefer plain HTTP to WebSockets? <code class="text-green-400">&#64;leaven-graphql/sse</code>
          implements the graphql-sse protocol in <strong class="text-white">distinct connections
          mode</strong>: each operation gets its own request and event stream. It is off by default;
          enable it with the <code class="text-green-400">sse</code> option:
        </p>
        <app-code-block [code]="sseServerCode" title="server.ts" />
        <p class="text-zinc-400 mt-6 mb-4">Connect from the browser with the graphql-sse client:</p>
        <app-code-block [code]="sseClientCode" title="client.ts" />
        <p class="text-zinc-400 mt-6 mb-4">
          Mutations sent with <code class="text-green-400">GET</code> are rejected with
          <code class="text-green-400">405</code> and <code class="text-green-400">Allow: POST</code>.
          A keep-alive comment is sent every 8000 ms by default (<code class="text-green-400">0</code>
          disables it) to stay under Bun's 10 second idle timeout; the server turns that timeout off while
          a stream is open and restores it afterwards. Over HTTP/1.1 browsers allow only about 6 connections per origin, so many live
          subscriptions on one page call for HTTP/2.
        </p>
        <p class="text-zinc-400 mb-4">
          Only request errors (no <code class="text-green-400">data</code> and no error
          <code class="text-green-400">path</code>, such as a validation error) are answered as non-200 JSON.
          Execution errors are streamed, because the graphql-sse client retries every non-200 response
          (<code class="text-green-400">retryAttempts</code>, default 5), and a retried mutation would run again.
        </p>
        <p class="text-zinc-400 mb-4">
          Frameworks that own routing, such as Knead, can use the low-level API: build the context, run the operation with
          <code class="text-green-400">executor.subscribe</code> or <code class="text-green-400">executor.execute</code>,
          answer request errors as plain JSON, stream the rest, and mask errors with
          <code class="text-green-400">formatResultErrors</code>:
        </p>
        <app-code-block [code]="sseLowLevelCode" title="custom-transport.ts" />
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
                <td class="py-3 pr-4"><code class="text-green-400">createWebSocketHandler</code></td>
                <td class="py-3">Create a WebSocketHandler that speaks the full protocol</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">WebSocketHandler</code></td>
                <td class="py-3">
                  Handler class; <code class="text-green-400">getWebSocketConfig()</code> returns Bun's
                  open/message/close callbacks
                </td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">createSubscriptionManager</code></td>
                <td class="py-3">Track subscriptions per connection; accepts a shared executor</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">PubSub</code></td>
                <td class="py-3">Event publishing/subscription system</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">createPubSub</code></td>
                <td class="py-3">Create a PubSub instance</td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">parseMessage</code></td>
                <td class="py-3">
                  Parse graphql-ws messages; <code class="text-green-400">{{ '{' }} requireId {{ '}' }}</code>
                  defaults to <code class="text-green-400">true</code>, which also requires
                  <code class="text-green-400">subscribe</code>/<code class="text-green-400">complete</code>
                  ids to match <code class="text-green-400">OPERATION_ID_PATTERN</code>
                </td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">isValidOperationId</code></td>
                <td class="py-3">
                  Check a client operation id against
                  <code class="text-green-400">^[A-Za-z0-9_.:-]{{ '{' }}1,64{{ '}' }}$</code>; the server closes
                  with 4400 on anything else
                </td>
              </tr>
              <tr class="border-b border-zinc-800/50">
                <td class="py-3 pr-4"><code class="text-green-400">formatMessage</code></td>
                <td class="py-3">Serialize a message object for sending</td>
              </tr>
              <tr>
                <td class="py-3 pr-4"><code class="text-green-400">createNextMessage</code></td>
                <td class="py-3">Build a subscription data message object</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Navigation -->
      <nav class="flex items-center justify-between pt-8 border-t border-zinc-800">
        <a routerLink="/http" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
          <svg class="w-5 h-5 group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"/>
          </svg>
          <div class="text-right">
            <span class="text-xs text-zinc-500 block">Previous</span>
            <span class="font-medium">HTTP Server</span>
          </div>
        </a>
        <a routerLink="/nestjs" class="group flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-right">
          <div>
            <span class="text-xs text-zinc-500 block">Next</span>
            <span class="font-medium">NestJS Integration</span>
          </div>
          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
          </svg>
        </a>
      </nav>
    </article>
  `,
})
export class WebsocketsComponent implements OnInit {
  constructor(private seoService: SeoService) {}

  ngOnInit(): void {
    this.seoService.updatePageSEO({
      title: 'WebSocket Subscriptions',
      description: 'Implement real-time GraphQL subscriptions with @leaven-graphql/ws using the graphql-ws protocol and built-in PubSub.',
      keywords: ['GraphQL subscriptions', 'WebSocket', 'real-time GraphQL', 'PubSub', 'Leaven'],
      canonical: '/websockets',
      ogType: 'article'
    });

    // Emit the JSON-LD counterpart of this page's TechArticle microdata,
    // plus the breadcrumb trail rendered at the top of the article.
    this.seoService.updateStructuredData([
      this.seoService.generateTechArticleSchema({
        title: 'WebSocket Subscriptions',
        description: 'Implement real-time GraphQL subscriptions with @leaven-graphql/ws using the graphql-ws protocol and built-in PubSub.',
        url: '/websockets'
      }),
      this.seoService.generateBreadcrumbSchema([
        { name: 'Home', url: '/' },
        { name: 'WebSocket Subscriptions', url: '/websockets' }
      ])
    ]);
  }

  // doc-check: skip - shell command, not TypeScript
  installCode = `bun add @leaven-graphql/ws @leaven-graphql/core graphql`;

  quickStartCode = `import { createServer } from '@leaven-graphql/http';
import { createPubSub, createWebSocketHandler } from '@leaven-graphql/ws';
import { schema } from './schema';

// Create PubSub instance
export const pubsub = createPubSub();

// The handler speaks the whole graphql-transport-ws protocol: connection_init,
// subscribe, next, complete, ping/pong keep-alives and teardown.
const websocket = createWebSocketHandler({
  schema,
  connectionInitTimeout: 3000,  // Default: 3000ms
  keepAliveInterval: 12000,     // Default: 12000ms
  context: (socket, request) => ({ connectionId: socket.data.connectionId, request }),
});

// createServer upgrades GET requests to the GraphQL path that carry
// "Upgrade: websocket" and routes them to the handler.
const server = createServer({
  schema,
  port: 4000,
  path: '/graphql',
  websocket,
});

server.start();

// Standalone Bun.serve instead? getWebSocketConfig() returns the
// open/message/close callbacks Bun expects:
// Bun.serve({ fetch, websocket: websocket.getWebSocketConfig() });`;

  pubsubCode = `import { PubSub, createPubSub } from '@leaven-graphql/ws';

// Create with default config
const pubsub = createPubSub();

// Or with custom config — PubSubConfig has exactly these three options
const customPubSub = createPubSub({
  maxSubscribersPerTopic: 1000,  // Default: 10000; subscribe() throws past it
  wildcards: true,               // Enable dot-segmented topic wildcards
  maxQueueSize: 100,             // asyncIterator buffer; drops OLDEST when full
});

// Subscribe to a topic
const unsubscribe = pubsub.subscribe('user:created', (payload) => {
  console.log('New user:', payload);
});

// Publish an event
pubsub.publish('user:created', {
  id: '123',
  name: 'Alice',
  email: 'alice@example.com',
});

// Unsubscribe when done
unsubscribe();

// Wildcards (when enabled) split topics on '.': '*' matches one segment,
// '#' matches the rest of the topic.
customPubSub.subscribe('user.*.created', onAnyTenantUserCreated);
customPubSub.subscribe('user.#', onAnyUserEvent);

// Create an async iterator for subscriptions (one topic or several)
const iterator = pubsub.asyncIterator('messages:new');
const multi = pubsub.asyncIterator(['messages:new', 'messages:edited']);

// Use in a subscribe resolver
async function* messageAdded() {
  for await (const event of iterator) {
    yield event;
  }
}

// Introspection helpers
pubsub.getSubscriberCount('messages:new');
pubsub.getTopics();
pubsub.clear();`;

  resolversCode = `import { createPubSub } from '@leaven-graphql/ws';

const pubsub = createPubSub();

const resolvers = {
  Subscription: {
    // Simple subscription
    messageAdded: {
      subscribe: () => pubsub.asyncIterator('MESSAGE_ADDED'),
    },

    // Subscription with filter
    messageAddedToRoom: {
      subscribe: (_, { roomId }) => {
        // Only receive messages for this room
        return pubsub.asyncIterator(\`MESSAGE_ADDED:\${roomId}\`);
      },
    },

    // Subscription with resolver
    userStatusChanged: {
      subscribe: () => pubsub.asyncIterator('USER_STATUS'),
      resolve: (payload, _, context) => {
        // Transform the payload
        return {
          ...payload,
          timestamp: new Date().toISOString(),
        };
      },
    },
  },

  Mutation: {
    sendMessage: async (_, { roomId, content }, context) => {
      const message = await context.db.messages.create({
        roomId,
        content,
        authorId: context.user.id,
      });

      // Publish to subscribers
      pubsub.publish(\`MESSAGE_ADDED:\${roomId}\`, message);
      pubsub.publish('MESSAGE_ADDED', message);

      return message;
    },
  },
};`;

  authCode = `import { createWebSocketHandler } from '@leaven-graphql/ws';

// Preferred: let the handler run the protocol and authenticate in onConnect.
// Returning false rejects the connection with 4403 Forbidden.
const websocket = createWebSocketHandler({
  schema,
  async onConnect(socket, params) {
    const user = await verifyToken(params?.['authToken']);
    if (!user) {
      return false;
    }
    // Stash whatever later hooks need on the socket's connection params
    socket.data.connectionParams = { ...params, userId: user.id };
    return true;
  },
  context: (socket) => ({ user: socket.data.connectionParams?.['userId'] }),
  onSubscribe: (socket, id, request) => {
    console.log('subscribe', id, request.operationName);
  },
  onDisconnect: (socket) => {
    console.log('closed', socket.data.connectionId);
  },
});`;

  errorFormattingCode = `import { createWebSocketHandler } from '@leaven-graphql/ws';

const websocket = createWebSocketHandler({
  schema,
  context: async () => ({ db: await getDatabase() }),
  // Unexpected errors become "An unexpected error occurred"; Leaven errors and
  // errors with a known code (FORBIDDEN, UNAUTHENTICATED, ...) pass through
  errorFormatting: { maskErrors: process.env.NODE_ENV === 'production' },
});`;

  protocolCode = `import {
  MessageType,
  parseMessage,
  formatMessage,
  createConnectionAck,
  createNextMessage,
  createErrorMessage,
  createCompleteMessage,
  createPongMessage,
  isValidOperationId,
} from '@leaven-graphql/ws';

// parseMessage(data, options). requireId defaults to true, which is correct
// for a SERVER parsing client frames: subscribe/next/error/complete without a
// routable id are rejected, and a subscribe/complete id outside
// ^[A-Za-z0-9_.:-]{1,64}$ throws 'Invalid message' (the handler closes 4400). Pass { requireId: false } on the CLIENT, where a
// lenient peer may omit it and a throw would tear down the connection.
const message = parseMessage(data);
const lenient = parseMessage(data, { requireId: false });

// The create* factories return message OBJECTS, not strings — pass them
// through formatMessage before sending them over the socket.
socket.send(formatMessage(createConnectionAck()));
socket.send(formatMessage(createNextMessage(id, result.data, result.errors)));
socket.send(formatMessage(createErrorMessage(id, [{ message: 'Boom' }])));
socket.send(formatMessage(createCompleteMessage(id)));

if (message.type === MessageType.Ping) {
  socket.send(formatMessage(createPongMessage()));
}

isValidOperationId('sub-1'); // true
isValidOperationId('a\\nb'); // false: control characters are never accepted`;

  // doc-check: skip - GraphQL SDL, not TypeScript
  schemaCode = `type Subscription {
  # Simple subscription
  messageAdded: Message!

  # Subscription with argument
  messageAddedToRoom(roomId: ID!): Message!

  # User status updates
  userStatusChanged(userId: ID): UserStatus!

  # Real-time notifications
  notificationReceived: Notification!
}

type Message {
  id: ID!
  content: String!
  author: User!
  room: Room!
  createdAt: DateTime!
}

type UserStatus {
  user: User!
  status: Status!
  lastSeen: DateTime
}

enum Status {
  ONLINE
  AWAY
  OFFLINE
}`;

  clientCode = `import { createClient } from 'graphql-ws';

// Create WebSocket client
const client = createClient({
  url: 'ws://localhost:4000/graphql',
  connectionParams: {
    authToken: 'your-jwt-token',
  },
});

// Subscribe to messages
const unsubscribe = client.subscribe(
  {
    query: \`
      subscription OnMessageAdded($roomId: ID!) {
        messageAddedToRoom(roomId: $roomId) {
          id
          content
          author {
            name
          }
        }
      }
    \`,
    variables: { roomId: 'room-123' },
  },
  {
    next: (data) => {
      console.log('New message:', data);
    },
    error: (error) => {
      console.error('Subscription error:', error);
    },
    complete: () => {
      console.log('Subscription completed');
    },
  }
);

// Later: unsubscribe
unsubscribe();`;

  sseServerCode = `import { createServer } from '@leaven-graphql/http';
import { schema } from './schema';

createServer({
  schema,
  // true, or tune the keep-alive comment interval in milliseconds
  sse: { keepAliveInterval: 5000 },
}).start();`;

  sseClientCode = `import { createClient } from 'graphql-sse';

const client = createClient({ url: '/graphql' });

for await (const result of client.iterate({
  query: 'subscription { messageAdded { id content } }',
})) {
  console.log('New message:', result.data);
}`;

  sseLowLevelCode = `import { getOperationAST } from 'graphql';
import { LeavenExecutor, type GraphQLRequest, type GraphQLResponse } from '@leaven-graphql/core';
import { formatErrors } from '@leaven-graphql/errors';
import {
  acceptsEventStream,
  createEventStreamResponse,
  formatResultErrors,
  isSubscriptionIterator,
} from '@leaven-graphql/sse';
import { schema } from './schema';

const executor = new LeavenExecutor({ schema });

// Mask unexpected errors; intentional Leaven errors keep their code and path
const masking = { maskErrors: true };

// Request errors all answer 400 here for brevity; @leaven-graphql/http derives
// the status from each error's code instead
const json = (body: GraphQLResponse, status = 400): Response => Response.json(body, { status });

// Rejected before anything ran: no data and no error path. Everything else,
// data: null included, ran resolvers and must be streamed, or the client's
// retries would run them again.
const isRequestError = (response: GraphQLResponse): boolean =>
  response.data === undefined && !response.errors?.some((error) => error.path);

export async function handleGraphQL(request: Request): Promise<Response> {
  if (!acceptsEventStream(request)) {
    return new Response('Not Acceptable', { status: 406 });
  }

  const graphqlRequest = (await request.json()) as GraphQLRequest;
  const context = { user: request.headers.get('authorization') };

  // executor.parse applies the executor's parser limits; a syntax error throws
  let operation;
  try {
    operation = getOperationAST(
      await executor.parse(graphqlRequest.query),
      graphqlRequest.operationName
    );
  } catch (error) {
    return json({ errors: formatErrors([error], masking) });
  }
  if (!operation) {
    return json({ errors: [{ message: 'Unknown operation' }] });
  }

  // Subscriptions go through subscribe, queries and mutations through execute
  const source =
    operation.operation === 'subscription'
      ? await executor.subscribe(graphqlRequest, context)
      : (await executor.execute(graphqlRequest, context)).response;

  if (!isSubscriptionIterator(source) && isRequestError(source)) {
    return json(formatResultErrors(source, masking));
  }

  return createEventStreamResponse(source, {
    // Closing the connection ends the stream and returns the iterator
    signal: request.signal,
    // Mask every result's errors before it is serialised
    formatResult: (response) => formatResultErrors(response, masking),
  });
}`;
}
