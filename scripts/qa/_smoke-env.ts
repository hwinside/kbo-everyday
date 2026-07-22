// QA 스모크 전용 — news-clipping 모듈은 트랜지티브로 supabase/admin 싱글톤을 로드하고,
// 그 싱글톤이 모듈 로드 시점에 SUPABASE env를 요구한다. 순수 함수(isOtherTeamTitle 등)만
// 검증하는 스모크에서 env 없이도 로드되도록 더미 값을 선주입한다.
// (반드시 news-clipping import 보다 먼저 import 될 것 — ESM 평가 순서 보장. 프로덕션 무변경.)
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-test-anon-key";
