import type { SlskdUserTransferGroup } from "../types.js";
import type { SlskdClient } from "../client.js";

export class TransfersApi {
  constructor(private client: SlskdClient) {}

  /** The download list currently being fetched, shared by everyone who asks meanwhile. */
  private downloadsInFlight: Promise<SlskdUserTransferGroup[]> | null = null;

  /**
   * slskd's whole download list. Callers that ask while a fetch is already
   * under way share that fetch instead of starting their own.
   *
   * The list is every transfer slskd remembers, finished ones included: 12 MB
   * and 21,000 files on a long-running host. Six parts of the addon ask for it,
   * two of them once per active job, so a burst of jobs meant that many copies
   * being downloaded and parsed at once. Measured: 25 simultaneous fetches of a
   * 12 MB list took one process past 1 GB and it never came back; the same
   * list fetched one at a time stayed near 210 MB (NicotinD#1137).
   *
   * Nothing is cached once the fetch settles, and a write (`enqueue`, `cancel`,
   * `removeCompleted`) detaches the fetch in progress, so a caller that reads
   * after its own write never gets a list from before it.
   */
  async getDownloads(): Promise<SlskdUserTransferGroup[]> {
    if (this.downloadsInFlight) return this.downloadsInFlight;
    const fetching = this.client
      .request<SlskdUserTransferGroup[]>("/transfers/downloads")
      .finally(() => {
        if (this.downloadsInFlight === fetching) this.downloadsInFlight = null;
      });
    this.downloadsInFlight = fetching;
    return fetching;
  }

  /** After a write, the next reader must not be handed a list fetched before it. */
  private downloadsChanged(): void {
    this.downloadsInFlight = null;
  }

  async getUploads(): Promise<SlskdUserTransferGroup[]> {
    return this.client.request<SlskdUserTransferGroup[]>("/transfers/uploads");
  }

  async enqueue(
    username: string,
    files: Array<{ filename: string; size: number }>,
  ): Promise<void> {
    await this.client.request(
      `/transfers/downloads/${encodeURIComponent(username)}`,
      {
        method: "POST",
        body: JSON.stringify(files),
      },
    );
    this.downloadsChanged();
  }

  /**
   * Cancel a download. With `remove`, slskd also drops it from its transfer
   * list — without it the row lives on forever and only a local hide keeps it
   * off screen. slskd's `Remove` filters on `TransferStateCategories.Completed`
   * and silently no-ops otherwise, so a still-in-flight transfer may survive
   * the removal (its cancellation lands asynchronously); callers must treat
   * removal as best-effort and keep a local fallback.
   */
  async cancel(
    username: string,
    id: string,
    opts?: { remove?: boolean },
  ): Promise<void> {
    const query = opts?.remove ? "?remove=true" : "";
    await this.client.request(
      `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}${query}`,
      { method: "DELETE" },
    );
    this.downloadsChanged();
  }

  /**
   * Drop every completed download (succeeded, errored or cancelled) from
   * slskd's list in one call — the bulk equivalent of cancelling each with
   * `remove=true`, without the per-transfer round trips.
   */
  async removeCompleted(): Promise<void> {
    await this.client.request("/transfers/downloads/all/completed", {
      method: "DELETE",
    });
    this.downloadsChanged();
  }

  async cancelAll(): Promise<void> {
    const downloads = await this.getDownloads();

    const cancels: Promise<void>[] = [];
    for (const group of downloads) {
      for (const dir of group.directories) {
        for (const file of dir.files) {
          cancels.push(this.cancel(group.username, file.id).catch(() => {}));
        }
      }
    }

    await Promise.all(cancels);
  }
}
