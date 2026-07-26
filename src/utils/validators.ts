/**
 * src/utils/validators.ts
 *
 * Shared validation helpers used across controllers.
 * Centralising these constants prevents duplicate definitions and ensures
 * consistent validation logic throughout the codebase.
 */

/**
 * Matches a valid Stellar public key (G… address).
 * A Stellar public key is a 56-character base-32 encoded string that starts
 * with 'G', followed by 55 characters from the set [A-Z2-7].
 *
 * @example
 *   STELLAR_ADDRESS_RE.test('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN') // true
 *   STELLAR_ADDRESS_RE.test('notakey') // false
 */
export const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
