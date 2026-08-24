import { supabase, getSafeSession } from "@/lib/supabase/client";
import type { FavoritePlayer } from "@/lib/store/favorites";
import {
  createFavoritesSaver,
  ProfileSaveError,
  type FavoriteSaveUpdates,
} from "@/lib/profile/favorites-saver-core";

/**
 * 최애선수/팀 저장 wiring (2026-08-24 최애선수 설정 유실 수정).
 *
 * 실제 로직·계약(직렬화 latest-wins, bounded auth/fetch, 401 refresh 1회
 * +재시도 1회)은 favorites-saver-core.ts — tsx로 직접 회귀를 태운다
 * (`npm run qa:favorites-save`). 이 파일은 브라우저 의존성 결선만 담당:
 * - getToken: getSafeSession (auth-lock hang 방어가 이미 내장된 repo 표준)
 * - refreshToken: supabase.auth.refreshSession (core가 timeout bound)
 * - putFavorites: fetch + AbortSignal.timeout (core race와 이중 방어)
 */

export { ProfileSaveError };

/** 서버가 반환한 저장된 profiles row 중 호출자가 쓰는 필드. */
export interface SavedProfileRow {
  id: string;
  team_id: number;
  favorite_players: FavoritePlayer[];
}

const REQUEST_TIMEOUT_MS = 10000;

const saver = createFavoritesSaver<SavedProfileRow>({
  getToken: async () => (await getSafeSession())?.access_token ?? null,
  refreshToken: async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (error) return null;
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  },
  putFavorites: async (token, updates) => {
    const res = await fetch("/api/me/favorite-players", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updates),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  },
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
});

/**
 * 최애선수(+옵션 팀) 저장.
 * @returns 저장된 row. 더 최신 저장 요청에 의해 대체(superseded)됐으면 null —
 *          호출자는 아무 것도 commit하지 않고 최신 요청의 결과를 기다린다.
 * @throws ProfileSaveError 저장 실패(needsRelogin이면 재로그인 안내).
 */
export async function saveMyFavorites(
  updates: FavoriteSaveUpdates & { favorite_players: FavoritePlayer[] }
): Promise<SavedProfileRow | null> {
  const outcome = await saver.save(updates);
  if (outcome.superseded) return null;
  return outcome.profile;
}
