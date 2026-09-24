"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

interface BlockedUser {
  id: string;
  blocked_id: string;
  nickname: string;
  team_id: number | null;
  created_at: string;
}

// 차단 변경 브로드캐스트 — 한 화면에서 차단하면 다른 화면의 피드/목록(useBlockedIds)이 즉시 갱신되게.
const BLOCK_CHANGED_EVENT = "kbo:block-changed";
function emitBlockChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BLOCK_CHANGED_EVENT));
}

// 명령형 차단 — 글/댓글 메뉴 등 hook 밖에서 즉시 호출. 이미 차단(23505)도 성공 취급.
export async function blockUserById(blockerId: string, blockedId: string): Promise<boolean> {
  const { error } = await supabase
    .from("user_blocks")
    .insert({ blocker_id: blockerId, blocked_id: blockedId });
  const ok = !error || error.code === "23505";
  if (ok) emitBlockChanged();
  return ok;
}

// 특정 유저 차단/해제
export function useBlockUser(targetId: string) {
  const { user } = useAuth();
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  // 차단 여부 체크
  useEffect(() => {
    if (!user || !targetId) { setLoading(false); return; } // eslint-disable-line react-hooks/set-state-in-effect

    supabase
      .from("user_blocks")
      .select("id")
      .eq("blocker_id", user.id)
      .eq("blocked_id", targetId)
      .maybeSingle()
      .then(({ data }) => {
        setIsBlocked(!!data); // eslint-disable-line react-hooks/set-state-in-effect
        setLoading(false); // eslint-disable-line react-hooks/set-state-in-effect
      });
  }, [user, targetId]);

  const block = useCallback(async () => {
    if (!user) return false;
    const { error } = await supabase
      .from("user_blocks")
      .insert({ blocker_id: user.id, blocked_id: targetId });
    if (!error) { setIsBlocked(true); emitBlockChanged(); }
    return !error;
  }, [user, targetId]);

  const unblock = useCallback(async () => {
    if (!user) return false;
    const { error } = await supabase
      .from("user_blocks")
      .delete()
      .eq("blocker_id", user.id)
      .eq("blocked_id", targetId);
    if (!error) { setIsBlocked(false); emitBlockChanged(); }
    return !error;
  }, [user, targetId]);

  return { block, unblock, isBlocked, loading };
}

// 차단 목록 — 두 진입점에서 공유하며 조회 실패를 빈 목록으로 처리하지 않는다.
export function useBlockList() {
  const { user } = useAuth();
  const userId = user?.id;
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    setLoading(true);
    setError(null);
    if (!userId) {
      setBlockedUsers([]);
      setLoading(false);
      return;
    }
    try {
      const result: BlockedUser[] = [];
      // Supabase 응답 상한과 큰 IN 쿼리를 피하면서 전체 차단 목록을 읽는다.
      for (let offset = 0; ; offset += 100) {
        // query-guard: bounded-page -- each 100-row page is accumulated until the final short page; composite unique order breaks timestamp ties
        const { data, error: blocksError } = await supabase
          .from("user_blocks")
          .select("id, blocked_id, created_at")
          .eq("blocker_id", userId)
          .order("created_at", { ascending: false })
          .order("blocker_id", { ascending: false })
          .order("blocked_id", { ascending: false })
          .range(offset, offset + 99);
        if (version !== request.current) return;
        if (blocksError) throw blocksError;
        if (!data?.length) break;
        // query-guard: bounded -- IN contains at most the 100 blocked IDs from this page; profiles.id is unique
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("id, nickname, team_id")
          .in("id", data.map((block) => block.blocked_id));
        if (version !== request.current) return;
        if (profilesError) throw profilesError;
        const profileMap = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
        result.push(...data.map((block) => ({
          ...block,
          nickname: profileMap.get(block.blocked_id)?.nickname ?? "알 수 없는 유저",
          team_id: profileMap.get(block.blocked_id)?.team_id ?? null,
        })));
        if (data.length < 100) break;
      }
      if (version === request.current) setBlockedUsers(result);
    } catch {
      if (version === request.current) setError("차단 목록을 불러오지 못했어요. 다시 시도해 주세요.");
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    setBlockedUsers([]);
    void refresh();
    window.addEventListener(BLOCK_CHANGED_EVENT, refresh);
    return () => {
      // This is a request generation counter, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++request.current;
      window.removeEventListener(BLOCK_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  return { blockedUsers, loading, error, refresh };
}

// 성공한 해제만 피드·채팅·쪽지의 차단 필터에 브로드캐스트한다.
export async function unblockUserById(blockerId: string, blockedId: string): Promise<boolean> {
  try {
    const { error } = await supabase.from("user_blocks").delete()
      .eq("blocker_id", blockerId).eq("blocked_id", blockedId);
    if (error) return false;
    emitBlockChanged();
    return true;
  } catch {
    return false;
  }
}

// 차단된 유저 ID 목록 (필터링용)
export function useBlockedIds() {
  const { user } = useAuth();
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .from("user_blocks")
      .select("blocked_id")
      .eq("blocker_id", user.id);

    if (data) {
      setBlockedIds(new Set(data.map((b: { blocked_id: string }) => b.blocked_id)));
    }
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    if (typeof window === "undefined") return;
    window.addEventListener(BLOCK_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(BLOCK_CHANGED_EVENT, refresh);
  }, [refresh]);

  return { blockedIds, refresh };
}

// 신고 제출
export async function submitDMReport(
  reporterId: string,
  reportedUserId: string,
  conversationId: string | null,
  reason: string
) {
  const { error } = await supabase.from("dm_reports").insert({
    reporter_id: reporterId,
    reported_user_id: reportedUserId,
    conversation_id: conversationId,
    reason,
  });
  return !error;
}
