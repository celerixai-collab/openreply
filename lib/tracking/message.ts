export interface MessageTrackedLink {
  slug: string;
  destinationUrl: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

function trimTrailingPunctuation(url: string) {
  return url.replace(/[.,!?;:]+$/, "");
}

export function extractFirstUrl(message: string): string | null {
  const match = message.match(URL_PATTERN);
  if (!match) return null;

  try {
    const url = trimTrailingPunctuation(match[0]);
    return new URL(url).toString();
  } catch {
    return null;
  }
}

export function replaceUrlWithTrackedPlaceholder(
  message: string,
  destinationUrl: string | null | undefined
) {
  if (!destinationUrl) return message;
  if (message.includes(destinationUrl)) {
    return message.replace(destinationUrl, "{link}");
  }

  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  return message.replace(withoutTrailingSlash, "{link}");
}

// {email} is filled in only when the caller passes an email (the email gate's
// thanks message). Callers that pass nothing leave the text exactly as before.
function renderEmail(message: string, email: string | null | undefined) {
  return email === undefined
    ? message
    : message.replace(/\{email\}/gi, email ?? "");
}

/**
 * Personalize {username} (and {email}, when given) and strip the {link} token
 * — used when the link is delivered as a separate button rather than inline
 * in the message text.
 */
export function renderMessageWithoutLink({
  message,
  commenterName,
  email,
}: {
  message: string;
  commenterName?: string | null;
  email?: string | null;
}) {
  return renderEmail(message, email)
    .replace(/\{username\}/gi, commenterName ?? "there")
    .replace(/\s*\{link\}\s*/gi, " ")
    .trim();
}

export function buildTrackedUrl(
  slug: string,
  baseUrl?: string,
  recipientToken?: string
) {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL ?? "http://localhost:3000");

  const url = `${resolvedBaseUrl.replace(/\/$/, "")}/r/${slug}`;
  return recipientToken ? `${url}?r=${recipientToken}` : url;
}

export function renderMessageWithTracking({
  message,
  commenterName,
  trackedLinks,
  baseUrl,
  recipientToken,
  email,
}: {
  message: string;
  commenterName?: string | null;
  trackedLinks?: MessageTrackedLink[];
  baseUrl?: string;
  recipientToken?: string;
  email?: string | null;
}) {
  let rendered = renderEmail(message, email).replace(
    /\{username\}/gi,
    commenterName ?? "there"
  );
  const primaryLink = trackedLinks?.[0];

  if (!primaryLink) return rendered;

  const trackedUrl = buildTrackedUrl(primaryLink.slug, baseUrl, recipientToken);

  if (/\{link\}/i.test(rendered)) {
    return rendered.replace(/\{link\}/gi, trackedUrl);
  }

  if (rendered.includes(primaryLink.destinationUrl)) {
    rendered = rendered.replaceAll(primaryLink.destinationUrl, trackedUrl);
  } else {
    const withoutTrailingSlash = primaryLink.destinationUrl.replace(/\/$/, "");
    rendered = rendered.replaceAll(withoutTrailingSlash, trackedUrl);
  }

  return rendered;
}
