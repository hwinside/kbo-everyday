import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * GET /api/leaderboard/my-rank?track=invite|writing[&month=YYYY-MM]
 *
 * 로그인한 유저의 본인 순위 + 점수 반환.
 * 비로그인 또는 집계 미포함 (예: 내부자) 시 { rank: null } 반환.
 *
 * - month 지정 시(writing 트랙만) 월별 뷰(v_leaderboard_writing_monthly) 기준.
 * - month 생략 시 누적(lifetime) 기존 동작 유지.
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

  const month = searchParams.get('month')
  if (month !== null && !MONTH_RE.test(month)) {
    return NextResponse.json(
      { error: 'month must be YYYY-MM' },
      { status: 400 },
    )
  }
  // month 는 writing 트랙 월별 랭킹용. 지정 시에만 월별 뷰로 분기.
  const useMonthly = track === 'writing' && month !== null

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
  let viewName: string
  let scoreColumn: string
  const tieBreakerColumn = track === 'invite' ? 'last_activated_at' : 'last_active_day'
  if (track === 'invite') {
    viewName = 'v_leaderboard_invite'
    scoreColumn = 'invite_count'
  } else if (useMonthly) {
    viewName = 'v_leaderboard_writing_monthly'
    scoreColumn = 'monthly_points'
  } else {
    viewName = 'v_leaderboard_writing'
    scoreColumn = 'total_points'
  }

  let query = admin
    .from(viewName)
    .select(`user_id, nickname, team_id, ${scoreColumn}, ${tieBreakerColumn}`)
    // view 내 ORDER BY 독립적으로 명시 정렬
    .order(scoreColumn, { ascending: false })
    .order(tieBreakerColumn, { ascending: true })
  if (useMonthly) {
    query = query.eq('month_start', `${month}-01`)
  }

  const { data: rows, error } = await query

  if (error) {
    return NextResponse.json(
      { error: 'my-rank query failed', details: error.message },
      { status: 500 },
    )
  }

  // 동적 select(scoreColumn 변수) → supabase 타입 추론이 ParserError 가 되므로 unknown 경유 캐스트
  const list = (rows ?? []) as unknown as Array<Record<string, unknown>>
  const idx = list.findIndex((r) => r.user_id === userId)
  if (idx === -1) {
    return NextResponse.json({
      rank: null,
      reason: 'not_in_leaderboard', // 내부자 또는 집계 0건 유저
      total: list.length,
    })
  }

  const self = list[idx]
  return NextResponse.json(
    {
      rank: idx + 1,
      score: self[scoreColumn],
      nickname: self.nickname,
      team_id: self.team_id,
      total: list.length,
      month: useMonthly ? month : null,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
