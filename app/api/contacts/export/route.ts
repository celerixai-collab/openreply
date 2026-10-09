import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { contactsToCsv } from "@/lib/contacts/export-csv";
import {
  CONTACT_LIST_SELECT,
  CONTACTS_ORDER_BY,
  contactsWhere,
  parseContactFilters,
  toContactCsvRow,
} from "@/lib/contacts/list";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * The contacts list as a CSV download, with the same search, has-email and
 * campaign filters as the page. See lib/contacts/export-csv.ts for the
 * escaping. Owners and admins only, like deleting: a members-wide one-click
 * copy of every email is a bigger step than viewing the page.
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can export contacts" },
      { status: 403 }
    );
  }

  const contacts = await prisma.contact.findMany({
    where: contactsWhere(
      context.workspaceId,
      parseContactFilters(request.nextUrl.searchParams)
    ),
    orderBy: CONTACTS_ORDER_BY,
    select: CONTACT_LIST_SELECT,
  });

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(contactsToCsv(contacts.map(toContactCsvRow)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="openreply-contacts-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
