# Download retries

`DownloadRetryService` (`packages/slskd-addon/src/services/download-retry.service.ts`) sweeps
slskd's downloads every 15 s. For each transfer that ended `Completed, Errored | TimedOut | Rejected`
it either **re-enqueues it on the same peer** (slskd resumes the partial `.incomplete` file) or
**gives up**, which marks `transfer_retries.gave_up` and so lets `AlbumFallbackService` move the
track to an alternate peer. `Completed, Cancelled` is a user's decision and is never retried.

## By reason (#26)

Before #26 every failure got the same rule: 3 same-peer retries, 60 s apart. Measured on kpc over
48 h to 2026-11-05, 8 of 122 retried transfers recovered (7%) and 111 gave up, because most failures
cannot be helped by waiting for the same peer:

| slskd `exception` | n (48 h) | class |
| --- | --- | --- |
| `Transfer rejected: File not shared.` | 564 | `not-shared` |
| `The wait timed out` | 118 | `timeout` |
| `Overwhelmed with requests; try again later` | 66 | `peer-busy` |
| `Too many files` | 64 | `peer-busy` |
| `Verification required` | 14 | `other` |

`classifyFailure(state, exception)` (`retry-policy.ts`) maps slskd's `exception` text to a class:
`not-shared`, `peer-busy`, `timeout`, `connection` or `other`. A `Completed, TimedOut` with no text
is a `timeout`; anything else unrecognised is `other`, never a guess.

`retryPolicyFor(reason, retriesSoFar)` maps a class to `{ action: 'retry', delayMs }` or
`{ action: 'give-up' }`. It is owner-written policy. Until it is, it keeps the reason-blind rule.

How the service applies a decision:

- **One decision per failure.** The policy is asked the first time a failure is seen, and its answer
  is stored on the `transfer_attempts` row. A randomized policy therefore draws one delay per failure,
  not one per sweep; per-sweep draws would bias an experiment toward its shortest arm.
- **The delay counts from when the failure was seen**, not from the previous retry.
- **Give-up on the first failure is immediate.** The `gave_up` row is upserted, so the fallback sees
  it on the same tick, even if the file was never retried.

## While Soulseek is offline

The service takes the same `isSourceReady` the fallback uses (`SourceConnection.isReady`, logged in
= ready). While the source is offline it re-enqueues nothing: an enqueue then answers 500 and used
to burn an attempt anyway, and 44 of the 111 give-ups above fell within ±5 min of an outage.

A failure first seen while offline is **not put to the policy**. It gets one free retry (delay 0)
once the source is back, and that retry does not count toward `retriesSoFar`, because the outage,
not the peer, is its likely cause.

## The `transfer_attempts` ledger

There is one row per failed transfer the service saw, keyed by `(transfer_key, transfer_id)`. A
re-enqueue creates a new slskd transfer id, so each retry's failure gets its own row. Rows are
**kept after success**, unlike `transfer_retries`, which is deleted on success. That deletion
was why success-after-retry could not be measured. Rows are pruned after 90 days.

| column | meaning |
| --- | --- |
| `state`, `exception`, `failure_class` | what slskd said, and its class |
| `retries_before` | same-peer retries already spent on this file when it failed |
| `source_offline` | first seen while Soulseek was logged out |
| `decision`, `delay_ms` | the stored decision (`delay_ms` null for a give-up) |
| `failed_at`, `retried_at` | first seen, and re-enqueued (null if never) |
| `outcome` | `succeeded` / `failed` (the retry failed again) / `gave-up`; null while open |

Each new failure also logs one `Transfer failed` line carrying the same fields.

Read it on kpc (read-only):

```bash
ssh kpc "docker exec nicotind-slskd-addon-1 bun -e '
  const { Database } = require(\"bun:sqlite\");
  const db = new Database(process.env.SLSKD_ADDON_DB, { readonly: true });
  console.table(db.query(process.argv[1]).all());
' \"<SQL>\""
```

Which reasons occur. If every row is `other` with a null `exception`, the running slskd does not
report `exception` and the classes are blind:

```sql
SELECT failure_class, exception, COUNT(*) AS n
FROM transfer_attempts GROUP BY 1, 2 ORDER BY n DESC;
```

Recovery by reason and delay, which is the number a retry delay is chosen from. A retry still in
flight (`outcome IS NULL`) and outage retries are excluded:

```sql
SELECT failure_class, delay_ms, COUNT(*) AS retried,
       SUM(outcome = 'succeeded') AS recovered,
       ROUND(100.0 * SUM(outcome = 'succeeded') / COUNT(*), 1) AS pct
FROM transfer_attempts
WHERE retried_at IS NOT NULL AND outcome IS NOT NULL AND source_offline = 0
GROUP BY 1, 2 ORDER BY 1, 2;
```

## Choosing a delay by experiment

For the classes the policy retries, the delay can be chosen by an experiment.

1. Have `retryPolicyFor` draw `delayMs` uniformly from a few arms, for example 60 s, 5 min and 20 min.
2. Let it run. The ledger records which arm each failure got.
3. Read the recovery query by arm only once each arm has enough rows. About 60 retryable failures
   per 48 h gives about 140 per arm in two weeks, enough to see a difference of about 15 points.
   Extend the run if that number is not reached; do not read it early.
