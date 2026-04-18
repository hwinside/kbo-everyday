# Hero Cutout 재생성 Spec (v2)

**작성일**: 2026-04-19
**목표**: 전체 선수(684명) 확대 전 이미지 품질 기준 확립

## 배경

신민재 cutout(65207.webp)에서 오른쪽 어깨/가슴 유니폼에 빨간 색번짐 현상 발견.
조사 결과 이미지 원본에 2가지 문제 중첩:

1. **팀 로고·포인트 색상이 원본에 포함**: LG 홈 유니폼의 빨간 트윈스 로고/넘버가 이미지에 있음 (정상)
2. **lossy WebP 압축 artifact**: 흰색 유니폼 ↔ 빨간 로고 경계에서 premultiplied alpha bleed 발생 → 빨간 halo
3. **앱 CSS의 spotlight glow**가 이 위에 겹쳐져 체감 번짐 심화

## v1 → v2 변경

### 인코딩 변경 (필수)

```bash
# v1 (현재 - lossy, bleeding 발생)
cwebp -q 80 input.png -o output.webp

# v2 (lossless alpha, RGB만 lossy)
cwebp -q 85 -alpha_q 100 -exact -metadata none input.png -o output.webp
```

- `-alpha_q 100`: 알파 채널 무손실
- `-exact`: 투명 픽셀 RGB 보존 (premultiplied bleed 차단)
- `-q 85`: RGB 품질 살짝 상향

파일 크기 영향: +20~40KB/장 (현재 평균 120KB → 150~170KB). 5명 전체 < 1MB 증가. 수용 가능.

### 원본 PNG 사양 (AI 생성 단계)

| 항목 | 기준 |
|---|---|
| 해상도 | 752×944 (유지) |
| 배경 | 순수 투명 (alpha 0), 회색/흰 배경 **금지** |
| 인물 크롭 | 정수리~배꼽 |
| 유니폼 가장자리 | **anti-aliasing 최소화** (binary alpha 선호) |
| DPI | 72 |
| 색공간 | sRGB |

### AI 생성 프롬프트 가이드라인

- "transparent background, crisp clean edges, no halo, no color bleeding"
- "sharp cutout, no motion blur, no semi-transparent edges"
- 생성 후 Photoshop/GIMP에서 **알파 채널 threshold 클린업** (50% 이하 알파는 0으로)

## 기존 5명 재생성 계획

- 오스틴(53123), 홍창기(66108), 문보경(69102), 신민재(65207), 문성주(68119)
- v2 스펙으로 재인코딩 (원본 PNG가 있으면 재압축만, 없으면 재생성)
- 작업량: 1명당 5~15분 × 5 = **30~75분**

## 전체 확대 (684명) 전 검증 체크리스트

- [ ] 10팀별 유니폼 베이스 컬러 대조표 작성 (흰/회/베이지 3종)
- [ ] v2 스펙으로 샘플 10명(각 팀 1명) 생성 → 모바일 prod에서 halo 육안 검사
- [ ] 자동 검증 스크립트: alpha 경계 1px 레이어 RGB 평균이 팀컬러 hue에 근접하는지 체크
- [ ] 합격선: 팀컬러 halo가 육안으로 안 보이는 수준 (< 5% 해당 선수)

## Spotlight CSS 병행 방어 (이미 배포됨)

- 위치: `50% 70%` → `50% 30%` (하단 유니폼 → 상단 머리 뒤)
- opacity: 0.55 → 0.35
- 팀컬러 농도: `bg+55` → `bg+33`

이미지가 완벽해도 spotlight가 과하면 여전히 유니폼에 색이 겹침. CSS는 v2 이미지 기준으로 추가 미세조정 필요할 수도 있음.

## 상태

- **v1 CSS 완화**: 2026-04-19 00:00 배포 완료 (`48ea48b`)
- **v2 이미지 재생성**: TODO — 전체 확대 착수 전 필수
- **검증 스크립트**: TODO
