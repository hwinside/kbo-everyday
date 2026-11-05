import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { isCanonicalKboGameId } from '@/lib/game/game-id';
import { isCollectorRequest, snapshotReadsEnabled, snapshotReadScopeIncludes } from './collector-request';
import { RELAY_DEGRADED_HEADER } from './relay-degraded-header';
export type SnapshotChannel = 'relay' | 'events' | 'live' | 'detail';
export interface DeliverySnapshot {
  game_id: string; channel: SnapshotChannel; payload: Record<string, unknown>;
  observed_at: string; final_seen_at?: string | null; archived_at?: string | null;
}
const FRESH_MS: Record<SnapshotChannel, number> = { relay: 15_000, events: 20_000, live: 20_000, detail: 40_000 };
export function snapshotResponse(row: DeliverySnapshot, now = Date.now()): NextResponse {
  const time = Date.parse(row.observed_at);
  if (!Number.isFinite(time) || time > now + 30_000 || !row.payload || Array.isArray(row.payload)) {
    return NextResponse.json({ error: 'snapshot_invalid' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const degraded = !row.archived_at && now - time > FRESH_MS[row.channel];
  const body = { ...row.payload, snapshotObservedAt: row.observed_at, degraded, archived: Boolean(row.archived_at),
    ...(row.channel === 'relay' ? { updatedAt: row.observed_at } : {}) };
  return NextResponse.json(body, { headers: {
    'Cache-Control': 'no-store', 'X-Game-Snapshot': 'stored',
    ...(degraded && row.channel === 'relay' ? { [RELAY_DEGRADED_HEADER]: '1' } : {}),
  } });
}
/** null means feature off/internal collection; enabled public requests NEVER fetch upstream. */
export async function serveDeliverySnapshot(req: NextRequest, channel: SnapshotChannel, key: string): Promise<NextResponse | null> {
  if (!snapshotReadsEnabled() || isCollectorRequest(req)) return null;
  const dateOnly = channel === 'live' && /^\d{8}$/.test(key);
  if (!dateOnly && !isCanonicalKboGameId(key)) {
    return NextResponse.json({ error: 'invalid gameId' }, { status: 400 });
  }
  if (!snapshotReadScopeIncludes(key)) return null;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(900)]);
  try {
    let query = getSupabaseAdmin().from('game_delivery_snapshots')
      .select('game_id,channel,payload,observed_at,final_seen_at,archived_at').eq('channel', channel);
    if (dateOnly) {
      // At most the current day's slate; index starts with canonical game_id.
      query = query.gte('game_id', key).lt('game_id', `${key}Z`).order('observed_at', { ascending: false });
    } else query = query.eq('game_id', key);
    const { data, error } = await query.limit(1).abortSignal(signal).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'snapshot_pending', state: 'pending', channel },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
    return snapshotResponse(data as DeliverySnapshot);
  } catch {
    return NextResponse.json({ error: 'snapshot_store_unavailable', channel },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
  }
}
