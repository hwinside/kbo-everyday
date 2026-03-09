import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Supabase Postgrest 에러 → NextResponse 변환.
 * 409(중복) 등 특수 코드는 codeStatusMap으로 매핑 가능.
 */
export function supabaseErrorResponse(
  error: PostgrestError,
  codeStatusMap?: Record<string, { status: number; message: string }>,
): NextResponse {
  const mapped = codeStatusMap?.[error.code];
  if (mapped) {
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
  return NextResponse.json({ error: error.message }, { status: 500 });
}
