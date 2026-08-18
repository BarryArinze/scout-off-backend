/**
 * Manual Jest mock for better-sqlite3.
 *
 * This mock delegates to the real better-sqlite3 library using in-memory
 * databases. This ensures that:
 *   1. The native binary is used when available (it is, on Node 24 + Python 3).
 *   2. Tests that create real Database instances get actual SQL functionality.
 *   3. Tests that need mock behaviour mock src/db/index.ts helpers directly
 *      (jest.mock('../../src/db', ...)) — which is the established pattern
 *      used throughout this test suite.
 */

'use strict';

const path = require('path');
const BetterSqlite3 = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

module.exports = BetterSqlite3;
module.exports.default = BetterSqlite3;
