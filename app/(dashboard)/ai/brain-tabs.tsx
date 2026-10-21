"use client";

/**
 * AI Assistant: the second brain (knowledge entries and sendable links), the
 * playground (try the assistant without sending anything) and the questions
 * it could not answer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { BRAIN_LIMITS } from "@/lib/ai/brain";

const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";
const primaryButton =
  "rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50";
const secondaryButton =
  "rounded border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-40";

interface Entry {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  position: number;
}

interface Link {
  id: string;
  label: string;
  url: string;
  description: string;
  enabled: boolean;
  position: number;
}

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (body?.success) return { ok: true, data: body.data as T };
    return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network error" };
  }
}

// ─── Second brain ───────────────────────────────────────────────────────────

export function BrainTab({ accountId, prefillTitle }: { accountId: string | null; prefillTitle?: string }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const result = await api<{ entries: Entry[]; links: Link[]; canManage: boolean }>(
      `/api/ai/brain?accountId=${encodeURIComponent(accountId)}`
    );
    if (result.ok) {
      setEntries(result.data.entries);
      setLinks(result.data.links);
      setCanManage(result.data.canManage);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!accountId) return null;
  if (loading) return <div className="panel rounded p-8 h-48" />;

  return (
    <div className="max-w-3xl space-y-8">
      <section className="panel rounded p-4 sm:p-6 space-y-2">
        <h2 className="text-base font-semibold">{t("Second brain")}</h2>
        <p className="text-sm text-muted">
          {t("One topic per entry: what it is, price, who it is for, FAQs. The assistant answers only from these, your settings and your campaigns. Turn an entry off to hide it without deleting it.")}
        </p>
      </section>

      {error && <p className="text-sm text-error">{error}</p>}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {t("Knowledge entries")} <span className="text-muted">({entries.length} / {BRAIN_LIMITS.entries})</span>
          </h3>
        </div>
        {entries.map((entry) => (
          <EntryEditor key={entry.id} entry={entry} canManage={canManage} onChanged={load} />
        ))}
        {canManage && entries.length < BRAIN_LIMITS.entries && (
          <NewEntry accountId={accountId} prefillTitle={prefillTitle} onCreated={load} />
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">
          {t("Links the assistant can send")} <span className="text-muted">({links.length} / {BRAIN_LIMITS.links})</span>
        </h3>
        <p className="text-xs text-muted">
          {t("Sent as a button under the reply. The assistant can send only these links, never one it makes up.")}
        </p>
        {links.map((link) => (
          <LinkEditor key={link.id} link={link} canManage={canManage} onChanged={load} />
        ))}
        {canManage && links.length < BRAIN_LIMITS.links && <NewLink accountId={accountId} onCreated={load} />}
      </section>
    </div>
  );
}

function EntryEditor({ entry, canManage, onChanged }: { entry: Entry; canManage: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = title !== entry.title || content !== entry.content;

  async function patch(body: Partial<Entry>) {
    setBusy(true);
    setMessage(null);
    const result = await api(`/api/ai/brain/entries?id=${encodeURIComponent(entry.id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (result.ok) onChanged();
    else setMessage(result.error);
  }

  async function remove() {
    if (!window.confirm(t("Delete this entry?"))) return;
    setBusy(true);
    const result = await api(`/api/ai/brain/entries?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    setBusy(false);
    if (result.ok) onChanged();
    else setMessage(result.error);
  }

  return (
    <article className={`panel rounded p-4 space-y-2 ${entry.enabled ? "" : "opacity-60"}`}>
      <input
        value={title}
        maxLength={BRAIN_LIMITS.entryTitle}
        disabled={!canManage}
        onChange={(event) => setTitle(event.target.value)}
        className={`${inputClass} font-medium`}
        aria-label={t("Title")}
      />
      <textarea
        value={content}
        rows={Math.min(10, Math.max(3, content.split("\n").length + 1))}
        maxLength={BRAIN_LIMITS.entryContent}
        disabled={!canManage}
        onChange={(event) => setContent(event.target.value)}
        className={`${inputClass} resize-y`}
        aria-label={t("Content")}
      />
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryButton} disabled={!dirty || busy} onClick={() => void patch({ title, content })}>
            {t("Save")}
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void patch({ enabled: !entry.enabled })}>
            {entry.enabled ? t("Turn off") : t("Turn on")}
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void remove()}>
            {t("Delete")}
          </button>
          <span className="text-xs text-muted">
            {t("{count} / {max} characters", { count: content.length, max: BRAIN_LIMITS.entryContent })}
          </span>
          {message && <span className="text-xs text-error">{message}</span>}
        </div>
      )}
    </article>
  );
}

function NewEntry({ accountId, prefillTitle, onCreated }: { accountId: string; prefillTitle?: string; onCreated: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(prefillTitle ?? "");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setMessage(null);
    const result = await api("/api/ai/brain/entries", {
      method: "POST",
      body: JSON.stringify({ accountId, title, content }),
    });
    setBusy(false);
    if (result.ok) {
      setTitle("");
      setContent("");
      onCreated();
    } else setMessage(result.error);
  }

  return (
    <article className="rounded border border-dashed border-border p-4 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("New entry")}</p>
      <input
        value={title}
        maxLength={BRAIN_LIMITS.entryTitle}
        placeholder={t("Topic, e.g. Price, Who it is for, Refunds")}
        onChange={(event) => setTitle(event.target.value)}
        className={inputClass}
      />
      <textarea
        value={content}
        rows={4}
        maxLength={BRAIN_LIMITS.entryContent}
        placeholder={t("The facts, written the way you would answer a fan")}
        onChange={(event) => setContent(event.target.value)}
        className={`${inputClass} resize-y`}
      />
      <div className="flex items-center gap-2">
        <button type="button" className={primaryButton} disabled={busy || !title.trim() || !content.trim()} onClick={() => void create()}>
          {t("Add entry")}
        </button>
        {message && <span className="text-xs text-error">{message}</span>}
      </div>
    </article>
  );
}

function LinkEditor({ link, canManage, onChanged }: { link: Link; canManage: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const [label, setLabel] = useState(link.label);
  const [url, setUrl] = useState(link.url);
  const [description, setDescription] = useState(link.description);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = label !== link.label || url !== link.url || description !== link.description;

  async function patch(body: Partial<Link>) {
    setBusy(true);
    setMessage(null);
    const result = await api(`/api/ai/brain/links?id=${encodeURIComponent(link.id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (result.ok) onChanged();
    else setMessage(result.error);
  }

  async function remove() {
    if (!window.confirm(t("Delete this link?"))) return;
    setBusy(true);
    const result = await api(`/api/ai/brain/links?id=${encodeURIComponent(link.id)}`, { method: "DELETE" });
    setBusy(false);
    if (result.ok) onChanged();
    else setMessage(result.error);
  }

  return (
    <article className={`panel rounded p-4 space-y-2 ${link.enabled ? "" : "opacity-60"}`}>
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <input value={label} maxLength={BRAIN_LIMITS.linkLabel} disabled={!canManage} onChange={(event) => setLabel(event.target.value)} className={inputClass} aria-label={t("Button text")} />
        <input value={url} maxLength={BRAIN_LIMITS.linkUrl} disabled={!canManage} onChange={(event) => setUrl(event.target.value)} className={inputClass} aria-label="URL" />
      </div>
      <input
        value={description}
        maxLength={BRAIN_LIMITS.linkDescription}
        disabled={!canManage}
        placeholder={t("When to send it, e.g. when they want to join the waitlist")}
        onChange={(event) => setDescription(event.target.value)}
        className={inputClass}
      />
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryButton} disabled={!dirty || busy} onClick={() => void patch({ label, url, description })}>
            {t("Save")}
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void patch({ enabled: !link.enabled })}>
            {link.enabled ? t("Turn off") : t("Turn on")}
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void remove()}>
            {t("Delete")}
          </button>
          {message && <span className="text-xs text-error">{message}</span>}
        </div>
      )}
    </article>
  );
}

function NewLink({ accountId, onCreated }: { accountId: string; onCreated: () => void }) {
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("https://");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setMessage(null);
    const result = await api("/api/ai/brain/links", {
      method: "POST",
      body: JSON.stringify({ accountId, label, url, description }),
    });
    setBusy(false);
    if (result.ok) {
      setLabel("");
      setUrl("https://");
      setDescription("");
      onCreated();
    } else setMessage(result.error);
  }

  return (
    <article className="rounded border border-dashed border-border p-4 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("New link")}</p>
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <input value={label} maxLength={BRAIN_LIMITS.linkLabel} placeholder={t("Button text")} onChange={(event) => setLabel(event.target.value)} className={inputClass} />
        <input value={url} maxLength={BRAIN_LIMITS.linkUrl} onChange={(event) => setUrl(event.target.value)} className={inputClass} aria-label="URL" />
      </div>
      <input
        value={description}
        maxLength={BRAIN_LIMITS.linkDescription}
        placeholder={t("When to send it, e.g. when they want to join the waitlist")}
        onChange={(event) => setDescription(event.target.value)}
        className={inputClass}
      />
      <div className="flex items-center gap-2">
        <button type="button" className={primaryButton} disabled={busy || !label.trim() || url.trim().length < 12} onClick={() => void create()}>
          {t("Add link")}
        </button>
        {message && <span className="text-xs text-error">{message}</span>}
      </div>
    </article>
  );
}

// ─── Playground ─────────────────────────────────────────────────────────────

type Turn = { from: "person" | "creator"; text: string };
type PlaygroundResult = {
  status: "done";
  replyText: string;
  intent: string;
  needsHuman: boolean;
  handoffReason: string | null;
  confidence: string;
  link: { id: string; label: string; url: string } | null;
  knowledgeGap: boolean;
  gapQuestion: string | null;
  usedTopics: string[];
  outgoingText: string;
  wouldAutoSend: boolean;
};

export function PlaygroundTab({ accountId }: { accountId: string | null }) {
  const { t } = useI18n();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [meta, setMeta] = useState<Record<number, PlaygroundResult>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  async function send() {
    if (!accountId || !input.trim()) return;
    const next: Turn[] = [...turns, { from: "person", text: input.trim() }];
    setTurns(next);
    setInput("");
    setBusy(true);
    setError(null);
    const started = await api<{ id: string }>("/api/ai/playground", {
      method: "POST",
      body: JSON.stringify({ accountId, turns: next }),
    });
    if (!started.ok) {
      setError(started.error);
      setBusy(false);
      return;
    }
    for (let i = 0; i < 60 && !cancelled.current; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const polled = await api<PlaygroundResult | { status: "pending" } | { status: "error"; error: string }>(
        `/api/ai/playground?id=${started.data.id}&accountId=${encodeURIComponent(accountId)}`
      );
      if (!polled.ok) {
        setError(polled.error);
        break;
      }
      if (polled.data.status === "pending") continue;
      if (polled.data.status === "error") {
        setError(polled.data.error);
        break;
      }
      const result = polled.data;
      setTurns([...next, { from: "creator", text: result.outgoingText }]);
      setMeta((current) => ({ ...current, [next.length]: result }));
      break;
    }
    setBusy(false);
  }

  if (!accountId) return null;

  return (
    <div className="max-w-2xl space-y-4">
      <section className="panel rounded p-4 sm:p-6 space-y-2">
        <h2 className="text-base font-semibold">{t("Playground")}</h2>
        <p className="text-sm text-muted">
          {t("Chat as a fan to see how the assistant answers with your current second brain and settings. Nothing is sent to Instagram.")}
        </p>
      </section>

      <div className="panel rounded p-4 space-y-3 min-h-48">
        {turns.length === 0 && <p className="text-sm text-muted">{t("Type a message a fan might send, e.g. 多少錢？")}</p>}
        {turns.map((turn, index) => (
          <div key={index} className={`flex ${turn.from === "person" ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[85%] space-y-1">
              <p
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  turn.from === "person" ? "bg-accent text-white" : "bg-surface-hover text-foreground"
                }`}
              >
                {turn.text}
              </p>
              {meta[index] && <ResultMeta result={meta[index]} />}
            </div>
          </div>
        ))}
        {busy && <p className="text-xs text-muted">{t("The assistant is writing…")}</p>}
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <div className="flex gap-2">
        <input
          value={input}
          maxLength={1000}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void send();
          }}
          placeholder={t("Message as a fan")}
          className={inputClass}
          disabled={busy}
        />
        <button type="button" className={primaryButton} disabled={busy || !input.trim()} onClick={() => void send()}>
          {t("Send")}
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={busy || turns.length === 0}
          onClick={() => {
            setTurns([]);
            setMeta({});
            setError(null);
          }}
        >
          {t("Clear")}
        </button>
      </div>
    </div>
  );
}

function ResultMeta({ result }: { result: PlaygroundResult }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1 text-xs text-muted">
      {result.link && (
        <p>
          🔗 {t("Link button:")} <span className="text-foreground">「{result.link.label}」</span>{" "}
          <span className="break-all">{result.link.url}</span>
        </p>
      )}
      <p>
        {result.needsHuman
          ? `✋ ${t("Would wait for you:")} ${result.handoffReason ?? ""}`
          : result.wouldAutoSend
            ? `✅ ${t("Would be sent automatically")}`
            : `📝 ${t("Would be a draft for you to send")}`}
        {" · "}
        {t("Confidence: {level}", { level: result.confidence })}
      </p>
      {result.usedTopics.length > 0 && (
        <p>
          📚 {t("Based on:")} {result.usedTopics.join("、")}
        </p>
      )}
      {result.knowledgeGap && (
        <p className="text-warning">
          {t("Not in your second brain:")} {result.gapQuestion ?? ""}
        </p>
      )}
    </div>
  );
}

// ─── Unanswered questions ───────────────────────────────────────────────────

type Gap = { question: string; count: number; lastAskedAt: string; example: string; usernames: string[] };

export function GapsTab({ accountId }: { accountId: string | null }) {
  const { t } = useI18n();
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const result = await api<{ gaps: Gap[] }>(`/api/ai/gaps?accountId=${encodeURIComponent(accountId)}`);
    if (result.ok) setGaps(result.data.gaps);
    else setError(result.error);
  }, [accountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!accountId) return null;
  if (adding !== null) {
    return (
      <div className="space-y-3">
        <button type="button" className={secondaryButton} onClick={() => setAdding(null)}>
          ← {t("Back to unanswered questions")}
        </button>
        <BrainTab accountId={accountId} prefillTitle={adding} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <section className="panel rounded p-4 sm:p-6 space-y-2">
        <h2 className="text-base font-semibold">{t("Unanswered")}</h2>
        <p className="text-sm text-muted">
          {t("Questions fans asked that your second brain does not answer, most asked first. Add an entry once and the assistant answers it from then on.")}
        </p>
      </section>
      {error && <p className="text-sm text-error">{error}</p>}
      {gaps === null ? (
        <div className="panel rounded p-8 h-32" />
      ) : gaps.length === 0 ? (
        <div className="panel rounded p-8 text-center text-sm text-muted">{t("No unanswered questions in the last 30 days.")}</div>
      ) : (
        gaps.map((gap) => (
          <article key={gap.question} className="panel rounded p-4 space-y-1">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-foreground">{gap.question}</p>
              <span className="shrink-0 rounded bg-surface-hover px-2 py-0.5 text-xs text-muted">
                {t("Asked {count} times", { count: gap.count })}
              </span>
            </div>
            <p className="text-xs text-muted">{gap.example}</p>
            <button type="button" className={secondaryButton} onClick={() => setAdding(gap.question)}>
              {t("Add to second brain")}
            </button>
          </article>
        ))
      )}
    </div>
  );
}
