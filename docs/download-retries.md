# Download retries

`DownloadRetryService` (`packages/slskd-addon/src/services/download-retry.service.ts`) sweeps
slskd's downloads every 15 s. For each transfer that ended `Completed, Errored | TimedOut | Rejected`
it makes one of three moves:

- **retry**: re-enqueue on the same peer. slskd resumes the partial `.incomplete` file.
- **give up**: mark `transfer_retries.gave_up`, which lets `AlbumFallbackService` move the track to
  another peer.
- **defer**: the same hand-off, but the peer only rests, and the file comes back to it later if
  nobody else delivered it.

`Completed, Cancelled` is a user's decision and is never retried.

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

`retryPolicyFor(reason, retriesSoFar)` maps a class to `{ action: 'retry', delayMs }`,
`{ action: 'give-up' }` or `{ action: 'defer', restMs }`. It is owner-written policy. Until it is
written, it keeps the pre-#26 rule: a first retry at once, then 60 s apart, three in all.

How the service applies a decision:

- **One decision per failure.** The policy is asked the first time a failure is seen, and its answer
  is stored on the `transfer_attempts` row. A randomized policy therefore draws one delay per failure,
  not one per sweep; per-sweep draws would bias an experiment toward its shortest arm.
- **The delay counts from when the failure was seen**, not from the previous retry.
- **A give-up or defer on the first failure is immediate.** The `gave_up` row is upserted, so the
  fallback sees it on the same sweep, even if the file was never retried.

## Choosing a move

What each move costs:

| move | the album | this peer | search time |
| --- | --- | --- | --- |
| `retry` | **waits** for the whole delay: the fallback acts only once the primary's folder has stopped working, and a file waiting on a retry counts as working | keeps its slot | none |
| `give-up` | moves on at once | never asked again for this file | only if no recorded alternate has the track |
| `defer` | moves on at once | rests, then gets the file back if nobody else delivered it | only if no awake recorded alternate has the track |

On search time: the fallback tries the **recorded alternates first**. These are the hunt's runner-up
folders, in rank order, and trying one costs no search. It only searches the network when none of
them has the missing tracks. That search runs at `background` priority on the shared `SearchLanes`
(NicotinD#1049), so a waiting click always goes first. A click arriving mid-search waits for at most
that one track's search.

On quality: a recorded alternate was scored by the same hunt that picked the primary. A network
search picks the cleanest title match, with FLAC and peer health only breaking ties. Where the
original peer's copy matters more than speed, `retry` is the move that keeps it.

## Defer: another peer first, then come back

A defer rests the peer in `peer_rest` (`peer-rest.ts`) until `now + restMs`. The rest is capped at
`MAX_REST_MS` (2 h), for the reason given under "Come-back" below. While the peer rests:

- the fallback **passes over** it as an alternate without using it up. If it is the only recorded
  alternate with the tracks, the fallback **waits** for the rest to end rather than searching;
- a network search ignores its responses;
- a same-peer `retry` of any of its other files waits until the rest ends.

**Come-back.** When the rest ends, the file is checked:

- **Delivered elsewhere:** if another peer has delivered the file, or is delivering it (same
  basename, the fallback's own rule), the failure closes as `covered`.
- **Album job closed:** if the folder's album job is `done` or `abandoned`, it closes as
  `not-needed`.
- **Otherwise:** it is re-enqueued on the same peer, and that retry counts toward `retriesSoFar`.

The check runs only when the rest ends, so an alternate copy that fails mid-rest does not cost the
come-back.

The cap exists because, by default, slskd 0.25.1 forgets a failed transfer after 3 h and a
delivered one after a day. A come-back has to happen while both are still in its list.

## While Soulseek is offline

The service takes the same `isSourceReady` the fallback uses (`SourceConnection.isReady`, logged in
= ready). While the source is offline it re-enqueues nothing: an enqueue then answers 500 and used
to burn an attempt anyway, and 44 of the 111 give-ups above fell within ±5 min of an outage.

A failure first seen while offline is **not put to the policy**. It gets one free retry (delay 0)
once the source is back, and that retry does not count toward `retriesSoFar`, because the outage,
not the peer, is its likely cause.

## slskd's own retries

NicotinD's compose pins slskd **0.25.1**. Its `Transfer` carries `exception`, so the classes above
are not blind. It also has no download retry of its own: there is no `transfers.download.retry`
block, which later releases add (3 attempts, 5–60 s). If slskd is upgraded and that block is on, a
transfer slskd will retry carries `nextAttemptAt` in the future. This service leaves such a
transfer alone until that time, so two layers never retry one transfer.

## The `transfer_attempts` ledger

There is one row per failed transfer the service saw, keyed by `(transfer_key, transfer_id)`. A
re-enqueue creates a new slskd transfer id, so each retry's failure gets its own row. Rows are
**kept after success**, unlike `transfer_retries`, which is deleted on success. That deletion was
why success-after-retry could not be measured. Rows are pruned after 90 days, and ended rests
hourly.

| column | meaning |
| --- | --- |
| `directory` | the folder, for the album-job check at come-back |
| `state`, `exception`, `failure_class` | what slskd said, and its class |
| `retries_before` | same-peer retries already spent on this file when it failed |
| `source_offline` | first seen while Soulseek was logged out |
| `decision`, `delay_ms` | the stored decision; `delay_ms` is the retry delay or the (capped) rest, null for a give-up |
| `failed_at`, `retried_at` | first seen, and re-enqueued (null if never) |
| `outcome` | see below |

`outcome` values:

- `succeeded`: the retry or come-back worked.
- `failed`: it failed again.
- `gave-up`: the service stopped retrying this peer.
- `covered`: deferred, and another peer delivered the file.
- `not-needed`: deferred, and the album job was closed.
- null: still open.

Each new failure also logs one `Transfer failed` line carrying the same fields.

Read it on kpc (read-only):

```bash
ssh kpc "docker exec nicotind-slskd-addon-1 bun -e '
  const { Database } = require(\"bun:sqlite\");
  const db = new Database(process.env.SLSKD_ADDON_DB, { readonly: true });
  console.table(db.query(process.argv[1]).all());
' \"<SQL>\""
```

Which reasons occur. This confirms the running slskd reports `exception`. Every row `other` with a
null `exception` would mean it does not:

```sql
SELECT failure_class, exception, COUNT(*) AS n
FROM transfer_attempts GROUP BY 1, 2 ORDER BY n DESC;
```

Recovery by reason, move and delay, which is the number a delay is chosen from. A retry still in
flight (`outcome IS NULL`) and outage retries are excluded:

```sql
SELECT failure_class, decision, delay_ms, COUNT(*) AS retried,
       SUM(outcome = 'succeeded') AS recovered,
       ROUND(100.0 * SUM(outcome = 'succeeded') / COUNT(*), 1) AS pct
FROM transfer_attempts
WHERE retried_at IS NOT NULL AND outcome IS NOT NULL AND source_offline = 0
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

How often a defer's come-back was needed at all:

```sql
SELECT failure_class, outcome, COUNT(*) AS n
FROM transfer_attempts WHERE decision = 'defer' AND outcome IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 2;
```

## Choosing a delay by experiment

For the classes the policy retries or defers, the delay can be chosen by an experiment.

1. Have `retryPolicyFor` draw `delayMs` (or `restMs`) uniformly from a few arms, for example 60 s,
   5 min and 20 min.
2. Let it run. The ledger records which arm each failure got.
3. Read the recovery query by arm only once each arm has enough rows. About 60 retryable failures
   per 48 h gives about 140 per arm in two weeks, enough to see a difference of about 15 points.
   Extend the run if that number is not reached; do not read it early.
