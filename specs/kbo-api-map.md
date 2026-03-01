# KBO API Map — 리버스 엔지니어링 결과 (2026-03-01)

## 1. 경기 목록 (JSON) ✅
```
POST https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList
Content-Type: application/json
X-Requested-With: XMLHttpRequest
Body: {"leId":"1","srId":"0,1,3,4,5,7,9","date":"YYYYMMDD"}
```

### Response Fields
| 필드 | 의미 |
|------|------|
| G_ID | 경기 고유 ID (예: "20250501KTOB0") |
| G_DT | 날짜 (YYYYMMDD) |
| G_TM | 시작 시간 (HH:MM) |
| S_NM | 구장명 |
| AWAY_ID / HOME_ID | 팀 코드 (KT, OB, SS, SK, NC, HT, LT, SM, HH, WO) |
| AWAY_NM / HOME_NM | 팀 이름 |
| T_SCORE_CN / B_SCORE_CN | 원정/홈 점수 |
| GAME_STATE_SC | 경기 상태 (3=종료) |
| GAME_INN_NO | 현재/최종 이닝 |
| GAME_TB_SC | 초(T)/말(B) |
| T_PIT_P_NM / B_PIT_P_NM | 선발 투수 |
| W_PIT_P_NM | 승리 투수 |
| L_PIT_P_NM | 패전 투수 |
| SV_PIT_P_NM | 세이브 투수 |
| T_RANK_NO / B_RANK_NO | 팀 순위 |
| CANCEL_SC_NM | "정상경기" / 취소 |
| STRIKE_CN / BALL_CN / OUT_CN | BSO 카운트 (진행 중 경기) |
| B1/B2/B3_BAT_ORDER_NO | 주자 상황 |

### 팀 코드 매핑
| 코드 | 팀 | 앱 teamId |
|------|-----|-----------|
| LG | LG 트윈스 | 1 |
| OB | 두산 베어스 | 2 |
| KT | KT 위즈 | 3 |
| SK | SSG 랜더스 | 4 |
| NC | NC 다이노스 | 5 |
| HT | KIA 타이거즈 | 6 |
| LT | 롯데 자이언츠 | 7 |
| SS | 삼성 라이온즈 | 8 |
| HH | 한화 이글스 | 9 |
| WO | 키움 히어로즈 | 10 |

## 2. 경기 날짜 탐색 (JSON) ✅
```
POST /ws/Main.asmx/GetKboGameDate
Body: {"leId":"1","srId":"0,1","date":"YYYYMMDD"}
→ BEFORE_G_DT, NOW_G_DT, AFTER_G_DT
```

## 3. 팀 순위 (HTML 파싱) ✅
```
GET /Record/TeamRank/TeamRank.aspx
→ <td>: 순위, 팀, 경기, 승, 패, 무, 승률, 게임차
```

## 4. 타자 기록 (HTML 파싱) ✅
```
GET /Record/Player/HitterBasic/Basic1.aspx
→ 순위, 이름, 팀, 타율, 경기, 타석, 타수, 득점, 안타, 2루타...
```

## 5. 투수 기록 (HTML 파싱) ✅
```
GET /Record/Player/PitcherBasic/Basic1.aspx  
→ 순위, 이름, 팀, ERA, 경기, 승, 패, 세이브, 이닝, 삼진...
```

## 6. 선수 검색 (JSON) ✅
```
POST /ws/Controls.asmx/GetSearchPlayer
```

## 7. Naver Sports Proxy Gateway (미확인)
```
proxyGwUrl = 'https://proxy-gateway.sports.naver.com'
```
- 403/404 반환. 별도 인증 필요할 수 있음

## 주의사항
- KBO ASMX 응답 뒤에 ASP.NET 에러 HTML이 붙을 수 있음 → JSON 파싱 시 `}<!` 앞까지만
- srId: 0=시범, 1=정규, 3=와카, 4=준PO, 5=PO, 7=한국시리즈, 9=올스타
- leId: 1=KBO 1군
- 2025 실제 데이터 확인됨 (순위: LG 1위 85승, 한화 2위 83승)
