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

    const { count: unread } = await supabase
      .from("dm_messages")
      .select("*", { count: "exact", head: true })
      .in("conversation_id", convIds)
      .eq("is_read", false)
      .neq("sender_id", user.id);

    setCount(unread ?? 0);
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
