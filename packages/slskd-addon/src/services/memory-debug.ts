import { heapStats } from 'bun:jsc';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface MemoryReport {
  /** Resident set size of the whole process, bytes. */
  rss: number;
  /** JavaScript heap in use, bytes. */
  heapSize: number;
  /** Memory the engine attributes to JS objects but holds outside the heap (buffers, strings), bytes. */
  extraMemorySize: number;
  objectCount: number;
  /** The most numerous object types, largest first. */
  topTypes: Array<[type: string, count: number]>;
}

/**
 * What this process holds, from the inside (NicotinD#1137: the container gains
 * ~15 MiB a minute with no input that explains it). `rss` far above `heapSize`
 * points at native memory; a `topTypes` count that climbs between two reports
 * names the JavaScript objects piling up.
 */
export function memoryReport(
  top = 30,
  stats: ReturnType<typeof heapStats> = heapStats(),
  usage: { rss: number } = process.memoryUsage(),
): MemoryReport {
  const topTypes = Object.entries(stats.objectTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top);
  return {
    rss: usage.rss,
    heapSize: stats.heapSize,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
    topTypes,
  };
}

/**
 * Write a V8-format heap snapshot (opens in Chrome DevTools' Memory tab) and
 * return its path. A snapshot of a large heap is itself large: take it while
 * the process is well under its memory cap.
 */
export async function writeHeapSnapshot(dir: string, now: Date = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `heap-${now.toISOString().replace(/[:.]/g, '-')}.heapsnapshot`);
  await Bun.write(path, Bun.generateHeapSnapshot('v8'));
  return path;
}
