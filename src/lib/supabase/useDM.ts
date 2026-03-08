"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

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
  sender_team_id?: number;
}

// 대화 목록
export function useDMList() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .from("dm_conversations")
      .select("*")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .order("last_message_at", { ascending: false });

    if (!data) { setLoading(false); return; }

    const mapped = await Promise.all(
      data.map(async (conv: { id: string; user1_id: string; user2_id: string; last_message: string | null; last_message_at: string }) => {
        const otherId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
        const { data: prof } = await supabase
          .from("profiles")
          .select("nickname, team_id, avatar_url")
          .eq("id", otherId)
          .single();

        // 안 읽은 메시지 수
        const { count } = await supabase
          .from("dm_messages")
          .select("*", { count: "exact", head: true })
          .eq("conversation_id", conv.id)
          .eq("is_read", false)
          .neq("sender_id", user.id);

        return {
          id: conv.id,
          other_user_id: otherId,
          other_nickname: prof?.nickname ?? "알 수 없음",
          other_team_id: prof?.team_id ?? null,
          other_avatar_url: prof?.avatar_url ?? null,
          last_message: conv.last_message,
          last_message_at: conv.last_message_at,
          unread_count: count ?? 0,
        };
      })
    );

    setConversations(mapped);
    setLoading(false);
  }, [user]);

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
        const mapped = await Promise.all(
          data.reverse().map(async (m: DMMessage) => {
            const { data: prof } = await supabase
              .from("profiles")
              .select("nickname, team_id")
              .eq("id", m.sender_id)
              .single();
            return {
              ...m,
              sender_nickname: prof?.nickname ?? "익명",
              sender_team_id: prof?.team_id,
            };
          })
        );
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

  // 메시지 전송
  const sendMessage = useCallback(
    async (content: string) => {
      if (!user || !content.trim()) return false;

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

// 대화 시작 (or 기존 대화 찾기)
export async function getOrCreateConversation(myId: string, otherId: string): Promise<string | null> {
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
