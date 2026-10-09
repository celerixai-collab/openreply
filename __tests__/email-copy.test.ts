import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_INVALID_MESSAGE,
  DEFAULT_EMAIL_PROMPT_MESSAGE,
  DEFAULT_EMAIL_THANKS_MESSAGE,
  MAX_DM_TEXT_BYTES,
  defaultEmailPrompt,
  truncateToUtf8Bytes,
  utf8ByteLength,
} from "../lib/contacts/email-copy";

describe("email gate default copy", () => {
  it("is the agreed Traditional Chinese copy", () => {
    expect(DEFAULT_EMAIL_PROMPT_MESSAGE).toBe(
      "想拿到連結前，先留下你的 Email 📩 直接回覆這則訊息就可以（手機上也能點下方按鈕一鍵帶入）。\nEmail 只會用來寄你索取的資料和之後的新內容，隨時可以退訂。"
    );
    expect(DEFAULT_EMAIL_INVALID_MESSAGE).toBe(
      "這個 Email 好像怪怪的 🤔 再輸入一次看看？（例如 name@gmail.com）"
    );
    expect(DEFAULT_EMAIL_THANKS_MESSAGE).toBe("收到 {email} ✅ 連結馬上傳給你！");
  });

  it("drops the button hint when the ask carries no quick reply", () => {
    expect(defaultEmailPrompt(true)).toBe(DEFAULT_EMAIL_PROMPT_MESSAGE);
    expect(defaultEmailPrompt(false)).toBe(
      "想拿到連結前，先留下你的 Email 📩 直接回覆這則訊息就可以。\nEmail 只會用來寄你索取的資料和之後的新內容，隨時可以退訂。"
    );
  });

  it("stays well under Instagram's 1000-byte limit, even with a long email", () => {
    for (const text of [
      DEFAULT_EMAIL_PROMPT_MESSAGE,
      DEFAULT_EMAIL_INVALID_MESSAGE,
      DEFAULT_EMAIL_THANKS_MESSAGE.replace("{email}", "a".repeat(254)),
    ]) {
      expect(utf8ByteLength(text)).toBeLessThan(MAX_DM_TEXT_BYTES / 2);
    }
  });
});

describe("truncateToUtf8Bytes", () => {
  it("leaves text within the limit untouched", () => {
    expect(truncateToUtf8Bytes("hello", 5)).toBe("hello");
    expect(truncateToUtf8Bytes(DEFAULT_EMAIL_PROMPT_MESSAGE)).toBe(
      DEFAULT_EMAIL_PROMPT_MESSAGE
    );
  });

  it("never cuts inside a multi-byte character", () => {
    // 連 is 3 bytes: 4 bytes fit one character, not one and a third.
    expect(truncateToUtf8Bytes("連結連結", 4)).toBe("連");
    // 📩 is 4 bytes (a surrogate pair): kept whole or dropped whole.
    expect(truncateToUtf8Bytes("a📩b", 4)).toBe("a");
    expect(truncateToUtf8Bytes("a📩b", 5)).toBe("a📩");
  });

  it("caps long Chinese text at 1000 bytes by default", () => {
    const out = truncateToUtf8Bytes("連結".repeat(400));
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(1000);
    expect(utf8ByteLength(out)).toBeGreaterThan(996);
    expect(out).not.toMatch(/�/);
  });
});
