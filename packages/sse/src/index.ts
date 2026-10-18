/**
 * @leaven-graphql/sse - Server-Sent Events (graphql-sse) transport for Leaven
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

export {
  SSE_CONTENT_TYPE,
  SSE_HEADERS,
  SSE_KEEP_ALIVE,
  DEFAULT_KEEP_ALIVE_INTERVAL,
  formatSSEEvent,
  formatNextEvent,
  formatCompleteEvent,
  acceptsEventStream,
} from './protocol';

export type {
  EventStreamSource,
  EventStreamOptions,
  EventStreamResponseOptions,
} from './stream';
export { isSubscriptionIterator, createEventStream, createEventStreamResponse } from './stream';

export { formatResultErrors } from './format';

export { isRequestError } from './request-error';
