import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import {
  AI_MODEL,
  AI_MODE_DRAFT,
  DEFAULT_DAILY_DRAFT_CAP,
  DEFAULT_DISCLOSURE_TEXT,
} from "@/lib/ai/constants";
import { parseAiSettingsPatch } from "@/lib/ai/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SETTINGS_SELECT = {
  enabled: true,
  mode: true,
  model: true,
  role: true,
  voice: true,
  guardrails: true,
  knowledge: true,
  disclosureText: true,
  dailyDraftCapPerPerson: true,
  updatedAt: true,
} as const;

const DEFAULT_SETTINGS = {
  enabled: false,
  mode: AI_MODE_DRAFT,
  model: AI_MODEL,
  role: "",
  voice: "",
  guardrails: "",
  knowledge: "",
  disclosureText: DEFAULT_DISCLOSURE_TEXT,
  dailyDraftCapPerPerson: DEFAULT_DAILY_DRAFT_CAP,
  updatedAt: null,
};

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      username: true,
      provider: true,
      aiAssistant: { select: SETTINGS_SELECT },
    },
  });
  const requested = request.nextUrl.searchParams.get("accountId");
  const selected =
    accounts.find((account) => account.id === requested) ??
    accounts.find((account) => account.provider === "META") ??
    accounts[0] ??
    null;

  // The key lives only on the worker; its heartbeat says whether it is set.
  const health = await getWorkerHealth().catch(() => null);

  return NextResponse.json(
    {
      success: true,
      data: {
        accounts: accounts.map(({ id, username, provider, aiAssistant }) => ({
          id,
          username,
          provider,
          enabled: Boolean(aiAssistant?.enabled),
        })),
        selectedAccountId: selected?.id ?? null,
        // AI replies use the Meta Conversations API and Send API only.
        supported: selected?.provider === "META",
        settings: selected ? (selected.aiAssistant ?? DEFAULT_SETTINGS) : null,
        worker: {
          healthy: Boolean(health?.healthy),
          // null: no heartbeat, or a worker that predates the AI assistant.
          aiConfigured:
            typeof health?.heartbeat?.aiConfigured === "boolean"
              ? health.heartbeat.aiConfigured
              : null,
        },
        canManage: canManageWorkspace(context.role),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can change the AI assistant" },
      { status: 403 }
    );
  }

  const parsed = parseAiSettingsPatch(await request.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }
  const { accountId, ...changes } = parsed.data;

  const account = await prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId: context.workspaceId },
    select: { id: true, provider: true },
  });
  if (!account) {
    return NextResponse.json({ success: false, error: "Account not found" }, { status: 404 });
  }
  if (account.provider !== "META") {
    return NextResponse.json(
      { success: false, error: "The AI assistant works with accounts connected through Meta only" },
      { status: 400 }
    );
  }

  const settings = await prisma.aiAssistant.upsert({
    where: { instagramAccountId: account.id },
    create: {
      workspaceId: context.workspaceId,
      instagramAccountId: account.id,
      mode: AI_MODE_DRAFT,
      model: AI_MODEL,
      ...changes,
    },
    update: changes,
    select: SETTINGS_SELECT,
  });
  return NextResponse.json({ success: true, data: { settings } });
}
