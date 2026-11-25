import type { Slskd } from '@nicotind/slskd-client';

/** How long a cancelled search gets to reach `Completed*` before it is deleted anyway. */
export const RETIRE_WAIT_MS = 3_000;
const RETIRE_POLL_MS = 250;

/**
 * Delete a search only once slskd has finished it. Deleting one that is still
 * `InProgress` races slskd's own finalize, which then fails with "expected to
 * affect 1 row(s), but actually affected 0" (#23). An unfinished search is
 * cancelled (`PUT /searches/:id`) first, then deleted when it reports
 * `Completed*` or after {@link RETIRE_WAIT_MS}, whichever comes first.
 */
export async function retireSearch(
  slskd: Pick<Slskd, 'searches'>,
  id: string,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<void> {
  const waitMs = opts.waitMs ?? RETIRE_WAIT_MS;
  const pollMs = opts.pollMs ?? RETIRE_POLL_MS;
  const done = async () => {
    const s = await slskd.searches.get(id).catch(() => null);
    return !s || s.state.startsWith('Completed');
  };
  if (!(await done())) {
    await Promise.resolve()
      .then(() => slskd.searches.cancel(id))
      .catch(() => {});
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !(await done())) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  await Promise.resolve()
    .then(() => slskd.searches.delete(id))
    .catch(() => {});
}
