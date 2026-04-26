# Shorts Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand shorts sourcing from 10 official KBO channels to 200+ community channels via RSS, add player auto-tagging from titles, and separate shorts from long-form in official video feeds — all at zero API quota cost.

**Architecture:** New `channel_pool` table stores discovered channels. Existing `/api/cron/videos` route expands to fetch RSS from all active pool channels. New `player-tagger` module matches player names/aliases in titles. Frontend `HomeHighlights` switches from YouTube API to `videos` table queries. Official channel videos are split: shorts → shorts feed, long-form → official videos feed.

**Tech Stack:** Next.js 14 (App Router), Supabase (Postgres + RLS), Vercel Cron, TypeScript

**Spec:** `specs/shorts-aggregator.md`

---

### Task 1: `channel_pool` migration

**Files:**
- Create: `supabase/migrations/20260426_channel_pool.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Shorts Aggregator: channel_pool for community channel discovery
-- Spec: specs/shorts-aggregator.md Phase 1

create table if not exists channel_pool (
  channel_id text primary key,
  channel_name text not null,
  tier int not null default 3
    check (tier between 1 and 4),
  subscriber_count int,
  is_active boolean not null default true,
  team_affinity text[],
  last_video_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table channel_pool is '숏츠 소싱용 YouTube 채널 풀 — 공식+비공식 통합';
comment on column channel_pool.tier is '1=방송사, 2=인기유튜버, 3=팬채널, 4=기타';
comment on column channel_pool.team_affinity is '연관 팀 shortName 배열 (nullable=범용)';

-- 활성 채널 조회용
create index if not exists idx_channel_pool_active
  on channel_pool(is_active, tier)
  where is_active = true;

-- RLS: 공개 읽기, 서비스 롤만 쓰기
alter table channel_pool enable row level security;

create policy "channel_pool_public_read"
  on channel_pool for select using (true);

create policy "channel_pool_service_write"
  on channel_pool for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
```

- [ ] **Step 2: Apply migration locally**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && npx supabase db push`
Expected: Migration applied, `channel_pool` table created

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260426_channel_pool.sql
git commit -m "feat(db): add channel_pool table for shorts aggregator"
```

---

### Task 2: Add `community_short` and `community_long` source types

**Files:**
- Modify: `supabase/migrations/20260426_channel_pool.sql` (append ALTER)
- Modify: `src/lib/video/videos-repo.ts:9-13`

- [ ] **Step 1: Extend the DB constraint**

Append to the migration file:

```sql
-- Extend videos.source_type to include community types
alter table videos drop constraint if exists videos_source_type_check;
alter table videos add constraint videos_source_type_check
  check (source_type in (
    'official_long', 'official_short',
    'player', 'team_search',
    'community_short', 'community_long'
  ));
```

- [ ] **Step 2: Update TypeScript type**

In `src/lib/video/videos-repo.ts`, change:

```typescript
export type VideoSourceType =
  | "official_long"
  | "official_short"
  | "player"
  | "team_search"
  | "community_short"
  | "community_long";
```

- [ ] **Step 3: Apply migration**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && npx supabase db push`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260426_channel_pool.sql src/lib/video/videos-repo.ts
git commit -m "feat(db): extend source_type with community_short/community_long"
```

---

### Task 3: `videos` table — add `player_ids` array column

**Files:**
- Create: `supabase/migrations/20260426_videos_player_ids.sql`
- Modify: `src/lib/video/videos-repo.ts`

- [ ] **Step 1: Write migration**

```sql
-- Add player_ids array for multi-player tagging
-- Existing player_id (single) remains for backwards compat with videos-shorts cron
alter table videos add column if not exists player_ids text[] default '{}';

-- Index for array contains queries (@>)
create index if not exists idx_videos_player_ids
  on videos using gin (player_ids)
  where array_length(player_ids, 1) > 0;
```

- [ ] **Step 2: Update VideoUpsertRow type**

In `src/lib/video/videos-repo.ts`, add to the `VideoUpsertRow` interface after `player_id`:

```typescript
  player_ids?: string[];
```

And in the `upsertVideos` function payload mapping, add:

```typescript
    player_ids: r.player_ids ?? [],
```

- [ ] **Step 3: Apply and commit**

```bash
cd /Users/harinclaw/Projects/kbo-everyday
npx supabase db push
git add supabase/migrations/20260426_videos_player_ids.sql src/lib/video/videos-repo.ts
git commit -m "feat(db): add player_ids array column to videos"
```

---

### Task 4: Player auto-tagger module

**Files:**
- Create: `src/lib/video/player-tagger.ts`

- [ ] **Step 1: Create the tagger module**

```typescript
/**
 * 영상 제목/설명에서 선수명·별명 매칭 → player_ids 반환
 * Shorts Aggregator Phase 3
 */

export interface PlayerAlias {
  kbo_id: string;
  name: string;
  team: string;
  aliases: string[]; // 별명/약칭
}

/** 선수 사전 로드 (Supabase players_roster 기반) */
export async function loadPlayerAliases(
  supabase: { from: (t: string) => any },
): Promise<PlayerAlias[]> {
  const { data } = await supabase
    .from("players_roster")
    .select("kbo_id, name, team, aliases")
    .not("kbo_id", "is", null);

  if (!data) return [];

  return data.map((r: any) => ({
    kbo_id: r.kbo_id,
    name: r.name,
    team: r.team,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
  }));
}

/**
 * 텍스트에서 매칭되는 player kbo_ids 반환
 * 이름 + aliases 모두 체크, 2글자 이상만 매칭 (노이즈 방지)
 */
export function matchPlayers(
  text: string,
  players: PlayerAlias[],
): string[] {
  const matched: string[] = [];

  for (const p of players) {
    const names = [p.name, ...p.aliases].filter((n) => n.length >= 2);
    for (const name of names) {
      if (text.includes(name)) {
        matched.push(p.kbo_id);
        break; // 같은 선수 중복 방지
      }
    }
  }

  return matched;
}
```

- [ ] **Step 2: Check if `aliases` column exists in players_roster**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && grep -r "aliases" supabase/migrations/ --include="*.sql" | head -5`

If no `aliases` column exists, create a migration:

```sql
-- Player aliases for auto-tagging
alter table players_roster add column if not exists aliases text[] default '{}';
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/video/player-tagger.ts supabase/migrations/20260426_player_aliases.sql
git commit -m "feat: add player auto-tagger module for shorts aggregator"
```

---

### Task 5: Seed initial channel pool

**Files:**
- Create: `scripts/seed-channel-pool.ts`

This is a 1-time script to populate `channel_pool` with known KBO YouTube channels. Uses hardcoded list (no API quota needed).

- [ ] **Step 1: Create seed script**

```typescript
/**
 * 1회성 채널 풀 시딩 — 알려진 KBO 야구 채널 등록
 * Usage: npx tsx scripts/seed-channel-pool.ts
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface ChannelSeed {
  channel_id: string;
  channel_name: string;
  tier: number;
  team_affinity: string[] | null;
}

// 10개 구단 공식 채널 (tier 1)
const OFFICIAL: ChannelSeed[] = [
  { channel_id: "UCL6QZZxb-HR4hCh_eFAnQWA", channel_name: "LG Twins", tier: 1, team_affinity: ["LG"] },
  { channel_id: "UCsebzRfMhwYfjeBIxNX1brg", channel_name: "두산 베어스", tier: 1, team_affinity: ["두산"] },
  { channel_id: "UCvScyjGkBUx2CJDMNAi9Twg", channel_name: "kt wiz", tier: 1, team_affinity: ["KT"] },
  { channel_id: "UCt8iRtgjVqm5rJHNl1TUojg", channel_name: "SSG 랜더스", tier: 1, team_affinity: ["SSG"] },
  { channel_id: "UC8_FRgynMX8wlGsU6Jh3zKg", channel_name: "NC 다이노스", tier: 1, team_affinity: ["NC"] },
  { channel_id: "UCKp8knO8a6tSI1oaLjfd9XA", channel_name: "KIA 타이거즈", tier: 1, team_affinity: ["KIA"] },
  { channel_id: "UCAZQZdSY5_YrziMPqXi-Zfw", channel_name: "롯데 자이언츠", tier: 1, team_affinity: ["롯데"] },
  { channel_id: "UCMWAku3a3h65QpLm63Jf2pw", channel_name: "삼성 라이온즈", tier: 1, team_affinity: ["삼성"] },
  { channel_id: "UCdq4Ji3772xudYRUatdzRrg", channel_name: "한화 이글스", tier: 1, team_affinity: ["한화"] },
  { channel_id: "UC_MA8-XEaVmvyayPzG66IKg", channel_name: "키움 히어로즈", tier: 1, team_affinity: ["키움"] },
];

// 방송사 채널 (tier 1)
const BROADCASTERS: ChannelSeed[] = [
  { channel_id: "UCBkyj16n2snkRg1BAzpovXQ", channel_name: "SPOTV", tier: 1, team_affinity: null },
  { channel_id: "UC4_RQ-L9bVHil4k-VurjN3A", channel_name: "MBC SPORTS+", tier: 1, team_affinity: null },
  { channel_id: "UCfV1GS_1HaDFD8fV5YmUvUA", channel_name: "SBS Sports", tier: 1, team_affinity: null },
];

// 인기 야구 유튜버 (tier 2) — 수동 확인된 채널만
// NOTE: channel_id는 실행 전 YouTube에서 확인 필요. 아래는 플레이스홀더가 아니라
// 실제 채널이지만, 이동/삭제 가능성이 있으므로 시딩 후 RSS 테스트 권장.
const YOUTUBERS: ChannelSeed[] = [
  // 아래 channel_id들은 seed 실행 전 확인 필요 — Task 5 Step 2에서 검증
];

// 팬채널/밈채널 (tier 3) — 추후 YouTube search로 발굴 후 추가
const FAN_CHANNELS: ChannelSeed[] = [];

const ALL_CHANNELS = [...OFFICIAL, ...BROADCASTERS, ...YOUTUBERS, ...FAN_CHANNELS];

async function main() {
  console.log(`Seeding ${ALL_CHANNELS.length} channels...`);

  const { error } = await supabase
    .from("channel_pool")
    .upsert(
      ALL_CHANNELS.map((c) => ({
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        tier: c.tier,
        team_affinity: c.team_affinity,
        is_active: true,
      })),
      { onConflict: "channel_id" },
    );

  if (error) {
    console.error("Seed error:", error.message);
    process.exit(1);
  }

  console.log(`Done. ${ALL_CHANNELS.length} channels upserted.`);
}

main();
```

- [ ] **Step 2: Discover and add community channel IDs**

Run YouTube searches manually or via a 1-time API call to find channel IDs for known channels:
- 크보톡, 1분크보, 야구왕, 끝까지간다, 생야구, 독수리약사_독약TV, 제욱볶음, 그냥만드는거좋아함, 엘트, 아린

For each: go to `https://www.youtube.com/@channelname` → view source → search `channelId` → add to `YOUTUBERS` array.

Alternatively, use 1 API call: `search.list?q=크보+숏츠&type=channel&maxResults=50` to batch-discover.

- [ ] **Step 3: Run seed script**

```bash
cd /Users/harinclaw/Projects/kbo-everyday
npx tsx scripts/seed-channel-pool.ts
```

Expected: `Done. N channels upserted.`

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-channel-pool.ts
git commit -m "feat: add channel pool seed script with official + broadcaster channels"
```

---

### Task 6: Expand RSS cron to fetch from `channel_pool`

**Files:**
- Modify: `src/app/api/cron/videos/route.ts`
- Modify: `src/lib/video/team-channels.ts`

- [ ] **Step 1: Add channel pool loader**

Add to `src/lib/video/team-channels.ts`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PoolChannel {
  channel_id: string;
  channel_name: string;
  tier: number;
  team_affinity: string[] | null;
}

/** Load active channels from channel_pool */
export async function getActiveChannels(
  supabase: SupabaseClient,
): Promise<PoolChannel[]> {
  const { data } = await supabase
    .from("channel_pool")
    .select("channel_id, channel_name, tier, team_affinity")
    .eq("is_active", true)
    .order("tier", { ascending: true });
  return data ?? [];
}
```

- [ ] **Step 2: Rewrite the cron to use channel_pool**

Replace the main loop in `src/app/api/cron/videos/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { OFFICIAL_CHANNEL_IDS } from "@/lib/video/team-channels";
import { getActiveChannels } from "@/lib/video/team-channels";
import { fetchChannelRss } from "@/lib/video/rss-parser";
import {
  extractNoiseFlags,
  isShortCandidate,
} from "@/lib/video/noise-flags";
import { upsertVideos, type VideoUpsertRow } from "@/lib/video/videos-repo";
import { loadPlayerAliases, matchPlayers } from "@/lib/video/player-tagger";

const CRON_SECRET = process.env.CRON_SECRET || "";
const CONCURRENCY = 10;

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("videos-rss");

  // Load channel pool + player aliases in parallel
  const [channels, playerAliases] = await Promise.all([
    getActiveChannels(supabaseAdmin),
    loadPlayerAliases(supabaseAdmin),
  ]);

  if (channels.length === 0) {
    await finishJob(logId, "error", undefined, "No active channels in channel_pool");
    return NextResponse.json({ error: "No channels" }, { status: 500 });
  }

  const results: Record<string, number> = {};
  const errors: Record<string, string> = {};
  let totalUpserted = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (ch) => {
        const entries = await fetchChannelRss(ch.channel_id);
        const isOfficial = OFFICIAL_CHANNEL_IDS.has(ch.channel_id);
        // Use first team_affinity or "ETC" for non-affiliated channels
        const teamId = ch.team_affinity?.[0] ?? "ETC";

        const rows: VideoUpsertRow[] = entries.map((e) => {
          const noiseFlags = extractNoiseFlags(e.title, e.channel);
          const isShort = isShortCandidate({ title: e.title });
          const playerIds = matchPlayers(e.title, playerAliases);

          let sourceType: VideoUpsertRow["source_type"];
          if (isOfficial) {
            sourceType = isShort ? "official_short" : "official_long";
          } else {
            sourceType = isShort ? "community_short" : "community_long";
          }

          return {
            video_id: e.video_id,
            team_id: teamId,
            player_id: playerIds[0] ?? null,
            player_ids: playerIds,
            title: e.title,
            channel: e.channel,
            channel_id: e.channel_id,
            thumbnail: e.thumbnail,
            published_at: e.published_at,
            duration_seconds: null,
            source_type: sourceType,
            is_short_candidate: isShort,
            noise_flags: noiseFlags,
          };
        });

        return { channelName: ch.channel_name, rows };
      }),
    );

    for (const result of settled) {
      if (result.status === "rejected") {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors[`batch_${i}`] = msg;
        continue;
      }
      const { channelName, rows } = result.value;
      const { upserted, error } = await upsertVideos(supabaseAdmin, rows);
      if (error) {
        errors[channelName] = error;
      } else {
        results[channelName] = upserted;
        totalUpserted += upserted;
      }
    }
  }

  // Update last_video_at for channels that had results
  const channelsWithVideos = Object.keys(results);
  if (channelsWithVideos.length > 0) {
    await supabaseAdmin
      .from("channel_pool")
      .update({ last_video_at: new Date().toISOString() })
      .in("channel_name", channelsWithVideos);
  }

  const errorCount = Object.keys(errors).length;
  const status: "success" | "error" = errorCount === 0 ? "success" : "error";
  const summary = `channels=${channels.length} upserted=${totalUpserted} ok=${Object.keys(results).length} err=${errorCount}`;

  await finishJob(logId, status, summary, errorCount > 0 ? JSON.stringify(errors).slice(0, 900) : undefined);

  return NextResponse.json({
    ok: errorCount === 0,
    status,
    channelsTotal: channels.length,
    totalUpserted,
    errorCount,
    errors: errorCount > 0 ? errors : undefined,
  });
}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && npx next build 2>&1 | tail -20`
Expected: Build succeeds, no type errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/videos/route.ts src/lib/video/team-channels.ts
git commit -m "feat: expand RSS cron to fetch from channel_pool (official + community)"
```

---

### Task 7: Shorts feed API — switch from YouTube API to `videos` table

**Files:**
- Create: `src/app/api/shorts-feed/route.ts`

This is B안 Phase 2 for the shorts section: read from `videos` table instead of calling YouTube API at runtime.

- [ ] **Step 1: Create the new API route**

```typescript
/**
 * Shorts feed API — serves shorts from videos table (quota 0)
 * Replaces runtime YouTube API calls for the shorts carousel
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET(req: NextRequest) {
  const team = req.nextUrl.searchParams.get("team") || "_ALL";
  const playerIdsParam = req.nextUrl.searchParams.get("player_ids") || "";
  const playerIds = playerIdsParam
    ? playerIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") || "30", 10),
    50,
  );

  // Query: shorts only, exclude noisy content
  let query = supabaseAdmin
    .from("videos")
    .select("video_id, title, thumbnail, channel, channel_id, published_at, source_type, player_id, player_ids")
    .eq("is_short_candidate", true)
    .not("noise_flags", "cs", '["highlight_compilation"]')
    .not("noise_flags", "cs", '["fancam"]')
    .not("noise_flags", "cs", '["vlog"]')
    .not("noise_flags", "cs", '["ceremony"]')
    .not("noise_flags", "cs", '["preview"]')
    .order("published_at", { ascending: false })
    .limit(limit * 2); // fetch extra for diversity filtering

  if (team !== "_ALL") {
    query = query.eq("team_id", team);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items = (data ?? []).map((v) => ({
    id: v.video_id,
    title: v.title,
    thumbnail: v.thumbnail,
    channel: v.channel,
    publishedAt: v.published_at,
    sourceType: v.source_type,
    playerId: v.player_id,
    playerIds: v.player_ids,
  }));

  // Sort: favorite player matches first, then recency
  const playerIdSet = new Set(playerIds);
  items.sort((a, b) => {
    const aMatch = a.playerIds?.some((id: string) => playerIdSet.has(id)) ? 1 : 0;
    const bMatch = b.playerIds?.some((id: string) => playerIdSet.has(id)) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  // Diversity: max 3 consecutive from same channel
  const diversified: typeof items = [];
  const channelStreak = new Map<string, number>();

  for (const item of items) {
    if (diversified.length >= limit) break;
    const ch = item.channel ?? "unknown";
    const streak = channelStreak.get(ch) ?? 0;
    if (streak >= 3) continue;
    channelStreak.set(ch, streak + 1);
    // Reset other channels' streaks when adding
    for (const [k] of channelStreak) {
      if (k !== ch) channelStreak.set(k, 0);
    }
    diversified.push(item);
  }

  return NextResponse.json(
    { items: diversified },
    {
      headers: {
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=60",
      },
    },
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && npx next build 2>&1 | tail -20`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/shorts-feed/route.ts
git commit -m "feat: add /api/shorts-feed — serves shorts from videos table (quota 0)"
```

---

### Task 8: Frontend — switch `HomeHighlights` to `shorts-feed` API

**Files:**
- Modify: `src/components/home/HomeHighlights.tsx`

- [ ] **Step 1: Update the data fetching**

Replace the `useEffect` fetch logic in `HomeHighlights.tsx`:

```typescript
  useEffect(() => {
    if (!team) { setLoading(false); return; }

    const favPlayers = getFavoritePlayers().slice(0, 5);
    // Use kbo_id for player matching (not names — server does name matching at cron time)
    const playerIdsParam = favPlayers.length > 0
      ? `&player_ids=${encodeURIComponent(favPlayers.map(p => p.kboId).join(","))}`
      : "";

    fetch(`/api/shorts-feed?team=${encodeURIComponent(team)}${playerIdsParam}`)
      .then(r => r.json())
      .then((data) => {
        const items: VideoItem[] = (data.items || []).map((v: any) => ({
          id: v.id,
          title: v.title,
          thumbnail: v.thumbnail,
          channel: v.channel,
          publishedAt: v.publishedAt,
          label: v.sourceType?.startsWith("official") ? team : v.channel,
        }));
        setVideos(items);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [team]);
```

- [ ] **Step 2: Verify the label rendering still works**

Check that the `label` badge in the JSX still renders correctly — it should show team name for official, channel name for community.

- [ ] **Step 3: Verify build**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && npx next build 2>&1 | tail -20`

- [ ] **Step 4: Commit**

```bash
git add src/components/home/HomeHighlights.tsx
git commit -m "feat: switch HomeHighlights to shorts-feed API (quota 0 runtime)"
```

---

### Task 9: Increase cron frequency in `vercel.json`

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Check current cron config**

Run: `cd /Users/harinclaw/Projects/kbo-everyday && cat vercel.json | grep -A5 cron`

- [ ] **Step 2: Update videos cron to run more frequently**

Change the `/api/cron/videos` schedule from `15 */6 * * *` (every 6h) to `*/30 * * * *` (every 30 min) or the closest allowed by the Vercel plan.

Note: Vercel Pro allows 10 crons, Hobby allows 2 with daily frequency only. If on Hobby, keep the 6h schedule and note this as a future upgrade.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "chore: increase videos cron frequency for shorts aggregator"
```

---

### Summary: Implementation Order

| Task | Description | Quota Cost | Dependencies |
|------|-------------|------------|--------------|
| 1 | `channel_pool` migration | 0 | none |
| 2 | Extend `source_type` | 0 | Task 1 |
| 3 | Add `player_ids` column | 0 | none |
| 4 | Player tagger module | 0 | none |
| 5 | Seed channel pool | 0 (hardcoded) | Task 1 |
| 6 | Expand RSS cron | 0 | Tasks 1-5 |
| 7 | Shorts feed API | 0 | Task 3, 6 |
| 8 | Frontend switch | 0 | Task 7 |
| 9 | Increase cron frequency | 0 | Task 6 |

Tasks 1, 3, 4 can run in parallel. Task 5 depends on 1. Task 6 depends on all prior. Tasks 7-9 are sequential after 6.
