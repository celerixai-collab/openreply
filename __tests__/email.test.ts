import { describe, expect, it } from "vitest";
import {
  EMAIL_MAX_LENGTH,
  extractEmail,
  looksLikeEmailAttempt,
  normalizeForEmail,
} from "../lib/utils/email";

const a = (n: number) => "a".repeat(n);
const label63 = "b".repeat(63);

describe("extractEmail", () => {
  it.each([
    ["abc@gmail.com", "abc@gmail.com"],
    ["我的信箱是 abc@gmail.com 謝謝", "abc@gmail.com"],
    ["ABC@Gmail.com.", "abc@gmail.com"],
    ["My email is John.Doe@Example.COM thanks!", "john.doe@example.com"],
    ["email: a.b+c@sub.example.co.uk", "a.b+c@sub.example.co.uk"],
    ["我的email是abc@yahoo.com.tw", "abc@yahoo.com.tw"],
    ["Email：abc@ms12.hinet.net", "abc@ms12.hinet.net"],
    ["(abc@gmail.com)", "abc@gmail.com"],
    ["mailto:abc@gmail.com", "abc@gmail.com"],
    ["abc@gmail.com, thanks", "abc@gmail.com"],
    ["0912345678@gmail.com", "0912345678@gmail.com"],
    ["user@example.xn--kpry57d", "user@example.xn--kpry57d"],
  ])("finds the address in %j", (input, expected) => {
    expect(extractEmail(input)).toBe(expected);
  });

  it("folds the full-width at sign and full stops a Chinese IME types", () => {
    expect(extractEmail("abc＠gmail．com")).toBe("abc@gmail.com");
    expect(extractEmail("ａｂｃ＠ｇｍａｉｌ．ｃｏｍ")).toBe("abc@gmail.com");
    expect(extractEmail("ＡＢＣ１２３＠ＧＭＡＩＬ．ＣＯＭ")).toBe("abc123@gmail.com");
    expect(extractEmail("abc﹫gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("abc＠gmail．com，謝謝你～")).toBe("abc@gmail.com");
  });

  it("treats the ideographic full stop as a dot", () => {
    expect(extractEmail("abc@gmail。com")).toBe("abc@gmail.com");
    expect(extractEmail("abc@yahoo。com。tw 謝謝")).toBe("abc@yahoo.com.tw");
    expect(extractEmail("abc@gmail｡com")).toBe("abc@gmail.com");
    expect(extractEmail("我的信箱是abc@gmail.com。謝謝！")).toBe("abc@gmail.com");
  });

  it("ignores invisible characters copied along with the address", () => {
    expect(extractEmail("abc​@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("abc@gmail​.com")).toBe("abc@gmail.com");
    expect(extractEmail("﻿abc@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("ab­c@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("‮abc@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("email: abc@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("abc@gmail.com　謝謝")).toBe("abc@gmail.com");
  });

  it("finds an address glued to Chinese text with no spaces", () => {
    expect(extractEmail("信箱abc@gmail.com謝謝")).toBe("abc@gmail.com");
    expect(extractEmail("📧abc@gmail.com📧")).toBe("abc@gmail.com");
    expect(extractEmail("加LINE@leo123 或寄信 leo@gmail.com")).toBe("leo@gmail.com");
  });

  it("drops a leading - + = so a stored email never starts a spreadsheet formula", () => {
    expect(extractEmail("-abc@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("+abc@gmail.com")).toBe("abc@gmail.com");
    expect(extractEmail("=1+1@x.com")).toBe("1+1@x.com");
    expect(extractEmail("信箱-abc@gmail.com")).toBe("abc@gmail.com");
  });

  it("returns the first of two emails", () => {
    expect(extractEmail("two: a@x.com b@y.com")).toBe("a@x.com");
  });

  it("returns the first valid email, skipping a mistyped one", () => {
    expect(extractEmail("abc.@gmail.com 打錯了 abc@gmail.com")).toBe("abc@gmail.com");
  });

  it("accepts a 64-character local part and rejects 65 instead of truncating it", () => {
    expect(extractEmail(`${a(64)}@gmail.com`)).toBe(`${a(64)}@gmail.com`);
    expect(extractEmail(`${a(65)}@gmail.com`)).toBeNull();
    expect(extractEmail(`x-${a(63)}@gmail.com`)).toBeNull();
  });

  it("enforces the domain and total length limits", () => {
    const longest = `a@${`${label63}.`.repeat(3)}com`;
    expect(extractEmail(longest)).toBe(longest);
    expect(longest.length).toBeLessThanOrEqual(EMAIL_MAX_LENGTH);
    expect(extractEmail(`a@${`${label63}.`.repeat(4)}com`)).toBeNull();
    expect(extractEmail(`a@${"b".repeat(64)}.com`)).toBeNull();
  });

  it.each([
    ["abc@gmail", "no TLD"],
    ["abc @ gmail.com", "spaces around @ (strict on purpose)"],
    ["abc@ gmail.com", "space after @"],
    ["@abc", "a handle"],
    ["我的IG是 @leo.tw", "an IG handle"],
    ["abc..def@gmail.com", "double dot in the local part"],
    [".abc@gmail.com", "local part starts with a dot"],
    ["abc@gmail..com", "double dot in the domain"],
    ["abc@-gmail.com", "label starts with -"],
    ["abc@gmail.c", "one-letter TLD"],
    ["abc@yahoo.com.t", "truncated .tw must not become yahoo.com"],
    ["abc@def@gmail.com", "two @"],
    ["abc@gmail,com", "comma for a dot"],
    ["https://medium.com/@leo/post", "a URL"],
    ["user@例子.台灣", "IDN domains are not supported"],
    ["我沒有email", "no email at all"],
    ["", "empty"],
  ])("returns null for %j (%s)", (input) => {
    expect(extractEmail(input)).toBeNull();
  });

  it("handles null and undefined", () => {
    expect(extractEmail(null)).toBeNull();
    expect(extractEmail(undefined)).toBeNull();
  });

  it("finds an address after 5000 Chinese characters", () => {
    expect(extractEmail(`${"我".repeat(5000)} abc@gmail.com`)).toBe("abc@gmail.com");
  });

  it("stays fast on long adversarial input", () => {
    const n = 200_000;
    const inputs = [
      a(n),
      `${a(n)}@gmail.com`,
      `${"a.".repeat(n / 2)}@`,
      "a@".repeat(n / 2),
      `${"a-".repeat(n / 2)}@gmail.com`,
      `a@${"b.".repeat(n / 2)}1`,
    ];
    const started = performance.now();
    for (const input of inputs) extractEmail(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("looksLikeEmailAttempt", () => {
  it.each([
    ["abc@gmail", true],
    ["abc gmail.com", true],
    ["abc at gmail dot com", true],
    ["我的LINE是@abc.tw", true],
    ["我不想給", false],
    ["好", false],
    ["連結", false],
  ])("%j -> %s", (input, expected) => {
    expect(looksLikeEmailAttempt(input)).toBe(expected);
  });
});

describe("normalizeForEmail", () => {
  it("applies NFKC, strips invisible characters, maps full stops and lowercases", () => {
    expect(normalizeForEmail("ＡＢＣ​＠Ｇｍａｉｌ。ＣＯＭ")).toBe("abc@gmail.com");
  });
});
