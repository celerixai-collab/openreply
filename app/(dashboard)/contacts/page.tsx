"use client";

/**
 * Contacts Page
 *
 * The emails campaigns' email gates collected: searchable, paginated, with a
 * CSV export and per-contact delete.
 */

import { useI18n } from "@/lib/i18n/provider";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { contactSource } from "@/lib/contacts/list";

interface Contact {
  id: string;
  username: string | null;
  name: string | null;
  followsYou: boolean | null;
  email: string | null;
  emailCapturedAt: string | null;
  emailSource: string | null;
  emailSourceType: string | null;
  emailSourceText: string | null;
  emailSourceMediaId: string | null;
  emailSourceKeyword: string | null;
  emailOptedOutAt: string | null;
  lastTriggerType: string | null;
  lastTriggerText: string | null;
  lastTriggerMediaId: string | null;
  lastTriggerKeyword: string | null;
  lastInteractionAt: string;
  emailAutomation: { id: string; name: string } | null;
  instagramAccount: { username: string };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const PAGE_SIZE = 25;

// useSearchParams (the ?campaign= filter) needs a Suspense boundary, or the
// prerendered client page fails the production build.
export default function ContactsPage() {
  return (
    <Suspense fallback={null}>
      <ContactsList />
    </Suspense>
  );
}

function ContactsList() {
  const { t, locale } = useI18n();
  const router = useRouter();
  // Set by a campaign's "N emails collected" link.
  const campaign = useSearchParams().get("campaign");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  // Export and delete are for owners and admins; hidden until the list says.
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // Everyone by default; a campaign's "N emails collected" link opens the
  // email list.
  const [hasEmail, setHasEmail] = useState(Boolean(campaign));
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  // Debounce typing so every keystroke is not a query.
  useEffect(() => {
    const next = searchInput.trim();
    if (next === search) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setPage(1);
      setSearch(next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (!hasEmail) params.set("hasEmail", "false");
    if (campaign) params.set("campaign", campaign);
    return params;
  }, [search, hasEmail, campaign]);

  const fetchContacts = useCallback(async () => {
    let steppedBack = false;
    try {
      const params = filterParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      const res = await fetch(`/api/contacts?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        const { totalPages } = data.data.pagination;
        // The last row of a later page was deleted: step back to the new
        // last page instead of showing an empty one.
        if (
          data.data.contacts.length === 0 &&
          totalPages >= 1 &&
          page > totalPages
        ) {
          steppedBack = true;
          setLoading(true);
          setPage(totalPages);
          return;
        }
        setContacts(data.data.contacts);
        setPagination(data.data.pagination);
        setCanManage(Boolean(data.data.canManage));
      }
    } catch (err) {
      console.error("Failed to fetch contacts:", err);
    } finally {
      if (!steppedBack) setLoading(false);
    }
  }, [filterParams, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchContacts();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchContacts]);

  // Once per browser session, add the commenters campaigns replied to before
  // contacts were recorded (DM logs); refetch if anyone new came in.
  useEffect(() => {
    if (!canManage) return;
    const key = "openreply:contacts-backfill";
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage blocked: run anyway, the import is idempotent.
    }
    void fetch("/api/contacts/backfill", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data?.success && data.data.created > 0) void fetchContacts();
      })
      .catch(() => {});
  }, [canManage, fetchContacts]);

  function toggleHasEmail() {
    setLoading(true);
    setHasEmail((value) => !value);
    setPage(1);
  }

  function showAllCampaigns() {
    setLoading(true);
    setPage(1);
    router.replace("/contacts");
  }

  async function deleteContact(contact: Contact) {
    const who =
      contact.email ??
      (contact.username ? `@${contact.username}` : t("this contact"));
    const question = contact.email
      ? t(
          "Delete {contact} from your contacts? Their email is removed and this cannot be undone.",
          { contact: who },
        )
      : t("Delete {contact} from your contacts? This cannot be undone.", {
          contact: who,
        });
    if (!confirm(question)) return;
    setError(null);
    setDeletingId(contact.id);
    try {
      const res = await fetch(`/api/contacts?id=${contact.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? t("Failed to delete contact"));
        return;
      }
      // Refetch rather than splice, so the page and total stay right (and a
      // page left empty steps back; see fetchContacts).
      await fetchContacts();
    } catch {
      setError(t("Failed to delete contact"));
    } finally {
      setDeletingId(null);
    }
  }

  // Pull everyone who commented on the account's posts from Instagram, in
  // slices; a rate-limited run resumes from the saved cursor next time.
  async function importAllCommenters() {
    const key = "openreply:import-comments-cursor";
    let cursor: unknown = null;
    try {
      cursor = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      cursor = null;
    }
    setImporting(true);
    setError(null);
    let scanned = 0;
    let created = 0;
    try {
      for (;;) {
        const res = await fetch("/api/contacts/import-comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor }),
        });
        const data = await res.json();
        if (!data.success) {
          setError(data.error ?? t("Import failed"));
          break;
        }
        const r = data.data;
        scanned += r.scannedComments;
        created += r.created;
        cursor = r.cursor;
        try {
          if (cursor) localStorage.setItem(key, JSON.stringify(cursor));
          else localStorage.removeItem(key);
        } catch {
          // Storage blocked: a rate-limited run restarts from the top.
        }
        setImportStatus(
          t(
            "Importing: {scanned} comments scanned, {created} new contacts (post {done}/{total})",
            {
              scanned,
              created,
              done: r.mediaDone,
              total: r.mediaTotal,
            },
          ),
        );
        if (r.rateLimited) {
          setImportStatus(
            t(
              "Instagram is rate limiting: {scanned} comments scanned, {created} new contacts. Click again later to continue where it stopped.",
              { scanned, created },
            ),
          );
          break;
        }
        if (!cursor) {
          setImportStatus(
            t(
              "Import finished: {scanned} comments scanned, {created} new contacts.",
              { scanned, created },
            ),
          );
          break;
        }
      }
    } catch {
      setError(t("Import failed"));
    } finally {
      setImporting(false);
      setPage(1);
      await fetchContacts();
    }
  }

  const exportParams = filterParams();
  const exportHref = `/api/contacts/export${
    exportParams.size ? `?${exportParams}` : ""
  }`;
  const isFiltered = Boolean(search) || !hasEmail || Boolean(campaign);
  const sourceLabel = (source: string | null) =>
    source === "quick_reply"
      ? t("One-tap button")
      : source === "typed"
        ? t("Typed")
        : "—";
  const describeSource = (contact: Contact) => {
    const { type, text } = contactSource(contact);
    return {
      label: type === "comment" ? t("Comment") : type === "dm" ? t("DM") : null,
      text,
    };
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <p className="text-sm text-muted">
          {pagination
            ? t(hasEmail ? "{count} emails" : "{count} contacts", {
                count: pagination.total,
              })
            : " "}
        </p>
        {canManage && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void importAllCommenters()}
              disabled={importing}
              className="rounded border border-border px-4 py-2 text-center text-sm font-medium text-muted hover:text-foreground disabled:opacity-40"
            >
              {importing ? t("Importing…") : t("Import all commenters")}
            </button>
            <a
              href={exportHref}
              download
              aria-disabled={!pagination || pagination.total === 0}
              className={`rounded border border-border px-4 py-2 text-center text-sm font-medium text-muted hover:text-foreground ${
                !pagination || pagination.total === 0
                  ? "pointer-events-none opacity-40"
                  : ""
              }`}
            >
              {t("Export CSV")}
            </a>
          </div>
        )}
      </div>
      {importStatus && (
        <p className="text-sm text-muted" role="status">
          {importStatus}
        </p>
      )}

      <p className="text-xs text-muted">
        {t(
          "Someone asks to be removed? Delete them here and unsubscribe them in your email tool too.",
        )}
      </p>

      {campaign && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span>{t("Showing the emails one campaign collected.")}</span>
          <button
            type="button"
            onClick={showAllCampaigns}
            className="font-medium text-foreground hover:text-accent"
          >
            {t("Show all")}
          </button>
        </div>
      )}

      {/* Search + has-email filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("Search by username or email…")}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
        />
        <label className="flex shrink-0 cursor-pointer items-center gap-3 text-sm text-foreground">
          <span>{t("Only people with an email")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={hasEmail}
            onClick={toggleHasEmail}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              hasEmail ? "bg-accent" : "bg-zinc-300"
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                hasEmail ? "left-6" : "left-1"
              }`}
            />
          </button>
        </label>
      </div>

      {error && (
        <div className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {/* Empty state: nothing collected yet */}
      {!loading && contacts.length === 0 && !isFiltered && (
        <div className="panel rounded p-8 text-center sm:p-12">
          <h3 className="mb-2 text-lg font-semibold">
            {t("No emails collected yet")}
          </h3>
          <p className="mx-auto mb-6 max-w-md text-sm text-muted">
            {t(
              "Turn on the Email gate in a campaign: open it, click Edit, and switch on “an email request before the link”. People then reply with their email to get the link, and every email shows up here.",
            )}
          </p>
          <Link
            href="/campaigns"
            className="inline-flex items-center gap-2 rounded bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            {t("Go to campaigns")}
          </Link>
        </div>
      )}

      {/* Table */}
      {(loading || contacts.length > 0 || isFiltered) && (
        <div className="panel rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">
                    {t("Username")}
                  </th>
                  <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">
                    {t("Email")}
                  </th>
                  <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">
                    {t("Campaign")}
                  </th>
                  <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">
                    {t("Captured")}
                  </th>
                  <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">
                    {t("Source")}
                  </th>
                  <th className="px-4 py-4 sm:px-6" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading &&
                  [...Array(5)].map((_, i) => (
                    <tr key={i}>
                      <td colSpan={6} className="px-4 py-4 sm:px-6">
                        <div className="h-4 bg-surface-hover rounded" />
                      </td>
                    </tr>
                  ))}
                {!loading && contacts.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-12 text-center text-muted sm:px-6"
                    >
                      {t("No contacts match your search.")}
                    </td>
                  </tr>
                )}
                {!loading &&
                  contacts.map((contact) => (
                    <tr
                      key={contact.id}
                      className="hover:bg-surface-hover/50 transition-colors"
                    >
                      <td className="px-4 py-4 sm:px-6">
                        <span className="block font-medium text-foreground">
                          {contact.username ? `@${contact.username}` : "—"}
                        </span>
                        {contact.name && (
                          <span className="block text-xs text-foreground/80">
                            {contact.name}
                          </span>
                        )}
                        {contact.followsYou !== null && (
                          <span
                            className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                              contact.followsYou
                                ? "bg-accent/10 text-accent"
                                : "bg-surface-hover text-muted"
                            }`}
                          >
                            {contact.followsYou
                              ? t("Follows you")
                              : t("Not following")}
                          </span>
                        )}
                        <span className="block text-xs text-muted">
                          {t("via @{account}", {
                            account: contact.instagramAccount.username,
                          })}
                        </span>
                      </td>
                      <td className="px-4 py-4 sm:px-6">
                        {contact.email ? (
                          <>
                            <span className="select-all break-all text-foreground">
                              {contact.email}
                            </span>
                            {contact.emailOptedOutAt && (
                              <span
                                title={t("Asked by DM not to be emailed")}
                                className="mt-1 block w-fit rounded bg-error/10 px-1.5 py-0.5 text-[11px] font-medium text-error"
                              >
                                {t("Unsubscribed")}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-4 sm:px-6">
                        {contact.emailAutomation ? (
                          <Link
                            href={`/campaigns/${contact.emailAutomation.id}`}
                            className="text-muted hover:text-foreground"
                          >
                            {contact.emailAutomation.name}
                          </Link>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-muted whitespace-nowrap sm:px-6">
                        {contact.emailCapturedAt
                          ? new Date(contact.emailCapturedAt).toLocaleString(
                              locale,
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            )
                          : "—"}
                      </td>
                      <td className="px-4 py-4 text-muted sm:px-6">
                        <span className="block whitespace-nowrap">
                          {sourceLabel(contact.emailSource)}
                        </span>
                        <SourceText {...describeSource(contact)} />
                      </td>
                      <td className="px-4 py-4 text-right sm:px-6">
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => void deleteContact(contact)}
                            disabled={deletingId === contact.id}
                            className="rounded px-2 py-1 text-xs font-medium text-muted hover:text-error disabled:opacity-40"
                          >
                            {t("Delete")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 border-t border-border sm:px-6">
              <p className="text-xs text-muted">
                {t("Showing {start}–{end} of {total}", {
                  start: (pagination.page - 1) * pagination.limit + 1,
                  end: Math.min(
                    pagination.page * pagination.limit,
                    pagination.total,
                  ),
                  total: pagination.total,
                })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => {
                    setLoading(true);
                    setPage(page - 1);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground hover:border-border-hover transition-all disabled:opacity-30 disabled:pointer-events-none"
                >
                  {t("Previous")}
                </button>
                <span className="text-xs text-muted px-2">
                  {page} / {pagination.totalPages}
                </span>
                <button
                  disabled={page >= pagination.totalPages}
                  onClick={() => {
                    setLoading(true);
                    setPage(page + 1);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground hover:border-border-hover transition-all disabled:opacity-30 disabled:pointer-events-none"
                >
                  {t("Next")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The comment or DM behind the contact, cut to one line; the full text is in
// the tooltip.
function SourceText({
  label,
  text,
}: {
  label: string | null;
  text: string | null;
}) {
  if (!text) return null;
  return (
    <span
      title={text}
      className="block max-w-[14rem] truncate text-xs text-muted"
    >
      {label ? `${label}: ` : ""}
      {text}
    </span>
  );
}
