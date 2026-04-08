"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { Loader2, MessageCircle, Send, ArrowLeft, User } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";

interface Conversation {
  id: string;
  other_user_id: string;
  other_nickname: string;
  other_team_id: number | null;
  last_message: string | null;
  last_message_at: string;
  unread_count: number;
}

interface Message {
  id: number;
  conversation_id: string;
  sender_id: string;
  sender_nickname: string;
  content: string;
  is_read: boolean;
  is_system: boolean;
  created_at: string;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

function getTeamColor(teamId: number | null) {
  if (!teamId) return "#6366F1";
  const team = getTeamById(teamId);
  return team?.colorPrimary || "#6366F1";
}

export default function AdminMessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const getPin = useCallback(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("admin_pin") || "";
    }
    return "";
  }, []);

  // 대화 목록 로드
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/admin/messages", {
          headers: { "x-admin-pin": getPin() },
        });
        if (res.ok) {
          const json = await res.json();
          setConversations(json.conversations || []);
        }
      } catch { /* ignore */ }
      setLoading(false);
    }
    load();
  }, [getPin]);

  // 대화 상세 로드
  async function loadMessages(conv: Conversation) {
    setSelectedConv(conv);
    setMsgLoading(true);
    setMessages([]);
    try {
      const res = await fetch(`/api/admin/messages?conversationId=${conv.id}`, {
        headers: { "x-admin-pin": getPin() },
      });
      if (res.ok) {
        const json = await res.json();
        setMessages(json.messages || []);
      }
    } catch { /* ignore */ }
    setMsgLoading(false);
  }

  // 답장 전송
  async function handleSend() {
    if (!selectedConv || !replyText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-pin": getPin(),
        },
        body: JSON.stringify({
          conversationId: selectedConv.id,
          content: replyText.trim(),
        }),
      });
      if (res.ok) {
        setReplyText("");
        // 메시지 다시 로드
        await loadMessages(selectedConv);
      }
    } catch { /* ignore */ }
    setSending(false);
  }

  // 스크롤 하단 자동 이동
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 animate-spin text-[#6366F1]" />
      </div>
    );
  }

  // 대화 상세 보기
  if (selectedConv) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setSelectedConv(null); setMessages([]); }}
            className="p-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: `${getTeamColor(selectedConv.other_team_id)}20` }}
            >
              <User className="w-4 h-4" style={{ color: getTeamColor(selectedConv.other_team_id) }} />
            </div>
            <h1 className="text-lg font-bold">{selectedConv.other_nickname}</h1>
          </div>
        </div>

        {/* 메시지 목록 */}
        <div className="glass-card p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {msgLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[#6366F1]" />
            </div>
          ) : messages.length === 0 ? (
            <p className="text-center text-[#8E8E93] py-8">메시지 없음</p>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.is_system ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm ${
                    msg.is_system
                      ? "bg-[#6366F1] text-white"
                      : "bg-white/8 text-white"
                  }`}
                >
                  {!msg.is_system && (
                    <p className="text-xs text-[#8E8E93] mb-1">{msg.sender_nickname}</p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  <p className={`text-xs mt-1 ${msg.is_system ? "text-white/60" : "text-[#636366]"}`}>
                    {timeAgo(msg.created_at)}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 답장 입력 */}
        <div className="glass-card p-3 flex items-center gap-2">
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="운영팀으로 답장..."
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-[#636366]"
          />
          <button
            onClick={handleSend}
            disabled={!replyText.trim() || sending}
            className="p-2 rounded-lg bg-[#6366F1] hover:bg-[#5558E6] disabled:opacity-40 transition-colors"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    );
  }

  // 대화 목록
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <MessageCircle className="w-6 h-6 text-[#6366F1]" />
        <h1 className="text-2xl font-bold">운영팀 쪽지함</h1>
        <span className="text-sm text-[#8E8E93]">
          {conversations.length}개 대화
          {conversations.reduce((sum, c) => sum + c.unread_count, 0) > 0 && (
            <span className="ml-1 text-[#FF453A]">
              · {conversations.reduce((sum, c) => sum + c.unread_count, 0)}개 안 읽음
            </span>
          )}
        </span>
      </div>

      {conversations.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <MessageCircle className="w-12 h-12 text-[#636366] mx-auto mb-3" />
          <p className="text-[#8E8E93]">아직 대화가 없습니다</p>
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => loadMessages(conv)}
              className="w-full text-left glass-card p-4 hover:bg-white/5 transition-colors rounded-xl"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: `${getTeamColor(conv.other_team_id)}20` }}
                >
                  <User className="w-5 h-5" style={{ color: getTeamColor(conv.other_team_id) }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{conv.other_nickname}</span>
                    <span className="text-xs text-[#636366]">{timeAgo(conv.last_message_at)}</span>
                  </div>
                  <p className="text-sm text-[#8E8E93] truncate mt-0.5">
                    {conv.last_message || "새 대화"}
                  </p>
                </div>
                {conv.unread_count > 0 && (
                  <div className="w-5 h-5 rounded-full bg-[#FF453A] flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold">{conv.unread_count}</span>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
