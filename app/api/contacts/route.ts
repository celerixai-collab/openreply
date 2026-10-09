import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  CONTACT_LIST_SELECT,
  CONTACTS_ORDER_BY,
  contactsWhere,
  parseContactFilters,
  parsePagination,
} from "@/lib/contacts/list";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// The list is read-your-writes (a delete must disappear at once), and it holds
// personal data, so it is never cached.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const params = request.nextUrl.searchParams;
  const where = contactsWhere(context.workspaceId, parseContactFilters(params));
  const { page, limit, skip } = parsePagination(params);

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: CONTACTS_ORDER_BY,
      skip,
      take: limit,
      select: CONTACT_LIST_SELECT,
    }),
    prisma.contact.count({ where }),
  ]);

  return NextResponse.json(
    {
      success: true,
      data: {
        contacts,
        // Export and delete are owner/admin actions; the page hides them
        // for members.
        canManage: canManageWorkspace(context.role),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can delete contacts" },
      { status: 403 }
    );
  }

  const contactId = request.nextUrl.searchParams.get("id");
  if (!contactId) {
    return NextResponse.json(
      { success: false, error: "Missing contact ID" },
      { status: 400 }
    );
  }

  // Scoped by workspace in the delete itself, so an id from another
  // workspace deletes nothing and reads as not found.
  const { count } = await prisma.contact.deleteMany({
    where: { id: contactId, workspaceId: context.workspaceId },
  });

  if (count === 0) {
    return NextResponse.json(
      { success: false, error: "Contact not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, data: { deleted: true } });
}
