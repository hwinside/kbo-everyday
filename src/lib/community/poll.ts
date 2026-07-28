import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 커뮤니티 투표(Poll) 서버 읽기 헬퍼 (spec: specs/community-poll.md).
 *
 * 3테이블(poll_polls/poll_options/poll_votes)은 RLS로 direct SELECT 전면 차단이므로
 * 반드시 service-role admin 클라이언트로만 읽는다. 이 모듈은 GET 상세 route 와
 * OG 카드 route 가 공유한다.
 */

export type PollOptionCore = {
  id: number;
  position: number;
  kind: "team" | "player" | "etc";
  refId: string | null;
  label: string | null; // label_snapshot (SSOT 렌더 실패 시 fallback)
  image: string | null; // image_snapshot (fallback)
  voteCount: number; // 캐시. 노출 여부는 상위 route 의 canSeeResults 가 결정
};

export type PollCore = {
  postId: number;
  title: string;
  content: string;
  allowMultiple: boolean;
  closesAt: string; // ISO
  closed: boolean;
  voterCount: number; // 고유 참여자 수 (항상 공개 가능)
  firstVoteAt: string | null;
  options: PollOptionCore[];
};

/**
 * poll 코어(질문 + 메타 + 선지, 작성순 position ASC)를 읽는다.
 * poll 이 아니거나 없으면 null.
 */
export async function fetchPollCore(
  admin: SupabaseClient,
  postId: number,
): Promise<PollCore | null> {
  const { data: post } = await admin
    .from("posts")
    .select("id, title, content, board_type, is_hidden")
    .eq("id", postId)
    .maybeSingle();
  // 신고 블라인드(is_hidden=true)는 일반 게시글/OG 와 동일하게 배제 → GET 404·OG 비노출.
  if (!post || post.board_type !== "poll" || post.is_hidden === true) return null;

  const { data: poll } = await admin
    .from("poll_polls")
    .select("post_id, allow_multiple, closes_at, voter_count, first_vote_at")
    .eq("post_id", postId)
    .maybeSingle();
  if (!poll) return null;

  // query-guard: bounded -- 선지 수는 create_poll CHECK 로 poll 당 2..10 로 상한(무한 성장 아님)
  const { data: options } = await admin
    .from("poll_options")
    .select("id, position, kind, ref_id, label_snapshot, image_snapshot, vote_count")
    .eq("post_id", postId)
    .order("position", { ascending: true });

  const closed = Date.now() >= new Date(poll.closes_at).getTime();

  return {
    postId: post.id,
    title: post.title,
    content: post.content ?? "",
    allowMultiple: poll.allow_multiple,
    closesAt: new Date(poll.closes_at).toISOString(),
    closed,
    voterCount: poll.voter_count,
    firstVoteAt: poll.first_vote_at ? new Date(poll.first_vote_at).toISOString() : null,
    options: (options ?? []).map((o) => ({
      id: o.id,
      position: o.position,
      kind: o.kind,
      refId: o.ref_id,
      label: o.label_snapshot,
      image: o.image_snapshot,
      voteCount: o.vote_count,
    })),
  };
}

/** 목록/OG 카드용 poll 요약 — 득표수(vote_count) 미포함(진행중 우회 노출 방지). 선지는 작성순. */
export type PollSummaryOption = {
  position: number;
  kind: "team" | "player" | "etc";
  refId: string | null;
  label: string | null; // label_snapshot (클라 현재 SSOT 해석 실패 시 fallback)
  image: string | null; // image_snapshot (fallback)
};

export type PollSummary = {
  postId: number;
  closesAt: string; // ISO
  closed: boolean;
  voterCount: number; // 참여자 수 (항상 공개)
  optionCount: number;
  options: PollSummaryOption[]; // 작성순, 득표수 없음
};

/**
 * 여러 postId 의 poll 요약을 배치로 읽는다(목록 카드용). poll_polls/options 는 RLS
 * 차단이므로 service-role admin 으로만 호출. hidden/비-poll 은 결과에서 제외.
 * 득표수는 반환하지 않는다(진행중 결과 은닉 계약 — 수치는 상세 GET 게이트에서만).
 */
export async function fetchPollSummaries(
  admin: SupabaseClient,
  postIds: number[],
): Promise<Record<number, PollSummary>> {
  const ids = [...new Set(postIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100);
  if (ids.length === 0) return {};

  // hidden 제외 + poll 만 유효
  // query-guard: bounded -- ids 는 호출측 목록 페이지 크기로 상한(≤100)
  const { data: posts } = await admin
    .from("posts")
    .select("id, board_type, is_hidden")
    .in("id", ids);
  const validIds = (posts ?? [])
    .filter((p) => p.board_type === "poll" && p.is_hidden !== true)
    .map((p) => p.id as number);
  if (validIds.length === 0) return {};

  // query-guard: bounded -- validIds ≤100, poll_polls 는 post 당 1행
  const { data: polls } = await admin
    .from("poll_polls")
    .select("post_id, closes_at, voter_count")
    .in("post_id", validIds);

  // query-guard: bounded -- 선지 수는 poll 당 ≤10, validIds ≤100 → ≤1000
  const { data: options } = await admin
    .from("poll_options")
    .select("post_id, position, kind, ref_id, label_snapshot, image_snapshot")
    .in("post_id", validIds)
    .order("position", { ascending: true });

  const optsByPost = new Map<number, PollSummaryOption[]>();
  for (const o of options ?? []) {
    const arr = optsByPost.get(o.post_id) ?? [];
    arr.push({
      position: o.position,
      kind: o.kind,
      refId: o.ref_id,
      label: o.label_snapshot,
      image: o.image_snapshot,
    });
    optsByPost.set(o.post_id, arr);
  }

  const out: Record<number, PollSummary> = {};
  for (const p of polls ?? []) {
    const opts = optsByPost.get(p.post_id) ?? [];
    out[p.post_id] = {
      postId: p.post_id,
      closesAt: new Date(p.closes_at).toISOString(),
      closed: Date.now() >= new Date(p.closes_at).getTime(),
      voterCount: p.voter_count,
      optionCount: opts.length,
      options: opts,
    };
  }
  return out;
}

/**
 * 특정 유저가 이 poll 에서 선택한 option_id 배열(mySelection). 없으면 [].
 */
export async function fetchMySelection(
  admin: SupabaseClient,
  postId: number,
  userId: string,
): Promise<number[]> {
  // query-guard: bounded -- 한 유저의 ballot 은 poll 선지 수(≤10)로 상한
  const { data } = await admin
    .from("poll_votes")
    .select("option_id")
    .eq("post_id", postId)
    .eq("user_id", userId);
  return (data ?? []).map((r) => r.option_id as number);
}
