import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no look-alike characters

/** Opaque, unguessable identifier with a readable prefix: `q_x7k2…`. */
export function newId(prefix: string, length = 20): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Transaction memo for a quote. Text memos are capped at 28 bytes; this is 23. */
export function memoFor(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `settle:${out}`;
}
