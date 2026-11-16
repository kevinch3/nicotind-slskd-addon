import { describe, expect, it } from "bun:test";
import { TransfersApi } from "./transfers.js";
import type { SlskdClient } from "../client.js";

/** A client whose download list takes a moment to arrive, and that counts the fetches. */
function countingClient() {
  const calls: string[] = [];
  let version = 0;
  const client = {
    request: async (path: string, options?: { method?: string }) => {
      const method = options?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (method !== "GET") {
        version++;
        return undefined;
      }
      const seen = version;
      await new Promise((r) => setTimeout(r, 10));
      return [{ username: `list-v${seen}`, directories: [] }];
    },
  } as unknown as SlskdClient;
  const gets = () =>
    calls.filter((c) => c === "GET /transfers/downloads").length;
  return { client, gets };
}

describe("TransfersApi.getDownloads (NicotinD#1137)", () => {
  it("shares one fetch between callers that ask at the same time", async () => {
    const { client, gets } = countingClient();
    const api = new TransfersApi(client);
    const lists = await Promise.all(
      Array.from({ length: 25 }, () => api.getDownloads()),
    );
    expect(gets()).toBe(1);
    expect(new Set(lists).size).toBe(1);
  });

  it("fetches again once the shared fetch has settled: nothing is cached", async () => {
    const { client, gets } = countingClient();
    const api = new TransfersApi(client);
    await api.getDownloads();
    await api.getDownloads();
    expect(gets()).toBe(2);
  });

  it("never hands a caller a list fetched before its own write", async () => {
    const { client, gets } = countingClient();
    const api = new TransfersApi(client);
    const before = api.getDownloads();
    await api.enqueue("peer", [{ filename: "a.flac", size: 1 }]);
    const after = api.getDownloads();
    expect((await before)[0]!.username).toBe("list-v0");
    expect((await after)[0]!.username).toBe("list-v1");
    expect(gets()).toBe(2);
  });

  it("a cancel and a bulk removal detach the fetch in progress too", async () => {
    for (const write of [
      (api: TransfersApi) => api.cancel("peer", "id-1", { remove: true }),
      (api: TransfersApi) => api.removeCompleted(),
    ]) {
      const { client, gets } = countingClient();
      const api = new TransfersApi(client);
      const before = api.getDownloads();
      await write(api);
      await api.getDownloads();
      await before;
      expect(gets()).toBe(2);
    }
  });

  it("a failed fetch is not remembered: the next caller tries again", async () => {
    let fail = true;
    const client = {
      request: async () => {
        if (fail) throw new Error("slskd down");
        return [];
      },
    } as unknown as SlskdClient;
    const api = new TransfersApi(client);
    await expect(api.getDownloads()).rejects.toThrow("slskd down");
    fail = false;
    expect(await api.getDownloads()).toEqual([]);
  });
});
