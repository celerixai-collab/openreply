import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import type { SystemIssue } from "@/lib/ops/system-check";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Mail a workspace owner about problems. Runs in the web app, which holds the mail key. */
export async function emailWorkspaceOwner(
  workspaceId: string,
  subject: string,
  issues: SystemIssue[]
): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { owner: { select: { email: true } } },
  });
  const to = workspace?.owner.email;
  if (!to) throw new Error("This workspace owner has no email address");

  const items = issues
    .map((issue) => `<li style="margin:0 0 14px"><b>${escapeHtml(issue.title)}</b><br>${escapeHtml(issue.detail)}</li>`)
    .join("");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html: `<ul style="padding-left:18px">${items}</ul><p><a href="${getBaseUrl()}/diagnostics">打開 OpenReply Diagnostics</a></p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

export function alertSubject(issues: SystemIssue[]): string {
  return `⚠️ OpenReply 有 ${issues.length} 個問題：${issues[0].title}`;
}
