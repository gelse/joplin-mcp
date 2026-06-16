import { describe, it, expect } from 'vitest';
import {
  ConfigError,
  DataApiError,
  NotFoundError,
  ConflictError,
  ValidationError,
  AuthError,
  FatalError,
} from '../src/errors.js';

describe('Error classes', () => {
  it('ConfigError has correct name', () => {
    const err = new ConfigError('test');
    expect(err.name).toBe('ConfigError');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('NotFoundError includes resource info', () => {
    const err = new NotFoundError('Note', 'abc123');
    expect(err.message).toContain('Note');
    expect(err.message).toContain('abc123');
    expect(err.statusCode).toBe(404);
  });

  it('DataApiError carries status code', () => {
    const err = new DataApiError('Server error', 500, 'trace');
    expect(err.statusCode).toBe(500);
    expect(err.responseBody).toBe('trace');
  });

  it('ConflictError has 409 status', () => {
    const err = new ConflictError('Note', 'abc123');
    expect(err.statusCode).toBe(409);
  });

  it('ValidationError has 400 status', () => {
    const err = new ValidationError('Invalid input');
    expect(err.statusCode).toBe(400);
  });

  it('AuthError has 401 status and default message', () => {
    const err = new AuthError();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Authentication failed');
  });

  it('FatalError is an instance of Error and FatalError', () => {
    const err = new FatalError('fatal');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FatalError);
    expect(err.name).toBe('FatalError');
  });

  it('FatalError sets the message correctly', () => {
    const err = new FatalError('Unrecoverable error occurred');
    expect(err.message).toBe('Unrecoverable error occurred');
  });

  it('FatalError defaults exitCode to 1', () => {
    const err = new FatalError('fatal');
    expect(err.exitCode).toBe(1);
  });

  it('FatalError accepts a custom exitCode', () => {
    const err = new FatalError('fatal', undefined, 42);
    expect(err.exitCode).toBe(42);
  });

  it('FatalError stores the cause when provided', () => {
    const cause = new Error('underlying issue');
    const err = new FatalError('fatal', cause);
    expect(err.cause).toBe(cause);
  });

  it('FatalError cause is undefined when not provided', () => {
    const err = new FatalError('fatal');
    expect(err.cause).toBeUndefined();
  });
});
