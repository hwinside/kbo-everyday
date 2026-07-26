"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

export function useUnreadDMCount() {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!user) { setCount(0); return; }

    // 내가 참여한 대화 목록
    const { data: convs } = await supabase
      .from("dm_conversations")
      .select("id")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`);

    if (!convs || convs.length === 0) { setCount(0); return; }

    const convIds = convs.map((c: { id: string }) => c.id);

    // query-guard: bounded -- p_conversation_ids는 RPC가 500개로 제한하며 현재 사용자 대화당 1행만 반환
    const { data: unreadRows } = await supabase
      .rpc("dm_unread_counts", { p_conversation_ids: convIds });

    setCount(
      (unreadRows ?? []).reduce(
        (total: number, row: { unread_count: number | string }) =>
          total + Number(row.unread_count),
        0,
      ),
    );
  }, [user]);

  useEffect(() => { load(); }, [load]); // eslint-disable-line react-hooks/set-state-in-effect

  // Realtime 구독 — dm_messages INSERT 시 리카운트
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("dm-unread-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dm_messages" },
        () => { load(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, load]);

  return count;
}
