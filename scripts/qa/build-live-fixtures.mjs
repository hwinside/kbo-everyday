#!/usr/bin/env node
/**
 * PR #1274 D안 — baseline/A1 공통 deterministic `isLive=true` fixture 생성기.
 *
 * 왜 필요한가(삼순 HOLD ③): 과거 종료 경기로 측정하면 `liveGame.isLive === false` →
 * `multiplexActive=false` → A1 이 바꾼 3초 NDJSON 경로가 **아예 켜지지 않는다**.
 * 그 상태의 수치는 A1 의 개선을 증명하지도, 이전 열세를 반증하지도 못한다.
 *
 * 그렇다고 진짜 라이브 경기를 쓰면 P0(실유저 공간) 위반이므로, **실제 과거 경기의
 * 실제 payload 를 캡처해 `isLive=true` 로 고정한 fixture** 를 baseline/A1 양쪽에
 * 동일하게 fulfill 한다. 두 arm 이 같은 바이트를 받으므로 업스트림 변동(시차·정정)이
 * 원리적으로 제거된다(= `live_vs_live_comparison_in_gate` 회피).
 *
 * 출력은 결정론적이어야 한다: 같은 입력 → 같은 sha256. 시각 의존 필드는 고정한다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const DIR = "scripts/qa/fixtures";
const GAME_ID = process.env.QA_LOAD_GAME_ID || "20260821LGHH0";

const read = (n) => JSON.parse(readFileSync(`${DIR}/${n}`, "utf8"));

/** 라이브 상태로 고정할 이닝 상태 — 경기 중반 고정값(결정론). */
const LIVE_STATE = Object.freeze({
  inning: 6,
  isTop: false,
  balls: 1,
  strikes: 2,
  outs: 1,
  currentInning: "6회말",
  status: "live",
  isLive: true,
});

/** 고정 trace — `useLiveGame.commitPayload` 는 trace.sourceAtMs/fetchedAtMs 가 유효할
 *  때만 games 를 커밋한다. trace 를 지우면 payload 가 invalid 로 떨어져 liveGame 이
 *  null 이 되고 derivedStatus 가 scheduled 로 밀린다(2026-08-22 실측: ScheduledView
 *  렌더 → 채팅 2시간 오픈 게이트에 막혀 composer 부재). 결정론을 위해 값은 고정한다. */
const FIXED_TRACE = Object.freeze({
  source: "qa-fixture",
  stage: "qa-fixture",
  sourceAtMs: 1787000000000,
  fetchedAtMs: 1787000000000,
});

function buildLive() {
  const raw = read("raw-game-live.json");
  const games = (raw.games ?? []).map((g) =>
    g.gameId === GAME_ID ? { ...g, ...LIVE_STATE } : g,
  );
  return { games, date: raw.date, trace: FIXED_TRACE };
}

function buildDetail() {
  const raw = read("raw-game-detail.json");
  return {
    ...raw,
    status: "live",
    isLive: true,
    meta: { ...(raw.meta ?? {}), endTime: null, duration: null },
  };
}

function buildRelay() {
  const raw = read("raw-game-relay.json");
  // relay 는 이닝 진행 데이터 자체가 본문이다. 상태 플래그만 라이브로 맞춘다.
  return { ...raw, isLive: true, isFinal: false, status: "live" };
}

const out = {
  "game-live.json": buildLive(),
  "game-detail.json": buildDetail(),
  "game-relay.json": buildRelay(),
};

const manifest = { gameId: GAME_ID, liveState: LIVE_STATE, files: {} };
for (const [name, body] of Object.entries(out)) {
  // ⚠️ JSON.stringify(body, keysArray) 는 **모든 깊이의 키를 필터**한다 —
  // 이전 구현이 그걸 "키 정렬"으로 착각해 중첩 데이터를 통째로 날렸고,
  // 결과 경기 페이지가 `Cannot read properties of undefined (reading 'length')` 로
  // 크래시했다(2026-08-22 실측). 입력 fixture 가 이미 결정론적이므로
  // 평범한 직렬화로 충분하다(같은 입력 → 같은 바이트).
  const text = JSON.stringify(body) + "\n";
  writeFileSync(`${DIR}/${name}`, text);
  manifest.files[name] = createHash("sha256").update(text).digest("hex");
}
writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1) + "\n");
console.log(JSON.stringify(manifest, null, 1));
