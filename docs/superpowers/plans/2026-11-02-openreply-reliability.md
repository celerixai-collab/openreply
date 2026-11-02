# OpenReply reliability, after the token outage of 2026-10-31

**Goal:** the failures of the past 30 days cannot silently come back.

**Approach:** fix each root cause where it starts, remove parts that do not earn their
place, and alert on what people experience. Lasting rules are in `docs/operations.md`.

## Failure classes

| What happened | Root cause | Fix | Proof |
| --- | --- | --- | --- |
| Token expired, every campaign stopped | Vercel's cron calls came without the secret and were refused daily, with no trace | Worker does the daily work, no Vercel crons | `headerLength: 0` in the cron log; follower rows only on page views |
| A renewal that may never have worked | The path never ran in production | First renewal 36 hours after connecting, alert if it fails | Pending: first run due 2026-11-03 21:00 UTC |
| Nobody noticed for 2 days | No alert reached the owner | Mail on real problems, outside check by GitHub | Failure mail received from a deliberately failed run |
| Throttled at 12, then again at 6 a minute | Speed raised without evidence, and limit code 4 mislabelled as 368 | 3 and 2 a minute, real code logged, quota usage logged | Pending: no throttle during the backlog |
| Queue reached 3,683 jobs for 465 comments | Sweep re-queued waiting comments; public-reply retries also took the DM path | Both stopped, duplicates removed at every start | Pending: delayed jobs track pending comments |
| "I got nothing", hours later | Waiting comments woke at random, so unlucky ones waited 5x longer | Each gets a sending time, oldest first | Pending: sends 10 seconds apart |
| Rows marked as waiting with no job | Marks trusted for 26 hours | Repair every 10 minutes | Unit test; pending: live count |
| Broken deploys | Lint failure not stopping a chained command; tests in the Vercel build | `verify` in Railway's build, `&&` rule | CI green; Vercel READY |
| Reconnect failed during the outage | Meta redirect still on the old domain | Fixed, and documented | Reconnected 2026-11-02 |
| Mails that said nothing useful | Stale events, self-healing states mailed | Rewritten, each says what it needs | Unit test on every mail |

## Looked at and left alone

Each of these came out of the audit, and live data showed no case in the past 7 days
(2,417 sent, 6 failed, all `user cannot be found`).

- Whole-word keyword misses: no active campaign uses whole-word match.
- Temporary refusals using up all attempts: no such row.
- Unconfirmed deliveries that never retry: no such row, and retrying can send a copy.
- Keywords that clean up to nothing: none in active campaigns.
- Buttons of paused campaigns doing nothing: by design.
