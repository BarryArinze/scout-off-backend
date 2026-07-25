/** Trims whitespace and strips null bytes/control characters (U+0000–U+001F, U+007F) from a string. */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return input;
  
  // 1. Trim surrounding whitespace
  let sanitized = input.trim();
  
  // 2. Strip null bytes and control chars (U+0000 to U+001F and U+007F)
  sanitized = sanitized
    .split('')
    .filter(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('');
  
  return sanitized;
}
