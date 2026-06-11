"use client";

import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "./platform";

// 잠금화면 실시간 스코어 = ongoing notification (안드로이드 전용, A4).
// 네이티브 GameNotificationPlugin(@CapacitorPlugin name="GameNotification")과 페어.
// iOS는 Live Activity(별도)라 여기선 android만 동작.
interface GameNotificationPlugin {
  start(opts: { title: string; body: string }): Promise<void>;
  update(opts: { title: string; body: string }): Promise<void>;
  remove(): Promise<void>;
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
