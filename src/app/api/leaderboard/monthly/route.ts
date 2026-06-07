import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** 현재 월(KST) "YYYY-MM" */
function currentMonthKST(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/**
 * GET /api/leaderboard/monthly?month=YYYY-MM&limit=100
 * 글쓰기 트랙 월별 리더보드 Top N
 *
 * - 집계 SSOT: v_leaderboard_writing_monthly view (월별 파티션)
 * - month 생략 시 현재 월(KST) 기준
 * - 일일 캡 200은 view 내부 day 단위로 적용 완료 (월 합산캡 없음)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // limit=abc/음수/소수 같은 값이 NaN·negative 로 Supabase .limit() 까지 가지 않도록 1~500 finite clamp
  const rawLimit = Number(searchParams.get('limit') ?? 100)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100
  const month = searchParams.get('month') ?? currentMonthKST()

  if (!MONTH_RE.test(month)) {
    return NextResponse.json(
      { error: 'month must be YYYY-MM' },
      { status: 400 },
    )
  }
  const monthStart = `${month}-01`

  const { data, error } = await supabaseAdmin
    .from('v_leaderboard_writing_monthly')
    .select('user_id, nickname, team_id, monthly_points, last_active_day')
    .eq('month_start', monthStart)
    // view 내 ORDER BY에 의존하지 않고 API에서 명시적 정렬
    .order('monthly_points', { ascending: false })
    .order('last_active_day', { ascending: true })
    .limit(limit)

  if (error) {
    return NextResponse.json(
      { error: 'monthly leaderboard query failed', details: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json(
    { month, rows: data ?? [], count: data?.length ?? 0 },
    {
      status: 200,
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
      },
    },
  )
}
