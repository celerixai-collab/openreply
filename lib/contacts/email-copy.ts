// Default copy and size limits for the email gate. No server imports here, so
// the campaign builder and preview can share the exact defaults the worker
// sends when a campaign leaves a message empty.

// Instagram rejects DM text over 1000 UTF-8 bytes. A Traditional Chinese
// character is 3 bytes and an emoji 4, so that is only ~333 characters.
export const MAX_DM_TEXT_BYTES = 1000;

// Shown only when the ask actually carries Instagram's one-tap email button.
const QUICK_REPLY_HINT = "（手機上也能點下方按鈕一鍵帶入）";

export const DEFAULT_EMAIL_PROMPT_MESSAGE = `想拿到連結前，先留下你的 Email 📩 直接回覆這則訊息就可以${QUICK_REPLY_HINT}。\nEmail 只會用來寄你索取的資料和之後的新內容，隨時可以退訂。`;
export const DEFAULT_EMAIL_INVALID_MESSAGE =
  "這個 Email 好像怪怪的 🤔 再輸入一次看看？（例如 name@gmail.com）";
export const DEFAULT_EMAIL_THANKS_MESSAGE = "收到 {email} ✅ 連結馬上傳給你！";

/**
 * The default ask. Without the quick-reply button (a comment's private reply,
 * a provider that cannot attach one, or the button turned off) the hint
 * pointing at that button is dropped rather than sending a message that
 * refers to something that is not there.
 */
export function defaultEmailPrompt(withQuickReply: boolean): string {
  return withQuickReply
    ? DEFAULT_EMAIL_PROMPT_MESSAGE
    : DEFAULT_EMAIL_PROMPT_MESSAGE.replace(QUICK_REPLY_HINT, "");
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Cut `text` to at most `maxBytes` of UTF-8, never inside a character: the
 * loop walks code points, so a surrogate pair (emoji) is kept or dropped
 * whole.
 */
export function truncateToUtf8Bytes(
  text: string,
  maxBytes: number = MAX_DM_TEXT_BYTES
): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const size = utf8ByteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}
