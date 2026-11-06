# Download retries

`DownloadRetryService` (`packages/slskd-addon/src/services/download-retry.service.ts`) sweeps
slskd's downloads every 15 s. For each transfer that ended `Completed, Errored | TimedOut | Rejected`
it makes one of three moves:

- **retry**: re-enqueue on the same peer. The file restarts from byte 0, because slskd 0.25.1 does
  not resume a partial file (its enqueue sets `StartOffset = 0`).
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
`not-shared`, `peer-busy`, `timeout`, `connection`, `shutdown` or `other`. A `Completed, TimedOut`
with no text is a `timeout`; anything else unrecognised is `other`, never a guess.

The retryable failures slskd still listed on kpc on 2026-11-06 (read from its API, numbers
collapsed), by class:

| class | listed | texts |
| --- | --- | --- |
| `not-shared` | 281 | `Transfer rejected: File not shared.` |
| `timeout` | 101 | `The wait timed out after N milliseconds` (86), `Inactivity timeout of N milliseconds was reached` (14), `…after hard time limit of N secs` (1) |
| `shutdown` | 88 | `Application shut down`: slskd restarted under the transfer, e.g. a deploy |
| `peer-busy` | 67 | `Overwhelmed with requests; try again later.` (45), `Too many files` (22) |
| `connection` | 45 | `Connection reset by peer` (18), `Failed to negotiate transfer connection … Value cannot be null` (13), `Remote connection closed` (13), `Failed to establish a direct or indirect transfer connection` (1) |
| `other` | 78 | `File read error.` (32), `Download reported as failed by remote client` (19), `Cancelled` (13), `Verification required…` (14) |

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
| `retry` | **waits** for the whole delay: the fallback acts only once the primary's folder has stopped working, and a file waiting on a retry counts as working | asked again; the file restarts from byte 0 | none |
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
`MAX_REST_MS` (2 h). That is a judgment, not an slskd limit: it keeps a policy from parking a peer,
which every album's fallback then passes over, for days. While the peer rests:

- the fallback **passes over** it as an alternate without using it up. If it is the only recorded
  alternate with the tracks, the fallback **waits** for the rest to end rather than searching;
- a network search ignores its responses;
- a same-peer `retry` of any of its other files waits until the rest ends.

**Come-back.** When the rest ends, the file is checked:

- **Delivered elsewhere:** if another peer has delivered the file, or is delivering it (same
  basename, the fallback's own rule), the failure closes as `covered`.
- **Nobody wants it:** if no open (`active`) protocol job has an item pointing at this exact file,
  it closes as `not-needed`. That covers every case: a released job is deleted, a cancelled or
  finished one is closed, and a fallback repoint moves the item to the alternate's file. Whether
  slskd still lists the file says nothing, because it keeps every transfer.
- **Otherwise:** it is re-enqueued on the same peer, and that retry counts toward `retriesSoFar`.

The check runs only when the rest ends, so an alternate copy that fails mid-rest does not cost the
come-back.

## While Soulseek is offline

The service takes the same `isSourceReady` the fallback uses (`SourceConnection.isReady`, logged in
= ready). While the source is offline it re-enqueues nothing: an enqueue then answers 500 and used
to burn an attempt anyway, and 44 of the 111 give-ups above fell within ±5 min of an outage.

A failure first seen while offline is **not put to the policy**. It gets one free retry (delay 0)
once the source is back, and that retry does not count toward `retriesSoFar`, because the outage,
not the peer, is its likely cause. A `shutdown` failure gets the same free retry, since slskd
restarting under the transfer says nothing about the peer.

**A refused enqueue** (the peer is offline, typically answered with a 500) counts as an attempt,
and is closed as `enqueue-failed`. slskd's record is left as it was, so the next sweep decides the
same failure again with the new `retriesSoFar`. The service no longer cancels the failed transfer
before re-enqueueing. That cancel was never needed, and when the enqueue was then refused it left
the file `Completed, Cancelled`, a state nothing retries.

## slskd on kpc (verified 2026-11-06)

What this service assumes about slskd, and how each point was checked:

| fact | evidence |
| --- | --- |
| kpc runs **slskd 0.25.1.0+7961741f**, the digest NicotinD's compose pins | `docker inspect` and the startup banner |
| Every failed transfer carries `exception` | live API, table above |
| slskd does not retry downloads itself: no `transfers.download.retry` (added in later releases), and no transfer has `nextAttemptAt` | 0.25.1 source and `/app/slskd.yml`; 0 of 8,080 listed |
| It keeps every transfer until something removes it: transfer retention defaults to `null`, and kpc sets only `retention.files.incomplete` | 0.25.1 `Options.cs`; 8,080 listed, 6,935 succeeded |
| A re-enqueue gets a new transfer id and supersedes the old record, so there is one record per peer and file | 190 of 190 files enqueued more than once in 7 days got a new id; 0 keys with two records; 0.25.1 `DownloadService.EnqueueAsync` |
| A retry starts from byte 0 | 0.25.1 enqueue sets `StartOffset = 0` |

If slskd is upgraded and its own retry is turned on, a transfer it will retry carries `nextAttemptAt`
in the future. This service leaves such a transfer alone until then, so two layers never retry one
transfer.

**Two gaps this does not close.** Both were measured on 2026-11-06 against the addon database
(read-only, counts only):

- **`Completed, Aborted`** (#28). There are 118 listed, all reading "the remote size of N does not
  match expected size N". The peer's file changed size after the search, and nothing retries an
  abort. **None of the 118 belongs to an open job**, so this is the fix for future aborts, not a
  backlog to recover.
- **`Completed, Cancelled`**. There are 270 listed. **Only 1** carries a retry row that was never
  given up, which is the signature of the removed cancel-then-refused-enqueue. The other 269 were
  never touched by this service, and none belongs to an open job.

The 88 `shutdown` failures all have a retry row and none is in an open job: the old reason-blind
retries already handled them. At the time only one protocol job was open, because core deletes a
job when it releases it, so almost everything slskd lists belongs to no one.

## The `transfer_attempts` ledger

There is one row per failure the service saw, looked up by `(transfer_key, transfer_id)`. A
re-enqueue creates a new slskd transfer id, so each retry's failure gets its own row. A refused
enqueue is the exception: the transfer id stays the same, and the failure gets a fresh row. Rows are
**kept after success**, unlike `transfer_retries`, which is deleted on success. That deletion was
why success-after-retry could not be measured. Rows are pruned after 90 days, and ended rests
hourly.

| column | meaning |
| --- | --- |
| `directory` | the folder (the album) the file belongs to |
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
- `not-needed`: deferred, and no open job wants the file any more.
- `enqueue-failed`: the re-enqueue was refused, and the failure is decided again.
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
