// The product runs on Mac and Windows, so no campaign may say otherwise.
const BANNED_COPY = /只支援\s*(Mac|macOS)|Windows\s*(不行|不能|還不能|不支援)|不支援\s*Windows/i;

export function findBannedCopy(fields: unknown): string | null {
  return JSON.stringify(fields ?? "").match(BANNED_COPY)?.[0] ?? null;
}
