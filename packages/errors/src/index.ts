/**
 * @leaven-graphql/errors - Error handling utilities for Leaven
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

export {
  LeavenError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ComplexityError,
  DepthLimitError,
  PersistedQueryError,
  InputError,
} from './errors';

export {
  formatError,
  formatErrors,
  maskError,
  MASKED_ERROR_MESSAGE,
  maskedErrorFor,
  withMaskingDefault,
  isLeavenError,
  errorToGraphQL,
  fromFormattedError,
  type ErrorFormatter,
  type ErrorMaskingOptions,
} from './formatter';

export {
  ErrorCode,
  ERROR_CODES,
  getErrorCode,
  getErrorMessage,
  statusForResponse,
} from './codes';

export { isPlainObject } from './guards';
