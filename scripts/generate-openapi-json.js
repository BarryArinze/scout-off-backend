#!/usr/bin/env node
/**
 * generate-openapi-json.js
 *
 * Converts src/openapi.yaml → src/openapi.json so the docs route can serve
 * the spec as JSON without requiring js-yaml at runtime.
 *
 * Usage:
 *   node scripts/generate-openapi-json.js
 *
 * Called automatically by the "build:openapi" npm script.
 * Run this whenever openapi.yaml changes (enforced by CI).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const YAML_PATH = path.join(__dirname, '..', 'src', 'openapi.yaml');
const JSON_PATH = path.join(__dirname, '..', 'src', 'openapi.json');

// Inline minimal YAML parser for the simple, flat structure of our spec.
// We depend on js-yaml if available, otherwise we require the developer to
// install it: npm install --save-dev js-yaml
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error(
    'js-yaml is not installed. Install it as a dev dependency:\n' +
    '  npm install --save-dev js-yaml\n' +
    'then re-run this script.',
  );
  process.exit(1);
}

const raw = fs.readFileSync(YAML_PATH, 'utf8');
const spec = yaml.load(raw);

fs.writeFileSync(JSON_PATH, JSON.stringify(spec, null, 2) + '\n', 'utf8');
console.log(`[generate-openapi-json] Written ${JSON_PATH}`);
