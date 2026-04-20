import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/leaderboard/my-rank?track=invite|writing
 *
 * 로그인한 유저의 본인 순위 + 점수 반환.
 * 비로그인 또는 집계 미포함 (예: 내부자) 시 { rank: null } 반환.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const track = searchParams.get('track')
  if (track !== 'invite' && track !== 'writing') {
    return NextResponse.json(
      { error: 'track must be "invite" or "writing"' },
      { status: 400 },
    )
  }

  // 1. 현재 유저 식별 (Authorization 헤더 우선, 쿠키 fallback)
  let userId: string | null = null
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const admin = getSupabaseAdmin()
    const { data: { user } } = await admin.auth.getUser(token)
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
    return NextResponse.json({ rank: null, reason: 'not_authenticated' })
  }

  const admin = getSupabaseAdmin()

  // 2. 전체 view 가져와서 순위 계산
  //    (뷰가 이미 정렬돼 있으므로 rank = index + 1)
  const viewName = track === 'invite' ? 'v_leaderboard_invite' : 'v_leaderboard_writing'
  const scoreColumn = track === 'invite' ? 'invite_count' : 'total_points'
  const tieBreakerColumn = track === 'invite' ? 'last_activated_at' : 'last_active_day'

  const { data: rows, error } = await admin
    .from(viewName)
    .select(`user_id, nickname, team_id, ${scoreColumn}, ${tieBreakerColumn}`)
    // view 내 ORDER BY 독립적으로 명시 정렬
    .order(scoreColumn, { ascending: false })
    .order(tieBreakerColumn, { ascending: true })

  if (error) {
    return NextResponse.json(
      { error: 'my-rank query failed', details: error.message },
      { status: 500 },
    )
  }

  const idx = (rows ?? []).findIndex((r: any) => r.user_id === userId)
  if (idx === -1) {
    return NextResponse.json({
      rank: null,
      reason: 'not_in_leaderboard', // 내부자 또는 집계 0건 유저
      total: rows?.length ?? 0,
    })
  }

  const self = rows![idx] as any
  return NextResponse.json(
    {
      rank: idx + 1,
      score: self[scoreColumn],
      nickname: self.nickname,
      team_id: self.team_id,
      total: rows!.length,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
