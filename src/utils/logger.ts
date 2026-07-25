import config from '../config';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 } as const;

function shouldLog(level: keyof typeof LEVELS): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel as keyof typeof LEVELS] ?? 0;
}

export const logger = {
  debug:    (...args: unknown[]) => shouldLog('debug')    && console.debug('[debug]',    ...args.map(sanitizeLogArg)),
  info:     (...args: unknown[]) => shouldLog('info')     && console.info('[info]',     ...args.map(sanitizeLogArg)),
  warn:     (...args: unknown[]) => shouldLog('warn')     && console.warn('[warn]',     ...args.map(sanitizeLogArg)),
  error:    (...args: unknown[]) => shouldLog('error')    && console.error('[error]',   ...args.map(sanitizeLogArg)),
  critical: (...args: unknown[]) => console.error('[critical]', ...args.map(sanitizeLogArg)),
};

function sanitizeLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') {
    // Strip newlines to prevent log forging (CWE-117)
    return arg.replace(/[\r\n]+/g, ' ');
  }
  return arg;
}
