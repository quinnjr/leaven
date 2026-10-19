# @leaven-graphql/ws

WebSocket support for GraphQL subscriptions using the graphql-ws protocol.

## Installation

```bash
bun add @leaven-graphql/ws @leaven-graphql/core graphql
```

## Quick Start

`createWebSocketHandler` implements the whole `graphql-ws` server: connection
init and acknowledgement, keep-alive pings, subscription lifecycle, and the
protocol close codes. Hand it to `Bun.serve` via `getWebSocketConfig()`.

```typescript
import { createWebSocketHandler, type WebSocketContext } from '@leaven-graphql/ws';

const handler = createWebSocketHandler({
  schema,
  // Optional: build the GraphQL context for every operation
  context: (socket) => ({ user: socket.data.connectionParams?.user }),
});

Bun.serve({
  port: 4000,
  fetch(request, server) {
    if (!handler.isOriginAllowed(request)) {
      return new Response('Forbidden', { status: 403 });
    }
    // Bun's types require the `data` option, but the handler's `open` replaces
    // socket.data with a fresh WebSocketContext, so nothing needs stashing.
    if (server.upgrade(request, { data: undefined as unknown as WebSocketContext })) {
      return;
    }
    return new Response('Not Found', { status: 404 });
  },
  websocket: handler.getWebSocketConfig(),
});
```

Queries and mutations are supported on the same transport: per the `graphql-ws`
protocol, a `subscribe` frame carrying a query or mutation is answered with a
single `next` followed by `complete`. Failures before execution (validation,
variable coercion) come back as an `error` frame instead; resolver errors ride
inside the `next` payload.

Serving HTTP and WebSocket from one server is a matter of passing the handler
to `@leaven-graphql/http`. Subscriptions do **not** inherit the HTTP
executor's options, so state them for both transports — otherwise the
longest-lived transport quietly runs on executor defaults:

```typescript
import { createServer } from '@leaven-graphql/http';
import { createWebSocketHandler } from '@leaven-graphql/ws';

const executor = { introspection: false, maxDepth: 10 };

createServer({
  schema,
  executor,
  websocket: createWebSocketHandler({
    schema,
    subscriptionManager: { executor },
  }),
}).start();
```

## Features

### PubSub

Built-in event publishing system:

```typescript
import { PubSub, createPubSub } from '@leaven-graphql/ws';

const pubsub = createPubSub();

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

// Unsubscribe
unsubscribe();

// Create async iterator for subscriptions
const iterator = pubsub.asyncIterator('messages:new');
```

### Subscription Resolvers

```typescript
import { createPubSub } from '@leaven-graphql/ws';

const pubsub = createPubSub();

const resolvers = {
  Subscription: {
    messageAdded: {
      subscribe: () => pubsub.asyncIterator('MESSAGE_ADDED'),
    },

    messageAddedToRoom: {
      subscribe: (_, { roomId }) => {
        return pubsub.asyncIterator(`MESSAGE_ADDED:${roomId}`);
      },
    },

    userStatusChanged: {
      subscribe: () => pubsub.asyncIterator('USER_STATUS'),
      resolve: (payload, _, context) => ({
        ...payload,
        timestamp: new Date().toISOString(),
      }),
    },
  },

  Mutation: {
    sendMessage: async (_, { roomId, content }, context) => {
      const message = await context.db.messages.create({
        roomId,
        content,
        authorId: context.user.id,
      });

      pubsub.publish(`MESSAGE_ADDED:${roomId}`, message);
      pubsub.publish('MESSAGE_ADDED', message);

      return message;
    },
  },
};
```

### Authentication

Authenticate in `onConnect`. Returning `false`, or throwing, closes the socket
with `4403`. `onConnect` gets `connectionInitTimeout` (counted from
`connection_init`) to settle: if it has not, the socket is closed with `4408`
and its late result is ignored (no ack, no keep-alive; a late rejection is
logged). No `subscribe` frame is accepted before a connection is acknowledged
(unacknowledged operations are closed with `4401`).

```typescript
import { createWebSocketHandler } from '@leaven-graphql/ws';

const users = new WeakMap<object, User>();

const handler = createWebSocketHandler({
  schema,
  async onConnect(socket, params) {
    try {
      users.set(socket, await verifyToken(params?.authToken as string));
      return true;
    } catch {
      return false;
    }
  },
  context: (socket) => ({ user: users.get(socket) }),
  onDisconnect(socket) {
    users.delete(socket);
  },
});
```

The lifecycle hooks may be async; a hook that rejects is logged and never
takes the connection (or the process) down with it.

### Allowed Origins

Browsers send cookies with a cross-site WebSocket handshake and no CORS
preflight applies, so a server that accepts any `Origin` is open to
cross-site WebSocket hijacking. By default only the server's own origin may
connect: the `Origin` header's host:port must equal the upgrade request's
`Host` header (case-insensitive, default ports normalised). A request with
no `Origin` header (a non-browser client) is always allowed.

Behind a reverse proxy that rewrites `Host` (nginx does by default), every
genuine browser is refused: forward the public Host (`proxy_set_header Host
$host`) or list the public origin in `allowedOrigins`.

`LeavenServer` checks `isOriginAllowed(request)` before upgrading and answers
`403 Forbidden` when it fails. Cross-origin browser clients must be listed,
or allowed with `'*'`:

```typescript
const handler = createWebSocketHandler({
  schema,
  // Added to the server's own origin; '*' allows any origin
  allowedOrigins: ['https://app.example.com'],
});
```

With a standalone `Bun.serve`, call the check yourself before
`server.upgrade()`:

```typescript
Bun.serve({
  fetch(request, server) {
    if (!handler.isOriginAllowed(request)) {
      return new Response('Forbidden', { status: 403 });
    }
    const data = { connectionId: '', initialized: false, subscriptions: new Set<string>() };
    if (server.upgrade(request, { data })) {
      return undefined;
    }
    return new Response('Upgrade failed', { status: 400 });
  },
  websocket: handler.getWebSocketConfig(),
});
```

### Error Formatting and Masking

`errorFormatting` takes the same `ErrorMaskingOptions` as the HTTP
transport's option of that name, and is applied the same way:

- An error thrown by `onSubscribe`, the context factory or a source stream is
  sent through `formatError(error, errorFormatting)` from
  `@leaven-graphql/errors`. Only a `LeavenError`, or an error with a
  known code other than `INTERNAL_ERROR`, keeps its message and
  `extensions.code`; anything else (including an uncoded `GraphQLError`) is
  masked and reported with `INTERNAL_ERROR`. `maskErrors` defaults to `true`
  for these, so set `errorFormatting: { maskErrors: false }` to send the raw
  message.
- Execution errors the executor already serialised (the `errors` of a `next`
  payload, or of an `error` frame for a rejected operation) are re-formatted
  only when `errorFormatting` is set, as HTTP does.

```typescript
import { createWebSocketHandler } from '@leaven-graphql/ws';

const handler = createWebSocketHandler({
  schema,
  context: async () => ({ db: await getDatabase() }),
  // A failing getDatabase() is sent as "An unexpected error occurred", not the DSN.
  // Thrown errors are masked even without errorFormatting; setting it also
  // masks errors resolvers raise in `next` payloads.
  errorFormatting: { maskErrors: true },
});

// Explicit opt-out: thrown errors reach the client with their raw message
createWebSocketHandler({ schema, errorFormatting: { maskErrors: false } });
```

Thrown errors are masked unless `maskErrors` is explicitly `false`. Errors
with a known Leaven code other than `INTERNAL_ERROR` (an `AuthenticationError`, a `FORBIDDEN` `GraphQLError`, the
`BAD_REQUEST` sent when `maxSubscriptionsPerConnection` is reached) are never
masked.

### Schema Definition

```graphql
type Subscription {
  messageAdded: Message!
  messageAddedToRoom(roomId: ID!): Message!
  userStatusChanged(userId: ID): UserStatus!
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
}
```

### Client Usage

```typescript
import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'ws://localhost:4000/graphql',
  connectionParams: {
    authToken: 'your-jwt-token',
  },
});

const unsubscribe = client.subscribe(
  {
    query: `
      subscription OnMessageAdded($roomId: ID!) {
        messageAddedToRoom(roomId: $roomId) {
          id
          content
          author { name }
        }
      }
    `,
    variables: { roomId: 'room-123' },
  },
  {
    next: (data) => console.log('New message:', data),
    error: (error) => console.error('Error:', error),
    complete: () => console.log('Completed'),
  }
);

// Later: unsubscribe
unsubscribe();
```

## API Reference

### WebSocketHandler

The `graphql-ws` server. `getWebSocketConfig()` returns the object `Bun.serve`
expects under `websocket`.

```typescript
class WebSocketHandler<TContext = unknown> {
  constructor(config: WebSocketHandlerConfig<TContext>);

  handleOpen(socket: ServerWebSocket<WebSocketContext>): void;
  handleMessage(
    socket: ServerWebSocket<WebSocketContext>,
    message: string | Buffer
  ): Promise<void>;
  handleClose(socket: ServerWebSocket<WebSocketContext>): Promise<void>;

  /** Whether an upgrade request's Origin is allowed (see allowedOrigins) */
  isOriginAllowed(request: Request): boolean;

  getWebSocketConfig(): {
    open: (socket: ServerWebSocket<WebSocketContext>) => void;
    message: (
      socket: ServerWebSocket<WebSocketContext>,
      message: string | Buffer
    ) => void;
    close: (socket: ServerWebSocket<WebSocketContext>) => void;
  };
}

function createWebSocketHandler<TContext = unknown>(
  config: WebSocketHandlerConfig<TContext>
): WebSocketHandler<TContext>;

interface WebSocketHandlerConfig<TContext = unknown> {
  /** GraphQL schema */
  schema: GraphQLSchema;
  /** Builds the GraphQL context for each operation */
  context?: (
    socket: ServerWebSocket<WebSocketContext>,
    request: GraphQLRequest
  ) => TContext | Promise<TContext>;
  /**
   * Close with 4408 if `connection_init` does not arrive in time, or if
   * `onConnect` has not settled this long after it arrived (default 3000ms)
   */
  connectionInitTimeout?: number;
  /** Server ping interval; 0 disables keep-alive (default 12000ms) */
  keepAliveInterval?: number;
  /**
   * Browser origins allowed to connect, in addition to the server's own
   * (default: same-origin only). '*' allows any. No Origin is always allowed.
   */
  allowedOrigins?: readonly string[] | '*';
  /** Forwarded to the SubscriptionManager (minus `schema`) */
  subscriptionManager?: Omit<SubscriptionManagerConfig, 'schema'>;
  /**
   * Destination for diagnostics such as failing hooks (default `console`).
   * Passed on to the SubscriptionManager unless it sets its own.
   */
  logger?: WebSocketLogger;
  /**
   * How errors sent in `error` and `next` frames are formatted and masked,
   * as for the HTTP transport (see "Error Formatting and Masking"). Passed on
   * to the SubscriptionManager unless it sets its own.
   */
  errorFormatting?: ErrorMaskingOptions;
  /** Return false to reject the connection with 4403 */
  onConnect?: (
    socket: ServerWebSocket<WebSocketContext>,
    params?: Record<string, unknown>
  ) => boolean | Promise<boolean>;
  onDisconnect?: (socket: ServerWebSocket<WebSocketContext>) => void | Promise<void>;
  onSubscribe?: (
    socket: ServerWebSocket<WebSocketContext>,
    id: string,
    request: GraphQLRequest
  ) => void | Promise<void>;
  /** Called once per operation id when it reaches a terminal state */
  onComplete?: (
    socket: ServerWebSocket<WebSocketContext>,
    id: string
  ) => void | Promise<void>;
}

interface WebSocketContext {
  /** Opaque UUIDv4 — do not parse it */
  connectionId: string;
  connectionParams?: Record<string, unknown>;
  initialized: boolean;
  subscriptions: Set<string>;
}
```

Close codes follow the protocol: `4400` invalid message (including a `subscribe`
payload that is not an object with a string `query`, a non-string
`operationName`, or non-object `variables`/`extensions`, closed with reason
"Invalid message"), `4401` unauthorized
(operation before `connection_init`), `4403` rejected by `onConnect` (returned
`false` or threw), `4408`
init timeout (no `connection_init`, or an `onConnect` that did not settle in
time), `4409` duplicate subscription id, `4429` repeated
`connection_init` (including a second one sent while `onConnect` for the
first is still running).

An operation is tracked from the moment its `subscribe` frame arrives. A
client `complete` for an operation that is still setting up cancels it, and
an operation still setting up when the socket closes is abandoned: in both
cases nothing is registered and any source stream it obtained is returned.
Operations still setting up count toward `maxSubscriptionsPerConnection`.

```typescript
interface WebSocketLogger {
  error(...args: unknown[]): void;
  /** Optional; warnings go to `error` without it */
  warn?(...args: unknown[]): void;
}
```

### SubscriptionManager

Owns the executor and the per-connection subscription registry. The handler
creates one; you only need it directly when driving subscriptions yourself.

```typescript
class SubscriptionManager {
  constructor(config: SubscriptionManagerConfig);

  subscribe<TContext = unknown>(
    connectionId: string,
    subscriptionId: string,
    request: GraphQLRequest,
    context: TContext,
    onNext: (result: GraphQLResponse) => void,
    onComplete: () => void,
    onError: (errors: readonly { message: string }[]) => void
  ): Promise<Subscription>;

  /** Parse with the executor's limits (maxTokens, maxDepth) */
  parse(query: string): Promise<DocumentNode>;

  /** Run a query or mutation on the same executor */
  execute<TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext
  ): Promise<GraphQLResponse>;

  unsubscribe(connectionId: string, subscriptionId: string): boolean;
  unsubscribeConnection(connectionId: string): number;
  getSubscription(connectionId: string, subscriptionId: string): Subscription | undefined;
  getConnectionSubscriptions(connectionId: string): Subscription[];
  clear(): void;

  readonly subscriptionCount: number;
  readonly connectionCount: number;
  /** maxSubscriptionsPerConnection */
  readonly subscriptionLimit: number;
}

function createSubscriptionManager(config: SubscriptionManagerConfig): SubscriptionManager;

interface SubscriptionManagerConfig {
  schema: GraphQLSchema;
  /** Default 100 */
  maxSubscriptionsPerConnection?: number;
  /** Complete a subscription after this many ms; 0 disables (default 0) */
  subscriptionTimeout?: number;
  /**
   * Reuse an existing executor, or configure the one this manager builds.
   * Sharing an executor with the HTTP transport avoids a second schema print
   * and a duplicate document cache, and is the only way subscriptions inherit
   * `introspection: false`, `maxDepth` or `maxComplexity`.
   */
  executor?: LeavenExecutor | Omit<ExecutorConfig, 'schema'>;
  /** Destination for timeout and callback diagnostics (default `console`) */
  logger?: WebSocketLogger;
  /**
   * Formats the errors passed to `onError` and `onNext` and returned by
   * `execute`: thrown errors always go through `formatError`, executor
   * errors only when this is set
   */
  errorFormatting?: ErrorMaskingOptions;
}

interface Subscription {
  id: string;
  connectionId: string;
  request: GraphQLRequest;
  status: 'pending' | 'active' | 'completed' | 'error';
  createdAt: number;
  iterator?: AsyncIterableIterator<GraphQLResponse>;
  cleanup?: () => void;
}
```

Subscription ids are scoped to a connection: `graphql-ws` clients number their
operations per connection (starting at `"1"`), so every lookup and teardown
takes **both** the connection id and the subscription id. `subscribe` throws
when the id is already registered on that connection rather than overwriting
it.

### PubSub

```typescript
class PubSub implements PubSubEngine {
  constructor(config?: PubSubConfig);

  subscribe<T = unknown>(topic: string, callback: (payload: T) => void): () => void;
  publish<T = unknown>(topic: string, payload: T): void;
  asyncIterator<T = unknown>(topic: string | string[]): AsyncIterableIterator<T>;
  getSubscriberCount(topic: string): number;
  getTopics(): string[];
  clear(): void;
}

function createPubSub(config?: PubSubConfig): PubSub;

interface PubSubConfig {
  /** Subscribers allowed per topic before `subscribe` throws (default 10000) */
  maxSubscribersPerTopic?: number;
  /** Enable `.`-segmented `*` / `#` topic patterns (default false) */
  wildcards?: boolean;
  /**
   * Payloads an `asyncIterator` buffers while nothing is pulling. When full,
   * the OLDEST payload is dropped so a slow consumer sees the most recent
   * events instead of an unbounded queue. Unlimited by default. Must be an
   * integer >= 1 or `Infinity`; anything else (including `0`) makes the
   * `PubSub` constructor throw a `TypeError`.
   */
  maxQueueSize?: number;
  /** Destination for subscriber callback errors (default `console`) */
  logger?: WebSocketLogger;
}
```

### Message Handling

`parseMessage` returns a parsed message object; `formatMessage` takes a message
object and returns the string to send. The `create*` helpers build message
objects, so they are composed with `formatMessage` rather than sent directly.

```typescript
function parseMessage(data: string | Buffer, options?: ParseMessageOptions): Message;
function formatMessage(message: Message): string;

function createConnectionAck(payload?: Record<string, unknown>): ConnectionAckMessage;
function createNextMessage(
  id: string,
  data: Record<string, unknown> | null | undefined,
  errors?: readonly { message: string }[],
  extensions?: Record<string, unknown> // forwarded as payload.extensions when set
): NextMessage;
function createErrorMessage(
  id: string,
  errors: readonly { message: string }[]
): ErrorMessage;
function createCompleteMessage(id: string): CompleteMessage;
function createPongMessage(payload?: Record<string, unknown>): PongMessage;

/** `/^[A-Za-z0-9_.:-]{1,64}$/`: the accepted shape of a client operation id */
const OPERATION_ID_PATTERN: RegExp;
function isValidOperationId(id: unknown): id is string;

interface ParseMessageOptions {
  /**
   * Require a string `id` on the types that carry one (`subscribe`, `next`,
   * `error`, `complete`). Defaults to `true`, which is correct for a server
   * reading client frames: an operation frame with no id cannot be routed.
   * Pass `false` on the client, where a lenient peer may omit the id and a
   * throw would tear down the whole connection.
   */
  requireId?: boolean;
}
```

```typescript
import {
  createCompleteMessage,
  createNextMessage,
  formatMessage,
  parseMessage,
} from '@leaven-graphql/ws';

socket.send(formatMessage(createNextMessage('1', { hello: 'world' })));
socket.send(formatMessage(createCompleteMessage('1')));

const message = parseMessage(data, { requireId: false });
```

`parseMessage` throws on invalid JSON, on JSON that is not an object, on a
missing or unknown `type`, and — unless `requireId` is `false` — on a missing
`id`, or on a `subscribe`/`complete` id that does not match
`OPERATION_ID_PATTERN` (`Invalid message`). It also throws `Invalid message`,
whatever `requireId` is, on a `subscribe` whose payload is not an object with a
string `query`, or that has a non-string `operationName` or non-object
`variables`/`extensions` (`null` is accepted for all three). The server closes the socket with
4400 in every one of those cases. Ids are client-chosen and reach close
reasons and log lines, so the allow-list keeps control characters and
oversized strings out of both; UUIDs, counters and `prefix:n` ids all pass.

### Message Types

```typescript
enum MessageType {
  ConnectionInit = 'connection_init',
  ConnectionAck = 'connection_ack',
  Ping = 'ping',
  Pong = 'pong',
  Subscribe = 'subscribe',
  Next = 'next',
  Error = 'error',
  Complete = 'complete',
}

type Message =
  | ConnectionInitMessage
  | ConnectionAckMessage
  | PingMessage
  | PongMessage
  | SubscribeMessage
  | NextMessage
  | ErrorMessage
  | CompleteMessage;

interface SubscribeMessage {
  id: string;
  type: MessageType.Subscribe;
  payload: {
    operationName?: string;
    query: string;
    variables?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
}

interface NextMessage {
  id: string;
  type: MessageType.Next;
  payload: {
    data?: Record<string, unknown> | null;
    errors?: readonly { message: string; [key: string]: unknown }[];
    extensions?: Record<string, unknown>;
  };
}

interface ErrorMessage {
  id: string;
  type: MessageType.Error;
  payload: readonly { message: string; [key: string]: unknown }[];
}

interface CompleteMessage {
  id: string;
  type: MessageType.Complete;
}
```

## License

Apache 2.0 - Joseph Quinn
