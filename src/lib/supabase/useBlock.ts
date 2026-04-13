"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

interface BlockedUser {
  id: string;
  blocked_id: string;
  nickname: string;
  team_id: number | null;
  created_at: string;
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
    if (!error) setIsBlocked(true);
    return !error;
  }, [user, targetId]);

  const unblock = useCallback(async () => {
    if (!user) return false;
    const { error } = await supabase
      .from("user_blocks")
      .delete()
      .eq("blocker_id", user.id)
      .eq("blocked_id", targetId);
    if (!error) setIsBlocked(false);
    return !error;
  }, [user, targetId]);

  return { block, unblock, isBlocked, loading };
}

// 차단 목록
export function useBlockList() {
  const { user } = useAuth();
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setLoading(false); return; }

    const { data } = await supabase
      .from("user_blocks")
      .select("id, blocked_id, created_at")
      .eq("blocker_id", user.id)
      .order("created_at", { ascending: false });

    if (!data || data.length === 0) {
      setBlockedUsers([]);
      setLoading(false);
      return;
    }

    const blockedIds = data.map((b: { blocked_id: string }) => b.blocked_id);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, nickname, team_id")
      .in("id", blockedIds);

    const profileMap = new Map(
      (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null }) => [p.id, p])
    );

    const mapped: BlockedUser[] = data.map((b: { id: string; blocked_id: string; created_at: string }) => {
      const prof = profileMap.get(b.blocked_id);
      return {
        id: b.id,
        blocked_id: b.blocked_id,
        nickname: prof?.nickname ?? "알 수 없음",
        team_id: prof?.team_id ?? null,
        created_at: b.created_at,
      };
    });

    setBlockedUsers(mapped);
    setLoading(false);
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]); // eslint-disable-line react-hooks/set-state-in-effect

  return { blockedUsers, loading, refresh };
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

  useEffect(() => { refresh(); }, [refresh]); // eslint-disable-line react-hooks/set-state-in-effect

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
