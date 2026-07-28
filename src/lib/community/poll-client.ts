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
    }),
  });
  if (!res.ok) throw new Error(await parseError(res, "투표 생성에 실패했어요"));
  const j = (await res.json()) as { postId: number };
  return j.postId;
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

/** 투표/변경. optionIds 는 선택한 선지 id 배열(단일선택이면 1개). */
export async function castPollVote(postId: number, optionIds: number[]): Promise<void> {
  const res = await fetch(`/api/polls/${postId}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ optionIds }),
  });
  if (!res.ok) throw new Error(await parseError(res, "투표에 실패했어요"));
}
