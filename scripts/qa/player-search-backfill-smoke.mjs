#!/usr/bin/env node
import {
  assertProfileIdentity,
  buildCandidateManifest,
  extractHiddenFields,
  parsePlayerDetailPage,
  parseSearchPage,
  photoUrlMatches2026,
  selectMissingPlayers,
} from "../lib/kbo-player-search.mjs";

let failed = 0;
function ok(name, condition) {
  console.log(`${condition ? "✅" : "❌"} ${name}`);
  if (!condition) failed++;
}

const html = `
<input id="__VIEWSTATE" value="vs" />
<input id="__VIEWSTATEGENERATOR" value="vg" />
<input id="__EVENTVALIDATION" value="ev" />
<p>검색결과 : <span class="point">2</span>건</p>
<table><tbody>
<tr><td>98</td><td><a href='/Futures/Player/PitcherDetail.aspx?playerId=51809'>조요한</a></td><td>SSG</td><td>투수</td><td>2000-01-06</td><td></td><td></td></tr>
<tr><td></td><td><a href='/Record/Player/PitcherDetail/Basic.aspx?playerId=50811'>길&amp;지석</a></td><td>SSG</td><td>투수</td><td>2001-11-02</td><td></td><td></td></tr>
</tbody></table>`;

const hidden = extractHiddenFields(html);
ok("ASP.NET hidden token 추출", hidden.__VIEWSTATE === "vs" && hidden.__EVENTVALIDATION === "ev");

const parsed = parseSearchPage(html, "SK");
ok("검색 결과 count 파싱", parsed.total === 2 && parsed.players.length === 2);
ok("선수 필드 파싱", parsed.players[0].kboId === "51809" && parsed.players[0].teamId === 4 && parsed.players[0].position === "투수");
ok("빈 등번호는 validator 허용값 '-'", parsed.players[1].backNo === "-");
ok("HTML entity decode", parsed.players[1].name === "길&지석");

let tokenFailed = false;
try { extractHiddenFields("<html></html>"); } catch { tokenFailed = true; }
ok("form token 누락 fail-closed", tokenFailed);

let teamFailed = false;
try { parseSearchPage(html.replaceAll("SSG", "KIA"), "SK"); } catch { teamFailed = true; }
ok("팀 filter 불일치 fail-closed", teamFailed);

const roster = [
  { name: "조요한", kboId: "51809", team: "SSG" },
  { name: "기존외인", kboId: "FP001", team: "SSG" },
  { name: "이름중복", kboId: "99999", team: "SSG" },
];
const source = [
  ...parsed.players,
  { ...parsed.players[0], name: "기존외인", kboId: "56789" },
];
const selected = selectMissingPlayers(source, roster, { "56789": "FP001" });
ok("기존 ID hit 차단 + 신규만 missing", selected.missing.length === 1 && selected.missing[0].kboId === "50811");
ok("외국인 alias는 name+team 겹쳐도 collision 아님(ID→alias→collision 순서)", selected.skippedForeignAliases.length === 1);

let collisionThrown = false;
try {
  selectMissingPlayers(
    [...parsed.players, { ...parsed.players[0], name: "이름중복", kboId: "77777" }],
    roster,
    { "56789": "FP001" },
  );
} catch (error) {
  collisionThrown = /collision/.test(String(error?.message));
}
ok("동명이인 name+team collision은 silent skip 대신 fail-closed throw", collisionThrown);

ok("2026 정확한 사진 경로 통과", photoUrlMatches2026("https://cdn.koreabaseball.com/KBO_IMAGE/person/middle/2026/65665.jpg", "65665"));
ok("old-year(2025) 사진 거부", !photoUrlMatches2026("https://cdn.koreabaseball.com/KBO_IMAGE/person/middle/2025/65665.jpg", "65665"));
ok("wrong-id 사진 거부", !photoUrlMatches2026("https://cdn.koreabaseball.com/KBO_IMAGE/person/middle/2026/99999.jpg", "65665"));
ok("default/no-image 사진 거부", !photoUrlMatches2026("https://cdn.koreabaseball.com/KBO_IMAGE/person/no_Image.png", "65665"));
ok("malformed 사진 URL 거부", !photoUrlMatches2026("not-a-url", "65665"));

let identityPassed = true;
try {
  assertProfileIdentity({ name: "이 준영", kboId: "65665" }, { name: "이준영" });
} catch {
  identityPassed = false;
}
ok("search/profile 정규화 동일 이름 통과", identityPassed);

let identityThrown = false;
try {
  assertProfileIdentity({ name: "이준영", kboId: "65665" }, { name: "김철수" });
} catch (error) {
  identityThrown = /name mismatch/.test(String(error?.message));
}
ok("다른 선수 profile name은 fail-closed throw", identityThrown);

const mkCandidate = (kboId, name, photoBytes) => ({
  teamId: 4,
  kboId,
  name,
  position: "투수",
  backNo: "1",
  birthDate: "2000-01-01",
  photo: Buffer.from(photoBytes),
});
const manifestA = buildCandidateManifest([mkCandidate("111", "A", "pa"), mkCandidate("222", "B", "pb")]);
const manifestAReversed = buildCandidateManifest([mkCandidate("222", "B", "pb"), mkCandidate("111", "A", "pa")]);
ok("manifest digest는 정렬 기반이라 순서 무관 안정", manifestA.sha256 === manifestAReversed.sha256);
const manifestSwapped = buildCandidateManifest([mkCandidate("111", "A", "pa"), mkCandidate("333", "C", "pc")]);
ok("same-count set-swap(A탈락+B신규)은 digest 변경", manifestSwapped.sha256 !== manifestA.sha256);
const manifestPhotoChanged = buildCandidateManifest([mkCandidate("111", "A", "pa"), mkCandidate("222", "B", "DIFFERENT")]);
ok("동일 집합이라도 사진 bytes 변경이면 digest 변경", manifestPhotoChanged.sha256 !== manifestA.sha256);

const detail = parsePlayerDetailPage(`
<img id="x_playerProfile_imgProgile" src="//cdn.example/65665.jpg" />
<span id="x_playerProfile_lblName">이준영</span>
<span id="x_playerProfile_lblBackNo">20</span>
<span id="x_playerProfile_lblPosition">투수(좌투좌타)</span>
<span id="x_playerProfile_lblDraft">15 KIA 2차 4라운드</span>`);
ok("선수상세 프로필/사진 파싱", detail.name === "이준영" && detail.position === "투수" && detail.backNo === "20");
ok("protocol-relative 사진 URL 보정", detail.photoUrl === "https://cdn.example/65665.jpg");

console.log(`\n${failed === 0 ? "🟢 ALL PASS" : `🔴 ${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
