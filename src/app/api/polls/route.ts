import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { TEAMS } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { formatPlayerTag } from "@/lib/utils/player-tags";
import { teamSlugsForPlayerTags } from "@/lib/utils/player-roster";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import { checkObjectionableContent } from "@/lib/moderation/content-filter";

// canonical SSOT: 팀 slug = teams.ts, 선수 kboId→name = players-roster.json.
// 옵션 ref_id 가 이 집합에 없으면 route 가 400으로 거절(서버 검증), 있으면 team_tags/
// player_tags 를 기존 커뮤니티 포맷(team=slug 배열, player="kboId:이름")으로 파생해
// create_poll RPC 에 전달한다. etc 옵션은 태그에 미반영.
const TEAM_BY_SLUG = new Map(TEAMS.map((t) => [t.slug, t]));
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
    teamTags?: unknown;
    playerTags?: unknown;
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
  const rawOptions = (body.options as OptionInput[]).map((o) => ({
    kind: typeof o.kind === "string" ? o.kind : null,
    ref_id: typeof o.refId === "string" && o.refId.trim() ? o.refId.trim() : null,
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : null,
  }));

  // canonical ref_id 서버 검증 + snapshot 서버 파생 + 태그 원자 파생.
  // team/player 선지의 label_snapshot/image_snapshot 은 해당 SSOT(teams.ts / roster+사진맵)
  // 에서 서버가 파생한다 — 클라이 label/image 는 무시(spoof 차단). etc 만 클라이 label 사용(image 없음).
  // 동일 kind+ref_id 중복 team/player 선지는 400 거절(같은 후보 중복 선택 방지).
  const teamTags = new Set<string>();
  const playerTags: string[] = [];
  const seenRefs = new Set<string>();
  const options: {
    kind: string | null;
    ref_id: string | null;
    label: string | null;
    image: string | null;
  }[] = [];
  for (const o of rawOptions) {
    if (o.kind === "team") {
      const team = o.ref_id ? TEAM_BY_SLUG.get(o.ref_id) : undefined;
      if (!o.ref_id || !team) {
        return NextResponse.json(
          { error: `알 수 없는 팀입니다: ${o.ref_id ?? "(빈값)"}` },
          { status: 400 },
        );
      }
      const key = `team:${o.ref_id}`;
      if (seenRefs.has(key)) {
        return NextResponse.json({ error: `중복된 팀 선지입니다: ${o.ref_id}` }, { status: 400 });
      }
      seenRefs.add(key);
      teamTags.add(o.ref_id);
      options.push({ kind: "team", ref_id: o.ref_id, label: team.name, image: team.logoPath });
      continue;
    }
    if (o.kind === "player") {
      const name = o.ref_id ? ROSTER_NAME_BY_KBOID.get(o.ref_id) : undefined;
      if (!o.ref_id || !name) {
        return NextResponse.json(
          { error: `알 수 없는 선수입니다: ${o.ref_id ?? "(빈값)"}` },
          { status: 400 },
        );
      }
      const key = `player:${o.ref_id}`;
      if (seenRefs.has(key)) {
        return NextResponse.json({ error: `중복된 선수 선지입니다: ${o.ref_id}` }, { status: 400 });
      }
      seenRefs.add(key);
      playerTags.push(formatPlayerTag(o.ref_id, name));
      options.push({
        kind: "player",
        ref_id: o.ref_id,
        label: name,
        image: getPlayerPhotoByKboId(o.ref_id),
      });
      continue;
    }
    // etc → 태그 미반영, 클라이 label 유지(이미지 없음). 잘못된 kind 는 RPC 가 거절.
    options.push({ kind: o.kind, ref_id: null, label: o.label, image: null });
  }
  // 수동 태그(작성 UI 태그 섹션) union — 기존 일반/사진글과 동일하게 팀/선수 피드 노출.
  // 선지에서 파생된 태그와 union(dedupe). 서버 canonical(teams.ts slug / roster kboId) 검증으로
  // 위조 태그 거부. etc만 있는 투표도 이 경로로 원하는 피드에 노출 가능.
  const seenPlayerKboIds = new Set(playerTags.map((t) => t.split(":")[0]));

  // 명시적 공개범위(body.teamTags)를 **별도 집합**으로 검증한다.
  // 위의 teamTags Set 은 이미 kind==='team' 선지에서 파생된 팀을 담고 있어서,
  // 그 Set 의 크기로 필수조건을 보면 body.teamTags=[] 여도 팀 선지만 있으면 통과한다
  // (삼순 NO-GO 2026-08-06). 따라서 파생과 섞이기 전의 순수 명시 태그를 따로 모은다.
  const explicitTeamTags: string[] = [];
  if (Array.isArray(body.teamTags)) {
    for (const raw of body.teamTags as unknown[]) {
      const slug = typeof raw === "string" ? raw.trim() : "";
      if (!slug) continue;
      // 위조/알 수 없는 수동 팀 태그는 조용히 버리지 않고 400 거절(선지 ref_id 검증과 동일 정책).
      if (!TEAM_BY_SLUG.has(slug)) {
        return NextResponse.json({ error: `알 수 없는 팀 태그입니다: ${slug}` }, { status: 400 });
      }
      explicitTeamTags.push(slug);
    }
  }
  if (Array.isArray(body.playerTags)) {
    for (const raw of body.playerTags as unknown[]) {
      // 기존 포맷 "kboId:name" 또는 단순 kboId 모두 수용.
      const kboId = typeof raw === "string" ? raw.trim().split(":")[0] : "";
      if (!kboId) continue;
      const name = ROSTER_NAME_BY_KBOID.get(kboId);
      // 위조/알 수 없는 수동 선수 태그도 400 거절(조용히 버리지 않음).
      if (!name) {
        return NextResponse.json({ error: `알 수 없는 선수 태그입니다: ${kboId}` }, { status: 400 });
      }
      if (!seenPlayerKboIds.has(kboId)) {
        seenPlayerKboIds.add(kboId);
        playerTags.push(formatPlayerTag(kboId, name));
      }
    }
  }
  // 공개범위 필수 조건 — **명시적 teamTags 1개 이상**(하린아빠 2026-08-06).
  // 선지에서 파생된 팀이나 선수 소속팀은 이 조건을 대신하지 않는다 — 글쓴이가 공개범위를
  // 직접 고르게 하는 게 목적이라 파생으로 통과시키면 의도가 무너진다.
  // 클라이언트 버튼 disabled 만으로는 직접 POST 를 막지 못하므로 서버가 경계다.
  // ⚠️ 합쳐진 teamTags Set 이 아니라 **explicitTeamTags** 를 봐야 한다 — Set 은 이미 팀 선지에서
  // 파생된 값을 담고 있어서 body.teamTags=[] 여도 항상 통과한다(삼순 2차 NO-GO 2026-08-06).
  if (explicitTeamTags.length === 0) {
    return NextResponse.json(
      { error: "팀을 최소 1개 선택해주세요 (모든 팀에 공개하려면 ‘전체 선택’)" },
      { status: 400 },
    );
  }

  // 명시 태그 union — 검증을 통과한 뒤에야 합친다.
  for (const slug of explicitTeamTags) teamTags.add(slug);
  // 선수 태그의 소속팀 slug 도 team_tags 에 union (기존 createPost 동일 — 팀 피드 노출).
  for (const slug of teamSlugsForPlayerTags(playerTags)) teamTags.add(slug);

  // 모더레이션 게이트 — 기존 일반/사진글(createPost)과 동일하게 금칙어·스팸을 차단.
  // 질문(title)·설명(content)·기타 선지 라벨까지 모두 검사(기타 선지도 유저 자유입력).
  const etcLabels = options
    .filter((o) => o.kind === "etc" && o.label)
    .map((o) => o.label)
    .join(" ");
  const contentForModeration = [
    typeof body.content === "string" ? body.content : "",
    etcLabels,
  ]
    .filter(Boolean)
    .join(" ");
  const moderation = checkObjectionableContent({ title, content: contentForModeration });
  if (!moderation.allowed) {
    return NextResponse.json(
      { error: moderation.issues[0] ?? "부적절한 콘텐츠입니다" },
      { status: 400 },
    );
  }

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
