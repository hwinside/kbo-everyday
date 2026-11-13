/**
 * 로스터 갭 알림 — 박스스코어에 출전했는데 로스터에 없어 fail-closed로 스킵된 선수를
 * 슬랙으로 통보한다. 신규/시즌중 합류 선수(특히 외국인)가 누적 스탯 리더보드에 뜨기 전,
 * "박스스코어 = 가장 빠른 소스"에서 당일 미등록을 잡기 위한 1단계 탐지.
 *
 * 활성화: env ROSTER_GAP_SLACK_WEBHOOK (Slack Incoming Webhook URL).
 * 미설정 시 no-op (탐지 결과는 cron job summary에 항상 기록되므로 /admin/jobs에서 확인 가능).
 */
import type { UnresolvedBoxScorePlayer } from "@/lib/game-logs/ingest";

const WEBHOOK_URL = process.env.ROSTER_GAP_SLACK_WEBHOOK || "";

const TEAM_ID_TO_NAME: Record<number, string> = {
  1: "LG", 2: "두산", 3: "KT", 4: "SSG", 5: "NC",
  6: "KIA", 7: "롯데", 8: "삼성", 9: "한화", 10: "키움",
};

export interface RosterGap {
  name: string;
  teamId: number;
  teamName: string;
  playerType: "batter" | "pitcher";
}

/** (이름, 팀) 기준 중복 제거. 같은 선수가 여러 경기/투타에 잡혀도 1건으로. */
export function dedupeGaps(players: UnresolvedBoxScorePlayer[]): RosterGap[] {
  const byKey = new Map<string, RosterGap>();
  for (const p of players) {
    const key = `${p.name}|${p.teamId}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      name: p.name,
      teamId: p.teamId,
      teamName: TEAM_ID_TO_NAME[p.teamId] ?? String(p.teamId),
      playerType: p.playerType,
    });
  }
  return [...byKey.values()];
}

export function formatGapMessage(gaps: RosterGap[]): string {
  const lines = gaps
    .map((g) => `• ${g.name} (${g.teamName}, ${g.playerType === "pitcher" ? "투수" : "타자"})`)
    .join("\n");
  return (
    `🆕 *박스스코어에 출전했지만 선수 식별 미해결 ${gaps.length}명* — ID·로스터 확인 필요\n` +
    `${lines}\n` +
    `_미등록 또는 동명이인·ID 불일치일 수 있습니다. 원본 선수 ID를 확인해 주세요. 해결 전까지 경기 기록이 불완전할 수 있습니다._`
  );
}

export type GapNotifyStatus = "no-gaps" | "no-webhook" | "sent" | "webhook-error";

/**
 * 미등록 선수 통보. webhook 미설정/갭 없음/전송실패 모두 throw 없이 status로 반환
 * (cron 본작업을 절대 막지 않도록 — 알림은 부가 기능).
 */
export async function notifyRosterGaps(
  players: UnresolvedBoxScorePlayer[],
): Promise<{ gaps: RosterGap[]; status: GapNotifyStatus }> {
  const gaps = dedupeGaps(players);
  if (gaps.length === 0) return { gaps, status: "no-gaps" };
  if (!WEBHOOK_URL) return { gaps, status: "no-webhook" };
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: formatGapMessage(gaps) }),
    });
    return { gaps, status: res.ok ? "sent" : "webhook-error" };
  } catch {
    return { gaps, status: "webhook-error" };
  }
}
