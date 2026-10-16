/**
 * @leaven-graphql/core - Log value escaping
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/** Default number of characters of a single value kept by {@link escapeLog} */
export const LOG_VALUE_MAX_LENGTH = 256;

/**
 * C0 controls, DEL, C1 controls and the Unicode line/paragraph separators:
 * everything a line-oriented log sink (or a terminal) could treat as a line
 * break or an escape sequence.
 */
const UNSAFE_LOG_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeChar(char: string): string {
  const named = NAMED_ESCAPES[char];
  if (named) return named;
  const code = char.charCodeAt(0);
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * Make a client-controlled value safe to interpolate into a log message.
 *
 * Subscription ids, topics, operation names and error text all originate
 * with the client. Interpolated raw, a `\n` in one of them starts a forged
 * log line and an ESC rewrites the operator's terminal. This escapes CR, LF,
 * tab and every other C0 control character, DEL, C1 controls and U+2028/9
 * into visible `\n` / `\xHH` / `\uHHHH` sequences, and caps the value at
 * `maxLength` characters (before escaping, so the output stays bounded) with
 * a `…[+N chars]` marker.
 *
 * Never throws: a value whose `toString` throws becomes `[unprintable]`.
 */
export function escapeLog(value: unknown, maxLength: number = LOG_VALUE_MAX_LENGTH): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    return '[unprintable]';
  }

  const overflow = text.length - maxLength;
  const head = overflow > 0 ? text.slice(0, maxLength) : text;
  const escaped = head.replace(UNSAFE_LOG_CHARS, escapeChar);
  return overflow > 0 ? `${escaped}…[+${overflow} chars]` : escaped;
}
