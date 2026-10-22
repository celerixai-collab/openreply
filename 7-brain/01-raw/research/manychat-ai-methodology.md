# ManyChat AI setup methodology: research for the OpenReply AI DM agent (2026-10-20)

**Note:** the earlier reports (`manychat-ai.md`, `fact-check_manychat-ai.md`) were not on disk. The scratchpad `research/` folder did not exist and nothing turned up under /private/tmp, COLLAB or the openreply repo. So this report starts from primary sources and does not build on them. Help-center articles were pulled through the Zendesk JSON API, and the `updated_at` dates are shown. The manychat.com blog was read in a browser because WebFetch got a 403. Firecrawl was out of credits.

## 1. ManyChat AI setup (current docs)

**Architecture.** The AI tab has these parts: Overview (replies sent, hand-offs, goal progress), Knowledge, Behavior, Skills (AI Replies, AI Comments, AI Goals) and a Playground ("Test AI"). It is still labelled beta and runs on Instagram only. [Overview, upd. 2026-08-27](https://help.manychat.com/hc/en-us/articles/14281227789468); [community launch post, Oct 22 2025](https://community.manychat.com/product-updates/your-new-ai-hub-beta-is-live-smarter-replies-faster-setup-same-manychat-magic-7631)

**Routing order.** When a DM comes in, existing automations (keywords, flows) get the first chance to handle it. If none does, the AI checks whether the message is a question (→ AI Replies) or a compliment (→ AI Comments). If it is neither, the default reply is used. [Overview FAQ](https://help.manychat.com/hc/en-us/articles/14281227789468)

**Behavior** ([AI Behavior, upd. 2026-09-23](https://help.manychat.com/hc/en-us/articles/26782002914332); launched Apr 8 2026 per the [community post](https://community.manychat.com/product-updates/your-ai-now-speaks-your-language-meet-ai-behavior-9491)):
- There are three free-text fields. ManyChat **pre-fills** them by scanning the IG bio and recent comment replies, and calls the result "a suggested starting point".
  - **AI Role**: a persona or job title, e.g. "Marketing Coach and Growth Strategist". It shapes how the AI introduces itself and frames its answers.
  - **Brand Voice & Persona**: tone, style **and formatting rules**, e.g. "professional, concise, no emojis".
  - **Guardrails & Constraints**: things the AI must never say or do, e.g. "Never provide legal or financial advice. Do not guarantee revenue results. Never disparage competitors." If a message hits a guardrail, the AI redirects or declines.
- Their main writing advice is to be concrete. Instead of "be professional", write "speak in a professional, direct tone. **Keep replies under 3 sentences. Don't use emojis.**" Instead of "don't give advice", write "never provide specific legal or financial advice regarding business structures or taxes."
- ManyChat says plainly that guardrails "greatly reduce" off-topic answers but "AI is not fully deterministic".
- A saved Behavior applies to all *future* conversations right away. Knowledge edits made during a live chat apply from the **next new conversation**. [Overview](https://help.manychat.com/hc/en-us/articles/14281227789468)
- Their split: Knowledge = *what* the AI knows, Behavior = *how* it talks.

**Knowledge** ([AI Knowledge, upd. 2026-10-08](https://help.manychat.com/hc/en-us/articles/25626595060124)):
- An entry is either plain text or one public URL (one page per entry; a site is not crawled). File upload is "coming soon". Each entry holds up to 250k characters.
- Suggested content: key details, packages/levels, pricing, payment options, **how to join**, access instructions, FAQs and policies. Links go inline in the text, e.g. "you can book a call with me here: [link]".
- Only extracted text is read. Images, video, PDFs and embeds are ignored. IG, YouTube, LinkedIn and Google Docs links can't be used, so paste the text instead. Long pages should be split into several entries.
- ManyChat does **not** say to use one topic per entry or a Q/A format. That advice is UNVERIFIED as ManyChat guidance. It is still a sensible way to build OpenReply (see §5).

**Playground / testing loop** ([AI Replies, upd. 2026-10-12](https://help.manychat.com/hc/en-us/articles/23018283889180)):
- Start from suggested questions or type your own. When the AI meets a question its Knowledge doesn't cover, it **suggests adding the missing info**. You can create the entry inside the Playground, click "See new answer" to re-run, and use "Start Over" to reset.
- The loop is: test, find the gap, add knowledge, re-test. Run it regularly.
- UNVERIFIED: a search-engine summary said newer builds show which Knowledge source fed each answer and add thumbs up/down ratings. I could not confirm this in the articles.

**Handoff / confidence:**
- AI Replies has an **"Assign to a person"** checkbox for questions the AI can't answer, with a choice of team member or group. Capture-leads also hands off when someone refuses to share their info.
- The Oct 2025 launch post says you can "set confidence limits so uncertain messages are routed to your team". No help article documents a numeric threshold or slider, so the actual setting is UNVERIFIED.

**AI Goals** ([AI Goals, upd. 2026-09-01](https://help.manychat.com/hc/en-us/articles/23096273858716)):
- Goals kick in after the AI has answered, to keep the conversation moving. You can run up to **3 at once**, ordered by drag-and-drop priority.
- **Share a link**: you supply the URL and *a description of what the link contains*. The AI generates the message, and you can edit it or "Try Another Message".
- **Grow followers**: checks whether the user already follows. If not, it suggests following with a message you can edit.
- **Capture leads**: you pick user fields, and the AI writes the questions from each field's name and type. You must add an **explanation of why you collect it**. There are four finish options: skip / send message + link button / trigger automation / assign to human.
- In every case the wording is AI-generated from your description and then reviewed by a person. ManyChat publishes no fixed templates.

**Other runtime behavior worth copying:**
- **Language**: the AI detects and replies in the user's language automatically. It warns that very short messages, or closely related languages, can be misdetected. [Overview FAQ](https://help.manychat.com/hc/en-us/articles/14281227789468)
- **Conversation timeout**: the AI "will stop waiting for the contact's reply after **10 hours**". [Overview FAQ](https://help.manychat.com/hc/en-us/articles/14281227789468)
- **Human takeover**: when a person replies from Inbox, a **30-minute pause** starts automatically (configurable in Settings → Inbox Behavior). Keywords don't fire during the pause, and pending Smart Delays are held until it ends. [Inbox](https://help.manychat.com/hc/en-us/articles/14281070478748). "Pause all automations" can last from 30 min to forever, and an agent can manually "Resume automations". The suggested uses are complaints, "talk to a human" requests, and friends/VIPs. [Pause all automations, upd. 2026-10-17](https://help.manychat.com/hc/en-us/articles/19957883687708)
- **Prompt advice for the AI Step** ([blog, upd. Oct 14 2025](https://manychat.com/blog/guide-to-mastering-manychat-ai/)): structure the prompt as context ("When a user says…"), then goal ("…respond with X, then ask Y"), then tone. Use if/then rules. **State a length limit ("50 words or less")**. Explain *why* you want the information. Put style-guide snippets inside the prompt. The AI cannot perform actions such as tag, wait or follow up; those belong in the flow. Also: "Highlight that you're using AI… not trying to dupe them."
- **Not documented anywhere** (UNVERIFIED): a hard maximum reply length or emoji rule for AI Replies (the only examples are "under 3 sentences" and "no emojis", set by the user), a number of AI turns before handoff, and a per-contact cap on AI replies.

## 2. Delayed follow-up DM after the link

- ManyChat's comment→DM Quick Automation has an optional **"follow-up DM if the link isn't clicked."** The order is Opening DM → email → follow request → link → follow-up reminder. The follow-up only works when the Opening DM (the button opt-in) is enabled. The default delay and default wording are not documented (UNVERIFIED). [Quick Automation, upd. 2026-10-18](https://help.manychat.com/hc/en-us/articles/16654065283100)
- From the [Follow to DM blog (Oct/Dec 2025)](https://manychat.com/blog/follow-to-dm-turn-followers-into-conversations/):
  - Keep it to **three sentences max**.
  - Give a clear next step, because "Welcome!" with no next step leads nowhere.
  - **Ask a question** to get a reply. Their examples include "What's your current workout goal?" and "What's your biggest struggle with growing on IG?".
  - Add texture, not polish (one emoji or a quirk).
  - Their nudge example is **"Still thinking about it?"**.
  - Etiquette: don't spam, don't bait-and-switch, and **"Don't ghost replies. If someone answers your DM, reply."**
  - Interest-split buttons ("I'm a creator / I run a business…") are their segmentation pattern.
  - A 30–60 s delay feels human (that advice is about first DMs).
- Third-party guides (vendor, treat as weak evidence): refer back to what the person actually asked for instead of "just checking in", and use a single nudge. [inro](https://www.inro.social/blog/instagram-dm-follow-up-automation), [superprofile](https://superprofile.bio/guides/follow-up-dm-template.md)
- **Hard constraint**: automated messages are only allowed within **24 h** of the user's last interaction. The 7-day window is for manual Inbox replies only. ManyChat blocks scheduled sends outside the window automatically. [Messaging windows](https://help.manychat.com/hc/en-us/articles/23358636027932). Vendor docs say the HUMAN_AGENT tag cannot be used on bot messages (UNVERIFIED against Meta's own docs). A 30-minute follow-up fits comfortably inside the window.

## 3. Waitlist / pre-launch DM funnels

- ManyChat's lead-gen post (2026) says qualification should answer **what they need, when, and budget/decision**, then send high-intent leads to a human and everyone else to nurture. Its statistics (DM open rate of 80–90%, a "100× more likely if within 5 min" claim attributed to HBR) are vendor-quoted and UNVERIFIED. [blog](https://manychat.com/blog/ai-chatbots-for-lead-generation/)
- Vendor playbooks ([inro](https://www.inro.social/blog/how-to-use-instagram-dms-for-a-product-launch-2026-playbook)):
  - Keep the confirmation DM short (under 300 characters).
  - Ask **1–2 qualifying questions** at most.
  - Tag contacts by their answers so the launch-day broadcast can be segmented.
  - Send people who don't qualify to free content instead of a dead end.
- What not to promise follows ManyChat's own guardrail examples ("Do not guarantee revenue results"). Applied to a waitlist, the AI should not invent launch dates, prices, discounts, or "you're guaranteed a spot". It should never claim the product does something the knowledge base doesn't say. This applying-the-pattern step is my inference, not a sourced rule.

## 4. Gaps in ManyChat worth beating

ManyChat does not document reply-length caps, turn limits or source citations for its AI. OpenReply can make all three explicit and visible to Leo.

---

## Concrete recommendations for OpenReply

**Behavior template**, as three fields mirroring ManyChat and pre-filled with Leo's defaults:
- *Role:* "You are Leo's DM assistant for his AI video-editing system (Claude Code–based edit pipeline for creators). You help people who got the waitlist link understand what it is and whether it fits them."
- *Voice:* "Taiwan Traditional Chinese (reply in the user's language if they write in another). Casual, like Leo texting a friend. **Max 2–3 short sentences / ~60 Chinese characters per message.** At most 1 emoji, often none. No bullet lists, no markdown. End with one short question when the conversation should continue."
- *Guardrails:* write these as concrete negatives:
  - "Never give a launch date, price, discount or seat guarantee unless it is in Knowledge."
  - "Never claim features not in Knowledge."
  - "Don't promise Leo will personally reply."
  - "No financial/legal advice."
  - "Don't discuss other creators or competitors negatively."
  - "If unsure, say you'll check with Leo."
- Show the "be specific" hint next to each field, using ManyChat's before/after examples.

**Knowledge structure:**
- Use one topic per entry, each with a title and a short Q/A body: what it is / who it's for / what you need (Mac, Claude Code?) / status and timing / price ("not announced") / how to join + waitlist link / what happens after signing up / contact Leo.
- Keep entries plain text with links inline. Reject or warn on IG, YouTube and Google Docs URLs.
- Log every question the AI couldn't answer as a **"suggested knowledge" item** with a one-click "add entry" action. This copies the Playground loop.
- Store which entry IDs each answer used, so the inbox can show which source fed the reply.
- Snapshot Knowledge and Behavior when a conversation starts, so edits apply from the next conversation (ManyChat's rule).

**Playground:** chat against a draft config before it goes live, with "Start over" and "See new answer after edit", and a preset list of 8–10 test questions (including off-topic, pricing, "are you a bot?", English, and an angry message).

**Follow-up copy pattern (T+30 min, only if no reply / no click):**
1. Name what they got.
2. Give one short value line or useful detail.
3. Ask one easy-to-answer question that also qualifies them.
- Keep it to 3 sentences max, no second link-dump, and send it once only.
- Example: 「剛剛的等候名單連結有收到嗎？這套剪輯系統是用 Claude Code 自動幫你粗剪＋上字幕的。好奇問一下，你現在剪一支 Reels 大概要花多久？」
- Alternative question to qualify: 「你主要拍 Reels 還是 YouTube？」
- Skip the follow-up if the user has already replied or clicked, or if a human has taken over.

**Handoff rules:**
- Hand off to Leo (and pause the AI for that contact) when any of these happen:
  - an explicit "talk to Leo / 真人" request
  - complaint or negative sentiment
  - a collab / business / sponsorship inquiry
  - two unknown-answer misses in a row
  - payment or refund questions
- Send one holding line ("我請 Leo 本人回你 🙏"), then go silent.
- **Auto-pause the AI for 30 min (configurable) whenever Leo replies manually**, and hold pending follow-ups until the pause ends. Add a manual "resume AI" button.
- Never auto-reply to friends or VIPs on an allowlist.

**Limits:**
- AI replies only to inbound messages, inside the 24 h window. Never send automated messages after 24 h.
- Stop the AI session after **10 h** of silence (ManyChat's value).
- Cap at about **6 AI turns per contact per day**, then hand off or stop (OpenReply choice; ManyChat publishes no number).
- Set max_tokens low (~200) and enforce the character cap in code, not only in the prompt.
- Detect the reply language per message, falling back to zh-TW when the message is shorter than about 4 characters.
- Run at most 3 goals in priority order: share link > capture email > follow.
- Disclose the AI once, e.g. a first-AI-reply footer like 「（AI 小幫手回覆，Leo 本人也會看）」, following ManyChat's advice not to "dupe" followers.
