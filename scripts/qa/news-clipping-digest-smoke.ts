/**
 * 뉴스클리핑 payload 정규화(digest 참조) 계약 게이트.
 *
 * Why
 * ---
 * 2026-08-20 실측: dm_messages 2,110MB 중 TOAST 1,592MB. content 는 평균 60바이트인데
 * payload 가 평균 2,025바이트이고 96.7% 행에 있었다. 내용을 보니 같은 기사 묶음을
 * 수신자 수만큼 통째로 복제 저장 중이었다(8/18 KIA 6,102행 / distinct payload 120 = 중복률 98%).
 *
 * 이 PR 은 기사 묶음을 news_clipping_digests 1행으로 옮기고 쪽지에는 digest_id 만 남긴다.
 *
 * 여기서 고정하는 계약(깨지면 유저가 즉시 다친다):
 *  1) 과거 쪽지(legacy payload)는 그대로 렌더된다 — 수백만 건을 재작성하지 않으므로 필수.
 *  2) 신규 쪽지(ref payload)는 digest 를 붙이면 렌더된다.
 *  3) ref 인데 digest 가 없으면 **null 로 fail-close** — 빈 카드는 "오늘 기사 없음"이라는
 *     거짓 정보다. 카드 대신 텍스트 본문이 나가야 한다.
 *  4) intro(유저별 닉네임 치환)는 digest 가 아니라 쪽지 payload 에 남는다 — digest 는
 *     (clip_date, team_id) 공유 행이라 거기 넣으면 한 사람 닉네임이 팀 전체에 보인다.
 *  5) 식별 술어가 두 형태를 모두 인정한다 — 기존 isNewsClippingPayload 는 articles.length>0 을
 *     요구했고, 그대로 뒀으면 신규 쪽지가 전부 일반 텍스트로 렌더됐다.
 *
 * 실행: npx tsx scripts/qa/news-clipping-digest-smoke.ts  (npm run qa:news-clip-digest)
 */
import {
  isLegacyNewsClippingPayload,
  isNewsClippingPayload,
  isRefNewsClippingPayload,
  toNewsClippingView,
  type NewsClippingArticle,
  type NewsClippingDigest,
  type NewsClippingLegacyPayload,
  type NewsClippingRefPayload,
} from "@/types/news-clipping";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const ARTICLES: NewsClippingArticle[] = [
  {
    title: "LG, 두산 꺾고 4연승",
    link: "https://n.news.naver.com/mnews/article/001/0001",
    original_link: "https://sports.example.com/1",
    thumbnail_url: "https://img.example.com/1.jpg",
    summary: ["무슨 일", "구체 내용", "팬 관점"],
  },
  {
    title: "오스틴 결승 2루타",
    link: "https://n.news.naver.com/mnews/article/001/0002",
    original_link: null as unknown as string | undefined,
    thumbnail_url: null,
    summary: ["a", "b", "c"],
  },
];

const LEGACY: NewsClippingLegacyPayload = {
  type: "news_clipping",
  team_id: 1,
  team_name: "LG 트윈스",
  date: "2026-08-19",
  overview: "4연승 질주",
  articles: ARTICLES,
};

const REF: NewsClippingRefPayload = {
  type: "news_clipping",
  team_id: 1,
  team_name: "LG 트윈스",
  date: "2026-08-19",
  digest_id: 42,
};

const DIGEST: NewsClippingDigest = {
  id: 42,
  clip_date: "2026-08-19",
  team_id: 1,
  team_name: "LG 트윈스",
  overview: "4연승 질주",
  articles: ARTICLES,
};

// ── 1) 식별 술어 ─────────────────────────────────────────────────────────
ok("legacy 는 legacy 로 식별", isLegacyNewsClippingPayload(LEGACY));
ok("legacy 는 ref 가 아님", !isRefNewsClippingPayload(LEGACY));
ok("ref 는 ref 로 식별", isRefNewsClippingPayload(REF));
ok("ref 는 legacy 가 아님", !isLegacyNewsClippingPayload(REF));
// 이게 깨지면 신규 쪽지가 전부 일반 텍스트로 렌더된다(사용자가 즉시 본다).
ok("통합 술어가 legacy 인정", isNewsClippingPayload(LEGACY));
ok("통합 술어가 ref 인정", isNewsClippingPayload(REF));

// 비클리핑/위조 방어
ok("type 다르면 거부", !isNewsClippingPayload({ type: "urgent_notice", articles: ARTICLES }));
ok("null 거부", !isNewsClippingPayload(null));
ok("문자열 거부", !isNewsClippingPayload("news_clipping"));
ok("빈 articles 는 legacy 아님", !isLegacyNewsClippingPayload({ ...LEGACY, articles: [] }));
ok(
  "digest_id 가 0/음수/문자열이면 ref 아님",
  !isRefNewsClippingPayload({ ...REF, digest_id: 0 }) &&
    !isRefNewsClippingPayload({ ...REF, digest_id: -1 }) &&
    !isRefNewsClippingPayload({ ...REF, digest_id: "42" }),
);

// ── 2) 렌더 정규화 ────────────────────────────────────────────────────────
{
  const view = toNewsClippingView(LEGACY, null);
  ok("legacy 는 digest 없이도 렌더됨(과거 쪽지 보존)", view !== null);
  ok("legacy 기사 수 보존", view?.articles.length === 2);
  ok("legacy overview 보존", view?.overview === "4연승 질주");
}
{
  const view = toNewsClippingView(REF, DIGEST);
  ok("ref + digest 렌더됨", view !== null);
  ok("ref 기사 수는 digest 에서", view?.articles.length === 2);
  ok("ref overview 는 digest 에서", view?.overview === "4연승 질주");
}
{
  // ⚠️ 관측 가능성: payload 와 digest 의 team_name/date 가 같은 픽스처로는 "어느 \audf을 우선하는가"
  //    계약이 원리적으로 관측되지 않는다(훼손해도 결과가 같다). 값을 달리 부여해 무대를 만든다.
  //    왜 쪽지 payload 가 우선인가: digest 는 (clip_date, team_id) 단일 행이라 나중에 갱신될 수
  //    있고(upsert), 그러면 **과거 쪽지의 팀명이 소급 변경**된다. 발송 당시 사실을 지키는 것은
  //    쪽지 payload 쪽이다.
  const renamedDigest: NewsClippingDigest = {
    ...DIGEST,
    team_name: "서울 LG 트윈스(개명)",
    clip_date: "2026-01-01",
  };
  const view = toNewsClippingView(REF, renamedDigest);
  ok("ref team_name 은 쪽지 payload 우선(발송 당시 사실)", view?.team_name === "LG 트윈스");
  ok("ref date 도 쪽지 payload 우선", view?.date === "2026-08-19");
  // 반대로 payload 값이 비어있으면 digest 로 폴백한다(방어적 기본값).
  const empty = toNewsClippingView({ ...REF, team_name: "", date: "" }, renamedDigest);
  ok("payload team_name 공백이면 digest 폴백", empty?.team_name === "서울 LG 트윈스(개명)");
  ok("payload date 공백이면 digest 폴백", empty?.date === "2026-01-01");
}

// ── 3) fail-close ────────────────────────────────────────────────────────
// 빈 카드를 그리면 "오늘 기사가 없다"는 거짓말이 된다. null 이어야 텍스트 본문으로 떨어진다.
ok("ref + digest 없음 → null(fail-close)", toNewsClippingView(REF, null) === null);
ok("ref + digest undefined → null", toNewsClippingView(REF, undefined) === null);
ok(
  "ref + digest.articles 빈배열 → null",
  toNewsClippingView(REF, { ...DIGEST, articles: [] }) === null,
);
ok(
  "ref + digest.articles 비배열 → null",
  toNewsClippingView(REF, { ...DIGEST, articles: null as unknown as NewsClippingArticle[] }) === null,
);

// ── 4) intro 는 쪽지 payload 단에 남는다 ──────────────────────────────────
// digest 는 (clip_date, team_id) 공유 행이다. intro 가 거기 들어가면 한 사람의 닉네임이
// 그 팀 수신자 전원에게 보인다 — 개인정보 노출.
{
  const refWithIntro: NewsClippingRefPayload = { ...REF, intro: "민수님 반갑습니다" };
  const view = toNewsClippingView(refWithIntro, DIGEST);
  ok("ref intro 가 view 로 전달됨", view?.intro === "민수님 반갑습니다");
  ok(
    "digest 타입에 intro 필드가 없다(공유 행 오염 방지)",
    !Object.prototype.hasOwnProperty.call(DIGEST, "intro"),
  );
  // 같은 digest 를 공유하는 다른 유저의 view 에는 그 intro 가 없어야 한다.
  const other = toNewsClippingView(REF, DIGEST);
  ok("같은 digest 를 쓰는 다른 유저에게 intro 안 샘", other?.intro === undefined);
}
{
  const legacyWithIntro: NewsClippingLegacyPayload = { ...LEGACY, intro: "영희님 반갑습니다" };
  ok("legacy intro 도 보존", toNewsClippingView(legacyWithIntro, null)?.intro === "영희님 반갑습니다");
}

// ── 5) 정규화 효과(용량) — 이 PR 의 존재 이유를 수치로 고정 ───────────────
{
  const legacyBytes = JSON.stringify(LEGACY).length;
  const refBytes = JSON.stringify(REF).length;
  ok(`ref payload 가 legacy 보다 작다 (${refBytes}B < ${legacyBytes}B)`, refBytes < legacyBytes);
  // 실측 기준: legacy 평균 2,025B → ref 는 100~200B 대. 최소 5배는 줄어야 의미가 있다.
  ok(`ref 가 legacy 의 1/5 미만 (${(legacyBytes / refBytes).toFixed(1)}배 감소)`, refBytes * 5 < legacyBytes);
}

console.log(`\nnews-clipping digest: ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
if (fail > 0) process.exit(1);
