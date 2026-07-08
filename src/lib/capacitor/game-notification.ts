"use client";

import { registerPlugin } from "@capacitor/core";
import { isAndroid, isIOS } from "./platform";
import { syncIosWidgetFavPlayers, syncIosWidgetMyTeam } from "../native-live-activity";

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
  start(opts: { title: string; body: string }): Promise<void>;
  update(opts: { title: string; body: string }): Promise<void>;
  remove(): Promise<void>;
  updateWidget(opts: WidgetData): Promise<void>;
  clearWidget(): Promise<void>;
  setMyTeam(opts: { code: string }): Promise<void>;
  setFavPlayers(opts: { json: string }): Promise<void>;
}

const GameNotification = registerPlugin<GameNotificationPlugin>("GameNotification");

/** ongoing notification 시작 (경기 시작 시). 실패는 silent — 부가 기능. */
export async function startGameNotification(title: string, body: string): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.start({ title, body });
  } catch {
    // silent
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
