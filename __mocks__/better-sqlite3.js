/**
 * Manual Jest mock for better-sqlite3.
 *
 * The native binary is not available in this environment (Node 24, no Python
 * for node-gyp). Tests that exercise DB logic directly use this mock so that
 * setup.ts's initDb() call completes without the native binding.
 *
 * Tests that need real query semantics should mock src/db/index.ts helpers
 * directly (jest.mock('../../src/db', ...)) — which is the established
 * pattern used throughout this test suite.
 */

'use strict';

/** A minimal prepared-statement stand-in. */
function makeStmt() {
  return {
    run: jest.fn().mockReturnValue({ changes: 0, lastInsertRowid: 1 }),
    get: jest.fn().mockReturnValue(undefined),
    all: jest.fn().mockReturnValue([]),
    iterate: jest.fn().mockReturnValue([][Symbol.iterator]()),
  };
}

/** A minimal Database stand-in. */
class Database {
  constructor(_path) {
    // no-op: native binding not needed for mocked unit tests
  }

  prepare(_sql) {
    return makeStmt();
  }

  exec(_sql) {
    // no-op
  }

  close() {
    // no-op
  }

  transaction(fn) {
    // Return a wrapper that runs fn() synchronously (mirrors better-sqlite3 API)
    return (...args) => fn(...args);
  }
}

module.exports = Database;
module.exports.default = Database;
