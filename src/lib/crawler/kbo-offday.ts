/** A second KBO endpoint must bracket the requested date before an empty slate
 * is authoritative. Never infer an off day from a failed/empty calendar response.
 * GetKboGameDate returns NOW=requested on game days, otherwise the next game date.
 */
export function isConfirmedKboOffday(date: string, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  const validDate = (v: unknown): v is string => {
    if (typeof v !== "string" || !/^\d{8}$/.test(v)) return false;
    const parsed = new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10).replaceAll("-", "") === v;
  };
  return data.code === "100" && validDate(date)
    && validDate(data.BEFORE_G_DT) && validDate(data.NOW_G_DT) && validDate(data.AFTER_G_DT)
    && data.BEFORE_G_DT < date && date < data.NOW_G_DT && data.NOW_G_DT < data.AFTER_G_DT;
}

export async function confirmKboOffday(
  date: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl("https://www.koreabaseball.com/ws/Main.asmx/GetKboGameDate", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
    },
    // Match the live scoreboard's entire series scope, including postseason.
    body: new URLSearchParams({ leId: "1", srId: "0,1,3,4,5,7,8,9", date }).toString(),
    cache: "no-store",
    signal,
  });
  if (!response.ok) return false;
  return isConfirmedKboOffday(date, await response.json());
}
