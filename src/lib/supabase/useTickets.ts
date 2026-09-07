"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "./client";
import { getKSTToday } from "@/lib/utils/date-kst";
import { resolveTicketStatus } from "@/lib/tickets/auto-complete";

export interface TicketTransfer {
  id: number;
  author_id: string;
  team_id: number;
  venue_id: string;
  game_date: string;
  opponent_team_id: number | null;
  seat_area: string;
  seat_detail: string | null;
  quantity: number;
  price: number;
  original_price: number | null;
  status: string;
  contact_method: string;
  contact_info: string | null;
  description: string | null;
  image_urls: string[];
  created_at: string;
  expires_at: string | null;
  // joined
  author_nickname?: string;
}

export function useTickets(venueId?: string) {
  const [tickets, setTickets] = useState<TicketTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [todayKst, setTodayKst] = useState(getKSTToday);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refreshDay = () => {
      clearTimeout(timer);
      const today = getKSTToday();
      setTodayKst(today);
      const nextMidnight = new Date(`${today}T00:00:00+09:00`).getTime() + 86_400_000;
      timer = setTimeout(refreshDay, Math.max(1, nextMidnight - Date.now()));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshDay();
    };
    refreshDay();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshDay);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshDay);
    };
  }, []);

  useEffect(() => {
    async function load() {
      let query = supabase
        .from("ticket_transfers")
        .select("*, profiles!ticket_transfers_author_id_fkey(nickname)")
        .in("status", ["open", "reserved", "sold"])
        .order("created_at", { ascending: false })
        .limit(50);

      if (venueId) query = query.eq("venue_id", venueId);

      const { data } = await query;
      if (data) {
        setTickets(data.map((d: TicketTransfer & { profiles?: { nickname?: string } }) => ({
          ...d,
          author_nickname: d.profiles?.nickname,
        })));
      }
      setLoading(false);
    }
    load();
  }, [venueId]);

  const createTicket = useCallback(async (ticket: Partial<TicketTransfer>) => {
    const { data, error } = await supabase
      .from("ticket_transfers")
      .insert(ticket)
      .select()
      .single();
    if (error) return { error: error.message };
    if (data) setTickets(prev => [data as TicketTransfer, ...prev]);
    return { data };
  }, []);

  const updateTicketStatus = useCallback(async (id: number, status: string) => {
    const { data, error } = await supabase
      .from("ticket_transfers")
      .update({ status })
      .eq("id", id)
      .select("status")
      .single();
    if (error) return { error: error.message };
    // The DB trigger may complete an old ticket instead of accepting a stale
    // "reserved" write. Also require a returned row (RLS may update zero rows).
    setTickets(prev =>
      prev.map(t => (t.id === id ? { ...t, status: data.status } : t))
    );
    return {};
  }, []);

  // Keep the raw rows: only the display is projected while the DB sweep catches
  // up. No per-reader privileged write or extra polling query is needed.
  const visibleTickets = useMemo(() => tickets.map(ticket => ({
    ...ticket,
    status: resolveTicketStatus(ticket, todayKst),
  })), [tickets, todayKst]);

  return { tickets: visibleTickets, loading, createTicket, updateTicketStatus };
}
