import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { normalizeNickname, validateNickname } from "@/lib/validation/nickname";

const MAX_CHANGES_PER_30_DAYS = 2;
const WINDOW_DAYS = 30;

type NicknameChangeRow = {
  changed_at: string;
};

function buildStatus(changes: NicknameChangeRow[]) {
  const used = changes.length;
  const remaining = Math.max(0, MAX_CHANGES_PER_30_DAYS - used);
  const oldestChange = changes[used - 1]?.changed_at ?? null;
  const resetAt = oldestChange
    ? new Date(new Date(oldestChange).getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  return {
    limit: MAX_CHANGES_PER_30_DAYS,
    windowDays: WINDOW_DAYS,
    used,
    remaining,
    resetAt,
  };
}

async function getRecentNicknameChanges(userId: string) {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("profile_nickname_changes")
    .select("changed_at")
    .eq("user_id", userId)
    .gte("changed_at", since)
    .order("changed_at", { ascending: false });

  if (error) throw error;

  return (data ?? []) as NicknameChangeRow[];
}

export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("nickname")
    .eq("id", verified.user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: "프로필을 찾을 수 없습니다" }, { status: 404 });
  }

  const changes = await getRecentNicknameChanges(verified.user.id);

  return NextResponse.json({
    nickname: profile.nickname,
    ...buildStatus(changes),
  });
}

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { nickname: rawNickname } = await req.json();
  const nickname = normalizeNickname(rawNickname);
  const validationError = validateNickname(nickname);

  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, nickname")
    .eq("id", verified.user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: "프로필을 찾을 수 없습니다" }, { status: 404 });
  }

  // 2026-04-19: 동일닉 체크도 case-insensitive (대소문자만 바꿸 동일닉 취급 정련 필요)
  if (profile.nickname.toLowerCase() === nickname.toLowerCase()) {
    const changes = await getRecentNicknameChanges(verified.user.id);
    return NextResponse.json({
      success: true,
      nickname,
      message: "현재 닉네임과 동일합니다",
      ...buildStatus(changes),
    });
  }

  // 2026-04-19: case-insensitive 중복 체크 (ktwiz/Ktwiz 사례)
  const { data: duplicate, error: duplicateError } = await supabase
    .from("profiles")
    .select("id")
    .ilike("nickname", nickname)
    .neq("id", verified.user.id)
    .maybeSingle();

  if (duplicateError) {
    return NextResponse.json({ error: "닉네임 중복 확인에 실패했습니다" }, { status: 500 });
  }

  if (duplicate) {
    return NextResponse.json({ error: "이미 사용 중인 닉네임입니다" }, { status: 409 });
  }

  const changes = await getRecentNicknameChanges(verified.user.id);
  const status = buildStatus(changes);

  if (status.remaining <= 0) {
    return NextResponse.json(
      {
        error: "최근 30일 내 닉네임은 2번까지만 변경할 수 있습니다",
        ...status,
      },
      { status: 429 }
    );
  }

  const changedAt = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      nickname,
      updated_at: changedAt,
    })
    .eq("id", verified.user.id);

  if (updateError) {
    return NextResponse.json({ error: "닉네임 저장에 실패했습니다" }, { status: 500 });
  }

  const { error: historyError } = await supabase.from("profile_nickname_changes").insert({
    user_id: verified.user.id,
    old_nickname: profile.nickname,
    new_nickname: nickname,
    changed_at: changedAt,
  });

  if (historyError) {
    await supabase
      .from("profiles")
      .update({ nickname: profile.nickname, updated_at: changedAt })
      .eq("id", verified.user.id);

    return NextResponse.json({ error: "닉네임 변경 이력 저장에 실패했습니다" }, { status: 500 });
  }

  const nextStatus = buildStatus([{ changed_at: changedAt }, ...changes]);

  return NextResponse.json({
    success: true,
    nickname,
    message: "닉네임이 변경되었습니다",
    ...nextStatus,
  });
}
