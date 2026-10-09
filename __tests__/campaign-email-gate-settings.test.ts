import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEmailGateFields,
  emailGateCreateData,
  normalizeEmailGateUpdate,
  updateEmailGateFields,
} from "../lib/campaigns/email-gate-settings";

const createSchema = z.object(createEmailGateFields);
const updateSchema = z.object(updateEmailGateFields);

describe("email gate campaign settings", () => {
  it("defaults to off, with the one-tap button on", () => {
    expect(createSchema.parse({})).toEqual({
      collectEmail: false,
      emailQuickReplyEnabled: true,
    });
  });

  it("leaves every field out of an update that does not mention it", () => {
    expect(updateSchema.parse({})).toEqual({});
  });

  it("rejects wrong types and over-long messages", () => {
    expect(createSchema.safeParse({ collectEmail: "yes" }).success).toBe(false);
    expect(
      createSchema.safeParse({ emailPromptMessage: "a".repeat(1001) }).success
    ).toBe(false);
    expect(
      updateSchema.safeParse({ emailThanksMessage: "a".repeat(1000) }).success
    ).toBe(true);
  });

  it("measures messages in Instagram's UTF-8 bytes, not characters", () => {
    // 3 bytes per Chinese character: 333 fit in 1000 bytes, 334 do not.
    expect(
      createSchema.safeParse({ emailPromptMessage: "請".repeat(333) }).success
    ).toBe(true);
    expect(
      createSchema.safeParse({ emailPromptMessage: "請".repeat(334) }).success
    ).toBe(false);
    expect(
      updateSchema.safeParse({ emailInvalidMessage: "📩".repeat(251) }).success
    ).toBe(false);
  });

  it("stores trimmed copy, and blank copy as null so the default is used", () => {
    expect(
      emailGateCreateData(
        createSchema.parse({
          collectEmail: true,
          emailPromptMessage: "  Leave your email 📩  ",
          emailInvalidMessage: "   ",
          emailThanksMessage: "",
          emailQuickReplyEnabled: false,
        })
      )
    ).toEqual({
      collectEmail: true,
      emailPromptMessage: "Leave your email 📩",
      emailInvalidMessage: null,
      emailThanksMessage: null,
      emailQuickReplyEnabled: false,
    });
  });

  it("drops custom copy when a new campaign has the gate off", () => {
    expect(
      emailGateCreateData(
        createSchema.parse({ collectEmail: false, emailPromptMessage: "Hi" })
      )
    ).toMatchObject({ collectEmail: false, emailPromptMessage: null });
  });

  it("normalizes an update: blanks become null, turning off clears the copy", () => {
    const update = updateSchema.parse({
      emailPromptMessage: " Custom ask ",
      emailThanksMessage: "  ",
    });
    normalizeEmailGateUpdate(update);
    expect(update).toEqual({
      emailPromptMessage: "Custom ask",
      emailThanksMessage: null,
    });

    const off = updateSchema.parse({
      collectEmail: false,
      emailPromptMessage: "Custom ask",
    });
    normalizeEmailGateUpdate(off);
    expect(off).toEqual({
      collectEmail: false,
      emailPromptMessage: null,
      emailInvalidMessage: null,
      emailThanksMessage: null,
    });
  });
});
