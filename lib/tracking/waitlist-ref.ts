import { prisma } from "@/lib/db/client";
import { DEFAULT_CLICK_SALT, hashRecipientIdWith } from "@/lib/tracking/server";

/**
 * Leo's early-bird waitlist: links to these hosts carry who tapped them, so
 * the sign-up form can show and store the person's Instagram username and
 * the campaign. Links to any other host are redirected exactly as before.
 */
export const WAITLIST_ORIGINS = ["https://leo-waitlist.vercel.app"];

export function isWaitlistUrl(url: string) {
  try {
    return WAITLIST_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** Adds `or_s` (link slug) and `or_r` (recipient token, if any) to a waitlist link. */
export function withWaitlistRef(
  destinationUrl: string,
  slug: string,
  recipientToken: string | null
) {
  if (!isWaitlistUrl(destinationUrl)) return destinationUrl;
  const url = new URL(destinationUrl);
  url.searchParams.set("or_s", slug);
  if (recipientToken) url.searchParams.set("or_r", recipientToken);
  return url.toString();
}

/**
 * Salts a recipient token may have been made with: this host's secret, and
 * the default one a host without NEXTAUTH_SECRET (the DM worker) falls back to.
 */
function candidateSalts() {
  return [...new Set([process.env.NEXTAUTH_SECRET, DEFAULT_CLICK_SALT].filter(Boolean))] as string[];
}

type Person = { commenterId: string; commenterName: string | null };

/** Which of these people a token belongs to, and with which salt (0 = this host's). */
export function matchRecipientToken(people: Person[], token: string) {
  const salts = candidateSalts();
  for (let i = 0; i < salts.length; i++) {
    const person = people.find((p) => hashRecipientIdWith(salts[i], p.commenterId) === token);
    if (person) return { person, salt: salts[i] === process.env.NEXTAUTH_SECRET ? "app" : "default" };
  }
  return null;
}

async function peopleOf(automationId: string): Promise<Person[]> {
  return prisma.dmLog.findMany({
    where: { automationId },
    select: { commenterId: true, commenterName: true },
    distinct: ["commenterId"],
  });
}

export type WaitlistRef = { campaign: string; username: string | null };

/**
 * The campaign a waitlist link belongs to and, when the token matches someone
 * its campaign messaged, that person's username. Null for other links.
 */
export async function resolveWaitlistRef(
  slug: string,
  recipientToken: string | null
): Promise<WaitlistRef | null> {
  const link = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      destinationUrl: true,
      automationId: true,
      automation: { select: { name: true, instagramAccountId: true } },
    },
  });
  if (!link || !isWaitlistUrl(link.destinationUrl)) return null;
  const campaign = link.automation.name;
  if (!recipientToken) return { campaign, username: null };

  const match = matchRecipientToken(await peopleOf(link.automationId), recipientToken);
  if (!match) return { campaign, username: null };

  let username = match.person.commenterName?.trim() || null;
  if (!username) {
    const contact = await prisma.contact.findFirst({
      where: { instagramAccountId: link.automation.instagramAccountId, igsid: match.person.commenterId },
      select: { username: true },
    });
    username = contact?.username?.trim() || null;
  }
  return { campaign, username: username ? username.replace(/^@/, "") : null };
}

/**
 * For the workspace owner: recent taps on waitlist links and whether each
 * one could be matched to the person it was sent to. No tokens or ids out.
 */
export async function checkWaitlistTaps(workspaceId: string, since: Date) {
  const links = await prisma.trackedLink.findMany({
    where: { workspaceId },
    select: { id: true, destinationUrl: true, automationId: true, automation: { select: { name: true } } },
  });
  const waitlist = links.filter((link) => isWaitlistUrl(link.destinationUrl));
  const people = new Map<string, Person[]>();
  for (const link of waitlist) {
    if (!people.has(link.automationId)) people.set(link.automationId, await peopleOf(link.automationId));
  }

  const clicks = await prisma.linkClick.findMany({
    where: { trackedLinkId: { in: waitlist.map((link) => link.id) }, createdAt: { gte: since } },
    select: { trackedLinkId: true, recipientHash: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const taps = clicks.map((click) => {
    const link = waitlist.find((l) => l.id === click.trackedLinkId)!;
    const match = click.recipientHash
      ? matchRecipientToken(people.get(link.automationId) ?? [], click.recipientHash)
      : null;
    return {
      at: click.createdAt,
      campaign: link.automation.name,
      token: Boolean(click.recipientHash),
      matched: match?.salt ?? null,
      username: match?.person.commenterName ?? null,
    };
  });
  return {
    campaigns: waitlist.map((link) => ({ campaign: link.automation.name, people: people.get(link.automationId)?.length ?? 0 })),
    total: taps.length,
    withToken: taps.filter((t) => t.token).length,
    matchedApp: taps.filter((t) => t.matched === "app").length,
    matchedDefault: taps.filter((t) => t.matched === "default").length,
    taps: taps.slice(0, 30),
  };
}
