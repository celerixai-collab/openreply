// One-time backfill for every workspace (the Contacts page also runs it per
// workspace automatically): DATABASE_URL=... npx tsx scripts/backfill-contacts.ts
import { prisma } from "@/lib/db/client";
import { backfillContactsFromDmLogs } from "@/lib/contacts/backfill";

backfillContactsFromDmLogs()
  .then((r) =>
    console.log(`${r.logs} DM log rows, ${r.people} people, ${r.created} contacts created.`)
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
