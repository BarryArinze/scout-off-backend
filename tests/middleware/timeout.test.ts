import { Request, Response, NextFunction } from 'express';

// Must come before importing the middleware so the config is mocked at load time.
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { requestTimeoutMs: 100 },
}));

import { requestTimeout } from '../../src/middleware/timeout';

function makeReqRes() {
  const listeners: Record<string, (() => void)[]> = {};
  let statusCode = 0;
  let body: unknown;
  let _headersSent = false;

  const res = {
    get headersSent() { return _headersSent; },
    on(event: string, cb: () => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    },
    status(code: number) { statusCode = code; return this; },
    json(data: unknown) { body = data; _headersSent = true; return this; },
    emit(event: string) { (listeners[event] ?? []).forEach(cb => cb()); },
    markSent() { _headersSent = true; },
    _getStatus: () => statusCode,
    _getBody: () => body,
  } as unknown as Response & {
    emit: (e: string) => void;
    markSent: () => void;
    _getStatus: () => number;
    _getBody: () => unknown;
  };

  const req = {} as Request;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('requestTimeout middleware', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('calls next()', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('responds 503 after the configured timeout elapses', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    jest.advanceTimersByTime(200);
    expect(res._getStatus()).toBe(503);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res._getBody() as any).code).toBe('REQUEST_TIMEOUT');
  });

  it('does not fire before the timeout', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    jest.advanceTimersByTime(50);
    expect(res._getStatus()).toBe(0);
  });

  it('does not send 503 after finish fires before the timeout', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    res.emit('finish');
    jest.advanceTimersByTime(200);
    // Timer was cleared on finish, so no 503
    expect(res._getStatus()).toBe(0);
  });

  it('does not send 503 if headers were already sent', () => {
    const { req, res, next } = makeReqRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).markSent();
    requestTimeout(req, res, next);
    jest.advanceTimersByTime(200);
    // headersSent=true prevents the json() call inside the timer
    expect(res._getBody()).toBeUndefined();
  });
});
