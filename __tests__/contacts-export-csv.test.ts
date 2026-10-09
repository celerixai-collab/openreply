import { describe, expect, it } from "vitest";
import {
  CONTACT_CSV_COLUMNS,
  contactsToCsv,
  escapeCsvCell,
  toCsv,
} from "../lib/contacts/export-csv";

// Strict RFC 4180 reader (no trimming), to prove the export reads back exactly.
function parseCsvStrict(text: string): string[][] {
  if (text.startsWith("﻿")) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("escapeCsvCell", () => {
  it.each([
    ["=1+1"],
    ['=HYPERLINK("http://evil.example","x")'],
    ["+886912345678"],
    ["-2+3"],
    ["@SUM(A1:A2)"],
    ["\t=1+1"],
    ["\r=1+1"],
    ["\n=1+1"],
    ["＝1+1"],
    ["＋1"],
    ["－1"],
    ["＠abc"],
    ["﹦1+1"],
    ["  =1+1"],
    ["　=1+1"],
  ])("guards %j against formula injection", (value) => {
    const cell = escapeCsvCell(value);
    expect(cell.startsWith(`"'`)).toBe(true);
    expect(parseCsvStrict(`${cell}\r\n`)[0][0]).toBe(`'${value}`);
  });

  it.each([
    ["leo.tw"],
    ["_leo_"],
    ["abc@gmail.com"],
    ["a=b"],
    ["🎁 免費資源"],
  ])("leaves %j unguarded", (value) => {
    expect(escapeCsvCell(value)).toBe(`"${value}"`);
  });

  it("quotes every field, doubles quotes and keeps commas and line breaks", () => {
    const value = '他說："免費，馬上領", ok\n第二行';
    const cell = escapeCsvCell(value);
    expect(cell).toBe('"他說：""免費，馬上領"", ok\n第二行"');
    expect(parseCsvStrict(`${cell}\r\n`)[0][0]).toBe(value);
  });

  it("writes empty values as an empty quoted field and dates as ISO 8601", () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
    expect(escapeCsvCell(new Date("2026-10-09T08:00:00Z"))).toBe(
      '"2026-10-09T08:00:00.000Z"'
    );
  });
});

describe("contactsToCsv", () => {
  const consent =
    "想拿到連結前，先留下你的 Email 📩 直接回覆這則訊息就可以。\nEmail 只會用來寄你索取的資料和之後的新內容，隨時可以退訂。";
  const csv = contactsToCsv([
    {
      username: "leo.tw",
      email: "leo@gmail.com",
      capturedAt: new Date("2026-10-09T08:00:00Z"),
      campaign: '早鳥,限定 "免費" 電子書',
      instagramAccount: "leo_creates",
      emailSource: "typed",
      consentText: consent,
      name: "Leo 李",
      followsYou: true,
      followerCount: 1234,
      sourceType: "comment",
      sourceText: "想要 LINK，謝謝",
      sourceMediaId: "17890000000000001",
      sourceKeyword: "link",
      optedOutAt: new Date("2026-10-10T09:00:00Z"),
    },
    {
      username: null,
      email: "x@y.io",
      capturedAt: null,
      campaign: "=cmd()",
      instagramAccount: "leo_creates",
      emailSource: "quick_reply",
      consentText: null,
      name: "@evil",
      followsYou: false,
      followerCount: null,
      sourceType: "dm",
      sourceText: "=HYPERLINK(\"http://x\")",
      sourceMediaId: null,
      sourceKeyword: "+1",
      optedOutAt: null,
    },
  ]);

  it("starts with a UTF-8 BOM and separates records with CRLF", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    // 1 header + 2 records; the consent text's own line break stays LF.
    expect(csv.split("\r\n")).toHaveLength(4);
  });

  it("has the export columns and no Instagram-scoped id", () => {
    const [header] = parseCsvStrict(csv);
    expect(header).toEqual([...CONTACT_CSV_COLUMNS]);
    expect(header).toEqual([
      "username",
      "email",
      "captured_at",
      "campaign",
      "instagram_account",
      "email_source",
      "consent_text",
      "name",
      "follows_you",
      "follower_count",
      "source_type",
      "source_text",
      "source_media_id",
      "source_keyword",
      "opted_out_at",
    ]);
    expect(csv).not.toMatch(/igsid/i);
  });

  it("reads back cell for cell, with the formula guard on risky text", () => {
    const [, first, second] = parseCsvStrict(csv);
    expect(first).toEqual([
      "leo.tw",
      "leo@gmail.com",
      "2026-10-09T08:00:00.000Z",
      '早鳥,限定 "免費" 電子書',
      "leo_creates",
      "typed",
      consent,
      "Leo 李",
      "true",
      "1234",
      "comment",
      "想要 LINK，謝謝",
      "17890000000000001",
      "link",
      "2026-10-10T09:00:00.000Z",
    ]);
    expect(second).toEqual([
      "",
      "x@y.io",
      "",
      "'=cmd()",
      "leo_creates",
      "quick_reply",
      "",
      // Free text from the person is guarded like every other cell.
      "'@evil",
      "false",
      "",
      "dm",
      '\'=HYPERLINK("http://x")',
      "",
      "'+1",
      "",
    ]);
  });

  it("quotes every field of every record", () => {
    const records = csv.slice(1).split("\r\n").filter(Boolean);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatch(/^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/);
    }
    expect(toCsv(["a", "b"], [["", null]])).toBe('﻿"a","b"\r\n"",""\r\n');
  });
});
