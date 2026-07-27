import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { TEAMS } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { formatPlayerTag } from "@/lib/utils/player-tags";
import { teamSlugsForPlayerTags } from "@/lib/utils/player-roster";

// canonical SSOT: 팀 slug = teams.ts, 선수 kboId→name = players-roster.json.
// 옵션 ref_id 가 이 집합에 없으면 route 가 400으로 거절(서버 검증), 있으면 team_tags/
// player_tags 를 기존 커뮤니티 포맷(team=slug 배열, player="kboId:이름")으로 파생해
// create_poll RPC 에 전달한다. etc 옵션은 태그에 미반영.
const TEAM_SLUGS = new Set(TEAMS.map((t) => t.slug));
const ROSTER_NAME_BY_KBOID = new Map(
  (PLAYERS_ROSTER as { kboId: string; name: string }[]).map((p) => [String(p.kboId), p.name]),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/polls — 투표글 생성 (spec: specs/community-poll.md §5)
 *
 * body: {
 *   title: string,                // 질문(필수)
 *   content?: string,             // 설명(선택)
 *   allowMultiple?: boolean,      // 복수선택 허용
 *   closesAt: string,             // ISO8601 (서버 RPC가 10분~30일 검증)
 *   options: { kind: 'team'|'player'|'etc', refId?: string, label?: string, image?: string }[]
 * }
 *
 * 인증(JWT) 필수. 검증(옵션 2~10, 팀+선수 공존 금지, closes 범위, etc label,
 * ref_id)은 전부 create_poll RPC(SECURITY DEFINER, service-role 전용)가 SSOT로 수행.
 */

// RPC(RAISE EXCEPTION) SQLSTATE → HTTP 매핑. check/FK 위반은 사용자 입력 문제(400).
function rpcErrorStatus(code?: string): number {
  switch (code) {
    case "23514": // check_violation
    case "23503": // foreign_key_violation
    case "22P02": // invalid_text_representation (e.g. bad uuid)
      return 400;
    case "P0002": // no_data_found
      return 404;
    default:
      return 500;
  }
}

type OptionInput = { kind?: unknown; refId?: unknown; label?: unknown; image?: unknown };

export async function POST(request: NextRequest) {
  const verified = await getVerifiedUserFromRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  let body: {
    title?: unknown;
    content?: unknown;
    allowMultiple?: unknown;
    closesAt?: unknown;
    options?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "질문(title)은 필수입니다" }, { status: 400 });
  }
  if (typeof body.closesAt !== "string" || Number.isNaN(Date.parse(body.closesAt))) {
    return NextResponse.json({ error: "마감시간(closesAt)이 올바르지 않습니다" }, { status: 400 });
  }
  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10) {
    return NextResponse.json({ error: "선지는 2~10개여야 합니다" }, { status: 400 });
  }

  // route 레벨 얇은 정규화 — 개수/공존/마감범위 등 권위 검증은 RPC.
  const options = (body.options as OptionInput[]).map((o) => ({
    kind: typeof o.kind === "string" ? o.kind : null,
    ref_id: typeof o.refId === "string" && o.refId.trim() ? o.refId.trim() : null,
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : null,
    image: typeof o.image === "string" && o.image.trim() ? o.image.trim() : null,
  }));

  // canonical ref_id 서버 검증 + team_tags/player_tags 원자 파생.
  const teamTags = new Set<string>();
  const playerTags: string[] = [];
  for (const o of options) {
    if (o.kind === "team") {
      if (!o.ref_id || !TEAM_SLUGS.has(o.ref_id)) {
        return NextResponse.json(
          { error: `알 수 없는 팀입니다: ${o.ref_id ?? "(빈값)"}` },
          { status: 400 },
        );
      }
      teamTags.add(o.ref_id);
    } else if (o.kind === "player") {
      const name = o.ref_id ? ROSTER_NAME_BY_KBOID.get(o.ref_id) : undefined;
      if (!o.ref_id || !name) {
        return NextResponse.json(
          { error: `알 수 없는 선수입니다: ${o.ref_id ?? "(빈값)"}` },
          { status: 400 },
        );
      }
      playerTags.push(formatPlayerTag(o.ref_id, name));
    }
    // etc → 태그 미반영
  }
  // 선수 태그의 소속팀 slug 도 team_tags 에 union (기존 createPost 동일 — 팀 피드 노출).
  for (const slug of teamSlugsForPlayerTags(playerTags)) teamTags.add(slug);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("create_poll", {
    p_author_id: verified.user.id,
    p_title: title,
    p_content: typeof body.content === "string" ? body.content : null,
    p_allow_multiple: body.allowMultiple === true,
    p_closes_at: new Date(body.closesAt).toISOString(),
    p_options: options,
    p_team_tags: [...teamTags],
    p_player_tags: playerTags,
  });

  if (error) {
    const status = rpcErrorStatus(error.code);
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ postId: Number(data) }, { status: 201 });
}
