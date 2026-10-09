/**
 * Pull an email address out of a free-text Instagram DM reply.
 *
 * People rarely send just the address: they write "我的信箱是 abc@gmail.com
 * 謝謝", type with a Chinese IME (＠ ． 。), or paste text full of invisible
 * characters. The rules, in order:
 *
 * - NFKC first: folds ＠ ﹫ -> @, ． -> ., full-width letters/digits -> ASCII,
 *   ｡ and ︒ -> 。 (not to '.'), U+3000 / U+00A0 -> space.
 * - Then strip invisible characters NFKC leaves alone (zero-width space and
 *   joiners, BOM, soft hyphen, bidi controls), so "abc<ZWSP>@gmail.com" still
 *   parses.
 * - Then map 。 to '.' (covers ｡ ︒ too, because NFKC already turned them
 *   into 。).
 * - ASCII-only pattern on purpose: anything non-ASCII (CJK, emoji) acts as a
 *   separator, so "信箱abc@gmail.com謝謝" works without spaces. IDN mailboxes
 *   such as 中文@例子.台灣 are not supported (punycode xn-- domains are).
 * - A candidate may only start at a token boundary (lookbehind). Without it an
 *   over-long local part is silently cut to its last 64 characters, and
 *   "abc@def@gmail.com" yields "def@gmail.com".
 * - The local part must start with [a-z0-9_], so a stored email never begins
 *   with = + - @ (CSV formula characters), and bullets such as
 *   "信箱-abc@gmail.com" are skipped.
 * - A TLD may not be followed by ".<alnum>", so "abc@yahoo.com.t" is rejected
 *   instead of being cut down to the wrong mailbox "abc@yahoo.com".
 * - Every candidate is validated (no "..", no trailing ".", local <= 64,
 *   domain <= 253, total <= 254) and the FIRST VALID one wins, so
 *   "abc.@gmail.com 打錯 abc@gmail.com" returns the corrected one.
 * - Spaces around @ are rejected on purpose: storing a wrong address costs
 *   more than asking for one retype.
 * - Bounded quantifiers plus the boundary lookbehind keep matching linear:
 *   1 MB of adversarial input runs in milliseconds.
 */

const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤ﻿ﾠ]/g;
const FULL_STOPS = /[。．｡︒]/g; // 。．｡︒

// Start: not preceded by a local-part character or '@', OR preceded by a
// single '+'/'-' that itself sits at a boundary (bullet style "-abc@...").
const EMAIL_RE =
  /(?:(?<![a-z0-9._+@-])|(?<=(?:^|[^a-z0-9._+@-])[+-]))([a-z0-9_][a-z0-9._+-]{0,63})@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59}))(?![a-z0-9-]|\.[a-z0-9])/g;

export const EMAIL_MAX_LENGTH = 254;

export function normalizeForEmail(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(FULL_STOPS, ".")
    .toLowerCase();
}

/** The first valid email in `text`, lowercased, or null. */
export function extractEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = normalizeForEmail(text);
  if (!t.includes("@")) return null;
  for (const m of t.matchAll(EMAIL_RE)) {
    const [email, local, domain] = m;
    if (local.includes("..") || local.endsWith(".")) continue;
    if (domain.length > 253 || email.length > EMAIL_MAX_LENGTH) continue;
    return email;
  }
  return null;
}

// Used only to pick which retry message to send when extractEmail() is null:
// true -> the "this email looks wrong" message, false -> the ask again.
// Beyond '@' it also catches "abcgmail.com" / "abc gmail" (forgot the @).
export function looksLikeEmailAttempt(text: string | null | undefined): boolean {
  const t = normalizeForEmail(text);
  return (
    t.includes("@") ||
    /\b(gmail|yahoo|hotmail|outlook|icloud|hinet|msa)\b/.test(t) ||
    /[a-z0-9]\.(com|net|org|edu|gov|tw|io|co|me)\b/.test(t)
  );
}
