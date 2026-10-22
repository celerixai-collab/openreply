import { z } from "zod";
import { AI_MODES, AI_SETTINGS_LIMITS as L, utf8ByteLength } from "./constants";

const text = (max: number) => z.string().max(max).transform((value) => value.trim());

// The model is not settable in v1: Claude Haiku 5.5.
const AiSettingsPatch = z
  .object({
    accountId: z.string().min(1),
    enabled: z.boolean().optional(),
    mode: z.enum(AI_MODES).optional(),
    goals: text(L.goals).optional(),
    humanPauseHours: z.number().int().min(0).max(L.humanPauseHoursMax).optional(),
    role: text(L.role).optional(),
    voice: text(L.voice).optional(),
    guardrails: text(L.guardrails).optional(),
    knowledge: text(L.knowledge).optional(),
    disclosureText: text(L.disclosureText)
      // Shares the 1000-byte message with the reply.
      .refine((value) => utf8ByteLength(value) <= 300, "Disclosure is too long")
      .optional(),
    campaignIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    testUsernames: z
      .array(z.string().transform((value) => value.trim().replace(/^@/, "").toLowerCase()).pipe(z.string().regex(/^[a-z0-9._]{1,30}$/)))
      .max(20)
      .optional(),
    dailyDraftCapPerPerson: z
      .number()
      .int()
      .min(L.dailyDraftCapMin)
      .max(L.dailyDraftCapMax)
      .optional(),
  })
  .strict();

export type AiSettingsPatchInput = z.infer<typeof AiSettingsPatch>;

export function parseAiSettingsPatch(
  body: unknown
): { ok: true; data: AiSettingsPatchInput } | { ok: false; error: string } {
  const result = AiSettingsPatch.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `Invalid ${issue?.path.join(".") || "settings"}: ${issue?.message ?? "invalid"}`,
    };
  }
  return { ok: true, data: result.data };
}
