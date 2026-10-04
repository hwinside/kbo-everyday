import { isAllStarGameId } from "@/lib/constants/teams";

/** KBO gameId → Naver gameId (연도 접미). 올스타는 앞 4자리를 9999 로 서비스. */
export function naverGameId(kboGameId: string): string {
  const year = kboGameId.slice(0, 4);
  const base = isAllStarGameId(kboGameId) ? `9999${kboGameId.slice(4)}` : kboGameId;
  return `${base}${year}`;
}
