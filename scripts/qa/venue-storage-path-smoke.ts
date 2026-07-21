/**
 * 직관 라이브 Storage 소유경로 canonicalization 우회 방지 스모크.
 * 실행: npm run qa:venue-storage-path
 * 배경: PR #689 삼순 P0 — ../ · %2e%2e · %2f · ..\ path traversal 로 타인 객체 소유 우회.
 */
import {
  parseStoragePublicUrl,
  ownsPath,
} from "../../src/lib/venue-stories/storage-path";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const BASE = "https://proj.supabase.co";
const GAME = "20260718OBLG0";
const ME = "11111111-1111-1111-1111-111111111111";
const VICTIM = "22222222-2222-2222-2222-222222222222";
const pub = (p: string) => `${BASE}/storage/v1/object/public/${p}`;

console.log("[parseStoragePublicUrl — 정상]");
const okUrl = parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/1700-ab.mp4`), BASE);
ok("정상 videos 경로 파싱", okUrl?.bucket === "videos" && okUrl.path === `venue-stories/${GAME}/${ME}/1700-ab.mp4`);
ok("photos 버킷 허용", parseStoragePublicUrl(pub(`photos/venue-stories/${GAME}/${ME}/x.jpg`), BASE)?.bucket === "photos");

console.log("[parseStoragePublicUrl — 우회 차단]");
ok("허용 안 된 버킷 → null", parseStoragePublicUrl(pub(`avatars/venue-stories/${GAME}/${ME}/x.jpg`), BASE) === null);
ok("다른 origin → null", parseStoragePublicUrl(`https://evil.com/storage/v1/object/public/videos/venue-stories/${GAME}/${ME}/x.mp4`, BASE) === null);
ok("prefix 불일치 → null", parseStoragePublicUrl(`${BASE}/storage/v1/object/sign/videos/x.mp4`, BASE) === null);
ok("raw ..\\ backslash → null", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/..\\${VICTIM}/x.mp4`), BASE) === null);
ok("raw %2e%2e → null", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/%2e%2e/${VICTIM}/x.mp4`), BASE) === null);
ok("raw %2f → null", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}%2f${VICTIM}/x.mp4`), BASE) === null);

console.log("[percent 봉인 — 삼순 09:44 #3 double-encode/malformed]");
// double-encoded %252f: 1회 decode 후 %2f 가 남아 ownsPath 우회하던 벡터 → percent 전면 거부
ok("double-encoded %252f → null", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/a%252fb.mp4`), BASE) === null);
ok("double-encoded %252e%252e → null", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/%252e%252e.mp4`), BASE) === null);
// malformed %zz: decodeURIComponent 가 URIError throw 하던 벡터 → throw 없이 null
{
  let threw = false;
  let r: unknown = undefined;
  try {
    r = parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/a%zz.mp4`), BASE);
  } catch {
    threw = true;
  }
  ok("malformed %zz → throw 없이 null(URIError 봉인)", !threw && r === null);
}
ok("임의 percent(%41) 도 전면 거부", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/%41.mp4`), BASE) === null);
ok("정상 경로는 계속 허용(봉인 부작용 없음)", parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/1700-ab.mp4`), BASE) !== null);
// URL 정규화로 ../ 가 접혀도, 남은 dot segment/규격 미스는 ownsPath 에서도 막힘. 여기선 파싱 단계 확인.
const traversal = parseStoragePublicUrl(pub(`videos/venue-stories/${GAME}/${ME}/../${VICTIM}/x.mp4`), BASE);
ok("../ 는 canonical 로 접힘(파싱은 될 수 있으나 victim 경로로 정규화)", traversal === null || traversal.path.includes(VICTIM));

console.log("[ownsPath — 소유권 바인딩]");
ok("본인 규격 경로 → true", ownsPath(`venue-stories/${GAME}/${ME}/1700-ab.mp4`, GAME, ME) === true);
ok("타인 userId → false", ownsPath(`venue-stories/${GAME}/${VICTIM}/1700-ab.mp4`, GAME, ME) === false);
ok("다른 gameId → false", ownsPath(`venue-stories/OTHERGAME/${ME}/x.mp4`, GAME, ME) === false);
ok("../ traversal 경로 → false(규격 불일치)", ownsPath(`venue-stories/${GAME}/${ME}/../${VICTIM}/x.mp4`, GAME, ME) === false);
ok("filename 에 하위 slash → false", ownsPath(`venue-stories/${GAME}/${ME}/sub/x.mp4`, GAME, ME) === false);
ok("prefix 밖 경로 → false", ownsPath(`other/${GAME}/${ME}/x.mp4`, GAME, ME) === false);
ok("uuid 형식 아님 → false", ownsPath(`venue-stories/${GAME}/not-a-uuid/x.mp4`, GAME, "not-a-uuid") === false);
// traversal 로 파싱을 통과시켜도(정규화 후 victim path) ownsPath 가 규격 미스로 최종 차단
ok("정규화된 victim 경로도 ownsPath 차단", ownsPath(`venue-stories/${GAME}/${VICTIM}/x.mp4`, GAME, ME) === false);
// strict filename allowlist([A-Za-z0-9._-]) — percent/공백/특수문자 거부(staging 경로 직접 검증에도 적용)
ok("filename 에 %2f → false(봉인)", ownsPath(`venue-stories/${GAME}/${ME}/a%2fb.mp4`, GAME, ME) === false);
ok("filename 에 공백 → false", ownsPath(`venue-stories/${GAME}/${ME}/a b.mp4`, GAME, ME) === false);
ok("filename 비 ASCII → false", ownsPath(`venue-stories/${GAME}/${ME}/한글.mp4`, GAME, ME) === false);
ok("과장 길이(>512) → false", ownsPath(`venue-stories/${GAME}/${ME}/${"a".repeat(600)}.mp4`, GAME, ME) === false);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
