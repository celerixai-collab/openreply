# ManyChat AI for Instagram DMs: parity checklist (2026-10-21)

This report builds on `manychat-ai-methodology.md` and does not repeat what it covered (Behavior writing tips, the 30-min human-takeover pause, the 24 h window, follow-up copy). Sources: the help-center Zendesk API (dates are `updated_at`), community.manychat.com, and manychat.com/product/ai, read in the browser because curl and WebFetch get a 403. `manychat-ai.md` does not exist.

## 1. Feature inventory

**Product shape.** The **Manychat AI** tab is still labelled **beta**. Replies, Comments, Goals, Knowledge and Behavior work on **Instagram only**. Only Admin and Editor roles can see the tab. Its sub-tabs are Overview, Knowledge, Behavior, Skills and Test AI. [Overview](https://help.manychat.com/hc/en-us/articles/14281227789468)

**Pricing.** Under the new pricing (Mar 2, 2026), "AI-powered automation" comes with **Pro at $39/mo, or $29/mo billed yearly**. Pro includes 2,500 active contacts and 3 channels. [Pro plan](https://help.manychat.com/hc/en-us/articles/25800228332572). The product page still says AI is a "$29/month add-on to Pro", so the two sources conflict. [product/ai](https://manychat.com/product/ai)

**No "AI Agent" product exists.** There is no help article, product update or page under that name. The 2026 launches are:
- Knowledge v2, Feb 24, 2026 ([post](https://community.manychat.com/product-updates/knowledge-v2-import-website-content-and-review-what-your-ai-knows-9132))
- Playground gap detection, Mar 3, 2026 ([post](https://community.manychat.com/product-updates/ai-playground-test-your-ai-detect-knowledge-gaps-and-go-live-with-confidence-9189))
- Playground source attribution and ratings, Mar 18, 2026 ([post](https://community.manychat.com/product-updates/better-faster-stronger-introducing-new-updates-to-ai-playground-9311))
- AI Behavior, Apr 2026 ([article](https://help.manychat.com/hc/en-us/articles/26782002914332))

I found nothing AI-specific shipped in Sept or Oct 2026. Those months only brought edits to existing articles.

**Routing order.** An inbound DM goes to existing automations (keyword, intent) first. If none of them catches it, the AI checks whether the message is a *question* (AI Replies) or a *compliment* (AI Comments). If it is neither, the Default Reply fires. [Overview FAQ](https://help.manychat.com/hc/en-us/articles/14281227789468)

**Knowledge** ([article, upd. 2026-10-08](https://help.manychat.com/hc/en-us/articles/25626595060124)):
- **Entry types.** Two types: *Text* and *public Link*. File upload is still "coming soon".
- **Size.** Each entry holds up to **250,000 characters**. Pages longer than that are cut off at the bottom.
- **Link scan.** You click "Scan Now", then review the extracted text, then "Add Source". The scan reads **one page only**, with no crawling of subpages. Only visible text is kept; images, video, PDFs, embeds, forms and widgets are ignored. The text is kept close to the page, not summarized.
- **Knowledge v2 additions.** Titles are auto-generated and editable. You can edit the extracted text before it goes Active. **"Refresh" rescans a link entry.**
- **Blocked domains.** Facebook, Instagram, YouTube, WhatsApp, LinkedIn, Google Docs/Sheets and S3. Canva links only give navigation text.
- **When edits apply.** Edits apply from the **next new conversation**.
- **Shared knowledge.** The Knowledge base feeds Replies, Comments and Goals only. **AI Step and Intention Recognition do not use it.** ([moderator, Dec 2025](https://community.manychat.com/general-q-a-43/highly-confused-about-manychat-ai-8022))

**Behavior.** Three fields, pre-filled from a scan of the IG bio and recent comment replies:
- **AI Role**
- **Brand Voice & Persona** (tone and formatting)
- **Guardrails & Constraints** (when one is hit, the AI redirects or declines)

Changes apply to future conversations right after you save. [Behavior](https://help.manychat.com/hc/en-us/articles/26782002914332)

**AI Replies.** Answers questions from Knowledge. The only option is an **"Assign to a person" checkbox** for questions the AI can't answer, routed to a team member or group. Language is detected automatically per message, and short messages can be misdetected. The AI **stops waiting for a reply after 10 h**. [Replies](https://help.manychat.com/hc/en-us/articles/23018283889180)

**AI Comments.** Replies to positive comments on Reels and Posts only (not Stories or Lives).
- "Set AI's Tone" reads your past comment replies and produces **5 sample replies**. You mark them "Looks Good" or "Not My Style".
- The product page says you "approve every reply". UNVERIFIED: the help article describes no approval queue.

[Comments](https://help.manychat.com/hc/en-us/articles/23096278263836)

**AI Goals** ([article, upd. 2026-09-01](https://help.manychat.com/hc/en-us/articles/23096273858716)):
- Goals run only after AI Replies or AI Comments has fired. **Up to 3 goals at once**, ordered by drag-and-drop priority, each with its own on/off toggle.
- **Share a link.** You give a URL and a *description of what it contains*. You then click Generate Message and can edit it or press "Try Another Message".
- **Grow followers.** The AI checks whether the contact already follows. If not, it sends a follow ask, which you can edit.
- **Capture leads.** You pick **system or custom user fields**, and the AI writes the questions "based on the field's type and name". You also add an *explanation of why you collect it*.
  - Refusal handling: an optional "Assign to a person" toggle.
  - Finish options: **Skip / Send a message + a button with a link / Trigger an automation / Assign to a person**.
  - There is a "Try the Preview" step before "Go Live".
- **Email and phone validation inside AI Goals is not documented** (UNVERIFIED). The flow-builder Data Collection block does validate:
  - email format
  - phone characters and country/operator code, plus a **Twilio deliverability check**
  - a custom retry message, a retry limit (e.g. 3), a reply timeout and a "Skip" button

  [Data Collection](https://help.manychat.com/hc/en-us/articles/18362925739932)

**Playground (Test AI)** ([Replies article](https://help.manychat.com/hc/en-us/articles/23018283889180) and the Mar 2026 posts above):
- Simulates a real DM. It answers from Knowledge plus profile information.
- Offers **3 default suggested questions**.
- When a question isn't covered, it shows a **knowledge-gap prompt**: you add the entry inline, then "See new answer". There is also an Edit button and "Start Over".
- **Source attribution** appears under every answer, and clicking it opens the Knowledge entry.
- Every answer gets a **thumbs up/down**. Thumbs-down asks for a preset or free-text reason.
- You choose who handles unanswered questions before going live.

**Overview / analytics.** A dashboard showing "replies sent, hand-offs, and progress toward goals" ([launch post](https://community.manychat.com/product-updates/your-new-ai-hub-beta-is-live-smarter-replies-faster-setup-same-manychat-magic-7631)). The Home tab (Apr 2026) adds metrics on followers, links, leads and automations, with "actionable insights" ([post](https://community.manychat.com/product-updates/see-what-s-working-and-what-to-do-next-on-the-new-home-tab-9479)). The launch post also mentions "confidence limits", but no setting for them is documented (UNVERIFIED).

**Intention Recognition.** A trigger on "User sends a message" set to "Recognize the intention of the message".
- You write the intent as a sentence, e.g. "USER asks about DELIVERY". There is no list of example phrases.
- Works on IG, Messenger, WhatsApp and Telegram.
- Docs advise one intent per topic, and adding a tag plus a condition so a reply is sent only once. [Intention](https://help.manychat.com/hc/en-us/articles/14281187229468)

**AI Step.** A flow node.
- **Setup.** You enter a goal and context, then click Generate. That produces editable **tasks**, and each can **save the user's reply to a field**. Context can be up to **10k characters** ([product page](https://manychat.com/product/ai)).
- **Testing.** "Save & Start Chat" runs a test.
- **Channels.** IG, Messenger, WhatsApp, TikTok and Telegram. [AI Step](https://help.manychat.com/hc/en-us/articles/14281187288860)
- **Follow-up.** An automatic follow-up after **30 min** without a reply ([2024 post](https://community.manychat.com/product-updates/ai-step-introducing-automated-follow-ups-response-time-update-%F0%9F%94%A5-2539)).
- **Limits.** The AI cannot perform actions itself; tags, waits and follow-ups belong in the flow.

**BYO LLM.** There are native ChatGPT and Claude actions: a prompt plus the last input go in, the answer is saved to a custom field and then sent. You can set model, max tokens and temperature. [Claude integration](https://help.manychat.com/hc/en-us/articles/19689792833180)

## 2. How link-sending works

- **Share a link goal.** The docs only say "AI sends your link in a DM". The message text is AI-written from your description. **Whether it goes as a URL button or as an inline text link is not documented** (UNVERIFIED). Click tracking for this goal is also not documented (UNVERIFIED); the Overview reports only "progress toward goals".
- **Capture leads.** The "Send a message" finish option explicitly attaches a **button with a link**. Normal ManyChat message buttons report per-automation clicks/CTR ([Creators FAQ](https://help.manychat.com/hc/en-us/articles/19687677652124)).
- **Knowledge links.** Links written inside Knowledge text are passed on as **plain inline links** in the AI's answer ("book a call here: [link]").
- **Triggering a flow.** **Yes, but only as the Capture-leads finish option** ("Trigger an automation"). Share-a-link and Replies cannot trigger a flow. The reverse direction does work: any flow can add an AI Step, or use Intention Recognition as a trigger.
- **Known risk.** Community advice is to keep personalized URLs out of AI Step output, because "AI can hallucinate and break the link". Instead, put them in a normal Message button built from a custom-field variable (UNVERIFIED thread, found via search, not opened).

## 3. Complaints and gaps (community, 2025–2026)

- **Instagram only.** Replies, Goals and Knowledge are Instagram-only. Users on WhatsApp or Messenger who pay for Pro find out after setup ([thread](https://community.manychat.com/general-q-a-43/highly-confused-about-manychat-ai-8022)). There is no website widget ([Apr 2026](https://community.manychat.com/general-q-a-43/question-about-using-manychat-with-publich-web-site-on-whatsapp-9592); [idea, Oct 18 2026](https://community.manychat.com/ideas/chatbot-manychat-11001)).
- **Two separate AI systems.** AI Step and Intention Recognition don't share Knowledge with AI Replies, so users have to configure twice.
- **Old threads get AI replies.** Users don't want AI answering existing clients. They ask for AI to stop once the human replies and to answer only new conversations. The fix is workarounds (New Contact trigger, tags, "conversations must be explicitly opened") ([Jan 2026](https://community.manychat.com/general-q-a-43/how-to-disable-ai-live-chat-for-existing-ig-messages-8957)).
- **The pause can't be turned off.** The auto-pause on a human reply can't be disabled, only its length changed ([idea, Aug 2026](https://community.manychat.com/ideas/do-not-pause-automations-when-human-agent-replies-10748)).
- **No external-AI handoff.** There is no handoff to an external agent, External Request timeouts are short, there is no deferred reply, and there is no API to pause or resume one subscriber ([idea, Aug 2026](https://community.manychat.com/ideas/let-an-external-ai-agent-take-over-a-live-conversation-via-external-request-ai-handoff-not-human-handoff-10764)).
- **No conversation export** for analysis ([idea, Sep 2026](https://community.manychat.com/ideas/export-conversations-for-ai-powered-funnel-analysis-10867)).
- **AI Step problems:**
  - Replies sound robotic.
  - There is no human-like delay between messages ([idea, 24 upvotes](https://community.manychat.com/ideas/ai-step-delay-between-messages-2786)).
  - Follow-ups come out in the wrong language (a Chinese bot follows up in English) or never fire ([thread](https://community.manychat.com/product-updates/ai-step-introducing-automated-follow-ups-response-time-update-%F0%9F%94%A5-2539)).
- **Can't stop the AI.** AI or Default Reply keeps firing after AI is turned off. The fix is to remove the "Manychat AI" trigger ([thread](https://community.manychat.com/general-q-a-43/unable-to-stop-ai-auto-message-instagram-6390)).
- **Link button missing for the recipient.** The button doesn't show up for some recipients, which is blamed on IG desktop ([Oct 13 2026](https://community.manychat.com/general-q-a-43/button-with-the-link-not-displaying-in-the-automated-message-10981)).
- **Beta caveats from ManyChat itself.** Guardrails are "not fully deterministic". The tone model is in beta, so "you might not notice changes right away".

## 4. Build list for OpenReply (prioritized)

**P0 — parity core**
1. **Routing order.** Keyword/flow first, then the AI question classifier, then default reply. *MC: automations always win; the AI only takes questions and compliments.*
2. **Knowledge entries.** Text plus single-page URL scan with review/edit before activation, editable title, Refresh button, and a 250k-character cap per entry. *MC: Scan Now → review → Add Source; visible text only, no crawl, blocked social and Google Docs domains.*
3. **Behavior.** Three fields (Role / Voice / Guardrails), pre-filled from the IG bio and past replies. *MC: an IG scan pre-fills them, the user edits, and changes apply on save.*
4. **AI Replies with handoff.** Answer from Knowledge. On "can't answer", assign to a human and pause the AI for that contact. *MC: an "Assign to a person" checkbox per skill.*
5. **Share-a-link goal.** Link plus description; the AI writes the message, which you can edit or regenerate. **Send it as a tracked URL button** (beats MC, whose format is undocumented).
6. **Capture-leads goal.** Choose fields, the AI asks with a "why" explanation, the answer is **validated** (email regex, phone E.164), with retry limit, skip and refusal → handoff. Finish with message + button / trigger flow / assign / skip. *MC: four finish options; validation only documented for Data Collection.*
7. **Human takeover.** A manual reply pauses the AI for N minutes (default 30, configurable, can be turned off), with a "Resume AI" button. AI answers new conversations only, as an option. *MC: fixed auto-pause; can't be disabled; "new conversations only" needs workarounds.*
8. **Per-message language detection** with a fallback language for short messages, applied to follow-ups too. *MC: auto-detects; follow-ups have been sent in the wrong language.*
9. **10 h conversation timeout and 24 h window enforcement.** *MC: AI stops waiting at 10 h.*

**P1 — testing and visibility**
10. **Playground:**
    - 3 suggested questions
    - gap detection with inline "add knowledge" and "See new answer"
    - **source attribution per answer**
    - 👍/👎 with reasons
    - Start Over

    *MC: shipped Mar 2026.*
11. **Overview dashboard:** replies sent, hand-offs, goal completions, link clicks. Add a **list of unanswered questions**, which MC lacks.
12. **Goal priority** (max 3, drag order) and per-goal toggles. *MC: Skills tab drag-and-drop.*
13. **Grow-followers goal:** check follow status, then make one ask. *MC: same.*
14. **Delayed follow-up** (30 min, once, only if no reply or click, in the same language). *MC: AI Step follow-up at 30 min.*

**P2 — beat them**
15. **One shared Knowledge base** across every AI surface, including flow nodes (MC keeps two separate systems).
16. **Typing delay / human pacing** between AI messages (the idea with 24 upvotes).
17. **Conversation export** (redacted CSV/JSON) and an AI funnel summary.
18. **API to pause/resume the AI per contact**, plus an async external-agent webhook with deferred reply.
19. **Approval queue / draft mode** for AI replies (MC claims approval for Comments only). OpenReply already has this.
20. **Intent triggers** written as plain-language intents (e.g. "user asks about price"), with a once-per-contact guard. *MC: Intention Recognition with tag-and-condition dedupe.*
