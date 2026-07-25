import { createSupabaseServer } from "@/lib/supabase/server";

/**
 * 기사 댓글 브릿지 ensure / 네이티브 댓글 오버레이는 로그인 유저에게만 연다.
 *
 * admin-only 해제 = "전체 로그인 유저 공개"(PR #818 선례와 동일 계약). 익명까지
 * 열면 ①비로그인 CTA가 generic 실패로 끝나 LoginSheet에 도달하지 못하고 ②익명이
 * rate-limit 안에서 임의 기사 URL로 post 브릿지를 무한 생성하는 bridge-spam이 가능하다.
 * 그래서 서버 게이트로 로그인 유저만 열고, 클라 CTA는 미로그인 시 LoginSheet를 선노출한다.
 * 실제 댓글 작성은 CommentSheet(user 필수)가 다시 막는다. 카운트 조회는 공개다.
 * (익명 열람까지 여는 건 별도 승인 범위.)
 */
export async function isNewsDiscussionUser(): Promise<boolean> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}
