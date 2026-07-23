import { NextResponse } from 'next/server'
import { getWritingLeaderboardRows } from '@/lib/events/leaderboard-cache'

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

  // 서버 메모리 60s 캐시 공유 (2026-07-22 장애 후속: view 재집계 mean ~316ms 흡수)
  let rows
  try {
    rows = (await getWritingLeaderboardRows()).slice(0, limit)
  } catch (e) {
    return NextResponse.json(
      { error: 'leaderboard query failed', details: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  return NextResponse.json(
    { rows, count: rows.length },
    {
      status: 200,
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
      },
    },
  )
}
