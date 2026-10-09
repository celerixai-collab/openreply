import type { Prisma } from "@/app/generated/prisma/client";
import type { ContactCsvRow } from "@/lib/contacts/export-csv";

// Query handling shared by the contacts list and its CSV export, so the file
// a creator downloads holds exactly the rows the page shows.

export type ContactFilters = {
  search: string;
  // Default true: the page is the email list; people who never left an
  // email are opt-in.
  hasEmail: boolean;
  // Only the emails one campaign collected (its "N emails collected" link).
  campaign?: string;
};

// Automation ids are cuids; anything else is ignored rather than queried.
const CAMPAIGN_ID = /^[\w-]{1,40}$/;

export function parseContactFilters(params: URLSearchParams): ContactFilters {
  const campaign = params.get("campaign") ?? "";
  return {
    // "@name" is how usernames are shown, so a pasted handle still matches.
    search: (params.get("search") ?? "").trim().replace(/^@+/, "").slice(0, 100),
    hasEmail: params.get("hasEmail") !== "false",
    ...(CAMPAIGN_ID.test(campaign) ? { campaign } : {}),
  };
}

export function parsePagination(params: URLSearchParams) {
  const page = Math.max(
    1,
    Number.parseInt(params.get("page") ?? "1", 10) || 1
  );
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(params.get("limit") ?? "25", 10) || 25)
  );
  return { page, limit, skip: (page - 1) * limit };
}

/** Always scoped to one workspace; the filters only narrow inside it. */
export function contactsWhere(
  workspaceId: string,
  { search, hasEmail, campaign }: ContactFilters
): Prisma.ContactWhereInput {
  return {
    workspaceId,
    ...(hasEmail ? { email: { not: null } } : {}),
    ...(campaign ? { emailAutomationId: campaign } : {}),
    ...(search
      ? {
          OR: [
            { username: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

// Newest capture first; people without an email (shown only with the
// has-email filter off) follow, most recently active first.
export const CONTACTS_ORDER_BY: Prisma.ContactOrderByWithRelationInput[] = [
  { emailCapturedAt: { sort: "desc", nulls: "last" } },
  { lastInteractionAt: "desc" },
  { id: "asc" },
];

// The igsid and the pending gate state stay server-side.
export const CONTACT_LIST_SELECT = {
  id: true,
  username: true,
  email: true,
  emailCapturedAt: true,
  emailSource: true,
  emailConsentText: true,
  emailSourceType: true,
  emailSourceText: true,
  emailSourceMediaId: true,
  emailSourceKeyword: true,
  emailOptedOutAt: true,
  lastTriggerType: true,
  lastTriggerText: true,
  lastTriggerMediaId: true,
  lastTriggerKeyword: true,
  name: true,
  followsYou: true,
  followerCount: true,
  firstSeenAt: true,
  lastInteractionAt: true,
  emailAutomation: { select: { id: true, name: true } },
  instagramAccount: { select: { username: true } },
} satisfies Prisma.ContactSelect;

export type ContactListItem = Prisma.ContactGetPayload<{
  select: typeof CONTACT_LIST_SELECT;
}>;

type SourceFields = {
  email: string | null;
  emailSourceType: string | null;
  emailSourceText: string | null;
  emailSourceMediaId: string | null;
  emailSourceKeyword: string | null;
  lastTriggerType: string | null;
  lastTriggerText: string | null;
  lastTriggerMediaId: string | null;
  lastTriggerKeyword: string | null;
};

/**
 * The comment or DM behind a contact, as the page and the CSV show it: for
 * an email, the trigger that led to it (unknown for emails captured before
 * it was recorded); for someone without one, what they last sent.
 */
export function contactSource(contact: SourceFields) {
  return contact.email
    ? {
        type: contact.emailSourceType,
        text: contact.emailSourceText,
        mediaId: contact.emailSourceMediaId,
        keyword: contact.emailSourceKeyword,
      }
    : {
        type: contact.lastTriggerType,
        text: contact.lastTriggerText,
        mediaId: contact.lastTriggerMediaId,
        keyword: contact.lastTriggerKeyword,
      };
}

export function toContactCsvRow(contact: ContactListItem): ContactCsvRow {
  const source = contactSource(contact);
  return {
    username: contact.username,
    email: contact.email,
    capturedAt: contact.emailCapturedAt,
    campaign: contact.emailAutomation?.name ?? null,
    instagramAccount: contact.instagramAccount.username,
    emailSource: contact.emailSource,
    consentText: contact.emailConsentText,
    name: contact.name,
    followsYou: contact.followsYou,
    followerCount: contact.followerCount,
    sourceType: source.type,
    sourceText: source.text,
    sourceMediaId: source.mediaId,
    sourceKeyword: source.keyword,
    optedOutAt: contact.emailOptedOutAt,
  };
}
