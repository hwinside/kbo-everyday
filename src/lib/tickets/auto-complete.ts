/** A game remains transferable throughout its calendar date in Korea. */
export function resolveTicketStatus(
  ticket: { status: string; game_date: string | null },
  todayKst: string,
): string {
  if (ticket.status !== "open" && ticket.status !== "reserved") return ticket.status;
  const date = ticket.game_date;
  // Fail closed for legacy/malformed dates; never infer a missing game date.
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return ticket.status;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return ticket.status;
  }
  return date < todayKst ? "sold" : ticket.status;
}
