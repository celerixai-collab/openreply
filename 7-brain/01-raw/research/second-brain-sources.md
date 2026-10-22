# AI second brain / knowledge base guides from the competitor list (checked 2026-10-21)

Goal: copy the best method for a knowledge base that a Claude DM assistant reads to answer fans' questions about Leo 剪輯室. Leo maintains it, and it may be reused for his course/community.

## Source: Karpathy, "LLM Wiki" gist (April 2026)
https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- **3 layers:** `raw/` sources, which the AI reads but never edits; `wiki/`, AI-written markdown pages (summaries, entity, concept and overview pages) that the human reads; and a **schema** file (CLAUDE.md / AGENTS.md) holding the conventions and workflows, which human and AI refine over time.
- **Special files:** `index.md` is a catalog with one line per page (link, one-line summary, optional date/source count). The AI updates it on every ingest and reads it first on every query. `log.md` is append-only, with entries like `## [date] ingest | Title`.
- **Operations:** *Ingest* reads a source, writes a summary, updates the related pages (often 10-15) plus the index, then logs it. *Query* goes index → pages → an answer with citations, and good answers get filed back in. *Lint* checks for contradictions, stale claims, orphan pages and gaps.
- No embeddings needed up to roughly 100 sources and a few hundred pages. Optional YAML frontmatter, git for history, Obsidian as the viewer.
- **Fit:** high. It is the base pattern almost every other guide below copies.

## Relevant guides found
| Creator | Guide | Method | Fit for a DM FAQ KB |
|---|---|---|---|
| Ten Fold (Marc) | **Claude Code Wiki System**: https://www.notion.so/33cc2d7ca4cf8155bfcbe61a23db8a8d | Most detailed version of the Karpathy pattern. `/wiki/` has CLAUDE.md, `hot.md` (rolling 3-5-day context, max 40 lines), index.md, log.md, and folders `entities/ projects/ concepts/ sources/ conversations/ raw/ archive/ templates/ backup/`. Frontmatter: `title, date_created, date_updated, tags, related, raw_source`. Index line format: `[[Page]] — one-sentence summary (tags)`. **Tiered retrieval:** read hot.md → index → 200-500-word page, and fall back to raw only on negative feedback or pages older than 30 days, then update the page. Archiving needs approval and is never automatic. Includes a copy-paste setup prompt. | High. The tiers and the "current facts" file map directly onto prices and versions. The personal-memory folders are overkill. |
| Ten Fold | **AI second brain in 15 min**: https://guides.tenfoldmarketing.com/ai-second-brain | `brain/` with me.md, INDEX.md, recent.md (dated 3-line logs), and identical CLAUDE.md + AGENTS.md. "Save this" files a fact right away. A **weekly Sunday clean-up** merges duplicates and fixes INDEX. Never store keys or financial data. | Medium-high. Good update routine. |
| Ten Fold | **7 Claude weekend projects, Second Brain**: https://guides.tenfoldmarketing.com/7-claude-weekend-projects | Existing folder (or Drive/Notion connector) plus INDEX.md plus **open-questions.md** (missing info). Rule: check the folder first, and if the answer isn't there, say so. | High. The gap file and the no-guessing rule are exactly what a bot needs. |
| Learn AI with Mariah | **3 Ways to Build an AI Second Brain**: https://learnaiwithmariah.com/guides/ai-second-brain-3-ways/ | (1) Claude Project: about-me doc, recurring docs, 3 best examples, 4-point instructions. (2) Obsidian: `inbox/ notes/ projects/ reference/`. (3) Folder: `brain/about-me/context.md` (6 sections), lowercase-dash `.md` files with one topic each. Monthly prune. | Medium. Good naming rules. Personal-focused. |
| Mariah | **3-Layer Claude Memory**: https://learnaiwithmariah.com/guides/claude-memory-system/ | Instructions.md, Memory.md (log of corrections), Context.md, and a **weekly dated archive** outside the folder. Layer 3 is a Notion "Memory Database" or Obsidian wiki. | Medium. The corrections log is useful. |
| Mariah | **Expert Knowledge File**: https://learnaiwithmariah.com/guides/expert-knowledge-file/ | `knowledge/substacks/ podcasts/ x-threads/` filled weekly by Apify, plus an instruction to search knowledge/ first. | Low. Built for industry research. |
| AI with Max | **Claude Code + Obsidian Second Brain**: https://aiwithmax.com/guide-claude-code-obsidian-second-brain-setup.html | `01-raw / 02-wiki / 03-output` plus CLAUDE.md (never edit raw). 4 prompts: compile, summarize, fold in new material, list unprocessed raw files. | Medium. Simple Karpathy starter. |
| AI with Max | **4 Ways to Get Ahead**: https://aiwithmax.com/guide-4-ways-to-get-ahead-of-everyone-else-using-ai.html | A Project made of instructions, knowledge and memory. Rule: if a doc contradicts the instructions, flag it and ask which is current. | Medium. |
| MavGPT | **5 Claude Weekend Projects, Second Brain**: https://mavgpt.ai/resources/five-things-to-build-with-claude-one-weekend-2026 | Claude Project with 15-30 docs. Instructions: answer **only** from the docs, else reply "Not in your documents", and cite the file and line. | Medium-high. Good answer rules. |
| Cindy Zhu | **Give Claude a memory (Obsidian)**: https://cindyzhu.com.au/guides/second-brain-claude-memory.html | CLAUDE.md (who / preferences / never-do / locked decisions), vault via Obsidian MCP + Local REST API, and **note titles written as sentences** because Claude matches on titles first. | Medium. The title tip helps retrieval. |
| Altari (= IG **alassafi.ai**) | **The Company Brain** ("BRAIN"): https://altari.ai/guide/company-brain | raw/ → clean (rewrite prompt) → chunk → embeddings in Supabase → retrieve top 20, re-rank to 8, cite the source. Tools work as drafts only, with human approval. Full guide is **email-gated** and was not unlocked. | Low for now. Built for 30 years of data. Copy only "cite source" and "drafts need approval". |
| Altari | **Second Brain with Claude + Obsidian**: https://altari.ai/guide/second-brain-claude-obsidian (and the OpenClaw variant, Group Brain, Files & Folders) | CLAUDE.md, Obsidian with MCP semantic search, brain-ingest for video/meetings, and a session rhythm. Email-gated, so only the outline is visible. | Medium. Couldn't verify details. |

## Sites with nothing relevant
- **sabrina.dev/p/free**: the list is a picture with no readable text, and the archive has no matching post.
- **noevarner.com/resources**: the whole vault is behind an email/SMS form. Not unlocked.
- **arjavjain.org/writing**: nothing on second brains. "Claude Starter Folder" and the "knowledge base strategy" in the Hormozi coach post are the closest.
- **chenmedialabs.com**: no free guides (service site).
- **takigpt.com**: none of its 20 resources is a second-brain guide. The IG "2nd brain in Obsidian" resource is not public.
- **growthexe.substack.com**: no matching posts.
- **cindyzhu.com.au**: only the guide above, plus a basic "Claude memory setup".

## Instagram creators
These resources are sent by DM after you comment a keyword. Profiles hit a login wall and no public copies turned up, so none were obtained.
- **seb.ai**: Linktree has a paid "AI Vault" and no free second-brain page.
- **taki.gpt**: bio link is skool.com/agenticaiacademy.
- **ibraviz.ai**: bio link is a consult intake form.
- **jasoncooperson** ("LARP"): bio link is skool.com/leveragelab. Per the brief, the post is based on Karpathy's GitHub method, which is summarized above.
- **bennett.spooner**: no bio link.
- **jay.newmedia**: bio link points to a YouTube video, and the 四層 framework wasn't found.
- **alassafi.ai**: = Altari. "BRAIN" is the Company Brain guide above.

## Best method for Leo
A **small Karpathy-style wiki in a git folder**, set up as a FAQ base rather than a personal journal. Take Ten Fold's hot/tiered idea, Ten Fold's open-questions gap file, and MavGPT's "answer only from docs" rule. Skip embeddings (Altari): at under 100 pages, Claude can read `index.md` and then open 1-3 pages, which is cheaper, easy to check, and easy for Leo to edit.

**Where it lives:** `leo-kb/` in a git repo (e.g. inside the openreply repo, or its own repo the bot pulls from). Open it in Obsidian for editing. Git gives history and rollback.

```
leo-kb/
  CLAUDE.md        # schema: how to read, answer, ingest, lint (same text as AGENTS.md)
  current.md       # volatile facts ONLY: price, plan, version, promo, links, deadlines (≤40 lines)
  index.md         # one line per page: [[標題]] — 一句摘要 (tags, audience)
  log.md           # ## [YYYY-MM-DD] ingest|update|lint | 標題
  gaps.md          # questions the bot couldn't answer → Leo fills these
  faq/             # one question-cluster per file, 150-400 字
  product/         # what 剪輯室 is, features, requirements (Mac/RAM), install, limits
  policy/          # refunds, support, what the bot must hand to Leo
  course/          # course/community material (audience: student)
  raw/             # Leo's dictations, changelogs, real DM threads. Never edited
  archive/
```

**Page frontmatter:**
`title` (written as the fan's question, e.g. 「8GB Mac 可以跑嗎？」), `questions` (3-6 ways fans phrase it, in Chinese and English), `answer_short` (1-2 sentences ready to send as a DM), `audience` (fan | buyer | student), `public` (true = bot may say it), `status` (live | draft | outdated), `updated`, `source` (raw file), `related`.

**CLAUDE.md rules for the DM bot:**
1. Read current.md, then index.md, then only the matching pages.
2. Answer only from the KB, in 繁中 and short. Prices and versions always come from current.md.
3. If the answer isn't in the KB, or `public: false`, or `status: draft`, don't guess: reply with the hand-off line and add the question to gaps.md.
4. Cite the page internally so Leo can check it. Replies stay drafts until Leo approves, as in OpenReply's draft mode.

**Update routine:**
- **Daily or as it happens:** when something changes (price, new version), edit only current.md and log it.
- **Weekly (15 min):** Leo answers gaps.md by voice, drops the transcript in raw/, and says 「ingest」. Claude updates or creates the faq pages, index and log. Then 「lint」: duplicates, contradictions with current.md, pages older than 60 days, orphans. Archiving only with Leo's approval.
- **Course reuse:** the same pages, filtered by `audience: student`. Course pages are `public: false` for the fan bot.

**Why this setup:** it is the one pattern every strong source shares (raw → curated pages → index), and it stays reviewable by one person. The current.md file (adapted from Ten Fold's hot.md) means a price change happens in one place. The gaps file plus the "no guessing" rule (from Ten Fold and MavGPT) is the safety layer a public DM bot needs.
