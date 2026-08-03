import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateNickname } from "@/lib/validation/nickname";

// 가벼운 닉네임 가용성 체크 (인증 불필요).
// 가입 onboarding /setup 에서 입력 중 debounce 호출되는 경로.
//
// 응답:
//   { available: true }                  // 사용 가능
//   { available: false, reason: "..." } // 형식 위반 또는 중복
//
// 보안 메모:
// - 이메일/UUID 같은 개인정보는 반환하지 않음 (boolean만)
// - public.profiles.nickname 컬럼은 RLS상 인증 사용자에게 select 가능 (이미 검색/멘션 등에서 노출됨)
//   → admin client로 조회해도 신규 노출 표면은 없음
// - 무인증 endpoint이므로 쿼리스트링 길이/형식만 신뢰. DB 조회 전에 형식 검증 통과해야 진입.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("nickname") ?? "";
  const nickname = raw.trim();

  if (!nickname) {
    return NextResponse.json({ available: false, reason: "닉네임을 입력해주세요" }, { status: 400 });
  }

  const formatError = validateNickname(nickname);
  if (formatError) {
    return NextResponse.json({ available: false, reason: formatError }, { status: 200 });
  }

  try {
    const admin = getSupabaseAdmin();
    // 2026-04-19: case-insensitive 비교 (ktwiz/Ktwiz 같은 대소문자 중복 차단)
    // validateFormat이 [가-힣a-zA-Z0-9]+만 허용하므로 ilike wildcard(%,_) 주입 위험 없음
    const { data, error } = await admin
      .from("profiles")
      .select("id")
      .ilike("nickname", nickname)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[api/check-nickname] supabase error:", error);
      return NextResponse.json({ available: false, reason: "확인 중 오류가 발생했습니다" }, { status: 500 });
    }

    if (data) {
      return NextResponse.json({ available: false, reason: "이미 사용 중인 닉네임입니다" }, { status: 200 });
    }

    return NextResponse.json({ available: true }, { status: 200 });
  } catch (e) {
    console.error("[api/check-nickname] unexpected:", e);
    return NextResponse.json({ available: false, reason: "확인 중 오류가 발생했습니다" }, { status: 500 });
  }
}
