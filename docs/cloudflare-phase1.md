# Spec — Cloudflare Phase 1 (설계 리뷰 초안 v2)

상태: **Draft PR 설계 리뷰용 / Notion SSOT 후속 반영 / 활성화 HOLD**. 2026-09-06 22:59 삼식 요청에 따라 docs-only PR에서 먼저 exact SHA 기준으로 리뷰한다. 이 문서는 실행 승인이나 코드 구현 완료를 뜻하지 않는다. 노션 접근 복구 후 검토 결과와 배포 기록을 원문에 반영하며, 기존 로컬 v1 미러는 직접 덮어쓰지 않는다.

- 작성: 삼순. 리뷰·모든 QA·인프라 운영: 삼식. 실제 콘솔/NS 실행자와 계정 접근 방식은 하린아빠 결정.
- 범위: 쿠키 캐시 역효과 설계, 존 설정, 활성화 전 증거, 단계적 전환·롤백. 코드 구현/머지와 인프라 활성화는 각각 해당 게이트를 거친다.
- 근거 코드: #1349 merge `02c1e44e332297ad37238542ef4b7990bd94496c`, `src/lib/http/{client-ip,cloudflare-cache}.ts` 직접 대조. PR https://github.com/hwinside/kbo-everyday/pull/1349
- 최신 QA: 삼식 2026-09-06 22:50 보고 — `dbc3e8f10`에 #1349 포함, OFF 상태 stats/counts 헤더·IP 경로·standings 스모크 PASS. ON 상태/인증서 갱신/실절감 PASS로 확대하지 않는다.
- Notion 편집 접근 미확보. SSOT 반영은 후속이며 PR 설계 리뷰를 막지 않는다. 인증정보는 채팅·스크립트로 수집하지 않는다.

## 1. 현 상태와 v1에서 폐기할 내용

두 플래그 `CLOUDFLARE_TRUST_CLIENT_IP`, `CLOUDFLARE_PUBLIC_API_CACHE`는 기본 OFF인 코드가 배포됐다. 이 작업에서 플래그·DNS·Cloudflare 설정을 변경하지 않았다. 현재 DNS/존 상태는 실제 실행자가 구성 직전에 재조회한다.

- IP는 무조건 `cf-connecting-ip` 우선이 아니다. VERCEL 환경·canonical host·플랫폼 peer·CF CIDR·단일 유효 client IP를 검증하는 코드다. 7파일/8콜사이트.
- stats/counts의 외부 `Cache-Control: public`만으로 원본 TTL이 없다고 판정하지 않는다. Vercel은 s-maxage를 소비·제거할 수 있다. 기존 remaining TTL을 재사용하며 실시간 지연 예산을 늘리지 않는다.
- `/_next/image`, HTML/RSC, 광범위 확장자 캐시 규칙은 초기 대상에서 제외한다. 이미지 Accept 변형 키 증거가 없으므로 단순 캐시/요금제 변경으로 해결한다고 쓰지 않는다.
- “9/7 무산/물리적 불가”, “9/14 확정” 모두 근거 없는 일정 단정이다. 준비 게이트·실행자·승인에 따라 창을 정한다.
- 존 생성/DNS-only 자체는 절감이 아니다. 실제 CF HIT와 Vercel 유입 감소 및 양사·이전 서비스 합산 비용이 필요하다.
- “프리뷰 main/release 제한”은 철회. #1276 배포 게이트 간소화 재검토는 별도 트랙이며 이 스펙에 구현을 혼합하지 않는다.

## 2. 쿠키 트래픽 정책 — 리뷰 제안 결정

**API의 Cookie/Authorization을 제거하지 않는다. 해당 API는 CF lookup 단계에서 우회하고 Vercel의 기존 캐시 계약을 보존한다.** 세션 무관 immutable 정적 파일의 R1은 별도 조건(§3)이다. “ineligible이면 모든 헤더 무변경”도 그대로 채택하지 않는다. 부적격 API의 브라우저/Vercel 계약은 보존하되 CF 전용 `no-store`를 명시해야 의도치 않은 CF 저장을 막을 수 있다.

| 경우 | Cloudflare | Vercel / 브라우저 | 구현 요구 |
| --- | --- | --- | --- |
| 플래그 OFF | 현행 그대로 | 응답 객체·모든 헤더 그대로 | OFF 보호 앵커 유지 |
| ON + 익명 허용 API + 유효 200 JSON/기존 TTL | 기존 remaining TTL로만 캐시 | Vercel no-store; browser는 OFF의 `public`에서 `private, no-store, max-age=0`으로 **명시 변경** | #1349에 준비된 ON eligible 분기 계약. 현재 OFF 브라우저 계약과 동일하다는 뜻이 아님 |
| ON + Cookie/Authorization/RSC 등 부적격 요청 | lookup BYPASS + origin `Cloudflare-CDN-Cache-Control: no-store` | **원래 Cache-Control/CDN-Cache-Control/Vercel-CDN-Cache-Control 보존** | 현재 부적격 분기의 일괄 no-store를 수정하는 후속 코드 필요 |
| ON + 오류/degraded/Set-Cookie/Vary/TTL 이상 등 부적격 응답 | 저장 금지 | 원본 no-store/private 등 더 엄격한 계약도 그대로 보존 | 인증·개인화 안전성 선행 확인; 원본 계약에 결함이 있으면 활성화 차단 |

중요: 원본이 Vercel 캐시 가능하다는 이유만으로 로그인 응답까지 공개 안전하다고 간주하지 않는다. **허용 API 두 개의 응답이 세션에 무관한 공개 집계인지** 두 계정·익명 비교로 확인한다. 개인정보가 섞이면 그 경로는 허용목록에서 제외하며 “기존 캐시 보존”을 강행하지 않는다.

### 2.1 혼합 캐시 순서 경계

- Cookie 요청이 먼저 Vercel 캐시를 채우면 같은 URL의 익명 요청이 그 캐시를 받을 수 있다. 이때 Vercel 캐시 HIT에도 CF 전용 no-store가 유지되는지 실측한다. 안전하게 CF BYPASS가 지속될 수 있으며, 이것을 무조건 CF HIT가 된다고 주장하지 않는다.
- 익명→Cookie, Cookie→익명, 계정 A→B, B→A를 동일 key에서 검증한다. origin 헬퍼가 실행되지 않는 Vercel HIT/CF HIT까지 포함한다.
- 이 보존안 때문에 CF 흡수량이 낮아질 수 있다. 정확성과 비용을 따로 판정하고, 안전 확인 없이 Cookie strip 또는 사용자별 고카디널리티 캐시 키로 우회하지 않는다.
- 현재 #1349 코드는 ineligible에서도 inner no-store를 설정하므로 이 결정은 **아직 구현된 상태가 아니다**. 후속 구현·회귀 앵커·삼식 GO·머지 승인·배포를 거치기 전 공개 API 캐시 플래그 ON 금지.

## 3. 초기 캐시 허용 범위와 규칙 순서

Phase 1-A = `/_next/static/`만. Phase 1-B = 검증·코드 보완 후 `/api/stats`, `/api/news/discussion/counts` 두 경로만 추가. 한 번에 이미지/다른 API로 넓히지 않는다.

공통 범위: 승인된 canonical HTTPS host, GET/HEAD, 정확한 허용 path. encoded path·trailing slash·유사 suffix·리다이렉트 변형은 허용하지 않고 실제 Cloudflare 정규화 결과를 검증한다.

- **R1 정적 predicate**: 공통 범위 + 검증된 `/_next/static/` 빌드 산출물 path만. Cookie/Authorization/RSC 헤더 유무로 제외하지 않는다. same-origin 로그인 브라우저는 JS/CSS에도 쿠키를 보내므로 쿠키 없음 조건을 두면 정적 HIT를 불필요하게 차단한다. 해시/버전으로 식별되는 public immutable 산출물이 세션에 따라 변하지 않는다는 것이 예외 근거이며, 익명·두 계정의 동일 bytes/헤더와 실제 HIT를 검증한다. 개인화된 파일이나 Set-Cookie 응답에는 예외를 확대하지 않는다.
- **R2 API predicate**: 공통 범위 + stats/counts exact path + Cookie/Authorization 헤더 **존재 자체가 없음**(빈 값도 제외) + RSC/Next router prefetch/state 헤더 없음 + `_rsc` 쿼리 없음. 정적 파일과 API의 인증 경계를 혼용하지 않는다.

| 순서 | 대상/조건 | 동작 |
| --- | --- | --- |
| R0 | 서비스 대상 host 전체 | 기본 BYPASS |
| R1 | R1 정적 predicate (Cookie/Authorization/RSC 헤더 조건 없음) | Eligible, origin TTL 존중, 오류 저장 금지 |
| R2 | R2 API predicate (인증/Cookie/RSC 제외) | 초기 disabled. Phase 1-B 게이트 후 Eligible, remaining TTL만 |
| R3 | 비 GET·HEAD/검증·민감 경로; API의 인증/Cookie/RSC 조건 및 R1 밖 HTML/RSC 경로 | 최종 BYPASS. **R1 정적 요청은 Cookie/Authorization/RSC 헤더만으로 다시 차단하지 않음.** 이후 이를 덮는 cache rule 없음 |

- Cloudflare Cache Rules는 마지막 일치 설정이 우선이다. 최초 catch-all BYPASS 다음에 좁은 허용 규칙을 놓고 마지막 hard deny로 보호한다. **catch-all BYPASS를 맨 마지막에 놓아 허용까지 전부 무효화하지 않는다.** 실제 UI/Trace 결과와 export로 검증.
- Edge TTL은 `bypass_by_default`(cache-control 있으면 존중, 없으면 BYPASS). `respect_origin`의 헤더 없는 응답 기본 TTL fallback과 구분. 200 TTL override·minimum TTL 강제·SWR/stale-if-error·Always Online 금지.
- 200 외 상태는 Status Code TTL `-1`(no-store) 후보로 제한한다. 200에는 고정 TTL override를 주지 않는다. Free 실제 설정 가능 여부·규칙 유효성 확인 후 반영하며 불가능하면 R2는 HOLD.
- `public`만 있고 명시 freshness 없는 API 응답이 캐시되지 않음을 검증한다. `bypass_by_default` 하나가 모든 부적격 응답을 해결한다고 가정하지 않는다. API는 origin CF 전용 positive TTL 또는 no-store 계약과 구캐시 제거가 필수.
- Browser TTL은 origin 존중. Cache Response Rules/Workers/Page Rules/Transform Rules가 헤더 또는 캐시 결정을 덮지 않는지 전수 확인. 현재 존재/가용성은 미확인.
- 키는 scheme + host + path + **전체 query 값** 구분. query 제거/무조건 정렬/host 합치기/계정 Cookie 포함 금지. query 순서별 중복 저장은 초기 수용하되 요청 혼합은 금지.
- 모든 HTML/RSC 응답 경로, `/_next/image`, 기타 API, 로그인/OAuth callback/admin/업로드/실시간 경로, `/.well-known/acme-challenge/*`, `/.well-known/vercel/*`는 BYPASS. R1의 immutable JS/CSS 요청에 RSC 헤더가 붙은 경우와 실제 RSC 응답 경로를 구분한다. 정적 확장자만으로 예외를 열지 않는다.

## 4. 존 구성 체크리스트 (실행 전 확인용, 아직 적용 안 함)

- [ ] 계정/zone owner, 최소권한 접근 또는 하린아빠 직접 조작·삼식 동행 방식 확정. 공유 비밀번호/토큰을 채팅으로 받지 않음.
- [ ] 가비아·현재 authoritative DNS 레코드 전체 snapshot: A/AAAA/CNAME/MX/TXT(SPF·DKIM·DMARC)/CAA/SRV/NS 위임/서브도메인. v1의 IP·MX 수를 현값으로 재사용하지 않음.
- [ ] Cloudflare 자동 스캔에 의존하지 않고 전수 diff. improvmx 메일 포워딩·MX 및 메일 관련 host DNS-only 보존. AAAA/CAA도 인증서·IPv6 경로에 맞춰 확인.
- [ ] DNSSEC/registrar DS 사용 여부 확인. 사용 중이면 provider 절차에 따라 DS/서명 전환 순서를 준비하여 SERVFAIL 방지. DNSSEC 사용 여부 미확인 상태로 NS 변경 금지.
- [ ] Free 플랜에서 필요한 Cache Rules 수/헤더 조건/Status TTL/키 정책 가용성 확인. 유료 업그레이드/Workers/Tiered Cache는 이번 기본안에 포함하지 않음.
- [ ] SSL Full(strict); Cloudflare edge certificate Active 및 Vercel origin certificate 유효. Origin CA 업로드가 가능하다고 가정하지 않음.
- [ ] Always Use HTTPS OFF를 초기값으로 제안하되 이것만으로 갱신 성공이라 판정하지 않음. HTTP port 80의 ACME path와 Vercel 검증 path에 redirect/WAF/challenge/cache 방해가 없는지 확인.
- [ ] Bot Fight OFF, challenge 규칙 없음. 기존 WAF/rate limit의 보호 범위를 비교하되 임의 전체 해제/방어 대체는 하지 않음. Browser Integrity Check는 앱 영향 검증 후 초기 OFF 제안.
- [ ] Rocket Loader/콘텐츠 재작성 기능/Always Online/기존 Worker route의 간섭 없음. 새 최적화 토글은 일괄 활성화하지 않음.
- [ ] `maxDuration=300` 등 장시간 유저 요청·업로드 크기와 CF 현재 플랜 제한 비교. v1의 “100초/100MB라 괜찮음”을 그대로 승인 근거로 쓰지 않음.
- [ ] 레코드 전부 DNS-only로 먼저 구성. NS 변경 후 authoritative/public resolver 대조·IPv4/IPv6·사이트/메일·서브도메인 확인. NS 안정화 전 주황 구름 ON 금지.

## 5. 활성화 전 검증 명세 — 실행/판정 삼식

각 항목은 exact 코드 SHA·deployment ID·UTC/KST 시각·zone/rule export revision·테스트 경로·expected/actual·증거 위치·판정을 남긴다. 토큰/쿠키 값·개인 IP 원문은 증거에 노출하지 않는다.

| ID | 검증 | PASS 조건 / 실패 시 |
| --- | --- | --- |
| G1 | OFF 회귀 + 새 쿠키 보존 정책 + mutation | OFF 객체/헤더 불변, eligible 단일 TTL, ineligible 원본 Vercel 계약 보존+CF no-store, Cookie strip 없음. 새 분기 mutation RED. 기존 R2 숫자를 후속 SHA에 이월하지 않음 |
| G2 | 실제 ingress 신뢰·버킷 분리 | 직결/preview/CF 경유에서 XFF·cf-connecting-ip·x-vercel-forwarded-for 위조와 IPv4/6·리스트/port/zone ID 경계. 플랫폼 덮어쓰기/정규화가 코드 가정과 일치. **서로 다른 실제 클라이언트 IP의 전용 2계정에서 rate-limit 버킷이 분리됨을 실측**, 정상 요청이 unknown/CF-IP 버킷으로 합쳐지거나 예기치 않은 429를 받지 않음. 같은 NAT IP의 두 계정이 같은 IP 버킷을 쓰는 것은 정상 대조군이며 계정별 분리를 강제하지 않음 |
| G3 | Cache lookup 경계 | R2 API를 익명으로 warm한 뒤 Cookie·Authorization·RSC·다른 method·쿼리 변형을 요청해 HIT 오염 없음. 반대로 R1 정적은 익명/로그인/Cookie/Authorization/RSC 헤더가 있어도 동일 bytes의 안전한 HIT를 유지하고 R3에 다시 막히지 않음. origin no-store만 보고 통과시키지 않음 |
| G4 | 혼합 캐시 순서 | Cookie→익명/익명→Cookie/A→B/B→A 및 실제 Vercel HIT 응답. CF no-store marker 유지·세션 데이터 혼합 없음·쿠키 요청의 기존 Vercel 캐시 가능성 불필요 상실 없음 |
| G5 | 헤더 전달·실제 TTL/형식/오류 | **origin→Vercel→CF ingress에서 CF 전용 positive TTL/no-store 헤더가 보존되어 도달함을 관측**하고, 동일 요청의 진단 증거·CF-Cache-Status·Age를 결속(§5.1). 같은 key·POP의 MISS→HIT와 소스 잔여 TTL, 만료/5xx 시 stale 미서빙. 3xx/4xx/5xx/degraded/Set-Cookie/Vary/public-only/TTL 누락·중복·0·음수·상한 초과는 저장 안 됨. CF 전용 헤더 유실/관측 불가 시 R2 HOLD |
| G6 | 사용자 흐름 | 전용 두 계정으로 웹/iOS/Android 로그인·계정전환·조회수·초대·admin rate limit·워치/실시간 신선도·업로드·callback 확인. 개인/공유 실사용 계정 금지 |
| G7 | DNS/TLS/메일 | 전수 레코드 일치, DNSSEC/CAA/IPv6, 사이트·메일 동작, plain-HTTP ACME/검증 경로 확인. 짧은 스모크는 인증서 실제 갱신 PASS가 아님 |
| G8 | purge/롤백 리허설 | CF rule BYPASS→대상 purge→헤더/데이터 재조회, Vercel 구캐시 제거 증거, proxy OFF 및 IP 플래그 rollback 순서 확인. 캐시 삭제 범위/종류 식별 없이 “재배포면 전부 purge” 가정 금지 |

환경 fixture에서 가능한 실패/오류 응답 검증은 별도 테스트 환경에서 수행한다. 운영에 강제 장애·로그인 잠금을 만들지 않는다. 진짜 CF 경유 증거는 승인된 격리 환경 또는 제한된 컷오버 창에서 확보하며, 준비 문서만으로 실측 PASS를 만들지 않는다.

`Vercel-CDN-Cache-Control`은 Vercel이 소비하고 `Cloudflare-CDN-Cache-Control`은 CF가 소비할 수 있다. 최종 클라이언트에서 헤더가 안 보이는 것을 OFF/부재의 단독 증거로 삼지 않는다. 배포 설정·오리진 fixture/진단·실제 Age/캐시 상태/로그를 결합한다. 임시 진단 경로는 비공개·최소 출력·검증 후 제거.

### 5.1 CF 전용 헤더 전달의 실제 증거와 대체안

- 승인된 진단 경로/요청 한정 edge 관측으로 ①origin이 설정한 캐시 헤더 ②Vercel 경유 후 응답 ③CF가 실제 수신한 origin 응답 헤더를 동일 요청 식별자·deployment/rule revision으로 결속한다. positive TTL과 no-store 양쪽, Vercel MISS와 HIT를 모두 확인한다. CF-Cache-Status/Age는 동작 증거이며 **그 값만으로 특정 헤더의 전달을 증명하지 않는다**. 실제 CF ingress 관측 수단이 없으면 G5 미통과로 기록한다.
- CF 전용 헤더가 Vercel에서 제거/변조되면 R2를 켜지 않는다. `CDN-Cache-Control` 대체를 별도 코드 변경·리뷰 대상으로 삼고, Vercel 이후 전달/CF 소비를 같은 방식으로 재검증한다. 플랜에 없는 관측 기능이나 새 Worker 도입을 기정사실로 두지 않는다.
- **`CDN-Cache-Control: no-store`만 맹목적으로 추가하면 Vercel에도 적용돼 기존 캐시 보존 목적을 깨뜨린다.** 대체 구현은 원본 유효 Vercel 정책(Vercel-CDN → CDN → Cache-Control 우선순위)을 먼저 평가해 `Vercel-CDN-Cache-Control`에 명시하고, CF/외부 CDN용 `CDN-Cache-Control`과 브라우저 정책을 분리해야 한다. 익명 eligible은 inner no-store/outer 잔여 TTL, ineligible은 원래 inner 정책/outer no-store를 각각 검증한다. 정책을 안전하게 보존할 수 없으면 이 대체안도 HOLD이며 캐시 범위를 넓히지 않는다.

### 5.2 프록시 ON 직후 IP/429 카나리

- 측정 대상: `/api/news/discussion`·`/api/news/discussion/counts`의 요청수/429수·비율, admin/auth 정상 입력의 예상 밖 백오프, 유효 클라이언트 IP를 가진 요청 중 `unknown`/CF 대역 IP로 계산된 rate-limit 버킷의 요청 점유율. IP/쿠키 원문 대신 분류와 비식별 버킷 식별자만 기록한다.
- 즉시 중단 기준: 다른 실제 IP를 가진 전용 두 계정 카나리의 버킷 충돌 **1건**, 유효 IP가 unknown/CF-IP 버킷으로 귀속 **1건**, 제한에 도달하지 않은 정상 카나리의 예상 밖 429 **1건**. 이 경우 5xx가 없어도 NO-GO다.
- 운영 집계 기준: 429 비율 및 unknown/CF-IP 버킷 점유율을 **60초 창**으로 비교한다. 경로별 직전 matched baseline, 최소 표본수, 허용 상승폭/상한의 숫자를 컷오버 기록에 사전 확정한다. **한 창이라도 승인 임계 초과 시 즉시 proxy OFF**; 표본 부족이면 두 계정 능동 카나리를 계속 검증하며 이를 집계 PASS로 대신 표기하지 않는다. 기준 숫자/관측 수단이 빈칸이면 프록시 ON 금지.
- 중단 실행: 삼식/지정 실행자가 즉시 proxy OFF를 적용하고 R1/R2 BYPASS 및 필요 purge를 수행한다. IP 플래그는 direct ingress 복구가 관측될 때까지 유지한다(§7). DNS 캐시 때문에 기존 CF 요청이 남을 수 있으므로 429/버킷 회복 확인 전 복구 완료로 쓰지 않는다.

## 6. 단계적 실행 순서와 중단 조건

1. **지금 가능한 준비**: 스펙 작성·삼식 리뷰, 쿠키 정책 후속 코드 요구사항 확정. 계정 결정과 독립. Notion 반영은 후속이며, 이 Draft PR의 review GO는 아직 미완료.
2. 후속 코드가 필요하면 삼순 구현→commit/push/PR→삼식 GO→하린아빠 exact 머지 승인→삼순 머지/배포. OFF 회귀 유지. QA 실행은 삼식.
3. 실행자·계정·창 결정 및 필요한 실제 변경 승인 후 존 DNS-only 구성/레코드 전수검증→NS 변경/전파 검증. 코드 머지 승인을 존/NS/플래그 승인으로 확대하지 않음.
4. 승인된 검증 환경에서 ingress G2 입증. IP 플래그를 켜면 직결 동작도 달라질 수 있으므로 direct/preview 회귀를 먼저 확인하고, **프록시 경유가 시작될 때 검증된 IP 처리 코드/설정이 이미 서빙**되도록 배포 결속. ingress 확인 수단이 없으면 프록시 ON HOLD.
5. CF 캐시 전부 BYPASS 상태의 제한 프록시 컷오버→G2/G6/G7 및 **§5.2의 429 비율·unknown/CF-IP 버킷 점유율/2계정 분리 카나리** 확인→static만 R1 활성화. 버킷 붕괴/예상 밖 카나리 429/운영 임계 초과는 **즉시 proxy OFF**, IP 회귀·네이티브 차단·인증서/메일 실패도 즉시 단계 중단. proxy ON만으로 절감 주장 금지.
6. API Phase 1-B는 쿠키 수정 배포+G1~G8 필수 범위 GO 후 별도 승인. R2 BYPASS 유지→필요한 env 배포→이전 Vercel/CF cache key 제거 및 적용 확인→origin 헤더·혼합순서 검증→R2 활성화. flag 변경 뒤 미구현 헤더를 가진 구 Vercel HIT가 남으면 중단.
7. 48h는 최초 관찰창일 뿐. 경기일 매칭이 없으면 연장하며, 인증서 갱신 및 2계정 네이티브 검증 미완료면 부분 PASS/HOLD로 남긴다.

## 7. 롤백 — 캐시와 ingress를 분리

- **캐시 문제**: R2(필요시 R1 포함) BYPASS → 대상 CF purge → 오염 중단 확인 → API 캐시 플래그 OFF 배포 → Vercel 원래 계약·구캐시 상태 확인. API 불가 시 CF 전체 BYPASS/proxy OFF로 우회하며 무조건 정상으로 간주하지 않음.
- **IP/프록시 문제**: §5.2의 429/unknown·CF-IP 버킷/카나리 충돌 임계 초과 시 **즉시 proxy OFF**. CF 뒤에서 IP 플래그만 먼저 OFF하지 않는다. trusted direct ingress를 복구하고 resolver/실제 경로·429 및 버킷 정상화 확인 후 IP 플래그 OFF 재배포. DNS 전파 중 기존 CF 경로가 남는 동안 검증된 IP 처리를 유지.
- **DNS/메일 문제**: 전환 전 레코드·NS/DS 스냅샷 기준 별도 복구. NS 원복은 최후 단계이며 효과가 즉시 나타난다고 주장하지 않음.
- CF proxy OFF 콘솔 조작시간과 최종 사용자 복구시간은 다르다. authoritative TTL·resolver/로컬 캐시를 포함해 관찰한다.
- 신규 5xx/**429 임계 초과·unknown/CF-IP 버킷 붕괴**/인증·계정격리 실패/실시간 신선도 회귀/인증서·메일 장애는 즉시 NO-GO. 수치형 오류율/지연 budget과 §5.2 운영 카나리 기준은 컷오버 전 matched baseline으로 정해 서명하며 빈값으로 전환하지 않는다.

## 8. 계측·비용 기준

- before/after 동일 요일·경기 유무·진행시간·트래픽 규모·지역·배포 버전으로 비교. 실제 Vercel Edge 요청·전송 bytes/CPU, CF 허용 경로 requests/bytes/HIT를 측정하고 PV/활성사용자 단위도 함께 제시.
- Invocations/Edge 비율을 miss율·CF 흡수풀·인과 절감률로 치환하지 않는다. Cookie BYPASS/혼합 Vercel 캐시로 CF HIT가 낮아지는 부분도 분리한다.
- 목표 판정은 경기일 보정 Vercel Edge -30% 이상뿐 아니라 실시간성/오류/네이티브/인증서 계약 만족과 **Vercel + CF + Supabase + Upstash** 합산 순비용으로 한다. CF HIT만으로 절감 완료 아님.
- 월 무료 Edge 10M/전송 1TB는 월 1회 할당. 지역별 초과 단가·크레딧·기본료·세금을 분리한다. $700이 subtotal인지 Total Due인지 결정 필요.
- 이전 월전망 $1,050~1,100, CF 절감 $250~480, 빌드 절감 $30~50은 미검증으로 폐기/보류. 청구 차액 약 $170은 고정비 미확정; `(1477.83 + 20) × 1.10 ≈ 1647.61`은 세금 상세 확인 전 가설이다.
- 9/9 재판독·9/15~16 무료 전송량 소진은 일정/과거 조건부 추정이지 현재 실측값이나 보장된 날짜가 아니다. 실제 일별 Usage로 다시 계산.

## 9. 리뷰 요청 범위 / 완료 구분

- 삼식 검토점: (A) ineligible Vercel 보존+CF no-store 정책 (B) 혼합 캐시 HIT 안전성/흡수량 trade-off (C) R0~R3 순서와 오류/TTL fallback 경계 (D) G1~G8 충분성 (E) IP 배포/캐시 purge/롤백 순서.
- 하린아빠 결정: Cloudflare 계정·NS/콘솔 실행자·준비 상태에 맞는 컷오버 창. 실제 설정 변경 승인은 실행 가능한 구성안과 검증 결과를 묶어 요청. 지금 스펙 착수 재승인 불필요.
- Draft PR 문서 작성 ≠ 삼식 GO ≠ Notion 게시 ≠ 코드 구현/배포 ≠ 인프라 활성화 ≠ 순절감 완료. 각 단계 별도로 기록.

## 10. 공식 근거 (2026-09-06 본문 확인)

- CF 전용 헤더·우선순위·최종 클라이언트 미전달: https://developers.cloudflare.com/cache/concepts/cdn-cache-control/
- Origin Cache Control/no-store: https://developers.cloudflare.com/cache/concepts/cache-control/
- Cache Rules 마지막 일치 우선: https://developers.cloudflare.com/cache/how-to/cache-rules/order/
- Edge TTL bypass_by_default·status no-store: https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
- 상태코드 캐시: https://developers.cloudflare.com/cache/how-to/configure-cache-status-code/
- Vercel 헤더 우선순위·s-maxage/Vercel-CDN 헤더 소비: https://vercel.com/docs/caching/cache-control-headers
- 추가 활성화 전 재확인: https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for , https://vercel.com/kb/guide/cloudflare-with-vercel , https://www.cloudflare.com/ips/
