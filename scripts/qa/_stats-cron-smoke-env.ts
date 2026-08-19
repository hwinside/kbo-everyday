// QA 스모크 전용 — cron/stats route 는 모듈 로드 시점에 supabase/admin 싱글톤과 CRON_SECRET 을
// 요구한다. route import 보다 먼저 평가되도록 별도 모듈로 분리한다(ESM 평가 순서 보장).
// 프로덕션 무변경.
//
// ⚠️ 반드시 무조건 덮어쓴다(`=`). `||=` 로 두면 Vercel prebuild 처럼 실제 Supabase env 가
// 이미 있는 환경에서 스텁이 안 먹혀 supabaseAdmin 이 프로덕션 URL 로 만들어지고,
// 스모크의 127.0.0.1 fetch 관측 분기가 전부 빗나간다(2026-08-19 Vercel 실측 —
// "타자 upsert 수행" false 로 빌드 실패). 전역 fetch 가 목킹되므로 실제 네트워크는
// 어느 쪽이든 나가지 않지만, 관측 계약은 URL 일치에 의존한다.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "smoke-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "smoke-anon-key";
process.env.CRON_SECRET = "smoke-cron-secret";
