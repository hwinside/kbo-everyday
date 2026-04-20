import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/leaderboard/invite?limit=100
 * 초대 트랙 리더보드 Top N
 *
 * - 집계 SSOT: v_leaderboard_invite view
 * - 내부자 7명은 view 레벨에서 이미 제외됨
 * - 기존 누적 + 이벤트 기간 활성화 모두 포함 (기간 필터 없음)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const { data, error } = await supabaseAdmin
    .from('v_leaderboard_invite')
    .select('user_id, nickname, team_id, invite_count, last_activated_at')
    // view 내 ORDER BY에 의존하지 않고 API에서 명시적 정렬 (안정성 + 동률 타이브레이커)
    .order('invite_count', { ascending: false })
    .order('last_activated_at', { ascending: true })
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
