#!/usr/bin/env node
/**
 * KBO 선수 사진 일괄 업데이트 스크립트
 * - 새 CDN (6ptotvmi5753.edge.naverncp.com)에서 2026시즌 사진 다운로드
 * - 외국인 선수는 KBO 공식 사이트에서 개별 추출
 * - player-photos.ts 자동 업데이트
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PHOTOS_DIR = path.join(PROJECT_ROOT, 'public', 'players');
const ROSTER_PATH = path.join(PROJECT_ROOT, 'src', 'lib', 'constants', 'players-roster.json');
const PHOTOS_TS_PATH = path.join(PROJECT_ROOT, 'src', 'lib', 'constants', 'player-photos.ts');

const CDN_BASE = 'https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2026';
const KBO_DETAIL_BASE = 'https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=';
const KBO_PITCHER_BASE = 'https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=';

// 임시/비표준 KBO ID를 기존 headshot으로 연결해야 하는 케이스
// 예: 재입단 외국인, 팀 이동 선수, 로스터 수집 시 임시 ID(FP/AQ/TR) 사용
const PHOTO_ALIAS_BY_KBO_ID = {
  TR001: '62934', // SSG 김성욱
  AQ001: '56719', // 왕옌청
  AQ003: '56415', // 미야지 유라
  AQ007: '56011', // 스기모토 고우키
  FP002: '56724', // 오웬 화이트
  FP006: '54400', // 르윈 디아즈
  FP010: '56928', // 드루 버하겐
  FP012: '56036', // 케일럽 보쉴리
  FP013: '56034', // 샘 힐리어드
  FP015: '56523', // 제러미 비슬리
  FP016: '56626', // 해럴드 카스트로
  FP017: '50234', // 크리스 플렉센
};

// KBO 기본 headshot 경로에 없는 신규 외국인/아시아쿼터 선수 수동 소스
// 공식 프로필이 없을 때는 보도사진으로 우선 blank state를 해소한다.
const MANUAL_PHOTO_URL_BY_KBO_ID = {
  AQ005: 'http://file.osen.co.kr/article_thumb/2026/03/19/202603191343779118_69bb7f0476bc4_300x.jpg', // 다케다 쇼타
  AQ006: 'https://wimg.mk.co.kr/news/cms/202603/02/news-p.v1.20260302.719f505021ce45b1bf90147a0a1dc234_P1.jpg', // 도다 나츠키
  AQ008: 'https://cdn.stnsports.co.kr/news/photo/202512/309575_312284_104.jpg', // 교야마 마사야
  AQ009: 'https://menu.mt.co.kr/cdn-cgi/image/w=1200,h=929,fit=cover,bg=whilte,f=auto,quality=high,sharpen=2,g=face/mobile/osen/data/2026/03/12/202603121615779085_1.jpg', // 다무라 이치로
  AQ010: 'http://file.osen.co.kr/article_thumb/2026/03/28/202603281810775678_69c79aeabb08c_300x.jpg', // 가나쿠보 유토
  FP005: 'http://file.osen.co.kr/article_thumb/2026/02/20/202602201057771560_6997bf8d5db9d_300x.jpg', // 맷 매닝
};

// Rate limit helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(15000),
      });
      return response;
    } catch (e) {
      if (i === maxRetries) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function downloadPhoto(kboId, destPath) {
  const url = `${CDN_BASE}/${kboId}.jpg`;
  try {
    const res = await fetchWithRetry(url);
    if (res.status !== 200) return false;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return false; // skip tiny placeholder images
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function downloadPhotoFromUrl(url, destPath) {
  try {
    const res = await fetchWithRetry(url);
    if (res.status !== 200) return false;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function extractPhotoFromKboPage(kboId) {
  // Try both hitter and pitcher pages
  for (const base of [KBO_DETAIL_BASE, KBO_PITCHER_BASE]) {
    try {
      const res = await fetchWithRetry(`${base}${kboId}`);
      if (res.status !== 200) continue;
      const html = await res.text();
      // Extract image URL from page
      const match = html.match(/src="(\/\/[^"]*\/KBO_IMAGE\/person\/[^"]*\.jpg)"/);
      if (match) {
        const imgUrl = `https:${match[1]}`;
        const imgRes = await fetchWithRetry(imgUrl);
        if (imgRes.status === 200) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          if (buf.length > 500) return buf;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function generatePhotosTs(photoMap, photoIdSet) {
  const sortedEntries = Object.entries(photoMap).sort(([a], [b]) => a.localeCompare(b, 'ko'));
  const sortedIds = [...photoIdSet].sort();
  
  let ts = `/**
 * KBO playerId → 선수 사진 URL 매핑
 * 사진 소스: KBO 공식 이미지 서버
 * URL 패턴: /players/{kboPlayerId}.jpg (public/players/)
 * 자동 생성: scripts/update-player-photos.mjs
 * 마지막 업데이트: ${new Date().toISOString().split('T')[0]}
 */

// 선수명 → KBO playerId 매핑
export const PLAYER_PHOTO_MAP: Record<string, string> = {\n`;

  for (const [name, id] of sortedEntries) {
    ts += `  "${name}": "${id}",\n`;
  }
  ts += `};\n\n`;

  // ID set
  ts += `// kboId 기반 사진 존재 여부 빠른 검색용\nexport const PLAYER_PHOTO_ID_SET = new Set([\n`;
  // Chunk into lines of 10
  for (let i = 0; i < sortedIds.length; i += 10) {
    const chunk = sortedIds.slice(i, i + 10);
    ts += `  ${chunk.map(id => `"${id}"`).join(', ')},\n`;
  }
  ts += `]);\n\n`;

  ts += `export function getPlayerPhotoUrl(name: string, kboId?: string): string | null {
  // kboId가 제공되면 우선 사용 (동명이인 대응)
  if (kboId && PLAYER_PHOTO_ID_SET.has(kboId)) {
    return \`/players/\${kboId}.jpg\`;
  }
  // kboId가 명시적으로 제공됐지만 사진이 없으면 → null (다른 동명이인 사진 방지)
  if (kboId) return null;
  // name 기반 fallback (kboId가 없는 경우만 — 라이브 경기 등)
  const mappedId = PLAYER_PHOTO_MAP[name];
  if (!mappedId) return null;
  return \`/players/\${mappedId}.jpg\`;
}

export function getPlayerPhotoByKboId(kboId: string): string | null {
  if (!PLAYER_PHOTO_ID_SET.has(kboId)) return null;
  return \`/players/\${kboId}.jpg\`;
}\n`;

  return ts;
}

async function main() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf-8'));
  console.log(`Roster: ${roster.length} players`);

  // Ensure photos dir exists
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });

  // Read existing photo map
  const existingPhotos = new Set(
    fs.readdirSync(PHOTOS_DIR)
      .filter(f => f.endsWith('.jpg'))
      .map(f => f.replace('.jpg', ''))
  );
  console.log(`Existing photos: ${existingPhotos.size}`);

  const photoMap = {}; // name → kboId
  const photoIdSet = new Set(); // all kboIds with photos
  const stats = { updated: 0, newDownloads: 0, failed: 0, skipped: 0, foreignExtracted: 0, aliasCopied: 0, manualDownloaded: 0 };

  // Group players: numeric IDs (CDN) vs non-numeric (need page scraping)
  const cdnPlayers = roster.filter(p => /^\d+$/.test(p.kboId));
  const foreignPlayers = roster.filter(p => !/^\d+$/.test(p.kboId));

  console.log(`\nPhase 1: CDN download (${cdnPlayers.length} players with numeric IDs)...`);
  
  for (let i = 0; i < cdnPlayers.length; i++) {
    const p = cdnPlayers[i];
    const destPath = path.join(PHOTOS_DIR, `${p.kboId}.jpg`);
    
    // Always re-download to get 2026 season photos (new uniforms after transfers)
    const ok = await downloadPhoto(p.kboId, destPath);
    if (ok) {
      photoMap[p.name] = p.kboId;
      photoIdSet.add(p.kboId);
      if (existingPhotos.has(p.kboId)) {
        stats.updated++;
      } else {
        stats.newDownloads++;
      }
    } else {
      // Keep existing if download failed
      if (existingPhotos.has(p.kboId)) {
        photoMap[p.name] = p.kboId;
        photoIdSet.add(p.kboId);
        stats.skipped++;
      } else {
        stats.failed++;
      }
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${cdnPlayers.length} processed (${stats.updated} updated, ${stats.newDownloads} new, ${stats.failed} failed)`);
    }
    // Rate limit: ~20 req/s
    if (i % 20 === 19) await sleep(1000);
  }

  console.log(`\nPhase 2: Foreign players (${foreignPlayers.length} from KBO pages)...`);
  
  for (const p of foreignPlayers) {
    const destPath = path.join(PHOTOS_DIR, `${p.kboId}.jpg`);
    const buf = await extractPhotoFromKboPage(p.kboId);
    if (buf) {
      fs.writeFileSync(destPath, buf);
      photoMap[p.name] = p.kboId;
      photoIdSet.add(p.kboId);
      stats.foreignExtracted++;
      console.log(`  ✅ ${p.team} ${p.name} (${p.kboId})`);
    } else {
      // 1) Keep existing current-id photo if already present
      if (existingPhotos.has(p.kboId)) {
        photoMap[p.name] = p.kboId;
        photoIdSet.add(p.kboId);
      } else {
        // 2) Reuse historic/local headshot via alias map when current roster ID is temporary
        const aliasId = PHOTO_ALIAS_BY_KBO_ID[p.kboId];
        const aliasPath = aliasId ? path.join(PHOTOS_DIR, `${aliasId}.jpg`) : null;
        if (aliasPath && fs.existsSync(aliasPath)) {
          fs.copyFileSync(aliasPath, destPath);
          photoMap[p.name] = p.kboId;
          photoIdSet.add(p.kboId);
          stats.aliasCopied++;
          console.log(`  ↪️  ${p.team} ${p.name} (${p.kboId}) <- alias ${aliasId}`);
        } else {
          // 3) Final fallback: curated manual source
          const manualUrl = MANUAL_PHOTO_URL_BY_KBO_ID[p.kboId];
          const ok = manualUrl ? await downloadPhotoFromUrl(manualUrl, destPath) : false;
          if (ok) {
            photoMap[p.name] = p.kboId;
            photoIdSet.add(p.kboId);
            stats.manualDownloaded++;
            console.log(`  🖼️  ${p.team} ${p.name} (${p.kboId}) <- manual source`);
          } else {
            stats.failed++;
            console.log(`  ❌ ${p.team} ${p.name} (${p.kboId})`);
          }
        }
      }
    }
    await sleep(500); // Be gentle with KBO server
  }

  // Also keep any existing photos for players NOT in current roster (backward compat)
  for (const id of existingPhotos) {
    if (!photoIdSet.has(id)) {
      photoIdSet.add(id);
    }
  }

  // Generate updated TypeScript
  console.log(`\nGenerating player-photos.ts...`);
  const ts = generatePhotosTs(photoMap, photoIdSet);
  fs.writeFileSync(PHOTOS_TS_PATH, ts);

  console.log(`\n=== Summary ===`);
  console.log(`Updated (re-downloaded): ${stats.updated}`);
  console.log(`New downloads: ${stats.newDownloads}`);
  console.log(`Foreign extracted: ${stats.foreignExtracted}`);
  console.log(`Alias copied: ${stats.aliasCopied}`);
  console.log(`Manual downloaded: ${stats.manualDownloaded}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Kept existing (CDN 404): ${stats.skipped}`);
  console.log(`Total photos: ${photoIdSet.size}`);
  console.log(`Photo map entries: ${Object.keys(photoMap).length}`);
}

main().catch(console.error);
