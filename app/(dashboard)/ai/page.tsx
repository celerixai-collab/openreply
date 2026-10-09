"use client";

/**
 * AI Assistant Page
 *
 * Draft mode: the worker writes a suggested reply to DMs no campaign
 * answered, and nothing is sent until someone here edits and sends it.
 * Two tabs: the drafts to review (plus their history) and the settings.
 */

import { useCallback, useEffect, useState } from "react";
import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import {
  AI_MODEL_LABEL,
  AI_SETTINGS_LIMITS,
  MAX_DM_TEXT_BYTES,
  composeOutgoingText,
  utf8ByteLength,
} from "@/lib/ai/constants";

type Tab = "drafts" | "settings";

interface AccountRow {
  id: string;
  username: string;
  provider: "META" | "ZERNIO";
  enabled: boolean;
}

interface Settings {
  enabled: boolean;
  role: string;
  voice: string;
  guardrails: string;
  knowledge: string;
  disclosureText: string;
  dailyDraftCapPerPerson: number;
}

interface SettingsPayload {
  accounts: AccountRow[];
  selectedAccountId: string | null;
  supported: boolean;
  settings: Settings | null;
  worker: { healthy: boolean; aiConfigured: boolean | null };
  canManage: boolean;
}

interface Turn {
  from: "person" | "creator";
  text: string;
  at: string | null;
}

interface Draft {
  id: string;
  username: string | null;
  name: string | null;
  accountUsername: string;
  inboundText: string;
  inboundAt: string;
  historySnapshot: Turn[];
  draftText: string;
  intent: string | null;
  needsHuman: boolean;
  handoffReason: string | null;
  status: string;
  finalText: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  sentAt: string | null;
  disclosureText: string;
  firstReply: boolean;
  windowEndsAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const INTENT_LABELS: Record<string, StaticMessageKey> = {
  greeting: "Greeting",
  offer_question: "Offer question",
  pricing: "Pricing question",
  link_request: "Link request",
  collab_or_business: "Collab or business",
  complaint_or_refund: "Complaint or refund",
  spam_or_abuse: "Spam or abuse",
  other: "Other topic",
};

const STATUS_LABELS: Record<string, StaticMessageKey> = {
  PENDING: "To review",
  SENDING: "Sending…",
  SENT: "Sent",
  DISMISSED: "Not replied",
  EXPIRED: "Expired",
  FAILED: "Failed",
  SUPERSEDED: "Replaced by a newer draft",
};

const HISTORY_FILTERS = ["ALL", "SENT", "DISMISSED", "EXPIRED", "FAILED", "SUPERSEDED"] as const;

const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

export default function AiAssistantPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("drafts");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSettings = useCallback(async (id: string | null) => {
    try {
      const res = await fetch(`/api/ai/settings${id ? `?accountId=${encodeURIComponent(id)}` : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) {
        setPayload(data.data);
        setAccountId(data.data.selectedAccountId);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSettings(null), 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings]);

  if (loading) return <div className="panel rounded p-8 h-64" />;

  const accounts: AccountOption[] = (payload?.accounts ?? []).map((account) => ({
    id: account.id,
    username: account.username,
    instagramId: account.id,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex gap-1 rounded-lg border border-border p-1 w-fit" role="tablist">
          {(["drafts", "settings"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`rounded px-4 py-1.5 text-sm ${
                tab === value
                  ? "bg-surface-hover font-medium text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {value === "drafts" ? t("Drafts") : t("Settings")}
            </button>
          ))}
        </div>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={accountId ?? ""}
            includeAll={false}
            onChange={(value) => {
              setAccountId(value);
              void loadSettings(value);
            }}
          />
        )}
      </div>

      <p className="text-xs text-muted">
        {t("Draft mode: the AI writes a suggested reply to DMs that no campaign answered. Nothing is sent until you edit it and press Send.")}
      </p>

      {!payload || payload.accounts.length === 0 ? (
        <div className="panel rounded p-8 text-center text-sm text-muted">
          {t("Connect an Instagram account first.")}
        </div>
      ) : tab === "drafts" ? (
        <DraftsTab accountId={accountId} />
      ) : (
        <SettingsTab
          key={accountId ?? "none"}
          payload={payload}
          accountId={accountId}
          onSaved={() => void loadSettings(accountId)}
        />
      )}
    </div>
  );
}

// ─── Drafts ─────────────────────────────────────────────────────────────────

function DraftsTab({ accountId }: { accountId: string | null }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<"pending" | "history">("pending");
  const [historyFilter, setHistoryFilter] = useState<(typeof HISTORY_FILTERS)[number]>("ALL");
  const [page, setPage] = useState(1);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // The "time left" labels count down.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const fetchDrafts = useCallback(async () => {
    try {
      const params = new URLSearchParams({ view, page: String(page), limit: "20" });
      if (view === "history" && historyFilter !== "ALL") params.set("status", historyFilter);
      if (accountId) params.set("accountId", accountId);
      const res = await fetch(`/api/ai/drafts?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        setDrafts(data.data.drafts);
        setPagination(data.data.pagination);
        setCanManage(Boolean(data.data.canManage));
        setNow(Date.now());
      }
    } catch (error) {
      console.error("Failed to fetch AI drafts:", error);
    } finally {
      setLoading(false);
    }
  }, [view, historyFilter, page, accountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchDrafts(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchDrafts]);

  // A send is delivered by the worker a moment later: refresh while any
  // draft on screen is still sending.
  const sending = drafts.some((draft) => draft.status === "SENDING" && !draft.error);
  useEffect(() => {
    if (!sending) return;
    const timer = window.setTimeout(() => void fetchDrafts(), 4000);
    return () => window.clearTimeout(timer);
  }, [sending, fetchDrafts]);

  function switchView(next: "pending" | "history") {
    setLoading(true);
    setPage(1);
    setView(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["pending", "history"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => switchView(value)}
            className={`rounded-full border px-3 py-1 text-xs ${
              view === value
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border text-muted hover:text-foreground"
            }`}
          >
            {value === "pending" ? t("To review") : t("History")}
          </button>
        ))}
        {view === "history" && (
          <select
            value={historyFilter}
            onChange={(event) => {
              setLoading(true);
              setPage(1);
              setHistoryFilter(event.target.value as (typeof HISTORY_FILTERS)[number]);
            }}
            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
            aria-label={t("Status")}
          >
            {HISTORY_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "ALL" ? t("All") : t(STATUS_LABELS[value])}
              </option>
            ))}
          </select>
        )}
      </div>

      {!canManage && !loading && drafts.length > 0 && (
        <p className="text-xs text-muted">
          {t("Only owners and admins can send or skip drafts.")}
        </p>
      )}

      {loading ? (
        <div className="panel rounded p-8 h-40" />
      ) : drafts.length === 0 ? (
        <div className="panel rounded p-8 text-center sm:p-12">
          <h3 className="mb-2 text-base font-semibold">
            {view === "pending" ? t("No drafts to review") : t("No drafts here yet.")}
          </h3>
          {view === "pending" && (
            <p className="mx-auto max-w-md text-sm text-muted">
              {t("When someone sends a DM that no campaign answers, the AI's suggested reply shows up here.")}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              now={now}
              locale={locale}
              canManage={canManage}
              onChanged={() => void fetchDrafts()}
            />
          ))}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {t("Showing {start}–{end} of {total}", {
              start: (pagination.page - 1) * pagination.limit + 1,
              end: Math.min(pagination.page * pagination.limit, pagination.total),
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
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
            >
              {t("Previous")}
            </button>
            <button
              disabled={page >= pagination.totalPages}
              onClick={() => {
                setLoading(true);
                setPage(page + 1);
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
            >
              {t("Next")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(value: string | null, locale: string): string {
  if (!value) return "";
  return new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DraftCard({
  draft,
  now,
  locale,
  canManage,
  onChanged,
}: {
  draft: Draft;
  now: number;
  locale: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(draft.draftText);
  const [busy, setBusy] = useState<"send" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actionable = draft.status === "PENDING" || draft.status === "FAILED";
  const msLeft = new Date(draft.windowEndsAt).getTime() - now;
  const windowOpen = msLeft > 0;
  const outgoing = composeOutgoingText(text, draft.disclosureText, draft.firstReply);
  const bytes = utf8ByteLength(outgoing);
  const tooLong = bytes > MAX_DM_TEXT_BYTES;

  // The burst being answered is the end of the snapshot; show a few turns
  // before it for context.
  const latestCount = Math.max(1, draft.inboundText.split("\n").length);
  const history = Array.isArray(draft.historySnapshot) ? draft.historySnapshot : [];
  const earlier = history.slice(0, Math.max(0, history.length - latestCount)).slice(-4);

  async function act(kind: "send" | "dismiss") {
    setError(null);
    setBusy(kind);
    try {
      const res = await fetch(`/api/ai/drafts/${draft.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: kind === "send" ? JSON.stringify({ text }) : "{}",
      });
      const data = await res.json();
      if (!data.success) {
        setError(
          data.code === "window_closed"
            ? t("The 24-hour reply window has closed")
            : data.code === "too_long"
              ? t("Too long for Instagram")
              : data.error ?? t("Could not send the reply")
        );
        if (data.code === "window_closed") onChanged();
        return;
      }
      onChanged();
    } catch {
      setError(t("Could not send the reply"));
    } finally {
      setBusy(null);
    }
  }

  const who = draft.username ? `@${draft.username}` : draft.name ?? t("Instagram user");
  const hours = Math.floor(msLeft / 3_600_000);
  const minutes = Math.floor((msLeft % 3_600_000) / 60_000);

  return (
    <article className="panel rounded p-4 sm:p-6 space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{who}</p>
          {draft.name && draft.username && <p className="text-xs text-foreground/80">{draft.name}</p>}
          <p className="text-xs text-muted">
            {t("via @{account}", { account: draft.accountUsername })} · {formatTime(draft.inboundAt, locale)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {draft.intent && INTENT_LABELS[draft.intent] && (
            <span className="rounded bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted">
              {t(INTENT_LABELS[draft.intent])}
            </span>
          )}
          {draft.needsHuman && (
            <span className="rounded bg-error/10 px-2 py-0.5 text-[11px] font-medium text-error">
              {t("Suggest replying personally")}
            </span>
          )}
          {!actionable && (
            <span className="rounded border border-border px-2 py-0.5 text-[11px] text-muted">
              {t(STATUS_LABELS[draft.status] ?? "Other topic")}
            </span>
          )}
          {actionable && (
            <span className={`text-xs ${windowOpen ? "text-muted" : "text-error"}`}>
              {windowOpen
                ? t("{hours}h {minutes}m left to reply", { hours, minutes })
                : t("The 24-hour reply window has closed")}
            </span>
          )}
        </div>
      </header>

      {draft.needsHuman && draft.handoffReason && (
        <p className="rounded border border-error/20 bg-error/5 p-2 text-xs text-error">
          {draft.handoffReason}
        </p>
      )}

      {earlier.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t("Earlier in the conversation")}
          </p>
          {earlier.map((turn, index) => (
            <p key={index} className="text-xs text-muted">
              <span className="font-medium">{turn.from === "creator" ? t("You") : t("Them")}:</span>{" "}
              {turn.text}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {t("Their message")}
        </p>
        <p className="whitespace-pre-wrap rounded bg-surface-hover p-3 text-sm text-foreground">
          {draft.inboundText}
        </p>
      </div>

      {draft.error && (
        <p className="rounded border border-error/20 bg-error/10 p-2 text-xs text-error">
          {draft.status === "SENDING"
            ? t("Delivery could not be confirmed. Check the Instagram inbox before replying again.")
            : t("Error: {error}", { error: draft.error })}
        </p>
      )}

      {actionable ? (
        <div className="space-y-2">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted" htmlFor={`reply-${draft.id}`}>
            {t("Reply")}
          </label>
          {draft.firstReply && draft.disclosureText.trim() && (
            <p className="text-xs text-muted">
              {t("First reply to this person, so this line goes in front:")}{" "}
              <span className="text-foreground">{draft.disclosureText}</span>
            </p>
          )}
          <textarea
            id={`reply-${draft.id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            disabled={!canManage}
            className={`${inputClass} resize-y`}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs ${tooLong ? "text-error" : "text-muted"}`}>
              {t("{bytes} / {max} bytes", { bytes, max: MAX_DM_TEXT_BYTES })}
              {tooLong ? ` · ${t("Too long for Instagram")}` : ""}
            </span>
            {canManage && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void act("dismiss")}
                  disabled={busy !== null}
                  className="rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-40"
                >
                  {t("Don't reply")}
                </button>
                <button
                  type="button"
                  onClick={() => void act("send")}
                  disabled={busy !== null || !text.trim() || tooLong || !windowOpen}
                  className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {busy === "send" ? t("Sending…") : t("Send reply")}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {draft.status === "SENT" || draft.status === "SENDING" ? t("Reply") : t("AI draft")}
          </p>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {draft.finalText ?? draft.draftText}
          </p>
          {draft.sentAt && (
            <p className="text-xs text-muted">{t("Sent {time}", { time: formatTime(draft.sentAt, locale) })}</p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-error">{error}</p>}
    </article>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

function SettingsTab({
  payload,
  accountId,
  onSaved,
}: {
  payload: SettingsPayload;
  accountId: string | null;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const initial = payload.settings;
  const [form, setForm] = useState<Settings | null>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = payload.canManage && payload.supported;

  if (!form || !accountId) return null;

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setMessage(null);
  }

  async function save() {
    if (!form || !accountId) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, ...form }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ ok: true, text: t("Settings saved") });
        onSaved();
      } else {
        setMessage({ ok: false, text: data.error ?? t("Could not save the settings") });
      }
    } catch {
      setMessage({ ok: false, text: t("Could not save the settings") });
    } finally {
      setSaving(false);
    }
  }

  const { aiConfigured, healthy } = payload.worker;

  return (
    <div className="max-w-2xl space-y-6">
      {!payload.supported && (
        <div className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
          {t("The AI assistant needs an account connected through Meta (Instagram login). Accounts connected through Zernio are not supported.")}
        </div>
      )}
      {!payload.canManage && (
        <p className="text-xs text-muted">{t("Only owners and admins can change these settings.")}</p>
      )}

      <section className="panel rounded p-4 sm:p-6 space-y-3">
        <h2 className="text-base font-semibold">{t("How it works")}</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{t("Someone DMs you. If an email gate or a campaign keyword answers it, the AI stays out.")}</li>
          <li>{t("Otherwise the AI reads the recent conversation and writes a draft here, about 15 seconds after their last message.")}</li>
          <li>{t("You edit it and press Send, or Don't reply. Nothing is sent without your approval.")}</li>
          <li>{t("Instagram only allows replies within 24 hours of their last message; older drafts expire.")}</li>
          <li>{t("Message text is sent to Anthropic (Claude) to write drafts. It is not used to train models.")}</li>
        </ul>
      </section>

      <section className="panel rounded p-4 sm:p-6 space-y-5">
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-foreground">{t("Turn on the AI assistant")}</span>
            <span className="block text-xs text-muted">{t("Off: no drafts are written.")}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            disabled={!editable}
            onClick={() => update("enabled", !form.enabled)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              form.enabled ? "bg-accent" : "bg-zinc-300"
            }`}
          >
            <span
              className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                form.enabled ? "left-6" : "left-1"
              }`}
            />
          </button>
        </label>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">{t("Model")}</dt>
            <dd className="text-foreground">{AI_MODEL_LABEL}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("AI key")}</dt>
            <dd className={aiConfigured === true ? "text-foreground" : "text-error"}>
              {aiConfigured === true
                ? t("Set on the worker")
                : aiConfigured === false
                  ? t("AI key not set")
                  : t("Can't tell: the worker is offline or out of date")}
            </dd>
            {aiConfigured !== true && (
              <p className="mt-1 text-xs text-muted">
                {t("Set ANTHROPIC_API_KEY on the worker (Railway). The web app does not need it.")}
              </p>
            )}
            {!healthy && aiConfigured !== null && (
              <p className="mt-1 text-xs text-error">{t("The worker is not running.")}</p>
            )}
          </div>
        </dl>
      </section>

      <section className="panel rounded p-4 sm:p-6 space-y-5">
        <Field
          label={t("Role")}
          hint={t("Who the assistant replies for, for example “Leo's assistant for his Instagram DMs”.")}
          value={form.role}
          max={AI_SETTINGS_LIMITS.role}
          rows={2}
          disabled={!editable}
          onChange={(value) => update("role", value)}
        />
        <Field
          label={t("Voice")}
          hint={t("How replies should sound: friendly, short, with or without emoji.")}
          value={form.voice}
          max={AI_SETTINGS_LIMITS.voice}
          rows={3}
          disabled={!editable}
          onChange={(value) => update("voice", value)}
        />
        <Field
          label={t("Guardrails")}
          hint={t("What the assistant must never do or say.")}
          value={form.guardrails}
          max={AI_SETTINGS_LIMITS.guardrails}
          rows={3}
          disabled={!editable}
          onChange={(value) => update("guardrails", value)}
        />
        <Field
          label={t("Knowledge")}
          hint={t("Facts the assistant may use: your offers, prices, FAQs. It answers only from this and your campaigns.")}
          value={form.knowledge}
          max={AI_SETTINGS_LIMITS.knowledge}
          rows={12}
          disabled={!editable}
          onChange={(value) => update("knowledge", value)}
        />
        <Field
          label={t("AI disclosure")}
          hint={t("Added in front of the first AI reply each person receives.")}
          value={form.disclosureText}
          max={AI_SETTINGS_LIMITS.disclosureText}
          rows={1}
          disabled={!editable}
          onChange={(value) => update("disclosureText", value)}
        />
        <label className="block space-y-1">
          <span className="block text-sm font-medium text-foreground">{t("Daily drafts per person")}</span>
          <span className="block text-xs text-muted">{t("Messages beyond this in 24 hours get no draft.")}</span>
          <input
            type="number"
            min={AI_SETTINGS_LIMITS.dailyDraftCapMin}
            max={AI_SETTINGS_LIMITS.dailyDraftCapMax}
            value={form.dailyDraftCapPerPerson}
            disabled={!editable}
            onChange={(event) => update("dailyDraftCapPerPerson", Number(event.target.value))}
            className={`${inputClass} max-w-32`}
          />
        </label>
      </section>

      {editable && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? t("Saving…") : t("Save settings")}
          </button>
          {message && (
            <span className={`text-sm ${message.ok ? "text-muted" : "text-error"}`}>{message.text}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  max,
  rows,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  max: number;
  rows: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <span className="block text-xs text-muted">{hint}</span>
      <textarea
        value={value}
        rows={rows}
        maxLength={max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} resize-y`}
      />
      <span className="block text-right text-xs text-muted">
        {t("{count} / {max} characters", { count: value.length, max })}
      </span>
    </label>
  );
}
