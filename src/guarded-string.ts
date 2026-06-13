/**
 * A string wrapper that guards sensitive values (e.g., passwords) from
 * accidental exposure through serialisation, logging, or string coercion.
 *
 * - `toString()`          → returns `'[REDACTED]'`
 * - `toJSON()`            → returns `'[REDACTED]'`
 * - `[Symbol.toPrimitive]`→ returns `'[REDACTED]'` / `NaN`
 *
 * The actual value is stored in a private field (`#value`) and is accessible
 * only via the explicit `.value` property.
 */
export class GuardedString {
  /** @internal The raw string value — accessible via `.value`. */
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /**
   * Returns the raw string value.
   * This is the **only** way to access the actual value.
   */
  get value(): string {
    return this.#value;
  }

  /**
   * Guards against accidental string coercion (e.g., template literals,
   * concatenation).
   */
  toString(): string {
    return '[REDACTED]';
  }

  /**
   * Guards against serialisation (e.g., `JSON.stringify`).
   */
  toJSON(): string {
    return '[REDACTED]';
  }

  /**
   * Guards against implicit type coercion.
   * - `String(guarded)` → `'[REDACTED]'`
   * - `Number(guarded)` → `NaN`
   * - default            → `'[REDACTED]'`
   */
  [Symbol.toPrimitive](hint: string): string | number {
    if (hint === 'number') {
      return NaN;
    }
    return '[REDACTED]';
  }
}
