import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateRuntimeEnv, findStaleExampleKeys } from '../scripts/validate-env';

describe('validate-env runtime validation', () => {
  it('should pass on a complete valid config (NODE_ENV=development)', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass on a complete valid config (NODE_ENV=production)', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should pass when NODE_ENV is unset (defaults to development)', () => {
    const env = {
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error when CONTRACT_ID is missing', () => {
    const env = {
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: CONTRACT_ID');
  });

  it('should report an error when JWT_SECRET is missing', () => {
    const env = {
      NODE_ENV: 'development',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: JWT_SECRET');
  });

  it('should report both errors when CONTRACT_ID and JWT_SECRET are missing', () => {
    const env = {
      NODE_ENV: 'development',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain('Missing required environment variable: CONTRACT_ID');
    expect(errors).toContain('Missing required environment variable: JWT_SECRET');
    expect(errors.length).toBe(2);
  });

  it('should report an error on a malformed/invalid NODE_ENV value', () => {
    const env = {
      NODE_ENV: 'invalid_env',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'NODE_ENV="invalid_env" is invalid. Must be one of: development, test, production'
    );
  });

  it('should pass on valid CORS_ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      CORS_ALLOWED_ORIGINS: 'https://app.scoutoff.io,https://staging.scoutoff.io',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toEqual([]);
  });

  it('should report an error on malformed CORS_ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      JWT_SECRET: 'test-secret',
      CORS_ALLOWED_ORIGINS: 'invalid-origin-without-protocol',
    };
    const errors = validateRuntimeEnv(env);
    expect(errors).toContain(
      'Invalid CORS origin format: "invalid-origin-without-protocol". Origins must be "*" or start with http:// or https://'
    );
  });
});

// ─── Helpers for findStaleExampleKeys tests ───────────────────────────────────

/** Write a temporary .env.example file and return its path. */
function makeTmpExample(keys: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-env-test-'));
  const filePath = path.join(tmpDir, '.env.example');
  const content = keys.map((k) => `${k}=`).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** Write a temporary .ts source file referencing the given keys and return its path. */
function makeTmpSrc(keys: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-env-src-'));
  const filePath = path.join(tmpDir, 'config.ts');
  const content = keys.map((k) => `const x = process.env.${k};`).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ─── findStaleExampleKeys tests ───────────────────────────────────────────────

describe('findStaleExampleKeys (reverse direction: .env.example → src/)', () => {
  it('returns empty array when every .env.example key is referenced in src/', () => {
    const examplePath = makeTmpExample(['CONTRACT_ID', 'JWT_SECRET', 'PORT']);
    const srcFile = makeTmpSrc(['CONTRACT_ID', 'JWT_SECRET', 'PORT']);

    const stale = findStaleExampleKeys(examplePath, [srcFile]);

    expect(stale).toEqual([]);
  });

  it('returns stale keys that appear in .env.example but not in src/', () => {
    // LEGACY_FLAG is documented but no longer referenced in code
    const examplePath = makeTmpExample(['CONTRACT_ID', 'JWT_SECRET', 'LEGACY_FLAG']);
    const srcFile = makeTmpSrc(['CONTRACT_ID', 'JWT_SECRET']);

    const stale = findStaleExampleKeys(examplePath, [srcFile]);

    expect(stale).toContain('LEGACY_FLAG');
    expect(stale).not.toContain('CONTRACT_ID');
    expect(stale).not.toContain('JWT_SECRET');
  });

  it('returns all keys as stale when src/ references nothing', () => {
    const examplePath = makeTmpExample(['CONTRACT_ID', 'JWT_SECRET']);
    const srcFile = makeTmpSrc([]); // no process.env references

    const stale = findStaleExampleKeys(examplePath, [srcFile]);

    expect(stale).toContain('CONTRACT_ID');
    expect(stale).toContain('JWT_SECRET');
    expect(stale.length).toBe(2);
  });

  it('returns empty array when .env.example is empty', () => {
    const examplePath = makeTmpExample([]);
    const srcFile = makeTmpSrc(['CONTRACT_ID']);

    const stale = findStaleExampleKeys(examplePath, [srcFile]);

    expect(stale).toEqual([]);
  });

  it('ignores comment lines and blank lines in .env.example', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-env-comment-'));
    const examplePath = path.join(tmpDir, '.env.example');
    fs.writeFileSync(
      examplePath,
      '# This is a comment\nCONTRACT_ID=\n\n# Another comment\nJWT_SECRET=\n',
      'utf8'
    );
    const srcFile = makeTmpSrc(['CONTRACT_ID', 'JWT_SECRET']);

    const stale = findStaleExampleKeys(examplePath, [srcFile]);

    expect(stale).toEqual([]);
  });

  it('handles multiple src files correctly', () => {
    const examplePath = makeTmpExample(['CONTRACT_ID', 'JWT_SECRET', 'PORT', 'STALE_VAR']);
    const srcFile1 = makeTmpSrc(['CONTRACT_ID', 'JWT_SECRET']);
    const srcFile2 = makeTmpSrc(['PORT']);

    const stale = findStaleExampleKeys(examplePath, [srcFile1, srcFile2]);

    expect(stale).toContain('STALE_VAR');
    expect(stale).not.toContain('CONTRACT_ID');
    expect(stale).not.toContain('JWT_SECRET');
    expect(stale).not.toContain('PORT');
  });

  it('does not treat commented-out env refs in src/ as active references', () => {
    const examplePath = makeTmpExample(['COMMENTED_VAR']);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-env-comment-src-'));
    const srcFile = path.join(tmpDir, 'config.ts');
    // COMMENTED_VAR is only referenced in a comment — should not count
    fs.writeFileSync(srcFile, '// const x = process.env.COMMENTED_VAR;\n', 'utf8');

    const stale = findStaleExampleKeys(examplePath, [srcFile]);

    expect(stale).toContain('COMMENTED_VAR');
  });
});
