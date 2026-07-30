/**
 * DM 메시지 타입 + 순수 병합 로직 (React·Supabase 비의존).
 * 폴링 폴백 재조회 결과를 기존 상태에 안전하게 병합한다.
 */

export interface DMMessage {
  id: number;
  conversation_id: string;
  sender_id: string | null;
  content: string;
  image_urls?: string[] | null;
  /** 구조화 쪽지 (뉴스클리핑 등) — payload->>'type'으로 렌더 분기 */
  payload?: unknown;
  is_read: boolean;
  created_at: string;
  sender_nickname?: string;
  sender_team_id?: number | null;
}

/**
 * 폴링 재조회 결과를 기존 메시지에 id 기준으로 병합(전체 교체 X → 스크롤 튐/낙관 append 보존).
 * incoming 은 같은 대화의 최근 메시지다. 대화 전환 중 구(prev) 대화 메시지가
 * 섞이는 leak 을 막기 위해 incoming 과 다른 conversation_id 의 prev 는 버린다.
 */
export function mergeDmMessagesById(
  prev: DMMessage[],
  incoming: DMMessage[],
): DMMessage[] {
  if (incoming.length === 0) return prev;
  const convId = incoming[0].conversation_id;
  const byId = new Map<number, DMMessage>();
  for (const m of prev) {
    if (m.conversation_id === convId) byId.set(m.id, m);
  }
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}
