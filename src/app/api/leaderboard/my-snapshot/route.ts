import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { verifyAccessToken } from '@/lib/auth/verified-user'

export const dynamic = 'force-dynamic'

/**
 * GET /api/leaderboard/my-snapshot
 *
 * 이벤트 종료 후 동결된 최종 순위(event_leaderboard_snapshot)에서
 * 로그인 유저 본인의 초대/글쓰기 트랙 순위를 반환.
 *
 * - 라이브 뷰가 아니라 박제된 스냅샷을 읽는다 (컷오프 2026-05-31 24:00 KST).
 * - 상품 매핑(getPrizeTierByRank)은 클라이언트가 SSOT(prizes.ts)로 수행.
 * - 비로그인 또는 양 트랙 모두 미포함 시 entries 빈 배열.
 */
export async function GET(request: NextRequest) {
  // 1. 현재 유저 식별 (Authorization 헤더 우선, 쿠키 fallback) — my-rank 와 동일 패턴
  let userId: string | null = null
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const user = await verifyAccessToken(token)
    userId = user?.id ?? null
  }
  if (!userId) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      },
    )
    const { data: { user } } = await supabase.auth.getUser()
    userId = user?.id ?? null
  }

  if (!userId) {
    return NextResponse.json({ entries: [], reason: 'not_authenticated' })
  }

  const admin = getSupabaseAdmin()

  // 2. 본인 스냅샷 행 + 트랙별 총 인원
  const { data: myRows, error } = await admin
    .from('event_leaderboard_snapshot')
    .select('track, rank, score, nickname, cutoff_at')
    .eq('user_id', userId)

  if (error) {
    return NextResponse.json(
      { error: 'my-snapshot query failed', details: error.message },
      { status: 500 },
    )
  }

  const { data: counts } = await admin
    .from('event_leaderboard_snapshot')
    .select('track')

  const totalByTrack: Record<string, number> = {}
  for (const row of counts ?? []) {
    totalByTrack[row.track] = (totalByTrack[row.track] ?? 0) + 1
  }

  const entries = (myRows ?? []).map((r) => ({
    track: r.track as 'invite' | 'writing',
    rank: r.rank as number,
    score: r.score as number,
    total: totalByTrack[r.track] ?? 0,
  }))

  return NextResponse.json(
    { entries, cutoffAt: myRows?.[0]?.cutoff_at ?? null },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
