#!/usr/bin/env node
/**
 * validate-openapi.js
 *
 * Validates src/openapi.yaml:
 *   1. Parses the YAML without error (well-formed)
 *   2. Checks required top-level OpenAPI 3.0 fields (openapi, info, paths)
 *   3. Verifies that src/openapi.json is in sync with src/openapi.yaml
 *      (fails if openapi.json is stale — run `npm run build:openapi` to fix)
 *
 * Usage (CI):
 *   node scripts/validate-openapi.js
 * Exit 0 = valid, Exit 1 = invalid (error message on stderr).
 *
 * The spec file locations can be overridden with OPENAPI_YAML_PATH /
 * OPENAPI_JSON_PATH (used by tests to run the check against fixture files).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const YAML_PATH =
  process.env.OPENAPI_YAML_PATH ||
  path.join(__dirname, '..', 'src', 'openapi.yaml');
const JSON_PATH =
  process.env.OPENAPI_JSON_PATH ||
  path.join(__dirname, '..', 'src', 'openapi.json');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('js-yaml not installed. Run: npm install --save-dev js-yaml');
  process.exit(1);
}

/**
 * Recursively canonicalise a parsed spec value so that two structurally
 * identical objects always serialise to the same string regardless of
 * object key order.
 *
 * - arrays: canonicalise each element (order is significant)
 * - plain objects: canonicalise each value, then sort the keys
 * - primitives (string / number / boolean / null): returned unchanged
 *
 * Keys are sorted at EVERY nesting level. The previous implementation
 * passed the top-level key list to JSON.stringify as a replacer ARRAY,
 * which JSON.stringify treats as an allow-list applied at every depth —
 * so any property whose name was not a top-level key (e.g.
 * paths./a.get.summary) was silently stripped at every level, collapsing
 * deep drift into "identical" specs.
 */
function canonicalise(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * True recursive deep-equality check between two parsed spec objects:
 * both are canonicalised (object keys sorted recursively) and then their
 * serialised forms are compared, so ordering/whitespace differences are
 * ignored but any real content difference — at any depth — is detected.
 */
function specsAreEqual(a, b) {
  return JSON.stringify(canonicalise(a)) === JSON.stringify(canonicalise(b));
}

module.exports = { canonicalise, specsAreEqual };

function main() {
  // ── Step 1: Parse YAML ────────────────────────────────────────────────────
  let spec;
  try {
    const raw = fs.readFileSync(YAML_PATH, 'utf8');
    spec = yaml.load(raw);
  } catch (err) {
    console.error('[validate-openapi] YAML parse error:', err.message);
    process.exit(1);
  }

  // ── Step 2: Check required top-level fields ───────────────────────────────
  const required = ['openapi', 'info', 'paths'];
  for (const field of required) {
    if (!spec[field]) {
      console.error(`[validate-openapi] Missing required OpenAPI field: "${field}"`);
      process.exit(1);
    }
  }

  if (!spec.openapi.startsWith('3.')) {
    console.error(`[validate-openapi] Expected OpenAPI 3.x, got: ${spec.openapi}`);
    process.exit(1);
  }

  if (!spec.info.version) {
    console.error('[validate-openapi] info.version is required');
    process.exit(1);
  }

  if (!spec.info.title) {
    console.error('[validate-openapi] info.title is required');
    process.exit(1);
  }

  const pathCount = Object.keys(spec.paths || {}).length;
  if (pathCount === 0) {
    console.error('[validate-openapi] spec.paths is empty — no routes defined');
    process.exit(1);
  }

  // ── Step 3: Check JSON is in sync ────────────────────────────────────────
  if (!fs.existsSync(JSON_PATH)) {
    console.error(
      '[validate-openapi] src/openapi.json does not exist.\n' +
      'Run: npm run build:openapi',
    );
    process.exit(1);
  }

  const jsonSpec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  if (!specsAreEqual(spec, jsonSpec)) {
    console.error(
      '[validate-openapi] src/openapi.json is out of sync with src/openapi.yaml.\n' +
      'Run: npm run build:openapi  then commit the updated openapi.json',
    );
    process.exit(1);
  }

  console.log(
    `[validate-openapi] ✓ OpenAPI ${spec.openapi} spec valid — ${pathCount} paths, info.version=${spec.info.version}`,
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}
