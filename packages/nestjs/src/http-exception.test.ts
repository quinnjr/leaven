/**
 * @leaven-graphql/nestjs - NestJS HttpException to ErrorCode mapping tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ErrorCode, isLeavenError } from '@leaven-graphql/errors';
import { httpExceptionCode, normalizeHttpException } from './http-exception';

describe('httpExceptionCode', () => {
  test('should map a status with a dedicated code', () => {
    expect(httpExceptionCode(new UnauthorizedException())).toEqual({
      code: ErrorCode.UNAUTHENTICATED,
      status: 401,
    });
    expect(httpExceptionCode(new ForbiddenException())?.code).toBe(ErrorCode.FORBIDDEN);
  });

  test('should map an unlisted 4xx to BAD_REQUEST and a 5xx to INTERNAL_ERROR', () => {
    expect(httpExceptionCode(new HttpException('teapot', 418))).toEqual({
      code: ErrorCode.BAD_REQUEST,
      status: 418,
    });
    expect(httpExceptionCode(new InternalServerErrorException())?.code).toBe(
      ErrorCode.INTERNAL_ERROR
    );
  });

  test('should return undefined for anything that is not an HttpException', () => {
    expect(httpExceptionCode(new Error('plain'))).toBeUndefined();
    expect(httpExceptionCode(undefined)).toBeUndefined();
  });
});

describe('normalizeHttpException', () => {
  test('should turn an HttpException into a LeavenError with its mapped code and status', () => {
    const cause = new ForbiddenException('No access');
    const normalized = normalizeHttpException(cause);

    expect(isLeavenError(normalized)).toBe(true);
    if (!isLeavenError(normalized)) return;
    expect(normalized.message).toBe('No access');
    expect(normalized.code).toBe(ErrorCode.FORBIDDEN);
    expect(normalized.statusCode).toBe(403);
    expect(normalized.originalError).toBe(cause);
  });

  test('should leave a 5xx HttpException unchanged so it stays maskable', () => {
    const cause = new InternalServerErrorException('db down');

    expect(normalizeHttpException(cause)).toBe(cause);
  });

  test('should return anything else unchanged', () => {
    const plain = new Error('plain');
    expect(normalizeHttpException(plain)).toBe(plain);
    expect(normalizeHttpException(undefined)).toBeUndefined();
  });
});
