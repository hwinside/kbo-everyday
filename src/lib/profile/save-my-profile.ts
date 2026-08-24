import { supabase } from "@/lib/supabase/client";
import type { FavoritePlayer } from "@/lib/store/favorites";

/**
 * 최애선수/팀 저장 클라이언트 헬퍼 (2026-08-24 최애선수 설정 유실 수정).
 *
 * 계약:
 * - 서버 라우트(/api/me/favorite-players)에 Bearer로 저장하고 **저장된 row를
 *   반환**한다. 호출자는 이 반환값으로만 로컬 상태를 확정한다(성공 전 commit 금지).
 * - 401(만료 토큰)이면 refreshSession **1회만** 시도 후 **1회만** 재시도한다
 *   (bounded — 무한 루프 없음). 그래도 실패하면 needsRelogin 오류로 던져
 *   호출자가 재로그인 안내를 노출한다. 조용한 롤백 금지.
 */

const RELOGIN_MESSAGE = "로그인이 만료됐어요. 다시 로그인한 뒤 시도해주세요.";
const GENERIC_MESSAGE = "저장에 실패했어요. 잠시 후 다시 시도해주세요.";

export class ProfileSaveError extends Error {
  needsRelogin: boolean;
  constructor(message: string, needsRelogin = false) {
    super(message);
    this.name = "ProfileSaveError";
    this.needsRelogin = needsRelogin;
  }
}

/** 서버가 반환한 저장된 profiles row 중 호출자가 쓰는 필드. */
export interface SavedProfileRow {
  id: string;
  team_id: number;
  favorite_players: FavoritePlayer[];
}

async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (error) return null;
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function putOnce(
  token: string,
  updates: { team_id?: number; favorite_players: FavoritePlayer[] }
): Promise<Response> {
  return fetch("/api/me/favorite-players", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });
}

export async function saveMyFavorites(updates: {
  team_id?: number;
  favorite_players: FavoritePlayer[];
}): Promise<SavedProfileRow> {
  let token = await getAccessToken();
  if (!token) token = await refreshAccessToken();
  if (!token) throw new ProfileSaveError(RELOGIN_MESSAGE, true);

  let res: Response;
  try {
    res = await putOnce(token, updates);
  } catch {
    throw new ProfileSaveError(GENERIC_MESSAGE);
  }

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new ProfileSaveError(RELOGIN_MESSAGE, true);
    try {
      res = await putOnce(refreshed, updates);
    } catch {
      throw new ProfileSaveError(GENERIC_MESSAGE);
    }
    if (res.status === 401) throw new ProfileSaveError(RELOGIN_MESSAGE, true);
  }

  if (!res.ok) throw new ProfileSaveError(GENERIC_MESSAGE);

  let json: { ok?: boolean; profile?: SavedProfileRow };
  try {
    json = await res.json();
  } catch {
    throw new ProfileSaveError(GENERIC_MESSAGE);
  }
  if (!json.ok || !json.profile) throw new ProfileSaveError(GENERIC_MESSAGE);
  return json.profile;
}
