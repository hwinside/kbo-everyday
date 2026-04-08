"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { useBlockedIds } from "./useBlock";

export interface DMConversation {
  id: string;
  other_user_id: string;
  other_nickname: string;
  other_team_id: number | null;
  other_avatar_url: string | null;
  last_message: string | null;
  last_message_at: string;
  unread_count: number;
}

export interface DMMessage {
  id: number;
  conversation_id: string;
  sender_id: string;
  content: string;
  is_read: boolean;
  created_at: string;
  sender_nickname?: string;
  sender_team_id?: number | null;
}

// 대화 목록 (N+1 개선: batch fetch)
export function useDMList() {
  const { user } = useAuth();
  const { blockedIds } = useBlockedIds();
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .from("dm_conversations")
      .select("*")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .order("last_message_at", { ascending: false });

    if (!data || data.length === 0) { setConversations([]); setLoading(false); return; }

    // 상대방 ID 추출
    const otherIds = data.map((conv: { user1_id: string; user2_id: string }) =>
      conv.user1_id === user.id ? conv.user2_id : conv.user1_id
    );

    // batch fetch profiles
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, nickname, team_id, avatar_url")
      .in("id", otherIds);

    const profileMap = new Map(
      (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null; avatar_url: string | null }) => [p.id, p])
    );

    // batch fetch unread counts — 한 쿼리로 모든 대화의 안 읽은 메시지 카운트
    const convIds = data.map((c: { id: string }) => c.id);
    const { data: unreadRows } = await supabase
      .from("dm_messages")
      .select("conversation_id")
      .in("conversation_id", convIds)
      .eq("is_read", false)
      .neq("sender_id", user.id);

    const unreadMap = new Map<string, number>();
    (unreadRows ?? []).forEach((r: { conversation_id: string }) => {
      unreadMap.set(r.conversation_id, (unreadMap.get(r.conversation_id) ?? 0) + 1);
    });

    const mapped: DMConversation[] = data
      .map((conv: { id: string; user1_id: string; user2_id: string; last_message: string | null; last_message_at: string }) => {
        const otherId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
        const prof = profileMap.get(otherId);
        return {
          id: conv.id,
          other_user_id: otherId,
          other_nickname: prof?.nickname ?? "알 수 없음",
          other_team_id: prof?.team_id ?? null,
          other_avatar_url: prof?.avatar_url ?? null,
          last_message: conv.last_message,
          last_message_at: conv.last_message_at,
          unread_count: unreadMap.get(conv.id) ?? 0,
        };
      })
      // 차단된 유저 대화 필터링
      .filter((conv: DMConversation) => !blockedIds.has(conv.other_user_id));

    setConversations(mapped);
    setLoading(false);
  }, [user, blockedIds]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return { conversations, loading, refresh: load };
}

// 개별 대화
export function useDMChat(conversationId: string) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [loading, setLoading] = useState(true);

  // 메시지 로드
  useEffect(() => {
    if (!conversationId) return;

    async function load() {
      const { data } = await supabase
        .from("dm_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (data) {
        // batch fetch sender profiles
        const senderIds = [...new Set(data.map((m: DMMessage) => m.sender_id))];
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, nickname, team_id")
          .in("id", senderIds);

        const profileMap = new Map(
          (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null }) => [p.id, p])
        );

        const mapped = data.reverse().map((m: DMMessage) => {
          const prof = profileMap.get(m.sender_id);
          return {
            ...m,
            sender_nickname: prof?.nickname ?? "익명",
            sender_team_id: prof?.team_id,
          };
        });
        setMessages(mapped);
      }
      setLoading(false);
    }

    load();
  }, [conversationId]);

  // 읽음 처리
  useEffect(() => {
    if (!user || !conversationId) return;

    supabase
      .from("dm_messages")
      .update({ is_read: true })
      .eq("conversation_id", conversationId)
      .eq("is_read", false)
      .neq("sender_id", user.id)
      .then(() => {});
  }, [user, conversationId, messages.length]);

  // Realtime
  useEffect(() => {
    if (!conversationId) return;

    const channel = supabase
      .channel(`dm:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "dm_messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const msg = payload.new as DMMessage;
          const { data: prof } = await supabase
            .from("profiles")
            .select("nickname, team_id")
            .eq("id", msg.sender_id)
            .single();

          setMessages((prev) => [
            ...prev,
            { ...msg, sender_nickname: prof?.nickname ?? "익명", sender_team_id: prof?.team_id },
          ]);

          // 읽음 처리 (내가 아닌 메시지)
          if (user && msg.sender_id !== user.id) {
            await supabase
              .from("dm_messages")
              .update({ is_read: true })
              .eq("id", msg.id);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [conversationId, user]);

  // 메시지 전송 (차단 체크)
  const sendMessage = useCallback(
    async (content: string) => {
      if (!user || !content.trim()) return false;

      // 차단 여부 체크
      const { data: conv } = await supabase
        .from("dm_conversations")
        .select("user1_id, user2_id")
        .eq("id", conversationId)
        .single();

      if (conv) {
        const otherId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;

        // 내가 상대를 차단했거나, 상대가 나를 차단했는지
        const { data: blocked } = await supabase
          .from("user_blocks")
          .select("id")
          .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${otherId}),and(blocker_id.eq.${otherId},blocked_id.eq.${user.id})`)
          .limit(1);

        if (blocked && blocked.length > 0) {
          console.error("차단된 사용자에게 메시지를 보낼 수 없습니다.");
          return false;
        }
      }

      const { error } = await supabase.from("dm_messages").insert({
        conversation_id: conversationId,
        sender_id: user.id,
        content: content.trim(),
      });

      if (!error) {
        // last_message 업데이트
        await supabase
          .from("dm_conversations")
          .update({ last_message: content.trim(), last_message_at: new Date().toISOString() })
          .eq("id", conversationId);
      }

      return !error;
    },
    [user, conversationId]
  );

  return { messages, loading, sendMessage, isLoggedIn: !!user };
}

// 대화 시작 (or 기존 대화 찾기) — 차단 체크 포함
export async function getOrCreateConversation(myId: string, otherId: string): Promise<string | null> {
  // 차단 여부 체크
  const { data: blocked } = await supabase
    .from("user_blocks")
    .select("id")
    .or(`and(blocker_id.eq.${myId},blocked_id.eq.${otherId}),and(blocker_id.eq.${otherId},blocked_id.eq.${myId})`)
    .limit(1);

  if (blocked && blocked.length > 0) {
    console.error("차단된 사용자와 대화할 수 없습니다.");
    return null;
  }

  // 정렬해서 저장 (user1 < user2)
  const [u1, u2] = [myId, otherId].sort();

  // 기존 대화 찾기
  const { data: existing } = await supabase
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .single();

  if (existing) return existing.id;

  // 새 대화 생성
  const { data: created, error } = await supabase
    .from("dm_conversations")
    .insert({ user1_id: u1, user2_id: u2 })
    .select("id")
    .single();

  if (error) { console.error("DM create error:", error); return null; }
  return created?.id ?? null;
}
