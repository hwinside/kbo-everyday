import { resolveMx } from "node:dns/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  guardEmailRecipient,
  guardMxRecipient,
} from "@/lib/email-domain-guard";

const SUCCESS_MESSAGE =
  "가입된 이메일이면 비밀번호 재설정 메일을 보내드렸어요.";

export const runtime = "nodejs";

interface ResetPasswordDependencies {
  lookupMx?: typeof resolveMx;
  dispatch?: typeof fetch;
  mxTimeoutMs?: number;
}

function guardMessage(
  result: Exclude<ReturnType<typeof guardEmailRecipient>, { allowed: true }>,
): string {
  if (result.reason === "possible_typo") {
    return `${result.suggestion} 아닌가요? 이메일 주소를 다시 확인해주세요.`;
  }
  if (result.reason === "qa_recipient") {
    return "QA 테스트용 이메일 주소로는 인증 메일을 보낼 수 없어요.";
  }
  if (result.reason === "blocked_domain") {
    return "더 이상 메일을 받을 수 없는 이메일 도메인이에요. 다른 이메일 주소를 입력해주세요.";
  }
  return "올바른 이메일 주소를 입력해주세요.";
}

export async function handlePasswordReset(
  request: NextRequest,
  dependencies: ResetPasswordDependencies = {},
) {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "올바른 이메일 주소를 입력해주세요." },
      { status: 400 },
    );
  }

  const emailResult = guardEmailRecipient(
    typeof body.email === "string" ? body.email : "",
  );
  if (!emailResult.allowed) {
    return NextResponse.json(
      {
        error: guardMessage(emailResult),
        code: emailResult.reason,
        suggestion: emailResult.suggestion,
      },
      { status: 422 },
    );
  }

  const mxResult = await guardMxRecipient(
    emailResult.domain,
    dependencies.lookupMx ?? resolveMx,
    dependencies.mxTimeoutMs,
  );
  if (!mxResult.allowed) {
    return NextResponse.json(
      {
        error:
          "메일을 받을 수 없는 이메일 도메인이에요. 다른 이메일 주소를 입력해주세요.",
        code: "mx_missing",
      },
      { status: 422 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "잠시 후 다시 시도해주세요." },
      { status: 503 },
    );
  }

  const redirectOrigin =
    process.env.NEXT_PUBLIC_SITE_URL || "https://keubo.fan";
  const recoveryUrl = new URL("/auth/v1/recover", supabaseUrl);
  recoveryUrl.searchParams.set(
    "redirect_to",
    `${redirectOrigin}/auth/callback`,
  );

  let response: Response;
  try {
    response = await (dependencies.dispatch ?? fetch)(recoveryUrl, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: emailResult.email }),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "비밀번호 재설정 메일을 보내지 못했어요. 잠시 후 다시 시도해주세요." },
      { status: 502 },
    );
  }

  if (!response.ok) {
    if (response.status === 429) {
      return NextResponse.json(
        { error: "요청이 너무 많아요. 잠시 후 다시 시도해주세요." },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "비밀번호 재설정 메일을 보내지 못했어요. 잠시 후 다시 시도해주세요." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, message: SUCCESS_MESSAGE });
}

export async function POST(request: NextRequest) {
  return handlePasswordReset(request);
}
