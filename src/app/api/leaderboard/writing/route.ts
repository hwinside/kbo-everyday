import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/leaderboard/writing?limit=100
 * 글쓰기 트랙 리더보드 Top N
 *
 * - 집계 SSOT: v_leaderboard_writing view
 * - 포인트 SSOT: src/lib/events/writing-points.ts
 * - 이벤트 기간(2026-04-20 ~ 2026-05-31 KST) 활동만 집계
 * - 일일 캡 + 합산 일일 캡(150) view 내부에서 적용 완료
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // limit=abc/음수/소수 같은 값이 NaN·negative 로 Supabase .limit() 까지 가지 않도록 1~500 finite clamp
  const rawLimit = Number(searchParams.get('limit') ?? 100)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100

  const { data, error } = await supabaseAdmin
    .from('v_leaderboard_writing')
    .select('user_id, nickname, team_id, total_points, last_active_day')
    // view 내 ORDER BY에 의존하지 않고 API에서 명시적 정렬
    .order('total_points', { ascending: false })
    .order('last_active_day', { ascending: true })
    .limit(limit)

  if (error) {
    return NextResponse.json(
      { error: 'leaderboard query failed', details: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json(
    { rows: data ?? [], count: data?.length ?? 0 },
    {
      status: 200,
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
      },
    },
  )
}
