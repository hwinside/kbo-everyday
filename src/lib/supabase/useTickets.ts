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
  status: "open" | "reserved" | "sold" | "expired";
  contact_method: string;
  contact_info: string | null;
  description: string | null;
  image_urls: string[];
  created_at: string;
  expires_at: string | null;
  profiles?: { nickname: string; team_id: number };
}

export function useTickets(venueId?: string, teamId?: number) {
  const [tickets, setTickets] = useState<TicketTransfer[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("ticket_transfers")
      .select("*, profiles(nickname, team_id)")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(50);

    if (venueId) query = query.eq("venue_id", venueId);
    if (teamId) query = query.eq("team_id", teamId);

    const { data } = await query;
    setTickets((data as TicketTransfer[]) || []);
    setLoading(false);
  }, [venueId, teamId]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  async function createTicket(ticket: Omit<TicketTransfer, "id" | "created_at" | "status" | "profiles">) {
    const { error } = await supabase.from("ticket_transfers").insert(ticket);
    if (error) throw error;
    await fetchTickets();
  }

  async function updateStatus(ticketId: number, status: string) {
    const { error } = await supabase
      .from("ticket_transfers")
      .update({ status })
      .eq("id", ticketId);
    if (error) throw error;
    await fetchTickets();
  }

  return { tickets, loading, createTicket, updateStatus, refresh: fetchTickets };
}
