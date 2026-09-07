/** Reviewer-owned live contract check; not run by the deterministic default. */
import assert from "node:assert/strict";
import { fetchServedBatterSnapshot } from "../../../src/lib/baseball-qa/stats/served-record";
import { renderAverageRank } from "../../../src/lib/baseball-qa/stats/question-operation";
import { resolveRagTeamCandidate } from "../../../src/lib/baseball-qa/pipeline";

export async function verifyLiveRankingPayload() {
  const snapshot = await fetchServedBatterSnapshot();
  const now = Date.now();
  const teamId = (name: string) => {
    const team = resolveRagTeamCandidate(name);
    return team ? Number(team.entityId) : null;
  };
  const qualified = snapshot.rows.filter((row) => Number(row.qualifiedRate) === 1);
  const alpha = qualified.filter((row) => /^[A-Z]{2}\d{3}$/.test(row.kbo_id));
  const noAverage = snapshot.rows.filter((row) => row.avg === "-" && Number(row.qualifiedRate) === 0);
  assert.ok(alpha.length > 0 && noAverage.length > 0, "Live payload lacks the alpha/dash classes needed to verify this contract");
  assert.ok(qualified.every((row) => Number.isFinite(Number(row.avg)) && Number(row.avg) >= 0 && Number(row.avg) <= 1));
  const target = alpha[0];
  // Independent rank oracle: strictly higher qualified AVG values + 1 (ties share rank).
  const expected = 1 + qualified.filter((row) => Number(row.avg) > Number(target.avg)).length;
  const reply = renderAverageRank(snapshot, { player: { id: target.kbo_id, name: target.name } }, now, teamId);
  assert.ok(reply, "The real full-entry payload was rejected instead of producing a foreign-player rank");
  assert.match(reply, new RegExp(`타율 ${expected}위`));
  assert.ok(reply.includes(target.name));
  assert.ok(renderAverageRank(snapshot, {}, now, teamId), "The real league ranking was rejected");
  const clubId = teamId(target.team ?? "");
  assert.ok(clubId);
  const clubExpected = 1 + qualified.filter((row) => teamId(row.team ?? "") === clubId && Number(row.avg) > Number(target.avg)).length;
  const clubReply = renderAverageRank(snapshot, { team: { id: clubId, name: target.team! }, player: { id: target.kbo_id, name: target.name } }, now, teamId);
  assert.ok(clubReply); assert.match(clubReply, new RegExp(`타율 ${clubExpected}위`));
  const missing = noAverage[0];
  const missingReply = renderAverageRank(snapshot, { player: { id: missing.kbo_id, name: missing.name } }, now, teamId);
  assert.ok(missingReply); assert.match(missingReply, /규정타석 미달/);
  return { rows: snapshot.rows.length, qualified: qualified.length, qualifiedAlpha: alpha.length, noAverage: noAverage.length, asOf: snapshot.updatedAt, foreignRank: expected };
}
