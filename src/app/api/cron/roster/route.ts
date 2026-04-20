import { NextResponse } from "next/server";

// ============================================================================
// DEPRECATED — Roster SSOT Fortress Phase 1.5
// ============================================================================
// 2026-04-20 비활성화. 본 라우트는 과거 KBO 공식 사이트를 크롤링해
// Supabase players_roster 테이블에 upsert하던 크론 잡이었음.
//
// 폐기 사유:
//   1. back_no: "" 공란으로 upsert하는 구조가 /api/roster의 static→Supabase
//      merge 시 core field(등번호)를 덮어써 145명 공란 P0 유발 (2026-04-20).
//   2. Phase 1에서 /api/roster merge rule을 "static only admission,
//      Supabase extension only"로 재작성 → Supabase 데이터는 서비스에
//      영향 없음.
//   3. 크롤러가 Supabase에 공란을 계속 쌓는 것은 데이터 위생 오염원.
//
// 대체 경로:
//   - roster 갱신은 src/lib/constants/players-roster.json (SSOT)에 PR로 반영
//   - validate-roster.mjs + GitHub Actions가 CI 가드 수행
//
// 향후 재활성화 조건 (Phase 1.5+):
//   - 크롤러 출력을 static JSON에 자동 PR로 open하는 방식으로 재작성
//   - 또는 읽기 전용 diff 알림(Supabase write 없음)으로 재작성
//
// 본 라우트는 vercel.json cron 스케줄에서도 제거됨.
// ============================================================================

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      error: "Gone",
      message:
        "This cron was deprecated on 2026-04-20. See specs/roster-ssot-fortress.md §7-T4. " +
        "Roster updates must go through static JSON PR.",
      deprecatedAt: "2026-04-20",
      replacement: "src/lib/constants/players-roster.json (SSOT)",
    },
    { status: 410 },
  );
}
