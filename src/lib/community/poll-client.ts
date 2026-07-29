import { supabase } from "@/lib/supabase/client";

/**
 * 커뮤니티 투표(Poll) 클라이언트 API 헬퍼 (spec: specs/community-poll.md §5).
 *
 * S1 서버 route 계약(`/api/polls`, `/api/polls/[postId]`, `.../vote`)을 감싼다.
 * 인증 필요한 호출(생성·투표)은 기존 커뮤니티와 동일하게 supabase 세션의
 * access_token 을 Bearer 로 실어 보낸다(usePosts.ts 패턴). 검증·SSOT 파생·
 * 결과 게이트는 전부 서버(route+RPC)가 수행하므로 여기서는 형태만 맞춘다.
 */

export type PollOptionKind = "team" | "player" | "etc";

/** 작성 폼이 서버로 보내는 선지 입력(라벨/이미지는 team/player면 서버가 canonical 파생). */
export type PollOptionInput = {
  kind: PollOptionKind;
  refId?: string; // team=slug, player=kboId. etc=undefined
  label?: string; // etc 자유입력. team/player 는 무시됨(서버 파생)
};

export type CreatePollInput = {
  title: string;
  content?: string;
  allowMultiple: boolean;
  closesAt: string; // ISO8601
  options: PollOptionInput[];
  /** 수동 팀 태그(slug[]). 선지 파생 태그와 서버에서 union. */
  teamTags?: string[];
  /** 수동 선수 태그("kboId:name"[]). 선지 파생 태그와 서버에서 union. */
  playerTags?: string[];
};

/** GET /api/polls/[postId] 응답 선지(결과 게이트 적용 — voteCount 는 은닉 시 null). */
export type PollDetailOption = {
  id: number;
  position: number;
  kind: PollOptionKind;
  refId: string | null;
  label: string | null;
  image: string | null;
  voteCount: number | null;
};

export type PollDetail = {
  postId: number;
  title: string;
  content: string;
  allowMultiple: boolean;
  closesAt: string;
  closed: boolean;
  voterCount: number;
  canSeeResults: boolean;
  voted: boolean;
  mySelection: number[];
  options: PollDetailOption[];
};

/** 목록 카드용 poll 요약(득표수 미포함, 선지 작성순). */
export type PollSummaryOption = {
  position: number;
  kind: PollOptionKind;
  refId: string | null;
  label: string | null;
  image: string | null;
};

export type PollSummary = {
  postId: number;
  closesAt: string;
  closed: boolean;
  voterCount: number;
  optionCount: number;
  options: PollSummaryOption[];
};

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j?.error || fallback;
  } catch {
    return fallback;
  }
}

/** 투표글 생성. 성공 시 새 postId 반환. 실패 시 서버 메시지로 throw. */
export async function createPoll(input: CreatePollInput): Promise<number> {
  const res = await fetch("/api/polls", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      title: input.title,
      content: input.content ?? "",
      allowMultiple: input.allowMultiple,
      closesAt: input.closesAt,
      options: input.options.map((o) => ({ kind: o.kind, refId: o.refId, label: o.label })),
      teamTags: input.teamTags ?? [],
      playerTags: input.playerTags ?? [],
    }),
  });
  if (!res.ok) throw new Error(await parseError(res, "투표 생성에 실패했어요"));
  const j = (await res.json()) as { postId: number };
  return j.postId;
}

/** 투표글 질문(title)·설명(content)만 수정. 서버 route(PATCH)가 인증·작성자·검증·모더레이션을
 *  강제하고, 비텍스트 필드 불변은 DB 트리거가 backstop 한다. 실패 시 서버 메시지로 throw. */
export async function editPollPost(
  postId: number,
  input: { title: string; content: string },
): Promise<void> {
  const res = await fetch(`/api/polls/${postId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ title: input.title, content: input.content }),
  });
  if (!res.ok) throw new Error(await parseError(res, "투표 수정에 실패했어요"));
}

/** 투표 상세 조회(결과 게이트 서버 적용). 없으면 null. */
export async function fetchPollDetail(postId: number): Promise<PollDetail | null> {
  const res = await fetch(`/api/polls/${postId}`, {
    headers: { ...(await authHeader()) },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await parseError(res, "투표를 불러오지 못했어요"));
  return (await res.json()) as PollDetail;
}

export const SUMMARIES_CHUNK = 100; // route/서버 계약 상한(≤100). 무한피드 누적 id는 chunk 해서 전량 조회.

/** 중복·비유효 제거 후 SUMMARIES_CHUNK(100) 단위로 분할. 무한피드 누적 id가 100개를
 *  넘어도 101번째 이후가 누락되지 않도록 보장(route 계약·테스트 공유 순수함수). */
export function chunkSummaryIds(postIds: number[]): number[][] {
  const ids = [...new Set(postIds.filter((n) => Number.isInteger(n) && n > 0))];
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += SUMMARIES_CHUNK) {
    chunks.push(ids.slice(i, i + SUMMARIES_CHUNK));
  }
  return chunks;
}

/** 단일 chunk 요약 — non-OK/네트워크 throw 를 격리해 다른 chunk 를 굶기지 않게 한다.
 *  bounded 재시도(기본 1회) 후에도 실패하면 빈 결과를 돌려(never rejects) — 호출측 Promise.all 이
 *  전체 reject 되어 모든 카드가 영구 로딩에 빠지는 것을 방지. 실패 chunk 카드만 로딩 유지. */
async function fetchSummaryChunk(
  chunk: number[],
  retries = 1,
): Promise<Record<number, PollSummary>> {
  try {
    const res = await fetch("/api/polls/summaries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postIds: chunk }),
    });
    if (!res.ok) {
      if (retries > 0) return fetchSummaryChunk(chunk, retries - 1);
      return {};
    }
    const j = (await res.json()) as { summaries?: Record<number, PollSummary> };
    return j.summaries ?? {};
  } catch {
    // 네트워크 throw → 다른 chunk 를 굶기지 않도록 격리. bounded 재시도 후 빈 결과.
    if (retries > 0) return fetchSummaryChunk(chunk, retries - 1);
    return {};
  }
}

/** 목록 카드용 poll 요약 배치 조회(인증 불필). hidden/비-poll 은 맵에서 제외된다.
 *  무한스크롤로 100개를 넘게 누적된 poll id 도 100개 단위 chunk 후 merge 해
 *  101번째 이후 카드가 영구 로딩에 멈추지 않게 한다. 각 chunk 는 독립 격리(하나 실패해도
 *  나머지는 merge). */
export async function fetchPollSummaries(
  postIds: number[],
): Promise<Record<number, PollSummary>> {
  const chunks = chunkSummaryIds(postIds);
  if (chunks.length === 0) return {};
  const results = await Promise.all(chunks.map((chunk) => fetchSummaryChunk(chunk)));
  return Object.assign({}, ...results) as Record<number, PollSummary>;
}

/** 투표/변경. optionIds 는 선택한 선지 id 배열(단일선택이면 1개). */
export async function castPollVote(postId: number, optionIds: number[]): Promise<void> {
  const res = await fetch(`/api/polls/${postId}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ optionIds }),
  });
  if (!res.ok) throw new Error(await parseError(res, "투표에 실패했어요"));
}
