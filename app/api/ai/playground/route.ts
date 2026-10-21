import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { accountAccess, accessError } from "@/lib/ai/route-access";
import {
  PlaygroundTurns,
  readPlaygroundResult,
  takePlaygroundRun,
  writePlaygroundResult,
} from "@/lib/ai/playground";
import { AI_PLAYGROUND_JOB_NAME, getAiQueue } from "@/lib/ai/queue";
import { firstIssue } from "@/lib/ai/brain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Queue a playground run; poll GET ?id= for the result. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { accountId?: unknown; turns?: unknown }
    | null;
  const access = await accountAccess(body?.accountId, { manage: true });
  if (!access.ok) return access.response;
  const turns = PlaygroundTurns.safeParse(body?.turns);
  if (!turns.success) return accessError(400, firstIssue(turns.error)).response;
  if (!(await takePlaygroundRun(access.workspaceId))) {
    return accessError(429, "Too many playground runs this hour. Try again later.").response;
  }

  const id = randomUUID();
  await writePlaygroundResult(id, { status: "pending" });
  await getAiQueue().add(
    AI_PLAYGROUND_JOB_NAME,
    { playgroundId: id, accountId: access.account.id, turns: turns.data },
    { jobId: `ai-playground_${id}`, removeOnComplete: true, removeOnFail: true }
  );
  return NextResponse.json({ success: true, data: { id } }, { status: 202 });
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return accessError(400, "id is required").response;
  const access = await accountAccess(request.nextUrl.searchParams.get("accountId"), {
    manage: true,
  });
  if (!access.ok) return access.response;
  const result = await readPlaygroundResult(id);
  if (!result) return accessError(404, "Playground run not found or expired").response;
  return NextResponse.json(
    { success: true, data: result },
    { headers: { "Cache-Control": "no-store" } }
  );
}
