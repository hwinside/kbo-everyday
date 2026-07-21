#!/usr/bin/env node
/**
 * KBO Player/Search.aspx 팀별 전 페이지를 기준으로 한 1회 로스터 백필.
 *
 * 기본은 dry-run이며 파일을 절대 수정하지 않는다. 실제 반영은 dry-run에서 확인한
 * 정확한 후보 수(`--ack-count=N`)와 sorted candidate manifest digest(`--ack-sha=HEX`)를
 * 모두 재확인해야만 허용한다. manifest는 `teamId,kboId,name,position,backNo,birthDate,photoSha256`
 * 정렬 라인의 sha256이므로 dry-run 이후 후보 집합/사진이 하나라도 바뀌면 write가 막힌다.
 *
 * Usage:
 *   node scripts/backfill-roster-from-player-search.mjs
 *   node scripts/backfill-roster-from-player-search.mjs --write --ack-count=N --ack-sha=HEX
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KBO_TEAM_CODES,
  buildCandidateManifest,
  fetchPlayerProfileWithPhoto,
  fetchTeamSearchEntries,
  selectMissingPlayers,
} from "./lib/kbo-player-search.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rosterPath = path.join(root, "src/lib/constants/players-roster.json");
const foreignMapPath = path.join(root, "src/lib/constants/foreign-id-map.ts");
const photosPath = path.join(root, "public/players");
const photoIndexPath = path.join(root, "src/lib/constants/player-photos.ts");
const args = process.argv.slice(2);
const write = args.includes("--write");
const ackCountArg = args.find((arg) => arg.startsWith("--ack-count="));
const ackCount = ackCountArg ? Number(ackCountArg.slice("--ack-count=".length)) : null;
const ackShaArg = args.find((arg) => arg.startsWith("--ack-sha="));
const ackSha = ackShaArg ? ackShaArg.slice("--ack-sha=".length).trim().toLowerCase() : null;
const REQUIRED_SOURCE_IDS = new Set(["51809", "65665"]); // 조요한·이준영 회귀 타깃

function loadForeignNumericToAlpha() {
  const source = fs.readFileSync(foreignMapPath, "utf8");
  return Object.fromEntries(
    [...source.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)].map((match) => [match[1], match[2]]),
  );
}

async function auditCandidates(candidates) {
  const eligible = [];
  const excluded = { foreign: [], "invalid-position": [], "no-photo": [], "stale-photo": [] };
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const results = await Promise.all(batch.map(async (candidate) => ({
      candidate,
      audit: await fetchPlayerProfileWithPhoto(candidate),
    })));
    for (const { candidate, audit } of results) {
      if (audit.excluded) {
        excluded[audit.excluded].push(candidate);
        continue;
      }
      eligible.push({
        ...candidate,
        name: audit.profile.name,
        position: audit.profile.position,
        backNo: audit.profile.backNo,
        photo: audit.photo,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { eligible, excluded };
}

function updatePhotoIdSet(ids) {
  const begin = "// === GENERATED:PHOTO_ID_SET:BEGIN ===";
  const end = "// === GENERATED:PHOTO_ID_SET:END ===";
  const source = fs.readFileSync(photoIndexPath, "utf8");
  const beginIndex = source.indexOf(begin);
  const endIndex = source.indexOf(end);
  if (beginIndex < 0 || endIndex <= beginIndex) throw new Error("player photo ID sentinel missing");
  const block = source.slice(beginIndex, endIndex);
  const allIds = new Set([...block.matchAll(/"([A-Z0-9]+)"/g)].map((match) => match[1]));
  for (const id of ids) allIds.add(id);
  const sorted = [...allIds].sort();
  let rendered = `${begin} (scripts/update-player-photos.mjs)\nexport const PLAYER_PHOTO_ID_SET = new Set([\n`;
  for (let index = 0; index < sorted.length; index += 10) {
    rendered += `  ${sorted.slice(index, index + 10).map((id) => `"${id}"`).join(", ")},\n`;
  }
  rendered += `]);\n${end}`;
  return source.slice(0, beginIndex) + rendered + source.slice(endIndex + end.length);
}

async function main() {
  const rosterRaw = fs.readFileSync(rosterPath, "utf8");
  const roster = JSON.parse(rosterRaw);
  const allSearchPlayers = [];

  for (const teamCode of KBO_TEAM_CODES) {
    const players = await fetchTeamSearchEntries(teamCode);
    allSearchPlayers.push(...players);
    console.log(`  ${players[0]?.team ?? teamCode}: ${players.length}명 완전수집`);
  }

  const sourceIds = new Set(allSearchPlayers.map((player) => player.kboId));
  const absentRequired = [...REQUIRED_SOURCE_IDS].filter((id) => !sourceIds.has(id));
  if (absentRequired.length > 0) {
    throw new Error(`known source target missing: ${absentRequired.join(", ")}`);
  }

  const foreignMap = loadForeignNumericToAlpha();
  const { missing, skippedForeignAliases } = selectMissingPlayers(allSearchPlayers, roster, foreignMap);
  const { eligible, excluded } = await auditCandidates(missing);
  const byTeam = new Map();
  for (const player of eligible) {
    const players = byTeam.get(player.team) ?? [];
    players.push(player);
    byTeam.set(player.team, players);
  }

  console.log(`\nKBO 검색 소스 ${allSearchPlayers.length}명 / 현재 roster ${roster.length}명`);
  console.log(`외국인 숫자 alias skip ${skippedForeignAliases.length}명`);
  console.log(`roster gap ${missing.length}명 → 외국인 ${excluded.foreign.length} / 유효포지션 없음 ${excluded["invalid-position"].length} / 2026 사진 없음 ${excluded["no-photo"].length} / 비정규(old-year·wrong-id) 사진 ${excluded["stale-photo"].length} 제외`);
  const manifest = buildCandidateManifest(eligible);
  console.log(`[dry-run] 사진 포함 신규 백필 후보 ${eligible.length}명`);
  console.log(`[dry-run] candidate manifest sha256: ${manifest.sha256}`);
  console.log(`[dry-run] 반영: --write --ack-count=${eligible.length} --ack-sha=${manifest.sha256}`);
  for (const [team, players] of byTeam) {
    console.log(`  ${team} ${players.length}명: ${players.map((p) => `${p.name}(${p.kboId}/${p.position}/#${p.backNo})`).join(", ")}`);
  }

  if (!write) return;
  if (!Number.isInteger(ackCount) || ackCount !== eligible.length) {
    throw new Error(`write blocked: --ack-count=${eligible.length} required (got ${ackCountArg ?? "none"})`);
  }
  if (ackSha !== manifest.sha256) {
    throw new Error(
      `write blocked: --ack-sha=${manifest.sha256} required (got ${ackShaArg ?? "none"}) — dry-run 이후 후보 집합/사진이 바뀌었을 수 있음`,
    );
  }

  const next = [...roster, ...eligible.map((player) => ({
    name: player.name,
    kboId: player.kboId,
    teamId: player.teamId,
    position: player.position,
    backNo: player.backNo,
    team: player.team,
    birthDate: player.birthDate,
  }))];
  const seen = new Set();
  for (const player of next) {
    if (seen.has(String(player.kboId))) throw new Error(`duplicate kboId before write: ${player.kboId}`);
    seen.add(String(player.kboId));
  }
  const nextRoster = JSON.stringify(next, null, 2) + (rosterRaw.endsWith("\n") ? "\n" : "");
  const nextPhotoIndex = updatePhotoIdSet(eligible.map((player) => player.kboId));
  fs.writeFileSync(rosterPath, nextRoster);
  fs.writeFileSync(photoIndexPath, nextPhotoIndex);
  for (const player of eligible) {
    fs.writeFileSync(path.join(photosPath, `${player.kboId}.jpg`), player.photo);
  }
  console.log(`\n✅ roster 백필 완료: ${roster.length} → ${next.length}`);
}

main().catch((error) => {
  console.error(`❌ player-search backfill failed: ${error?.message ?? error}`);
  process.exit(1);
});
