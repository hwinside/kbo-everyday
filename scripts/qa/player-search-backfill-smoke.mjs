#!/usr/bin/env node
import {
  extractHiddenFields,
  parsePlayerDetailPage,
  parseSearchPage,
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
  { ...parsed.players[0], name: "기존외인-숫자alias", kboId: "56789" },
  { ...parsed.players[0], name: "이름중복", kboId: "77777" },
];
const selected = selectMissingPlayers(source, roster, { "56789": "FP001" });
ok("기존 id/name+team/외국인 alias 중복 차단", selected.missing.length === 1 && selected.missing[0].kboId === "50811");
ok("외국인 alias skip 관측", selected.skippedForeignAliases.length === 1);

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
