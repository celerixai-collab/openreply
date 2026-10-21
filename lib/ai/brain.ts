/**
 * The assistant's "second brain": knowledge entries (one topic each) and the
 * links it may send as a button. Shared by the API routes, the worker and
 * the prompt; no server-only imports, so the page can use the same limits.
 */

import { z } from "zod";

export const BRAIN_LIMITS = {
  entries: 100,
  entryTitle: 80,
  entryContent: 4000,
  links: 20,
  linkLabel: 20,
  linkUrl: 1000,
  linkDescription: 300,
  // Instagram's button template caps the text above the buttons.
  buttonText: 640,
} as const;

export type KnowledgeEntryInput = { title: string; content: string; enabled?: boolean };
export type LinkInput = { label: string; url: string; description?: string; enabled?: boolean };

const trimmed = (max: number) =>
  z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(max));

export const KnowledgeEntrySchema = z
  .object({
    title: trimmed(BRAIN_LIMITS.entryTitle),
    content: trimmed(BRAIN_LIMITS.entryContent),
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const LinkSchema = z
  .object({
    label: trimmed(BRAIN_LIMITS.linkLabel),
    url: trimmed(BRAIN_LIMITS.linkUrl).refine(
      (value) => /^https:\/\/[^\s]+$/i.test(value),
      "Use a full https:// link"
    ),
    description: z
      .string()
      .max(BRAIN_LIMITS.linkDescription)
      .transform((value) => value.trim())
      .optional(),
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`;
}

export type BrainEntry = { title: string; content: string };
export type BrainLink = { id: string; label: string; url: string; description: string };

/** The knowledge the model reads: entries first, then any legacy free text. */
export function compileKnowledge(entries: BrainEntry[], legacy: string): string {
  const parts = entries.map((entry) => `【${entry.title.trim()}】\n${entry.content.trim()}`);
  if (legacy.trim()) parts.push(legacy.trim());
  return parts.join("\n\n");
}

/** One line per link, with its id for send_link_id. */
export function describeLinks(links: BrainLink[]): string {
  return links
    .map(
      (link) =>
        `- id: ${link.id} | button: 「${link.label}」 | send it when: ${
          link.description.trim() || "the person asks for it"
        } | url: ${link.url}`
    )
    .join("\n");
}

/** Every URL the assistant is allowed to write: in knowledge or as a link. */
export function allowedLinkText(knowledge: string, links: BrainLink[]): string {
  return [knowledge, ...links.map((link) => link.url)].join("\n");
}
