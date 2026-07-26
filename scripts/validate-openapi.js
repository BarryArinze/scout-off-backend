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
 */

'use strict';

const fs = require('fs');
const path = require('path');

const YAML_PATH = path.join(__dirname, '..', 'src', 'openapi.yaml');
const JSON_PATH = path.join(__dirname, '..', 'src', 'openapi.json');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('js-yaml not installed. Run: npm install --save-dev js-yaml');
  process.exit(1);
}

// ── Step 1: Parse YAML ────────────────────────────────────────────────────────
let spec;
try {
  const raw = fs.readFileSync(YAML_PATH, 'utf8');
  spec = yaml.load(raw);
} catch (err) {
  console.error('[validate-openapi] YAML parse error:', err.message);
  process.exit(1);
}

// ── Step 2: Check required top-level fields ───────────────────────────────────
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

// ── Step 3: Check JSON is in sync ────────────────────────────────────────────
if (!fs.existsSync(JSON_PATH)) {
  console.error(
    '[validate-openapi] src/openapi.json does not exist.\n' +
    'Run: npm run build:openapi',
  );
  process.exit(1);
}

const jsonSpec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
// Compare normalised (re-serialised) forms to avoid whitespace / key-order false positives
const normalise = (o) => JSON.stringify(JSON.parse(JSON.stringify(o)), Object.keys(JSON.parse(JSON.stringify(o))).sort(), 2);
const yamlNorm = normalise(spec);
const jsonNorm = normalise(jsonSpec);

if (yamlNorm !== jsonNorm) {
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
