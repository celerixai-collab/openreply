import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy - OpenReply",
  description:
    "How OpenReply handles Instagram account data, webhook payloads, billing data, and customer campaign information.",
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      description="OpenReply helps businesses send Meta-compliant private replies when people comment on connected Instagram posts or reels."
      updatedAt="October 9, 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-white">Data We Collect</h2>
        <p className="mt-3">
          We collect account email addresses for authentication, workspace and
          billing metadata, connected Instagram account identifiers, encrypted
          Instagram access tokens, campaign settings, webhook payloads,
          comments needed to process campaigns, delivery logs, and operational
          diagnostics.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Contacts And Emails</h2>
        <p className="mt-3">
          When a campaign uses the Email gate, people who comment on or message
          the connected Instagram account are asked for their email before they
          get the campaign&apos;s link. For each person a campaign answers we
          store their Instagram-scoped id and username and, if they reply with
          one, their email, when and how it was shared, and the exact message
          they replied to as a record of consent. The business that runs the
          campaign decides how those emails are used and is responsible for
          them; OpenReply stores them only to run the campaign and to show and
          export them to that business. Emails sent in direct messages are left
          out of the webhook and delivery logs we keep. A contact is kept until the business deletes it, or
          disconnects the Instagram account, which deletes all of its contacts.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">AI Reply Drafts</h2>
        <p className="mt-3">
          When a business turns on the AI assistant for a connected Instagram
          account, the text of direct messages that no campaign answered, the
          recent conversation with that person (up to the last 20 messages),
          and the business&apos;s own assistant settings are sent to Anthropic
          (Claude) to draft a suggested reply. Email addresses in those
          messages are masked before anything is sent. Anthropic processes this
          data under its commercial terms, which do not allow it to train
          models on it. Drafts are stored with the business&apos;s workspace and
          nothing is sent to the person until someone at the business approves
          it. The assistant is off unless the business turns it on, and turning
          it off stops any further messages from being sent to Anthropic.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">How We Use Data</h2>
        <p className="mt-3">
          We use this data to authenticate users, connect Instagram
          integrations, match comment keywords, send private replies through the
          official Meta APIs, prevent duplicate sends, troubleshoot failures,
          and protect the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Instagram And Meta Data</h2>
        <p className="mt-3">
          OpenReply does not ask for Instagram passwords, scrape Instagram, or
          use browser automation. Instagram tokens are encrypted at rest and are
          used only to perform actions authorized by the connected business
          account.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Subprocessors</h2>
        <p className="mt-3">
          The production service may use hosting, database, Redis queue, email,
          and observability providers such as Vercel, Railway, PostgreSQL,
          Redis, and Resend, and Anthropic when the AI assistant is turned on.
          These providers process data only as needed to run the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Retention And Deletion</h2>
        <p className="mt-3">
          Customers can disconnect Instagram from settings, which removes the
          stored Instagram connection and stops campaigns. For account or data
          deletion, follow the Data Deletion page linked from the footer.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Contact</h2>
        <p className="mt-3">
          For privacy questions, contact the repository owner through GitHub or
          the support email configured for the hosted OpenReply service.
        </p>
      </section>
    </LegalShell>
  );
}
