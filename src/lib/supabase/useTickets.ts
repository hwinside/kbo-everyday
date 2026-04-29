"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "./client";

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
    const { error } = await supabase
      .from("ticket_transfers")
      .update({ status })
      .eq("id", id);
    if (error) return { error: error.message };
    setTickets(prev =>
      prev.map(t => (t.id === id ? { ...t, status } : t))
    );
    return {};
  }, []);

  return { tickets, loading, createTicket, updateTicketStatus };
}
