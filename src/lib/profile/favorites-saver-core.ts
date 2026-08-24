/**
 * 최애선수 저장 core (2026-08-24, PR #1297 삼순 NO-GO 3축 반영).
 *
 * 순수 로직 + 의존성 주입 — 브라우저 없는 실행면(tsx/node)에서 행동 회귀를
 * 직접 태울 수 있게 auth/fetch를 전부 주입받는다(검증 가능성은 배치의 함수).
 *
 * 계약:
 * 1) **저장 직렬화 + latest-wins**: 모든 save()는 단일 체인에서 순서대로
 *    실행된다. 이전 요청이 in-flight면 다음 요청은 그 완료를 기다리므로
 *    delayed-A/fast-B에서도 서버 도착 순서가 뒤집히지 않는다. 실행 차례가
 *    왔을 때 더 최신 save()가 이미 접수돼 있으면 그 요청은 서버로 보내지
 *    않고 superseded로 끝난다 → DB 최종값 = 항상 마지막 선택.
 * 2) **bounded**: getToken/refreshToken/putFavorites 가 never-settle이어도
 *    (네이티브 auth-lock hang #209/#419, 네트워크 hang) 타임아웃 상한 안에
 *    반드시 실패로 종료한다. 무기한 await 없음.
 * 3) **401 → refresh 1회 + 재시도 1회**: 그래도 401이면 needsRelogin 오류.
 *    성공 판정은 서버가 반환한 저장된 row가 있을 때만.
 */

export const RELOGIN_MESSAGE = "로그인이 만료됐어요. 다시 로그인한 뒤 시도해주세요.";
export const GENERIC_MESSAGE = "저장에 실패했어요. 잠시 후 다시 시도해주세요.";

export class ProfileSaveError extends Error {
  needsRelogin: boolean;
  /**
   * 이 saver에서 마지막으로 **성공한 저장의 서버 row**(없으면 null).
   * A 성공 후 최신 B 실패 시 로컬=기존값·DB=A로 갈라지므로, 호출자는 실패 시
   * 이 값(= DB 현재값)으로 로컬을 정합한다.
   */
  lastSaved: unknown = null;
  constructor(message: string, needsRelogin = false) {
    super(message);
    this.name = "ProfileSaveError";
    this.needsRelogin = needsRelogin;
  }
}

export interface FavoritePlayerPayload {
  playerId: string;
  name: string;
  teamId: number;
  position: string;
  number: number;
}

export interface FavoriteSaveUpdates {
  team_id?: number;
  favorite_players: FavoritePlayerPayload[];
}

export interface PutResult {
  status: number;
  body: unknown;
}

export interface FavoritesSaverDeps {
  /** access token 조회. never-settle 가능성이 있어도 core가 bound한다. */
  getToken: () => Promise<string | null>;
  /** 세션 갱신 후 새 access token. 실패는 null. core가 bound한다. */
  refreshToken: () => Promise<string | null>;
  /** 서버 저장 호출. core가 bound한다(구현측 AbortSignal 권장, 이중 방어). */
  putFavorites: (token: string, updates: FavoriteSaveUpdates) => Promise<PutResult>;
  /** auth 단계(getToken/refreshToken) 타임아웃. 기본 6000ms. */
  authTimeoutMs?: number;
  /** 저장 요청 타임아웃. 기본 10000ms. */
  requestTimeoutMs?: number;
}

export type SaveOutcome<TProfile> =
  | { superseded: true; profile: null }
  | { superseded: false; profile: TProfile };

/** race 타임아웃 — never-settle promise를 상한 안에 null로 강제 종료. */
function boundedOrNull<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), ms);
    p.then((v) => done(v)).catch(() => done(null));
  });
}

/** race 타임아웃 — 타임아웃/reject 를 ProfileSaveError(GENERIC)로 통일. */
function boundedRequest(p: Promise<PutResult>, ms: number): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ProfileSaveError(GENERIC_MESSAGE));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ProfileSaveError(GENERIC_MESSAGE));
      }
    );
  });
}

async function performSave<TProfile>(
  deps: FavoritesSaverDeps,
  updates: FavoriteSaveUpdates
): Promise<TProfile> {
  const authMs = deps.authTimeoutMs ?? 6000;
  const reqMs = deps.requestTimeoutMs ?? 10000;

  let token = await boundedOrNull(deps.getToken(), authMs);
  if (!token) token = await boundedOrNull(deps.refreshToken(), authMs);
  if (!token) throw new ProfileSaveError(RELOGIN_MESSAGE, true);

  let res = await boundedRequest(deps.putFavorites(token, updates), reqMs);

  if (res.status === 401) {
    // 만료 토큰: refresh 1회 + 재시도 1회 (bounded — 여기서 끝, 루프 없음)
    const refreshed = await boundedOrNull(deps.refreshToken(), authMs);
    if (!refreshed) throw new ProfileSaveError(RELOGIN_MESSAGE, true);
    res = await boundedRequest(deps.putFavorites(refreshed, updates), reqMs);
    if (res.status === 401) throw new ProfileSaveError(RELOGIN_MESSAGE, true);
  }

  if (res.status < 200 || res.status >= 300) throw new ProfileSaveError(GENERIC_MESSAGE);
  const body = res.body as { ok?: boolean; profile?: TProfile } | null;
  if (!body?.ok || !body.profile) throw new ProfileSaveError(GENERIC_MESSAGE);
  return body.profile;
}

export interface FavoritesSaver<TProfile> {
  save: (updates: FavoriteSaveUpdates) => Promise<SaveOutcome<TProfile>>;
}

/**
 * row 소유 fail-close (삼순 4차 리뷰): row.id가 현재 사용자 ID와 정확히
 * 일치할 때만 row를 돌려준다. 계정 전환 런타임에서 다른 계정의 row가 로컬에
 * commit되는 오염을 호출부 마지막 관문에서 차단한다.
 */
export function ownedRow<T extends { id?: unknown }>(
  row: T | null | undefined,
  userId: string
): T | null {
  if (!row || typeof row.id !== "string" || !userId || row.id !== userId) return null;
  return row;
}

/** 세션 모양 — supabase Session의 필요 필드만. */
export interface SessionLike {
  access_token?: string | null;
  user?: { id?: unknown } | null;
}

/**
 * 토큰 소유 fail-close (삼순 5차 리뷰): 세션의 `user.id`가 요청 `userId`와
 * 정확히 일치할 때만 access_token을 반환한다. A 요청이 큐 대기 중 계정이 B로
 * 바뀌면 실행 시점의 토큰은 B 것 — 그 토큰으로 PUT하면 **B DB가 먼저 갱신**되고
 * 응답 거절(ownedRow)은 늦는다. 이 가드는 side effect **전**(PUT 전)에 차단한다.
 * 초기 세션 조회와 401 refresh 경로 모두 이 함수를 거쳐야 한다.
 */
export function tokenForUser(
  session: SessionLike | null | undefined,
  userId: string
): string | null {
  if (!session || !userId) return null;
  if (typeof session.access_token !== "string" || !session.access_token) return null;
  if (typeof session.user?.id !== "string" || session.user.id !== userId) return null;
  return session.access_token;
}

export function createFavoritesSaver<TProfile>(
  deps: FavoritesSaverDeps
): FavoritesSaver<TProfile> {
  // 단일 체인 직렬화. 실패해도 체인은 끊기지 않는다.
  let chain: Promise<void> = Promise.resolve();
  let latestSeq = 0;
  // 마지막 성공 저장의 서버 row — 최신 요청 실패 시 호출자가 로컬을 DB 현재값으로
  // 정합할 수 있도록 오류(ProfileSaveError.lastSaved)에 실어 내보낸다.
  let lastSaved: TProfile | null = null;

  return {
    save(updates: FavoriteSaveUpdates): Promise<SaveOutcome<TProfile>> {
      const seq = ++latestSeq;
      const run: Promise<SaveOutcome<TProfile>> = chain.then(async () => {
        // 실행 차례에 더 최신 요청이 접수돼 있으면 이 요청은 서버로 보내지
        // 않는다 — 중간값이 최신값 뒤에 도착해 DB를 되돌리는 것을 원리적으로 차단.
        if (seq !== latestSeq) return { superseded: true as const, profile: null };
        try {
          const profile = await performSave<TProfile>(deps, updates);
          lastSaved = profile;
          return { superseded: false as const, profile };
        } catch (e) {
          if (e instanceof ProfileSaveError) e.lastSaved = lastSaved;
          throw e;
        }
      });
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}
