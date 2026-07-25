"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { useBlockedIds } from "./useBlock";
import { OPERATOR_USER_ID } from "@/lib/constants/operator";

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
  image_urls?: string[] | null;
  /** 구조화 쪽지 (뉴스클리핑 등) — payload->>'type'으로 렌더 분기 */
  payload?: unknown;
  is_read: boolean;
  created_at: string;
  sender_nickname?: string;
  sender_team_id?: number | null;
}

interface AtomicDMSendResult {
  conversation_id: string;
  message_id: number;
}

// 대화 목록 (N+1 개선: batch fetch)
export function useDMList() {
  const { user } = useAuth();
  const { blockedIds } = useBlockedIds();
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;

    // query-guard: bounded -- 쪽지함은 최신 대화 500개 UI 페이지만 제공한다.
    const { data } = await supabase
      .from("dm_conversations")
      .select("*")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .not("last_message", "is", null)
      .order("last_message_at", { ascending: false })
      .limit(500);

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

  // Realtime — dm_messages 변경(읽음 처리 포함) 시 목록/대화별 안읽음 재계산
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("dm-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dm_messages" },
        () => { load(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, load]);

  return { conversations, loading, refresh: load };
}

// 개별 대화
export function useDMChat(conversationId: string) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(conversationId));

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
          // 낙관 append(발신자 본인 echo)로 이미 넣은 행이면 중복 방지
          let alreadyPresent = false;
          setMessages((prev) => {
            alreadyPresent = prev.some((m) => m.id === msg.id);
            return prev;
          });
          if (alreadyPresent) return;

          const { data: prof } = await supabase
            .from("profiles")
            .select("nickname, team_id")
            .eq("id", msg.sender_id)
            .single();

          setMessages((prev) =>
            prev.some((m) => m.id === msg.id)
              ? prev
              : [
                  ...prev,
                  { ...msg, sender_nickname: prof?.nickname ?? "익명", sender_team_id: prof?.team_id },
                ]
          );

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

  // 메시지 전송: 방 생성·메시지 INSERT·목록 preview를 DB 한 트랜잭션으로 처리한다.
  const sendMessage = useCallback(
    async (content: string, imageUrls?: string[], targetUserIdOverride?: string) => {
      const trimmed = content.trim();
      const images = (imageUrls ?? []).filter((u) => typeof u === "string" && u.length > 0);
      // 텍스트 또는 사진 중 하나는 있어야 전송
      if (!user || (!trimmed && images.length === 0)) return { ok: false, conversationId: null };

      let targetUserId = targetUserIdOverride;
      if (!targetUserId && conversationId) {
        const { data: conv } = await supabase
          .from("dm_conversations")
          .select("user1_id, user2_id")
          .eq("id", conversationId)
          .single();
        if (!conv) return { ok: false, conversationId: null };
        targetUserId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
      }
      if (!targetUserId) return { ok: false, conversationId: null };

      // query-guard: bounded -- RPC는 방 id와 메시지 id 한 행만 반환한다.
      const { data: inserted, error } = await supabase
        .rpc("send_dm_message_atomic", {
          p_target_user_id: targetUserId,
          p_content: trimmed,
          p_image_urls: images,
        })
        .single();
      const result = inserted as AtomicDMSendResult | null;

      if (!error) {
        // 낙관 append — 발신 즉시 내 메시지를 대화창에 반영 (Realtime echo가 본인에게 지연/누락되는 경우 대비).
        // RPC가 준 message_id로 dedup하므로 Realtime echo와 중복되지 않는다.
        if (result?.message_id && conversationId && result.conversation_id === conversationId) {
          const optimistic: DMMessage = {
            id: result.message_id,
            conversation_id: result.conversation_id,
            sender_id: user.id,
            content: trimmed,
            image_urls: images.length > 0 ? images : null,
            is_read: false,
            created_at: new Date().toISOString(),
          };
          setMessages((prev) =>
            prev.some((m) => m.id === optimistic.id) ? prev : [...prev, optimistic]
          );
        }
        // 운영팀 대화면 어드민 PWA 알림 트리거 (fire-and-forget — 실패해도 쪽지 발송에 영향 0, 2026-07-18)
        // messageId를 전달해 서버가 "정확히 그 행"을 검증 + 메시지당 1회 claim (replay 방지)
        if (
          result?.message_id &&
          user.id !== OPERATOR_USER_ID &&
          targetUserId === OPERATOR_USER_ID
        ) {
          const messageId = result.message_id;
          void (async () => {
            try {
              const { data: { session } } = await supabase.auth.getSession();
              await fetch("/api/dm/notify-admin", {
                method: "POST",
                keepalive: true,
                headers: {
                  "Content-Type": "application/json",
                  ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
                },
                body: JSON.stringify({ conversationId: result.conversation_id, messageId }),
              });
            } catch {
              /* ignore */
            }
          })();
        }
      }

      return { ok: !error, conversationId: result?.conversation_id ?? null };
    },
    [user, conversationId]
  );

  return { messages, loading, sendMessage, isLoggedIn: !!user };
}

// 대화 화면 진입만으로 빈 방을 만들지 않도록 기존 방 조회와 생성을 분리한다.
export async function getExistingConversation(myId: string, otherId: string): Promise<string | null> {
  const [u1, u2] = [myId, otherId].sort();
  const { data } = await supabase
    .from("dm_conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  return data?.id ?? null;
}
