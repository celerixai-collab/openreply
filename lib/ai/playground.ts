/**
 * Playground: try the assistant on a made-up conversation. The web app
 * queues the request (the Claude key lives only on the worker), the worker
 * writes the result to Redis, and the page polls for it. Nothing is ever
 * sent to Instagram and no draft is stored.
 */

import { z } from "zod";
import { BRAIN_LIMITS, KnowledgeEntrySchema, LinkSchema } from "@/lib/ai/brain";
import { AI_SETTINGS_LIMITS } from "@/lib/ai/constants";
import { getRedisConnection } from "@/lib/queue/client";

export const PLAYGROUND_TTL_SECONDS = 15 * 60;
export const PLAYGROUND_HOURLY_LIMIT = 120;

export const PlaygroundTurns = z
  .array(
    z
      .object({
        from: z.enum(["person", "creator"]),
        text: z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(1000)),
      })
      .strict()
  )
  .min(1)
  .max(30)
  .refine((turns) => turns.at(-1)?.from === "person", "The last message must be from the person");

export type PlaygroundTurn = z.infer<typeof PlaygroundTurns>[number];

/**
 * A draft brain to try instead of the saved one: the run reads these settings,
 * entries and links, and the account's saved brain is left untouched.
 */
export const PlaygroundBrain = z
  .object({
    settings: z
      .object({
        role: z.string().max(AI_SETTINGS_LIMITS.role),
        voice: z.string().max(AI_SETTINGS_LIMITS.voice),
        guardrails: z.string().max(AI_SETTINGS_LIMITS.guardrails),
        goals: z.string().max(AI_SETTINGS_LIMITS.goals),
        knowledge: z.string().max(AI_SETTINGS_LIMITS.knowledge).default(""),
      })
      .passthrough(),
    entries: z.array(KnowledgeEntrySchema).max(BRAIN_LIMITS.entries),
    links: z.array(LinkSchema).max(BRAIN_LIMITS.links),
  });

export type PlaygroundBrain = z.infer<typeof PlaygroundBrain>;

export type PlaygroundResult =
  | { status: "pending" }
  | { status: "error"; error: string }
  | {
      status: "done";
      replyText: string;
      intent: string;
      needsHuman: boolean;
      handoffReason: string | null;
      confidence: string;
      language: string;
      link: { id: string; label: string; url: string } | null;
      knowledgeGap: boolean;
      gapQuestion: string | null;
      usedTopics: string[];
      // What would actually be sent (the disclosure in front of a first reply).
      outgoingText: string;
      wouldAutoSend: boolean;
    };

const key = (id: string) => `ai:playground:${id}`;

export async function writePlaygroundResult(id: string, result: PlaygroundResult) {
  await getRedisConnection().set(key(id), JSON.stringify(result), "EX", PLAYGROUND_TTL_SECONDS);
}

export async function readPlaygroundResult(id: string): Promise<PlaygroundResult | null> {
  const raw = await getRedisConnection().get(key(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PlaygroundResult;
  } catch {
    return null;
  }
}

/** Count a playground run for the workspace; false once over the hourly cap. */
export async function takePlaygroundRun(workspaceId: string): Promise<boolean> {
  const redis = getRedisConnection();
  const bucket = `ai:playground:count:${workspaceId}:${Math.floor(Date.now() / 3_600_000)}`;
  const used = await redis.incr(bucket);
  if (used === 1) await redis.expire(bucket, 3600);
  return used <= PLAYGROUND_HOURLY_LIMIT;
}
