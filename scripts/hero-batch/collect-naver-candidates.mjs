/**
 * 네이버 이미지 검색(공식 Open API)으로 선수 후보 이미지를 수집.
 *
 * ⚠️ 크롤링 아님 — 발급받은 NAVER_CLIENT_ID/SECRET 로 공식 Open API 호출.
 *    (search.naver.com robots Disallow 는 HTML 크롤러 대상이며, 본 정식 API 와 무관)
 *
 * 사용:
 *   import { collectNaverCandidates } from "./collect-naver-candidates.mjs";
 *   const cands = await collectNaverCandidates("가나쿠보", { team: "키움", count: 5 });
 *   // cands = [{ link, thumbnail, title }, ...]
 *
 * 셀프테스트:
 *   node scripts/hero-batch/collect-naver-candidates.mjs --selftest
 */

import fs from "fs";

function envOr(name) {
  if (process.env[name]) return process.env[name];
  // 로컬 fallback: repo .env.local (CI 에선 env 주입)
  try {
    const root = new URL("../../.env.local", import.meta.url);
    const txt = fs.readFileSync(root, "utf8");
    const m = txt.match(new RegExp(`^${name}=(.+)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

const CLIENT_ID = envOr("NAVER_CLIENT_ID");
const CLIENT_SECRET = envOr("NAVER_CLIENT_SECRET");

/**
 * @param {string} name 선수명
 * @param {object} [opts]
 * @param {string} [opts.team] 팀명 (쿼리 정확도용)
 * @param {number} [opts.count=5] 수집 개수
 * @returns {Promise<Array<{link:string, thumbnail:string, title:string}>>}
 */
export async function collectNaverCandidates(name, opts = {}) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("NAVER_CLIENT_ID/SECRET missing");
  const count = opts.count ?? 5;
  const query = [name, opts.team, "야구선수"].filter(Boolean).join(" ");

  const url = new URL("https://openapi.naver.com/v1/search/image");
  url.searchParams.set("query", query);
  url.searchParams.set("display", String(Math.min(count * 2, 20))); // 노이즈 대비 여유
  url.searchParams.set("sort", "sim");
  url.searchParams.set("filter", "large"); // 얼굴 판별 가능한 큰 이미지 위주

  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": CLIENT_ID,
      "X-Naver-Client-Secret": CLIENT_SECRET,
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Naver API HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return items.slice(0, count).map((it) => ({
    link: it.link,
    thumbnail: it.thumbnail,
    title: it.title?.replace(/<\/?b>/g, "") || "",
  }));
}

// ===== 셀프테스트 =====
async function selftest() {
  const cands = await collectNaverCandidates("가나쿠보", { team: "키움", count: 5 });
  console.log(`수집 ${cands.length}건:`);
  cands.forEach((c, i) => console.log(`  ${i + 1}. ${c.title.slice(0, 40)} :: ${c.link.slice(0, 70)}`));
  process.exit(cands.length > 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
}
