/**
 * 종료 clear·경기별 이벤트 알림 production 계약 회귀.
 * 실행: npm run qa:notif-terminal-group
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "smoke-dummy-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-dummy-anon";

import type { PushPayload } from "../../src/lib/notifications/fcm";

let pass = 0;
let fail = 0;

function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.error(`✗ ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

async function main() {
  const {
    WIDGET_STREAM,
    WIDGET_CONTROL_KINDS,
    buildAndroidConfig,
    buildDeadlineAndroidConfig,
    endClearGroupFlag,
    gameEventNotificationPolicy,
  } = await import("../../src/lib/notifications/fcm");
  const { sendTerminalClear } = await import("../../src/lib/notifications/game-status");

  const gameId = "20260726LGHH0";
  const tag = `game:${gameId}`;

  check("terminal collapse key", WIDGET_STREAM.terminal.collapseKey, "kbo_widget_end");
  check("live collapse key", WIDGET_STREAM.live.collapseKey, "kbo_widget_stream");
  check("terminal/live collapse 분리",
    WIDGET_STREAM.terminal.collapseKey !== WIDGET_STREAM.live.collapseKey, true);
  check("live TTL", WIDGET_STREAM.live.ttlSeconds, 90);
  check("terminal TTL", WIDGET_STREAM.terminal.ttlSeconds, 24 * 60 * 60);
  check("game_end w_ts 자동부여 대상", WIDGET_CONTROL_KINDS.has("game_end"), true);

  const eventPolicy = gameEventNotificationPolicy(gameId);
  check("경기별 시스템 notification tag", eventPolicy.androidNotificationTag, tag);
  check("foreground native도 같은 경기 주소", eventPolicy.data, {
    n_group: tag,
    n_tag: tag,
  });
  check("Admin SDK transport에 Android tag 배선",
    buildAndroidConfig({ title: "득점", body: "1:0", ...eventPolicy }).notification,
    { tag });
  check("deadline HTTP v1 transport에 Android tag 배선",
    buildDeadlineAndroidConfig({ title: "득점", body: "1:0", ...eventPolicy }).notification,
    { tag });
  check("다른 경기 tag 분리",
    gameEventNotificationPolicy("20260726KTSS0").androidNotificationTag !== tag, true);
  check("종료 clear 주소 일치", endClearGroupFlag(gameId), { n_clear_group: tag });

  const captured: PushPayload[] = [];
  const captureSend = async (_userIds: string[], payload: PushPayload) => {
    captured.push(payload);
    return {
      tokens: 1,
      sent: 1,
      failed: 0,
      cleaned: 0,
      skipped: 0,
      ok: true,
    };
  };

  await sendTerminalClear(["cancel-user"], gameId, undefined, {
    prefKey: "game_start",
    send: captureSend,
  });
  await sendTerminalClear(
    ["final-user"],
    gameId,
    { awayScore: 1, homeScore: 9 },
    { send: captureSend },
  );

  const [cancelPayload, finalPayload] = captured;
  for (const [kind, payload] of [["취소", cancelPayload], ["정상 종료", finalPayload]] as const) {
    check(`${kind} production clear data-only`, payload.dataOnly, true);
    check(`${kind} production clear APNs wake`, payload.apnsBackground, true);
    check(`${kind} production clear collapse`, payload.collapseKey, "kbo_widget_end");
    check(`${kind} production clear TTL`, payload.ttlSeconds, 24 * 60 * 60);
    check(`${kind} production clear group`, payload.data?.n_clear_group, tag);
    check(`${kind} production FINAL tombstone`, payload.data?.w_final, "1");
    check(`${kind} production gameId`, payload.data?.gameId, gameId);
  }
  check("취소 clear는 점수 없음", cancelPayload.data?.w_as, undefined);
  check("정상 종료 최종 원정 점수", finalPayload.data?.w_as, "1");
  check("정상 종료 최종 홈 점수", finalPayload.data?.w_hs, "9");

  console.log(`\n${fail === 0 ? "✅" : "❌"} notif-terminal-group: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
