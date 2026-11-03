import type { NextRequest } from 'next/server';
// Process-local object capability. HTTP headers/hostnames cannot impersonate a collector.
const collectors = new WeakSet<NextRequest>();
export function markCollectorRequest(request: NextRequest): NextRequest {
  collectors.add(request);
  return request;
}
export function isCollectorRequest(request: NextRequest): boolean { return collectors.has(request); }
export function snapshotWritesEnabled(): boolean { return process.env.GAME_SNAPSHOT_WRITE_ENABLED === '1'; }
export function snapshotReadsEnabled(): boolean {
  return snapshotWritesEnabled() && process.env.GAME_SNAPSHOT_READ_ENABLED === '1';
}

/** Explicit staged rollout scope: old games/no-game dates retain their existing path. */
export function snapshotReadScopeIncludes(key: string): boolean {
  const ids = (process.env.GAME_SNAPSHOT_GAME_IDS ?? '').split(',').map(s => s.trim())
    .filter(s => /^\d{8}[A-Z]{4}\d$/.test(s));
  return ids.includes(key) || (/^\d{8}$/.test(key) && ids.some(id => id.startsWith(key)));
}
