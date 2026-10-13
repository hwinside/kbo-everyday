import { supabase, getSafeSession } from "@/lib/supabase/client";
import { getAuthIdentity } from "@/lib/supabase/auth-identity";
import type { FavoritePlayer } from "@/lib/store/favorites";
import {
  createFavoritesSaver,
  ownedRow,
  tokenForUser,
  isActiveUser,
  ProfileSaveError,
  GENERIC_MESSAGE,
  type FavoritesSaver,
  type FavoriteSaveUpdates,
  type AuthSaveIdentity,
} from "@/lib/profile/favorites-saver-core";

/**
 * 최애선수/팀 저장 wiring (2026-08-24 최애선수 설정 유실 수정).
 *
 * 실제 로직·계약(직렬화 latest-wins, bounded auth/fetch, 401 refresh 1회
 * +재시도 1회, lastSaved 정합)은 favorites-saver-core.ts — tsx로 직접 회귀를
 * 태운다(`npm run qa:favorites-save`). 이 파일은 브라우저 의존성 결선만 담당.
 *
 * 계정 격리(삼순 4차 리뷰): saver는 **user ID별 인스턴스** — lastSaved가
 * 계정에 결속돼 계정 전환 시 다른 계정의 row가 넘어올 수 없다. 여기에 더해
 * 반환 직전 `ownedRow(row, userId)` fail-close 이중 방어(서버가 다른 계정
 * row를 반환하는 비정상 경우까지 차단). 호출부도 lastSaved 사용 시 같은
 * 가드를 다시 태운다.
 */

export { ProfileSaveError, ownedRow, isActiveUser };
export type { AuthSaveIdentity };

/** 서버가 반환한 저장된 profiles row 중 호출자가 쓰는 필드. */
export interface SavedProfileRow {
  id: string;
  team_id: number;
  favorite_players: FavoritePlayer[];
}

const REQUEST_TIMEOUT_MS = 10000;

// UID별 saver — 직렬화 체인은 UID 단위로 epoch를 넘어 유지(삼순 8차): 옥 epoch 느린
// PUT이 새 epoch 빠른 PUT 뒤 완료해 DB를 되돌리는 것을 차단. lastSaved만 epoch 격리는
// saver 내부(createFavoritesSaver)에서 처리. save(updates, epoch)에 요청 epoch 전달.
const savers = new Map<string, FavoritesSaver<SavedProfileRow>>();

function saverFor(userId: string): FavoritesSaver<SavedProfileRow> {
  const existing = savers.get(userId);
  if (existing) return existing;
  // 토큰 소유 fail-close(삼순 5차): 초기 세션·401 refresh 모두 세션의 user.id가
  // 이 saver의 userId와 일치할 때만 토큰 반환 — 계정 전환 중 B 토큰으로 PUT해
  // B DB를 갱신하는 side effect를 PUT **전**에 차단(tokenForUser).
  const created = createFavoritesSaver<SavedProfileRow>({
    getToken: async () => tokenForUser(await getSafeSession(), userId),
    refreshToken: async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) return null;
        return tokenForUser(data.session, userId);
      } catch {
        return null;
      }
    },
    // 실행 시점 current-epoch fail-close(삼순 10차): 요청이 큐에서 대기하는 사이
    // A→B→A(신원 전환마다 epoch 증가)로 바뀌면 옛 epoch 요청은 token/PUT 직전
    // ensureCurrent에서 멈춰 PUT 0으로 종료된다(handler enqueue 전 검사만으로는
    // 못 닫는 큐 대기 창을 saver 실행면에서 닫는다).
    currentEpoch: () => getAuthIdentity().epoch,
    putFavorites: async (token, updates) => {
      const res = await fetch("/api/me/favorite-players", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          // 서버측 이중 방어: 토큰 user와 기대 user 불일치면 409(저장 안 함)
          "X-Expected-User-Id": userId,
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
  savers.set(userId, created);
  return created;
}

/**
 * 최애선수(+옵션 팀) 저장. identity는 요청 시작 시 캡처한 `{uid, epoch}` — saver 격리
 * 키(uid:epoch)이자 반환 row 소유 검증 기준(uid). epoch 격리로 계정 전환·동일 UID
 * 재인증 후 옥 lastSaved가 새 세션으로 넘어오지 않는다(삼순 7차).
 * @returns 저장된 row. 더 최신 저장 요청에 의해 대체(superseded)됐으면 null —
 *          호출자는 아무 것도 commit하지 않고 최신 요청의 결과를 기다린다.
 * @throws ProfileSaveError 저장 실패(needsRelogin이면 재로그인 안내).
 *         반환 row가 uid 소유가 아니면 fail-close 실패 처리.
 */
export async function saveMyFavorites(
  updates: FavoriteSaveUpdates & { favorite_players: FavoritePlayer[] },
  identity: AuthSaveIdentity
): Promise<SavedProfileRow | null> {
  // saver는 uid로만 격리(체인은 epoch를 넘어 유지) — lastSaved만 epoch 격리.
  const outcome = await saverFor(identity.uid).save(updates, identity.epoch);
  if (outcome.superseded) return null;
  const owned = ownedRow(outcome.profile, identity.uid);
  if (!owned) throw new ProfileSaveError(GENERIC_MESSAGE); // 소유 불일치 — commit 금지
  return owned;
}
