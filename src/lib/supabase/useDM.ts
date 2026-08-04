"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { useBlockedIds } from "./useBlock";
import { OPERATOR_USER_ID } from "@/lib/constants/operator";
import {
  BASEBALL_GENIUS_NAME,
  BASEBALL_GENIUS_USER_ID,
} from "@/lib/constants/baseball-genius";
import {
  BASEBALL_QA_MAX_ATTEMPTS,
  attemptBaseballQaOutbox,
  enqueueBaseballQaQuestion,
  getBaseballQaReplyStates,
  observeBaseballQaReplies,
  readBaseballQaOutbox,
  resetBaseballQaQuestion,
  applyBaseballQaPlayerPick,
  collectBaseballQaAnsweredQuestionIds,
  createBaseballQaAnsweredUpdater,
  type BaseballQaReplyStates,
} from "@/lib/baseball-qa/client-outbox";
import { usePollingFallback } from "./usePollingFallback";
import { mergeDmMessagesById, type DMMessage } from "./dm-messages";

export type { DMMessage };

// Realtime 구독이 죽은 동안만 도는 안전망 폴링 주기.
const DM_LIST_POLL_MS = 30_000;
const DM_CHAT_POLL_MS = 20_000;

// SSR 에서는 useLayoutEffect 경고를 피하고 브라우저에서는 paint 전 동기 실행.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface DMConversation {
  id: string;
  other_user_id: string | null;
  other_nickname: string;
  other_team_id: number | null;
  other_avatar_url: string | null;
  last_message: string | null;
  last_message_at: string;
  unread_count: number;
}

interface AtomicDMSendResult {
  conversation_id: string;
  message_id: number;
}

interface DMConversationRow {
  id: string;
  user1_id: string | null;
  user2_id: string | null;
  last_message: string | null;
  last_message_at: string;
}

// 대화 목록 (N+1 개선: batch fetch)
export function useDMList() {
  const { user } = useAuth();
  const { blockedIds } = useBlockedIds();
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [realtimeHealthy, setRealtimeHealthy] = useState(false);
  const channelGenerationRef = useRef(0);

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

    // 빈 목록이어도 야잘알봇 고정방은 렌더해야 하므로 조기 반환하지 않는다.
    const conversationRows = (data ?? []) as DMConversationRow[];

    // 상대방 ID 추출
    const otherIds = [
      ...new Set(
        conversationRows
          .map((conv) =>
            conv.user1_id === user.id ? conv.user2_id : conv.user1_id
          )
          .filter((id): id is string => id !== null),
      ),
    ];

    // batch fetch profiles
    const { data: profiles } = otherIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, nickname, team_id, avatar_url")
          .in("id", otherIds)
      : { data: [] };

    const profileMap = new Map(
      (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null; avatar_url: string | null }) => [p.id, p])
    );

    // batch fetch unread counts — RPC 결과는 요청 대화당 최대 1행(목록 상한 500).
    const convIds = conversationRows.map((c) => c.id);
    // query-guard: bounded -- p_conversation_ids는 클라이언트·RPC 양쪽에서 500개로 제한되고 대화당 1행만 반환
    const { data: unreadRows } = await supabase
      .rpc("dm_unread_counts", { p_conversation_ids: convIds });

    const unreadMap = new Map<string, number>();
    (unreadRows ?? []).forEach((r: { conversation_id: string; unread_count: number | string }) => {
      unreadMap.set(r.conversation_id, Number(r.unread_count));
    });

    const mapped: DMConversation[] = conversationRows
      .map((conv) => {
        const otherId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
        const prof = otherId ? profileMap.get(otherId) : undefined;
        return {
          id: conv.id,
          other_user_id: otherId,
          other_nickname: otherId ? (prof?.nickname ?? "알 수 없음") : "탈퇴한 사용자",
          other_team_id: prof?.team_id ?? null,
          other_avatar_url: prof?.avatar_url ?? null,
          last_message: conv.last_message,
          last_message_at: conv.last_message_at,
          unread_count: unreadMap.get(conv.id) ?? 0,
        };
      })
      // 차단된 유저 대화 필터링
      .filter((conv: DMConversation) =>
        conv.other_user_id === null ||
        conv.other_user_id === BASEBALL_GENIUS_USER_ID ||
        !blockedIds.has(conv.other_user_id)
      );

    const geniusConversation = mapped.find(
      (conversation) => conversation.other_user_id === BASEBALL_GENIUS_USER_ID,
    );
    const pinnedGenius: DMConversation = geniusConversation ?? {
      id: `new-${BASEBALL_GENIUS_USER_ID}`,
      other_user_id: BASEBALL_GENIUS_USER_ID,
      other_nickname: BASEBALL_GENIUS_NAME,
      other_team_id: null,
      other_avatar_url: null,
      last_message: "야구 룰이나 용어를 물어보세요 ⚾",
      last_message_at: new Date(0).toISOString(),
      unread_count: 0,
    };
    setConversations([
      pinnedGenius,
      ...mapped.filter((conversation) => conversation.other_user_id !== BASEBALL_GENIUS_USER_ID),
    ]);
    setLoading(false);
  }, [user, blockedIds]);

  // 초기 load·Realtime refresh·폴링 폴백 모두 단일 request owner(single-flight)로 실행.
  // (컨슈머 효과보다 먼저 호출해 컨트롤러가 선생성되게 한다.)
  const requestLoad = usePollingFallback(load, {
    enabled: !!user,
    healthy: realtimeHealthy,
    intervalMs: DM_LIST_POLL_MS,
  });

  useEffect(() => { requestLoad(); }, [load, requestLoad]);

  // Realtime — dm_messages 변경(읽음 처리 포함) 시 목록/대화별 안읽음 재계산. 구독 상태를 폴링 폴백에 전달.
  useEffect(() => {
    if (!user) return;
    const generation = ++channelGenerationRef.current;

    const channel = supabase
      .channel("dm-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dm_messages" },
        () => { requestLoad(); }
      )
      .subscribe((status) => {
        if (channelGenerationRef.current !== generation) return;
        setRealtimeHealthy(status === "SUBSCRIBED");
      });

    return () => {
      if (channelGenerationRef.current === generation) {
        channelGenerationRef.current += 1;
        setRealtimeHealthy(false);
      }
      void supabase.removeChannel(channel);
    };
  }, [user, requestLoad]);

  return { conversations, loading, refresh: load };
}

// 개별 대화
export function useDMChat(conversationId: string) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [realtimeHealthy, setRealtimeHealthy] = useState(false);
  const loadGenerationRef = useRef(0);
  const channelGenerationRef = useRef(0);
  // 대화 전환마다 증가 — 늦게 resolve 된 send RPC 성공이 다른 대화 상태를 못 건드리게 하는 fence.
  const conversationGenerationRef = useRef(0);
  const [geniusReplyStates, setGeniusReplyStates] =
    useState<BaseballQaReplyStates>({});
  const processingBaseballQaRef = useRef(false);
  const observedBaseballQaReplyIdsRef = useRef(new Set<number>());
  const observedBaseballQaPickerIdsRef = useRef(new Set<number>());
  /**
   * picker 선택이 이미 끝난(또는 불가능한) 질문 id.
   *
   * 카드를 즉시 비활성화해 같은 카드의 다른 옵션·연속 탭이 여러 요청으로 갈라지지 않게 한다.
   */
  const [geniusPickedQuestionIds, setGeniusPickedQuestionIds] =
    useState<ReadonlySet<number>>(() => new Set<number>());
  /** 최종 답변이 있는 질문 id — 과거 picker 카드 재탭을 UI에서도 막는다. */
  const [geniusAnsweredQuestionIds, setGeniusAnsweredQuestionIds] =
    useState<ReadonlySet<number>>(() => new Set<number>());
  /**
   * "생각중" 을 한 번이라도 거친 질문 id — **append-only**.
   *
   * ⚠️ `geniusReplyStates` 는 답변이 도착하면 outbox 에서 빠지며 사라진다. 그래서 생각중
   * 말풍선도 같이 사라졌고, Production 실측상 그 노출이 **500ms** 뿐이라 사람 눈에 안 잡혔다
   * (사전 히트 답변은 +700ms 에 도착). 하린아빠 2026-08-04 20:27 지시대로 생각중을 대화
   * 기록으로 남기려면 "지금 대기 중인가"와 별개로 **거쳤다는 사실**을 따로 들고 있어야 한다.
   *
   * 대화 전환 시에만 비운다(answered/picked 집합과 같은 규칙) — 이전 대화의 질문 id 가
   * 다음 대화로 새지 않게.
   */
  const [geniusThinkingQuestionIds, setGeniusThinkingQuestionIds] =
    useState<ReadonlySet<number>>(() => new Set<number>());

  const observeBaseballQaMessages = useCallback((nextMessages: DMMessage[]) => {
    if (typeof window === "undefined") return;
    // 최종 답변 집합은 observed 여부와 무관하게 매 관측마다 갱신한다 — 이미 답변된
    // 히스토리만 불러온 재진입에서도 picker를 비활성화해야 한다.
    //
    // ⚠️ **관측은 누적 merge 이지 교체가 아니다**(삼순 5차 P0-a). 이 함수는 전체
    // 히스토리(`loadMessages`)로도 불리고 Realtime INSERT 단건(`[msg]`)으로도 불린다.
    // 단건 증분으로 집합을 교체하면 그 메시지 하나에 없는 answered id 가 전부 사라져
    // 이미 답변된 과거 picker 가 다시 활성화된다(= 영구 typing 재발).
    // 집합은 **대화 전환 시에만** 비우고(아래 conversationId effect), 그 외엔 단조 증가만 한다.
    const answered = collectBaseballQaAnsweredQuestionIds(
      nextMessages,
      BASEBALL_GENIUS_USER_ID,
    );
    // updater 를 factory 로 만든다 — 이 call-site 에는 `prev` 가 없으므로 누적을 버릴 방법이
    // 구조적으로 없다(삼순 6차 P0-3: `merge(new Set(), ...)` 변종 차단).
    setGeniusAnsweredQuestionIds(
      createBaseballQaAnsweredUpdater(nextMessages, BASEBALL_GENIUS_USER_ID),
    );
    for (const messageId of answered) observedBaseballQaReplyIdsRef.current.add(messageId);
    const observed = observeBaseballQaReplies(
      window.localStorage,
      nextMessages,
      BASEBALL_GENIUS_USER_ID,
    );
    if (observed.length === 0) return;
    for (const messageId of observed) {
      // 최종 답변이 질문 INSERT 응답보다 먼저 도착한 경우에만 enqueue를 막는다.
      // picker는 outbox를 보존해야 선택 클릭이 exact 원 질문을 재처리할 수 있다.
      if (nextMessages.some((message) =>
        message.sender_id === BASEBALL_GENIUS_USER_ID &&
        message.dedup_key === `baseball-genius:${messageId}`)) {
        observedBaseballQaReplyIdsRef.current.add(messageId);
      }
      if (nextMessages.some((message) =>
        message.sender_id === BASEBALL_GENIUS_USER_ID &&
        message.dedup_key === `baseball-genius-picker:${messageId}`)) {
        observedBaseballQaPickerIdsRef.current.add(messageId);
      }
    }
    setGeniusReplyStates(getBaseballQaReplyStates(readBaseballQaOutbox(window.localStorage)));
  }, []);

  const processBaseballQaOutbox = useCallback(async () => {
    if (typeof window === "undefined" || processingBaseballQaRef.current) return;
    processingBaseballQaRef.current = true;
    try {
      const queued = readBaseballQaOutbox(window.localStorage);
      if (queued.length === 0) {
        setGeniusReplyStates({});
        return;
      }
      const retrying = new Set(
        queued
          .filter((entry) =>
            !entry.acknowledged && entry.attempts < BASEBALL_QA_MAX_ATTEMPTS)
          .map((entry) => entry.messageId),
      );
      setGeniusReplyStates(getBaseballQaReplyStates(queued, retrying));
      const { data: { session } } = await supabase.auth.getSession();
      await attemptBaseballQaOutbox(
        window.localStorage,
        session?.access_token ?? null,
      );
      setGeniusReplyStates(getBaseballQaReplyStates(readBaseballQaOutbox(window.localStorage)));
    } finally {
      processingBaseballQaRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    const initial = window.setTimeout(() => {
      void processBaseballQaOutbox();
    }, 0);
    const handleOnline = () => { void processBaseballQaOutbox(); };
    window.addEventListener("online", handleOnline);
    return () => {
      window.clearTimeout(initial);
      window.removeEventListener("online", handleOnline);
    };
  }, [user, processBaseballQaOutbox]);

  // 대기 상태로 관측된 질문은 전부 "생각중을 거친" 것으로 누적한다. 여기서만 더하고
  // 빼지 않으므로 답변 도착으로 outbox 가 비어도 말풍선이 유지된다.
  useEffect(() => {
    const ids = Object.keys(geniusReplyStates)
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) return;
    setGeniusThinkingQuestionIds((prev) => {
      let next: Set<number> | null = null;
      for (const id of ids) {
        if (prev.has(id)) continue;
        next ??= new Set(prev);
        next.add(id);
      }
      return next ?? prev;
    });
  }, [geniusReplyStates]);

  useEffect(() => {
    if (!Object.values(geniusReplyStates).some((state) => state === "waiting")) return;
    const timer = window.setTimeout(() => {
      void processBaseballQaOutbox();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [geniusReplyStates, processBaseballQaOutbox]);

  const retryBaseballQa = useCallback((messageId: number) => {
    if (typeof window === "undefined") return;
    resetBaseballQaQuestion(window.localStorage, messageId);
    setGeniusReplyStates(
      getBaseballQaReplyStates(
        readBaseballQaOutbox(window.localStorage),
        new Set([messageId]),
      ),
    );
    void processBaseballQaOutbox();
  }, [processBaseballQaOutbox]);

  /**
   * 동명이인 picker 선택 — 새 질문을 보내지 않고 **원래 질문 messageId를 그대로 재처리**한다.
   * 새 메시지를 만들면 quota가 또 예약되고 대화창에 같은 질문이 두 번 남는다.
   */
  const pickBaseballQaPlayer = useCallback((messageId: number, kboId: string) => {
    if (typeof window === "undefined" || !conversationId) return;
    // 이미 최종 답변이 있거나 이번 세션에서 이미 고른 질문은 요청을 만들지 않는다.
    // 서버는 dedup 200만 돌려주고 새 DM이 안 생기므로 outbox가 waiting으로 영원히 남는다.
    if (geniusPickedQuestionIds.has(messageId)) return;
    const enqueued = applyBaseballQaPlayerPick(
      window.localStorage,
      conversationId,
      messageId,
      kboId,
      observedBaseballQaReplyIdsRef.current.has(messageId),
    );
    setGeniusPickedQuestionIds((prev) => {
      if (prev.has(messageId)) return prev;
      const next = new Set(prev);
      next.add(messageId);
      return next;
    });
    if (!enqueued) return;
    setGeniusReplyStates(
      getBaseballQaReplyStates(
        readBaseballQaOutbox(window.localStorage),
        new Set([messageId]),
      ),
    );
    void processBaseballQaOutbox();
  }, [conversationId, processBaseballQaOutbox, geniusPickedQuestionIds]);

  // 대화 전환(A→B) 즉시 렌더 시점에 이전 대화 화면을 무효화한다:
  // A 메시지 잔존 상태로 B composer 가 뜨면 A 화면을 보고 B 에 오발송하는 창이 생긴다.
  // (React 공식 "렌더 중 이전 렌더 값 비교 후 setState" 패턴 — effect 보다 먼저 적용된다.)
  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  if (activeConversationId !== conversationId) {
    setActiveConversationId(conversationId);
    setMessages([]);
    setLoading(Boolean(conversationId));
    setRealtimeHealthy(false);
  }

  // 전환 commit 직후(paint 전·비동기 이벤트 개입 전) 이전 대화 소속 load/payload 를 fence.
  // (렌더 중 ref 변경은 react-hooks/refs 위반이라 layout effect 에서 수행.)
  useIsomorphicLayoutEffect(() => {
    loadGenerationRef.current += 1;
    channelGenerationRef.current += 1;
    conversationGenerationRef.current += 1;
  }, [conversationId]);

  // 메시지 로드/재조회 — 초기는 replace, 폴링 폴백은 merge(append 보존).
  const loadMessages = useCallback(
    async (mode: "replace" | "merge" = "merge") => {
      if (!conversationId) return;
      const generation = loadGenerationRef.current;

      const { data } = await supabase
        .from("dm_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (data) {
        // batch fetch sender profiles
        const senderIds = [
          ...new Set(
            data
              .map((m: DMMessage) => m.sender_id)
              .filter((id): id is string => id !== null),
          ),
        ];
        const { data: profiles } = senderIds.length > 0
          ? await supabase
              .from("profiles")
              .select("id, nickname, team_id")
              .in("id", senderIds)
          : { data: [] };

        const profileMap = new Map(
          (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null }) => [p.id, p])
        );

        const mapped = data.reverse().map((m: DMMessage) => {
          const prof = m.sender_id ? profileMap.get(m.sender_id) : undefined;
          return {
            ...m,
            sender_nickname: m.sender_id ? (prof?.nickname ?? "익명") : "탈퇴한 사용자",
            sender_team_id: prof?.team_id,
          };
        });
        if (loadGenerationRef.current !== generation) return;
        observeBaseballQaMessages(mapped);
        setMessages((prev) =>
          mode === "replace" ? mapped : mergeDmMessagesById(prev, mapped),
        );
      }
      if (loadGenerationRef.current !== generation) return;
      setLoading(false);
    },
    [conversationId, observeBaseballQaMessages],
  );

  // Realtime 이 끊긴 동안만 보이는 대화창을 주기 재조회(새 메시지 무증상 누락 방지).
  // requestLoad 는 초기 replace 를 포함한 모든 재조회의 단일 owner(동시 요청 최대 1).
  const requestLoad = usePollingFallback(loadMessages, {
    enabled: !!conversationId,
    healthy: realtimeHealthy,
    intervalMs: DM_CHAT_POLL_MS,
  });

  // 대화 전환 시에는 replace 로 새 대화 메시지만 로드.
  // single-flight 대기 중 대화가 또 바뀌면 generation 가드가 실행 자체를 건너뛴다.
  useEffect(() => {
    // answered/picked 집합은 관측 단계에서 누적만 하므로(증분 교체 금지), 대화가
    // 바뀔 때 여기서 버린다. 이게 없으면 이전 대화의 question id 가 다음 대화로 샐다.
    setGeniusAnsweredQuestionIds((prev) => (prev.size === 0 ? prev : new Set<number>()));
    setGeniusPickedQuestionIds((prev) => (prev.size === 0 ? prev : new Set<number>()));
    setGeniusThinkingQuestionIds((prev) => (prev.size === 0 ? prev : new Set<number>()));
    const generation = ++loadGenerationRef.current;
    requestLoad(() => {
      if (loadGenerationRef.current !== generation) return;
      return loadMessages("replace");
    });
    return () => {
      if (loadGenerationRef.current === generation) {
        loadGenerationRef.current += 1;
      }
    };
  }, [conversationId, loadMessages, requestLoad]);

  // 읽음 처리
  useEffect(() => {
    if (!user || !conversationId) return;

    supabase
      .from("dm_messages")
      .update({ is_read: true })
      .eq("conversation_id", conversationId)
      .eq("is_read", false)
      .or(`sender_id.neq.${user.id},sender_id.is.null`)
      .then(() => {});
  }, [user, conversationId, messages.length]);

  // Realtime
  useEffect(() => {
    if (!conversationId) return;
    const generation = ++channelGenerationRef.current;

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
          if (channelGenerationRef.current !== generation) return;
          const msg = payload.new as DMMessage;
          observeBaseballQaMessages([msg]);
          // 낙관 append(발신자 본인 echo)로 이미 넣은 행이면 중복 방지
          let alreadyPresent = false;
          setMessages((prev) => {
            alreadyPresent = prev.some((m) => m.id === msg.id);
            return prev;
          });
          if (alreadyPresent) return;

          const { data: prof } = msg.sender_id
            ? await supabase
                .from("profiles")
                .select("nickname, team_id")
                .eq("id", msg.sender_id)
                .maybeSingle()
            : { data: null };

          if (channelGenerationRef.current !== generation) return;
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id)
              ? prev
              : [
                  ...prev,
                  {
                    ...msg,
                    sender_nickname: msg.sender_id
                      ? (prof?.nickname ?? "익명")
                      : "탈퇴한 사용자",
                    sender_team_id: prof?.team_id,
                  },
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
      .subscribe((status) => {
        if (channelGenerationRef.current !== generation) return;
        setRealtimeHealthy(status === "SUBSCRIBED");
      });

    return () => {
      if (channelGenerationRef.current === generation) {
        channelGenerationRef.current += 1;
        setRealtimeHealthy(false);
      }
      void supabase.removeChannel(channel);
    };
  }, [conversationId, user, observeBaseballQaMessages]);

  // 메시지 전송: 방 생성·메시지 INSERT·목록 preview를 DB 한 트랜잭션으로 처리한다.
  const sendMessage = useCallback(
    async (content: string, imageUrls?: string[], targetUserIdOverride?: string) => {
      const trimmed = content.trim();
      const images = (imageUrls ?? []).filter((u) => typeof u === "string" && u.length > 0);
      // 텍스트 또는 사진 중 하나는 있어야 전송
      if (!user || (!trimmed && images.length === 0)) return { ok: false, conversationId: null };
      // RPC await 중 A→B 전환 시 late 성공이 B 화면에 A 메시지를 append 하는 것을 막는 fence.
      // (서버 반영 자체는 유효 — 훅 상태 갱신만 폐기한다.)
      const sendGeneration = conversationGenerationRef.current;

      let targetUserId = targetUserIdOverride;
      if (!targetUserId && conversationId) {
        const { data: conv } = await supabase
          .from("dm_conversations")
          .select("user1_id, user2_id")
          .eq("id", conversationId)
          .maybeSingle();
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
        if (
          result?.message_id &&
          conversationId &&
          result.conversation_id === conversationId &&
          conversationGenerationRef.current === sendGeneration
        ) {
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

        // 야잘알봇 질문은 기존 DM insert 성공 후 서버 파이프라인이 같은 대화에
        // 시스템 계정 답변을 넣는다. 답변 INSERT도 기존 DM push trigger를 그대로 탄다.
        if (
          result?.message_id &&
          targetUserId === BASEBALL_GENIUS_USER_ID
        ) {
          if (!observedBaseballQaReplyIdsRef.current.has(result.message_id)) {
            enqueueBaseballQaQuestion(window.localStorage, {
              conversationId: result.conversation_id,
              messageId: result.message_id,
            });
            if (observedBaseballQaPickerIdsRef.current.has(result.message_id)) {
              observeBaseballQaReplies(window.localStorage, [{
                sender_id: BASEBALL_GENIUS_USER_ID,
                dedup_key: `baseball-genius-picker:${result.message_id}`,
              }], BASEBALL_GENIUS_USER_ID);
            }
          }
          setGeniusReplyStates(
            getBaseballQaReplyStates(readBaseballQaOutbox(window.localStorage)),
          );
          void processBaseballQaOutbox();
        }
      }

      return { ok: !error, conversationId: result?.conversation_id ?? null };
    },
    [user, conversationId, processBaseballQaOutbox]
  );

  return {
    messages,
    loading,
    sendMessage,
    isLoggedIn: !!user,
    geniusReplyStates,
    retryBaseballQa,
    pickBaseballQaPlayer,
    geniusPickedQuestionIds,
    geniusAnsweredQuestionIds,
    geniusThinkingQuestionIds,
  };
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
