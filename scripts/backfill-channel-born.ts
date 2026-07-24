/**
 * channel_born 마킹 백필 (1회성 — 2026-07-24 WOHT0 마킹 소실 사고 구제).
 *
 * 대상: live_activity_started_users에서 channel_born_* null인데, 같은 (game_id,
 * user_id)에 *현재 active 채널과 정확 일치*하는 네이티브 채널 ACK
 * (live_activity_channel_subscriptions)가 있는 행. ACK = 단말이 그 채널에 실제
 * 부착됨 증명이므로, p2s 발송 성공 서버 기록(channel_born)보다 강한 증거 — 그
 * (environment, channel_id)로 재마킹해도 isLiveBornChannel 세대 일치 계약을 위반하지
 * 않는다. ACK 없는 누락 행은 건드리지 않음(보수적 — 종전대로 gap 집계).
 *
 * 안전장치:
 *   - 기본 dry-run(대상 집계 출력만). 실제 쓰기는 `--apply` (머지 승인 후에만 실행).
 *   - 이미 마킹된 행은 미변경(.is null 필터). 유저별 ACK가 복수 env면 production 우선.
 *
 * 실행:
 *   npx tsx --env-file=.env.local scripts/backfill-channel-born.ts 20260724WOHT0           # dry-run
 *   npx tsx --env-file=.env.local scripts/backfill-channel-born.ts 20260724WOHT0 --apply   # 백필
 */
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");
const gameIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (gameIds.length === 0) {
  console.error("usage: backfill-channel-born.ts <game_id...> [--apply]");
  process.exit(1);
}

const PAGE = 1000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

(async () => {
  for (const gameId of gameIds) {
    // 현재 active 채널 — stale ACK(교체 전 구채널) 배제 기준.
    // query-guard: bounded -- 경기당 active 채널은 env(production/sandbox)별 1행 ≤2행, 상한 명시.
    const { data: chans, error: chanErr } = await supabase
      .from("live_activity_channels")
      .select("environment, channel_id")
      .eq("game_id", gameId)
      .eq("status", "active")
      .limit(10);
    if (chanErr) throw new Error(chanErr.message);
    const activeByEnv = new Map((chans ?? []).map((c) => [c.environment as string, c.channel_id as string]));
    if (activeByEnv.size === 0) {
      console.log(`${gameId}: active 채널 없음 — skip (채널 종료 후엔 백필 무의미)`);
      continue;
    }

    // 마킹 누락 카드.
    const unmarked = await fetchAll<{ user_id: string }>((from, to) =>
      // query-guard: bounded-page -- fetchAll 30페이지×1000행 상한 + PK(game_id,user_id) 안정 정렬 페이지
      supabase
        .from("live_activity_started_users")
        .select("user_id")
        .eq("game_id", gameId)
        .is("channel_born_channel_id", null)
        // PK(game_id, user_id) 전체 순서 고정 — 부분 순서 range는 page 누락/중복 위험(삼순 R1).
        .order("game_id", { ascending: true })
        .order("user_id", { ascending: true })
        .range(from, to),
    );

    // 유효(active 채널 일치) 네이티브 ACK — user → env (production 우선).
    const subs = await fetchAll<{ user_id: string | null; environment: string; channel_id: string }>((from, to) =>
      // query-guard: bounded-page -- fetchAll 30페이지×1000행 상한 + PK(game_id,environment,channel_id,device_key) 안정 정렬 페이지
      supabase
        .from("live_activity_channel_subscriptions")
        .select("user_id, environment, channel_id")
        .eq("game_id", gameId)
        // PK(game_id, environment, channel_id, device_key) 전체 순서 고정 — 같은 device_key가
        // env/구채널별로 중복 존재 가능해 device_key 단독 순서는 비결정적(삼순 R1).
        .order("game_id", { ascending: true })
        .order("environment", { ascending: true })
        .order("channel_id", { ascending: true })
        .order("device_key", { ascending: true })
        .range(from, to),
    );
    const ackEnvByUser = new Map<string, string>();
    for (const s of subs) {
      if (!s.user_id) continue;
      if (activeByEnv.get(s.environment) !== s.channel_id) continue; // 구채널 ACK 배제
      const prev = ackEnvByUser.get(s.user_id);
      if (!prev || (prev !== "production" && s.environment === "production")) {
        ackEnvByUser.set(s.user_id, s.environment);
      }
    }

    // env별 백필 대상 = 마킹 누락 ∩ 유효 ACK.
    const targetsByEnv = new Map<string, string[]>();
    for (const row of unmarked) {
      const env = ackEnvByUser.get(row.user_id);
      if (!env) continue;
      if (!targetsByEnv.has(env)) targetsByEnv.set(env, []);
      targetsByEnv.get(env)!.push(row.user_id);
    }
    const total = [...targetsByEnv.values()].reduce((n, u) => n + u.length, 0);
    console.log(
      `${gameId}: 마킹누락 ${unmarked.length} / 유효ACK보유 ${ackEnvByUser.size} → 백필 대상 ${total}` +
        [...targetsByEnv.entries()].map(([e, u]) => ` [${e}: ${u.length}]`).join(""),
    );

    if (!APPLY) continue;
    for (const [env, userIds] of targetsByEnv) {
      const channelId = activeByEnv.get(env)!;
      for (let i = 0; i < userIds.length; i += 200) {
        const slice = userIds.slice(i, i + 200);
        const { error } = await supabase
          .from("live_activity_started_users")
          .update({ channel_born_environment: env, channel_born_channel_id: channelId })
          .eq("game_id", gameId)
          .is("channel_born_channel_id", null) // 경합 보호 — 그 사이 마킹된 행 미변경
          .in("user_id", slice);
        if (error) throw new Error(`apply failed (env=${env} batch=${i / 200}): ${error.message}`);
        console.log(`  applied env=${env} batch=${i / 200} users=${slice.length}`);
      }
    }
  }
  console.log(APPLY ? "\n백필 완료" : "\ndry-run — 쓰기 없음 (--apply로 실행)");
})().catch((e) => {
  console.error("backfill crashed:", e);
  process.exit(1);
});
