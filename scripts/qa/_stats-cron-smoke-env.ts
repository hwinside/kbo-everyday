// QA 스모크 전용 — cron/stats route 는 모듈 로드 시점에 supabase/admin 싱글톤과 CRON_SECRET 을
// 요구한다. route import 보다 먼저 평가되도록 별도 모듈로 분리한다(ESM 평가 순서 보장).
// 프로덕션 무변경.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "smoke-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";
process.env.CRON_SECRET ||= "smoke-cron-secret";
