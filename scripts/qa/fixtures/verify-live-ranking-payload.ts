/** Reviewer-owned live contract check; not run by the deterministic default. */
import assert from "node:assert/strict";
import { fetchServedBatterSnapshot } from "../../../src/lib/baseball-qa/stats/served-record";
import { renderAverageRank } from "../../../src/lib/baseball-qa/stats/question-operation";
import { resolveRagTeamCandidate, resolveNamedPlayerCandidate } from "../../../src/lib/baseball-qa/pipeline";
import { loadRosterPlayers } from "../../../src/lib/baseball-qa/roster/load-roster-players";
import { readRankPlayerId } from "../../../src/lib/baseball-qa/stats/rank-request-context";

export async function verifyLiveRankingPayload() {
  const snapshot = await fetchServedBatterSnapshot();
  const roster = await loadRosterPlayers();
  const now = Date.now();
  const teamId = (name: string) => {
    const team = resolveRagTeamCandidate(name);
    return team ? Number(team.entityId) : null;
  };
  const qualified = snapshot.rows.filter((row) => Number(row.qualifiedRate) === 1);
  const alpha = snapshot.rows.filter((row) => /^[A-Z]{2}\d{3}$/.test(row.kbo_id));
  const qualifiedAlpha = alpha.filter((row) => Number(row.qualifiedRate) === 1);
  const noAverage = snapshot.rows.filter((row) => row.avg === "-" && Number(row.qualifiedRate) === 0);
  assert.ok(qualifiedAlpha.length > 0 && noAverage.length > 0, "Live payload lacks the alpha/dash classes needed to verify this contract");
  assert.ok(qualified.every((row) => Number.isFinite(Number(row.avg)) && Number(row.avg) >= 0 && Number(row.avg) <= 1));
  let numericChecked = 0; let foreignChecked = 0; let nameDifferences = 0;
  for (const row of snapshot.rows) {
    // This is the production pipeline's caller contract: name comes from the roster.
    const player = roster.find((entry) => entry.kboId === row.kbo_id);
    assert.ok(player, `Served ID ${row.kbo_id} has no production roster identity`);
    const reply = renderAverageRank(snapshot, { player: { id: player.kboId, name: player.name } }, now, teamId);
    assert.ok(reply, `Full-entry row rejected for roster identity ${player.kboId}/${player.name}`);
    assert.ok(reply.includes(player.name));
    if (Number(row.qualifiedRate) === 1) {
      // Independent competition-rank oracle, including all qualified foreign players.
      const expected = 1 + qualified.filter((other) => Number(other.avg) > Number(row.avg)).length;
      assert.match(reply, new RegExp(`타율 ${expected}위`));
    } else assert.match(reply, /규정타석 미달/);
    if (/^[A-Z]/.test(row.kbo_id)) foreignChecked++; else numericChecked++;
    if (row.name !== player.name) nameDifferences++;
  }
  assert.equal(numericChecked + foreignChecked, snapshot.rows.length);
  assert.ok(renderAverageRank(snapshot, {}, now, teamId), "The real league ranking was rejected");
  for (const row of qualifiedAlpha) {
    const player = roster.find((entry) => entry.kboId === row.kbo_id)!;
    const surnameIds = new Set(roster.filter((entry) => entry.name === row.name
      || (/^[A-Z]/.test(readRankPlayerId(entry.kboId) ?? "") && entry.name.trim().split(/\s+/).at(-1) === row.name))
      .map((entry) => entry.kboId));
    const named = resolveNamedPlayerCandidate(`${row.name} 타율 순위`, roster);
    assert.ok(surnameIds.size > 0, `No roster surname candidate for ${row.name}`);
    if (surnameIds.size === 1) assert.equal(named?.entityId, player.kboId, `Common short-name request lost ${row.name}`);
    else assert.equal(named, null, `Ambiguous surname selected one player: ${row.name}`);
    const clubId = teamId(player.team ?? "");
    assert.ok(clubId);
    const expected = 1 + qualified.filter((other) => teamId(other.team ?? "") === clubId && Number(other.avg) > Number(row.avg)).length;
    const reply = renderAverageRank(snapshot, { team: { id: clubId, name: player.team! }, player: { id: player.kboId, name: player.name } }, now, teamId);
    assert.ok(reply); assert.match(reply, new RegExp(`타율 ${expected}위`));
  }
  return { rows: snapshot.rows.length, qualified: qualified.length, qualifiedAlpha: qualifiedAlpha.length,
    noAverage: noAverage.length, numericChecked, foreignChecked, nameDifferences, asOf: snapshot.updatedAt };
}
