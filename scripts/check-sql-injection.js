const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '../src/db');
let found = false;

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  // Look for backticks containing SELECT, INSERT, UPDATE, or DELETE followed by string interpolation ${
  const sqlInterpolationRegex = /`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*\$\{.*?\}[^`]*`/g;
  
  let match;
  while ((match = sqlInterpolationRegex.exec(content)) !== null) {
    console.error(`[FAIL] SQL string interpolation found in ${filePath}:\n${match[0]}\n`);
    found = true;
  }
}

fs.readdirSync(dbDir).forEach(file => {
  if (file.endsWith('.ts')) {
    scanFile(path.join(dbDir, file));
  }
});

if (found) {
  process.exit(1);
} else {
  console.log('[PASS] No SQL string interpolation detected.');
}
