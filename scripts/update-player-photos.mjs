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
  const stats = { updated: 0, newDownloads: 0, failed: 0, skipped: 0, foreignExtracted: 0 };

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
      if (existingPhotos.has(p.kboId)) {
        photoMap[p.name] = p.kboId;
        photoIdSet.add(p.kboId);
      } else {
        stats.failed++;
        console.log(`  ❌ ${p.team} ${p.name} (${p.kboId})`);
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
  console.log(`Failed: ${stats.failed}`);
  console.log(`Kept existing (CDN 404): ${stats.skipped}`);
  console.log(`Total photos: ${photoIdSet.size}`);
  console.log(`Photo map entries: ${Object.keys(photoMap).length}`);
}

main().catch(console.error);
