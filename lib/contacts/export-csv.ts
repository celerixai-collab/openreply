/**
 * Contacts CSV export (the serializer; lib/utils/csv.ts is the campaign
 * import parser). Built to open cleanly in Excel and Numbers, Chinese
 * included, and to be safe to open there:
 *
 * - UTF-8 BOM, so Excel detects UTF-8 instead of garbling Chinese text;
 * - CRLF between records (RFC 4180); line breaks inside a cell stay as-is;
 * - every field in double quotes, embedded quotes doubled;
 * - formula injection guard (OWASP): a cell that would start with = + - @,
 *   TAB, CR or LF — also their full-width forms (＝ ＋ － ＠, ﹦ ...), and
 *   also after leading spaces — gets a leading ' so a spreadsheet shows it
 *   as text instead of running it.
 *
 * The Instagram-scoped id is left out on purpose: it is internal, and Excel
 * keeps only 15 significant digits of a long number.
 */

export const CONTACT_CSV_COLUMNS = [
  "username",
  "email",
  "captured_at",
  "campaign",
  "instagram_account",
  "email_source",
  "consent_text",
] as const;

export type ContactCsvRow = {
  username: string | null;
  email: string | null;
  capturedAt: Date | null;
  campaign: string | null;
  instagramAccount: string | null;
  emailSource: string | null;
  consentText: string | null;
};

type CsvValue = string | Date | null | undefined;

// Checked on the NFKC form, so full-width and small-form variants fold to
// the ASCII characters first; leading whitespace does not hide a formula.
const FORMULA_START = /^(?:[\t\r\n]|\s*[=+\-@])/;

export function needsFormulaGuard(value: string): boolean {
  return FORMULA_START.test(value.normalize("NFKC"));
}

export function escapeCsvCell(value: CsvValue): string {
  let text =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  if (needsFormulaGuard(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[]
): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCsvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function contactsToCsv(rows: readonly ContactCsvRow[]): string {
  return toCsv(
    CONTACT_CSV_COLUMNS,
    rows.map((row) => [
      row.username,
      row.email,
      row.capturedAt,
      row.campaign,
      row.instagramAccount,
      row.emailSource,
      row.consentText,
    ])
  );
}
