/**
 * 신규 외국인 선수 자동 온보딩 보조 (순수 로직 — reconcile + 스모크 공용).
 *
 * A안(2026-07-19 하린아빠 확정): 신규 외국인은 **숫자 KBO id 직결**로 온보딩한다.
 * 박스스코어·스탯·KBO 상세·사진 CDN이 모두 동일 숫자 id를 쓰므로(예: 페덱 56459),
 * roster에 숫자 id를 그대로 넣으면 매핑(foreign-id-map) 없이 페이지·사진이 전부 resolve된다.
 * FP/AQ canonical 코드는 *기존 외인 관례*로만 남기고, 신규는 숫자로 통일한다.
 *
 * 이 모듈의 분류는 **온보딩을 막지 않는다** — 국적 알림 대상 판별에만 쓴다.
 * 따라서 오판(국내선수를 외인으로/외인을 국내로)이 나도 서비스 영향은 0이다.
 *   - false positive: 국내선수를 외인 후보로 알림 → 사람이 무시(노이즈만)
 *   - false negative: 외인을 못 잡아 국적 알림 누락 → 페이지·사진은 이미 정상, 국기만 미표시
 */

/**
 * KBO 상세 draft/name 신호로 외국인 여부 추정.
 * @param {{draft?: string, name?: string}} detail
 * @returns {boolean}
 */
export function classifyForeign(detail) {
  if (!detail) return false;
  // 1순위: KBO 입단 표기 "자유선발" = 외국인 영입 전용 표기(실측: 세베리노/아빌라/페덱/디아즈).
  if (/자유선발/.test(detail.draft || "")) return true;
  // 2순위: 아시아쿼터/외국인 풀네임은 공백 포함("가나쿠보 유토", "르윈 디아즈").
  //   국내 선수명(한글 2~4음절)은 공백이 없다.
  if (typeof detail.name === "string" && /\s/.test(detail.name.trim())) return true;
  return false;
}

/**
 * 국적 대기 리포트를 갱신한다(기존 대기 + 신규 병합, 이미 국적 붙은 항목은 제거).
 * @param {Record<string, {name: string, team: string, addedAt: string}>} existing
 * @param {Array<{kboId, name, team}>} pending  이번 실행에서 새로 감지된 후보
 * @param {Record<string, string>} nationalityMap
 * @param {string} nowIso
 * @returns {Record<string, {name: string, team: string, addedAt: string}>}
 */
export function mergePendingReport(existing, pending, nationalityMap, nowIso) {
  const next = {};
  // 1) 기존 대기 중 아직 국적 미등록인 것만 유지(사람이 국적 넣으면 자동 소멸).
  for (const [kboId, v] of Object.entries(existing || {})) {
    if (nationalityMap && Object.prototype.hasOwnProperty.call(nationalityMap, kboId)) continue;
    next[kboId] = v;
  }
  // 2) 신규 후보 추가(기존 addedAt 보존).
  for (const p of pending) {
    if (next[p.kboId]) continue;
    next[p.kboId] = { name: p.name, team: p.team, addedAt: nowIso };
  }
  return next;
}

/**
 * 이번 reconcile 실행에서 숫자 KBO id로 온보딩된 선수 전원을 사진 게이트에 인계한다.
 * 외국인 분류는 false-negative를 허용하는 국적 알림용 휴리스틱이므로 사진 게이트 대상
 * 선정에 사용하면 안 된다.
 * @param {Array<{kboId: string | number, name: string, team: string}>} onboarded
 * @returns {Array<{kboId: string, name: string, team: string}>}
 */
export function buildNewlyOnboardedPhotoManifest(onboarded) {
  return onboarded
    .filter((entry) => /^\d+$/.test(String(entry.kboId)))
    .map((entry) => ({ kboId: String(entry.kboId), name: entry.name, team: entry.team }));
}

/**
 * tsx tsImport의 Node 버전별 ESM/CJS interop 차이를 흡수한다.
 * Node 22(GitHub Actions)는 TS named export를 default 객체 아래에만 노출하고,
 * Node 24(local)는 named export도 최상위에 노출한다.
 * @param {Record<string, unknown>} moduleNamespace
 * @returns {(html: string) => Array<{kboId: string, name: string, backNo: string, position: string}>}
 */
export function resolveTeamRegisterParser(moduleNamespace) {
  const parser = moduleNamespace?.parseTeamRegister ?? moduleNamespace?.default?.parseTeamRegister;
  if (typeof parser !== "function") {
    throw new TypeError("parseTeamRegister export not found");
  }
  return parser;
}

/**
 * P0 사진 게이트: 이번 실행에서 신규 온보딩된 숫자 id 선수 각각이 실제로
 * public/players/{id}.jpg + player-photos.ts PLAYER_PHOTO_ID_SET 양쪽에서 확인되는지 검사한다.
 * 다운로드 실패(404/타임아웃) 시에도 roster 온보딩 자체는 통과해 사진만 조용히
 * 빠질 수 있으므로 외국인 분류 결과와 무관하게 전원을 검사한다.
 * @param {Array<{kboId: string, name: string, team: string}>} entries
 * @param {{photoFileExists: (kboId: string) => boolean, idSetHas: (kboId: string) => boolean}} deps
 * @returns {Array<{kboId: string, name: string, team: string, hasFile: boolean, hasIdSet: boolean}>} 누락된 항목만
 */
export function checkNewlyOnboardedPhotos(entries, { photoFileExists, idSetHas }) {
  const missing = [];
  for (const e of entries) {
    const hasFile = photoFileExists(e.kboId);
    const hasIdSet = idSetHas(e.kboId);
    if (!hasFile || !hasIdSet) {
      missing.push({ ...e, hasFile, hasIdSet });
    }
  }
  return missing;
}
