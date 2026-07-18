"use client";

import { registerPlugin } from "@capacitor/core";
import { isAndroid, isIOS } from "./platform";
import { syncIosWidgetFavPlayers, syncIosWidgetMyTeam } from "../native-live-activity";
import { supabase } from "../supabase/client";

// 잠금화면 실시간 스코어 = ongoing notification (안드로이드 전용, A4).
// 네이티브 GameNotificationPlugin(@CapacitorPlugin name="GameNotification")과 페어.
// iOS는 Live Activity(별도)라 여기선 android만 동작.
interface WidgetData {
  myTeam: string;
  away: string;
  home: string;
  awayScore: string;
  homeScore: string;
  status: string;
  pitcher: string;
  pitcherTeam: string;
  batter: string;
  batterTeam: string;
  outs: string;
  diamond: string;
  stadium?: string; // 경기장(잠실 등) — 위젯에서 점수 위 별도 표시
  awayStarter?: string; // 예고선발(원정) — 예정 경기에서만. 미확정이면 빈 문자열
  homeStarter?: string; // 예고선발(홈)
  gameId?: string; // 경기 id(YYYYMMDD…) — 위젯 06:00 롤오버 기준일
  next?: WidgetNextGame; // 다음 예정 경기 — live/final일 때만. 06:00 자동 전환 타깃
}

/** 안드 위젯 06:00 롤오버 타깃(다음 예정 경기, 라이트). */
export interface WidgetNextGame {
  away: string;
  home: string;
  stadium: string;
  time: string;
  date: string;
  astarter?: string;
  hstarter?: string;
}

interface GameNotificationPlugin {
  start(opts: { title: string; body: string; path?: string }): Promise<void>;
  update(opts: { title: string; body: string }): Promise<void>;
  remove(): Promise<void>;
  updateWidget(opts: WidgetData): Promise<void>;
  clearWidget(): Promise<void>;
  setMyTeam(opts: { code: string }): Promise<void>;
  setFavPlayers(opts: { json: string }): Promise<void>;
  getLiveUpdateState(): Promise<LiveUpdateState>;
  setLiveUpdateOptIn(opts: { enabled: boolean }): Promise<void>;
  setLockCardEnabled(opts: { enabled: boolean }): Promise<void>;
}

/** Android 16+(One UI 8.5) 잠금화면 라이브 카드(Promoted Ongoing) 지원/opt-in 상태. */
export interface LiveUpdateState {
  supported: boolean;
  enabled: boolean;
}

const GameNotification = registerPlugin<GameNotificationPlugin>("GameNotification");

/** ongoing notification 시작 (경기 시작 시). 실패는 silent — 부가 기능.
 *  path = 카드 탭 시 열 경기룸 경로(옵셔널 — 네이티브 start가 path를 딥링크로 사용).
 *  반환 = 브릿지 호출 성공 여부(구빌드 메서드 부재/브릿지 실패 = false — 재노출 버튼 결과 안내용,
 *  PR #680 삼순 blocker②). 단 네이티브 post()가 권한 미허용(SecurityException)을 삼키므로
 *  true = "게시 확정"이 아니라 "요청 접수"로 해석할 것. */
export async function startGameNotification(title: string, body: string, path?: string): Promise<boolean> {
  if (!isAndroid) return false;
  try {
    await GameNotification.start({ title, body, ...(path ? { path } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** ongoing notification 갱신 (득점/이닝 변경 시). */
export async function updateGameNotification(title: string, body: string): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.update({ title, body });
  } catch {
    // silent
  }
}

/** ongoing notification 제거 (경기 종료 시). */
export async function removeGameNotification(): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.remove();
  } catch {
    // silent
  }
}

/** 홈/잠금화면 위젯을 풀 라이브 데이터로 갱신 (경기룸 포그라운드). 주자/투수/타자 포함. */
export async function updateGameWidget(data: WidgetData): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.updateWidget(data);
  } catch {
    // silent
  }
}

/** 위젯 빈 상태로 전환 (경기 종료). */
export async function clearGameWidget(): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.clearWidget();
  } catch {
    // silent
  }
}

/** 디바이스 최애팀 코드 기록 (위젯 배경/워터마크 색 결정). */
export async function setWidgetMyTeam(code: string): Promise<void> {
  if (!code) return;
  if (isIOS) {
    // iOS는 GameNotification(안드 전용) 대신 LiveActivity 플러그인으로 App Group에 기록.
    await syncIosWidgetMyTeam(code);
    return;
  }
  if (!isAndroid) return;
  try {
    await GameNotification.setMyTeam({ code });
  } catch {
    // silent
  }
}

/** 잠금화면 카드 마스터 게이트(서버 prefs.live_activity의 디바이스 미러) 동기화 — 안드 전용.
 *  off면 네이티브가 현재 카드를 즉시 제거하고 이후 FCM game_live 수신 시에도 카드를 게시하지
 *  않는다(홈위젯은 영향 없음 — game_live가 홈위젯과 잠금카드 겸용이라 서버 발송은 유지).
 *  구 네이티브 빌드(메서드 부재)는 조용히 무시 — vc14+부터 유효. */
export async function syncAndroidLockCardGate(enabled: boolean): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.setLockCardEnabled({ enabled });
  } catch {
    // silent — 구빌드/브릿지 실패(카드는 기존 동작 유지)
  }
}

/** 부팅/로그인 시 서버 live_activity pref → 네이티브 잠금카드 게이트 동기화(안드 전용).
 *  다른 기기에서 꺼둔 유저/재설치(네이티브 디폴트 on) 복원용. 확정 응답일 때만 반영 —
 *  비로그인/네트워크 실패 시 기존 네이티브 값 유지(임의 on 덮어쓰기 금지). */
export async function bootstrapAndroidLockCardGate(): Promise<void> {
  if (!isAndroid) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    const res = await fetch("/api/push/prefs", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { prefs } = await res.json();
    await syncAndroidLockCardGate(prefs?.live_activity !== false);
  } catch {
    // silent — 다음 부팅/마이페이지 진입 시 재동기화
  }
}

/** 잠금화면 라이브 카드 지원/opt-in 상태 — 미지원(비안드/구버전 OS)이면 supported:false.
 *  구 네이티브 빌드(플러그인 메서드 부재)에서도 조용히 미지원 처리(fail-open — 토글 행 숨김용). */
export async function getLiveUpdateState(): Promise<LiveUpdateState> {
  if (!isAndroid) return { supported: false, enabled: false };
  try {
    return await GameNotification.getLiveUpdateState();
  } catch {
    return { supported: false, enabled: false };
  }
}

/** strict 버전 — 수동 재노출 경로 전용(삼순 #680 재리뷰). 브릿지 조회 실패(구빌드 메서드
 *  부재 포함)를 null로 구분 반환 — suppression 상태 불명인 채 재게시하면 네이티브 post()가
 *  조용히 suppress해 성공 오안내가 나므로 호출부가 failed 처리한다. */
export async function getLiveUpdateStateStrict(): Promise<LiveUpdateState | null> {
  if (!isAndroid) return null;
  try {
    return await GameNotification.getLiveUpdateState();
  } catch {
    return null;
  }
}

/** 잠금화면 라이브 카드 명시 opt-in 토글(디바이스 로컬).
 *  반환 = 브릿지 호출 성공 여부 — 재노출 경로에서 suppression 리셋 실패를 성공으로
 *  오안내하지 않기 위함(PR #680 삼순 blocker②). 기존 토글 호출부는 void 소비라 무영향. */
export async function setLiveUpdateOptIn(enabled: boolean): Promise<boolean> {
  if (!isAndroid) return false;
  try {
    await GameNotification.setLiveUpdateOptIn({ enabled });
    return true;
  } catch {
    return false;
  }
}

/** 최애선수 목록 동기화 — 선수 카드 위젯 config(선수 선택 목록)용. */
export async function setWidgetFavPlayers(players: unknown[]): Promise<void> {
  if (isIOS) {
    // iOS는 GameNotification(안드 전용) 대신 LiveActivity 플러그인으로 App Group에 기록.
    await syncIosWidgetFavPlayers(players);
    return;
  }
  if (!isAndroid) return;
  try {
    await GameNotification.setFavPlayers({ json: JSON.stringify(players ?? []) });
  } catch {
    // silent
  }
}
