# Running this deployment

Read this before changing sending speed, tokens, schedules or deploys. Every rule
here comes from something that failed in production.

## Who does what

| Job | Where | How often |
| --- | --- | --- |
| Send DMs and public replies | Railway worker | Continuous, paced |
| Sweep for comments webhooks missed | Railway worker | 5 min |
| Check the system, mail the owner | Railway worker, through `/api/ops/alert` | 10 min |
| Re-send what was missed, repair lost jobs | Railway worker | 10 min |
| Renew the Instagram token, snapshot followers | Railway worker | 6 h |
| Notice everything above being down | GitHub Actions, `uptime.yml` | 30 min |

There are no Vercel crons. Vercel's cron calls reached the routes without the
`Authorization` header (`[Cron] Refused`, `sentSecret: false`), so every call was
refused from at least 2026-09-18 until they were removed on 2026-11-02. That is why
the token expired on 2026-10-31. Followers were only recorded on days someone opened
the page, which is what gave it away. Do not move daily work back there.

Railway is the one scheduler, and GitHub watches it from outside. A failed Uptime run
makes GitHub email the owner; this was tested on 2026-11-02. GitHub has not started a single
scheduled run yet: none at minutes 0 and 30 in the first 2.5 hours, and none since moving to
minutes 17 and 47. Only manual runs have happened, so do not count on this check until a
`schedule` run shows up in the workflow's history.

## Sending speed

| Pace | Result |
| --- | --- |
| About 15 DMs a minute (2026-10-20) | Half of the next ones refused |
| 6 DMs a minute at launch, with hopeless sends being retried (2026-10-29) | Throttled, so lowered to 3 |
| 3 DMs a minute (2026-10-29 to the outage) | Stable |
| 12 DMs and 12 public replies a minute (2026-11-02) | Limit hit within 8 minutes |
| 6 DMs a minute, evenly spaced (2026-11-02) | Throttled after about 11 minutes, exactly 200 DMs into the rolling hour |
| 6 DMs a minute with no hourly cap, as a test (2026-11-02) | Throttled again at about 200 in the rolling hour, `code=100 sub=2534001` |

So this account's limit is now about 200 private replies in a rolling hour, and Instagram
reports it as `thread does not exist`, not as a rate limit. It was higher before: on
2026-10-20 about 400 went out in a rolling hour before refusals began, and 520 in all. Those
were also comments days old, so the age of a comment does not explain the drop. Normal use
never reaches it: before that day no hour passed 177. `DM_PACE_PER_MINUTE=3`,
`PUBLIC_REPLY_PACE_PER_MINUTE=2`, `DM_HOURLY_BUDGET=190`. A comment from a webhook has its
own line, 10 seconds apart and up to the full budget. Everything else waits in the backlog,
which stops 30 short of the budget so it never holds up a new comment. Meta documents 750 private replies an hour, and other tools report
running near it, so this account's limit is lower than the documented one for a reason not
yet known. Raising the pace needs evidence, not hope: the throttle log line carries the
error code, and the worker logs `[API usage, last 10 min]`, with what the calls were spent on
and the usage Instagram reports. The app usage it reports stayed at 0 while DMs were
being throttled, so this limit is not the app's call allowance. `[code=...]` in an error
says which limit it was: code 4 on public replies is `Application request limit reached`.

`The requested user cannot be found` (`sub=2534014`) is a real refusal, not the throttle in
disguise. On 2026-11-02, 37 comments refused this way were retried with nothing throttled,
and all 37 were refused again. For 30 of the 36 that were checked, the public reply also
failed because the comment no longer exists. Leave these as failed.

A new `DM_PACE_PER_MINUTE` reaches comments already waiting at the worker's next start
(`respaceWaitingComments`), which also reorders them: near the 7-day deadline first, then
people who already saw the public reply, then the newest. Each comment gets a sending time one spacing apart (`reservePaceSlot`),
with a minimum gap under it so a lowered pace also applies to jobs already waiting. The
DM does not wait for the public reply, but the reply waits for the DM's turn: it tells
people to check their inbox, so it must never go out while their DM is still in line.

## The Instagram token

It lasts 60 days and can be renewed without a login once it is a day old. Until one
renewal has worked (`ops:token-renewal-proven` in Redis), the worker tries 36 hours
after connecting, then once a month with 30 days left.

Renewal cannot survive a changed password or removed authorization. Then sending
pauses without failing anyone, the owner gets a mail, and sending resumes by itself
after a reconnect in Settings (Connect using your own Meta app, not Disconnect).

## Domains

`NEXTAUTH_URL` on Vercel and on Railway, and the OAuth redirect in the Meta app
(Instagram, API setup, business login settings), must all use the production domain.
A mismatch shows up only when someone reconnects, as `Invalid redirect_uri`, which is
the worst moment for it. The redirect goes in the OAuth field, not the deauthorize one.

## Alerts

A mail starts with what it needs from the owner: `要你動手`, `不用動手` or `交給 Claude`.
Prefer checks on what people experience (`comments-stuck`: waiting over 3 hours,
whatever the cause) to one check per cause. Something that clears by itself, such as a
throttle cooldown, does not get a mail of its own. Each problem is mailed at most once
per 12 hours.

## Deploys

- Pushing `main` deploys Vercel (web) and Railway (worker).
- Railway's build runs `npm run verify`, so a failing check keeps the old worker running.
- Vercel's build runs typecheck and lint, not tests: some tests read the environment
  and fail with production values.
- GitHub CI runs everything on push.

Before pushing:

- Chain with `&&`, never `;`. A failed `git add` followed by `;` once pushed a commit
  without its code, and a failed lint once let a broken page through.
- Never pipe a check before `&&`: `npm run verify | tail && git push` pushes when the
  check fails, because `&&` sees `tail`'s result. This pushed a type error on 2026-11-02.
- Read `git show --stat HEAD`.
- Pushing a workflow file needs the `workflow` scope: use
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`.

## Job rules

- BullMQ ignores adding a job id that is in use, including the running job's own, so
  a job cannot re-add itself under the same id.
- A comment has at most one job for its DM and one (`..._pub`) for its public reply. A
  job that retries the public reply must not also take the DM path; that is how the
  queue reached 3,683 jobs for 465 comments.
- A retry after an unknown Meta result can deliver a second copy, as it did before
  2026-10-21. Retry those once at most. Only confirmed refusals are safe to repeat.
