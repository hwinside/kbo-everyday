//
//  KBOLiveActivityWidget.swift
//  KBO 크보팬 Live Activity
//
//  잠금화면 카드 = 앱 홈의 "MY TEAM" 카드(MyTeamHero) 레이아웃을 그대로 옮긴 것.
//  BSO만 제외하고, MY TEAM 헤더 + 3컬럼 스코어(로고+이름) + LIVE 이닝 + 하단 P/AB +
//  베이스 다이아몬드(주자) 구성. 다이나믹 아일랜드는 약어, 잠금화면은 풀네임 표기.
//  로고는 Assets.xcassets의 `Logo_<코드>` imageset(벡터 SVG).
//

import SwiftUI
import WidgetKit
import ActivityKit

// MARK: - 팀 컬러 (src/lib/constants/teams.ts colorPrimary)

@available(iOS 16.1, *)
func teamColorHex(_ code: String) -> UInt32 {
    switch code {
    case "LG": return 0xC60C30
    case "OB": return 0x131230  // 두산
    case "KT": return 0x000000
    case "SK": return 0xCE0E2D  // SSG
    case "NC": return 0x315288
    case "HT": return 0xEA0029  // KIA
    case "LT": return 0x002856  // 롯데
    case "SS": return 0x074CA1  // 삼성
    case "HH": return 0xFF6600  // 한화
    case "WO": return 0x820024  // 키움
    case "XH": return 0xE85050  // 미리보기 더미(돌고래스) — 팀순위 위젯 하이라이트와 동일 코랄
    default:   return 0x222222
    }
}

@available(iOS 16.1, *)
func teamColor(_ code: String) -> Color { Color(hex: teamColorHex(code)) }

// 예고선발 표시명 — 공백 제거 후 비었으면 "미정"(선발 미확정 폴백).
func starterDisplayName(_ name: String?) -> String {
    let n = (name ?? "").trimmingCharacters(in: .whitespaces)
    return n.isEmpty ? "미정" : n
}

// 두 hex 컬러를 t:1-t 비율로 섞는다(t = a의 비율). 그라데이션 톤 계산용.
func mixHex(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
    func ch(_ x: UInt32, _ s: UInt32) -> Double { Double((x >> s) & 0xFF) }
    let r = ch(a, 16) * t + ch(b, 16) * (1 - t)
    let g = ch(a, 8)  * t + ch(b, 8)  * (1 - t)
    let bl = ch(a, 0) * t + ch(b, 0)  * (1 - t)
    return (UInt32(r) << 16) | (UInt32(g) << 8) | UInt32(bl)
}

// 카드 배경 그라데이션 — 승인 목업(specs/widgets/mockups/lockscreen-card-approved) 기준.
// 팀 컬러를 어두운 베이스(#1A1A1D)에 40% 섞은 톤(top) → 어두운 베이스(bottom)로 떨어지는
// "고급스럽고 어두운" 그라데이션. 최애팀 없으면 전체 다크. 하단(아웃/주자)이 어두워져
// 빨강 점이 다시 또렷하게 보인다.
@available(iOS 16.1, *)
let kCardDarkBase: UInt32 = 0x1A1A1D

@available(iOS 16.1, *)
func cardGradient(_ code: String, hasMyTeam: Bool) -> LinearGradient {
    let topHex = hasMyTeam ? mixHex(teamColorHex(code), kCardDarkBase, 0.40) : kCardDarkBase
    return LinearGradient(
        colors: [Color(hex: topHex), Color(hex: kCardDarkBase)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
}

// MARK: - 팀 표기 (teams.ts shortName / name). DI=약어, 잠금=풀네임.

@available(iOS 16.1, *)
func teamShortName(_ code: String) -> String {
    switch code {
    case "LG": return "LG"
    case "OB": return "두산"
    case "KT": return "KT"
    case "SK": return "SSG"
    case "NC": return "NC"
    case "HT": return "KIA"
    case "LT": return "롯데"
    case "SS": return "삼성"
    case "HH": return "한화"
    case "WO": return "키움"
    case "XA": return "수달스"   // 위젯 피커 미리보기 전용 더미(실팀 익명화)
    case "XH": return "돌고래스"
    default:   return code
    }
}

@available(iOS 16.1, *)
func teamFullName(_ code: String) -> String {
    switch code {
    case "LG": return "LG 트윈스"
    case "OB": return "두산 베어스"
    case "KT": return "KT 위즈"
    case "SK": return "SSG 랜더스"
    case "NC": return "NC 다이노스"
    case "HT": return "KIA 타이거즈"
    case "LT": return "롯데 자이언츠"
    case "SS": return "삼성 라이온즈"
    case "HH": return "한화 이글스"
    case "WO": return "키움 히어로즈"
    case "XA": return "수달스"   // 미리보기 더미 — 풀네임 없음
    case "XH": return "돌고래스"
    default:   return code
    }
}

// MARK: - 폰트 (숫자·영어 = Montserrat / 한글 = 시스템 폰트).
// 1.0.7(11) 렌더 예산 다이어트: NotoSansKR-VF(10.4MB 가변폰트)를 익스텐션에서 제거하고
// 한글은 시스템 폰트(Apple SD Gothic Neo 계열)로 그린다 — 위젯 익스텐션 30MB 한도에서
// 대형 한글 VF의 굵기 인스턴스 생성이 라이브 프레임 렌더 간헐 실패(스피너)의 주 소비자로
// 지목됨(2026-07-07 인시던트). 숫자/영문 브랜드 룩(Montserrat 745KB)은 유지.
// helper 시그니처는 유지 — 호출부(잠금 카드·홈 위젯) 무변경.

@available(iOS 16.1, *)
func montserrat(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
    Font.custom("Montserrat", size: size).weight(weight)
}

@available(iOS 16.1, *)
func notoKR(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    Font.system(size: size, weight: weight)
}

/// 한글 자간 — 기존 Noto Sans KR 룩과 맞추기 위해 시스템 한글에 좁은 자간을 적용(하린아빠
/// 요청 2026-07-07). Text 전용 modifier라 한글 run에 개별 적용한다. 실기기 육안으로 미세조정.
let kKoreanTracking: CGFloat = -0.3

// 혼합 문자열을 글자 종류별 폰트로 — 영숫자(LIVE/점수/LG·SSG 약어)=Montserrat, 한글=Noto.
// SwiftUI Text 연결로 per-run 폰트를 지정한다.

// 팀 약어가 라틴(LG/KT/SSG/NC/KIA)이면 Montserrat, 한글(롯데/두산/삼성/한화/키움)이면 Noto.
@available(iOS 16.1, *)
func teamShortText(_ code: String, _ size: CGFloat, _ weight: Font.Weight) -> Text {
    let s = teamShortName(code)
    let isLatin = s.allSatisfy { $0.isASCII }
    return isLatin
        ? Text(s).font(montserrat(size, weight))
        : Text(s).font(notoKR(size, weight)).tracking(kKoreanTracking)
}

// "2회초" → "2"(Montserrat) + "회초"(Noto). 숫자 접두부와 한글 접미부를 분리.
@available(iOS 16.1, *)
func inningRun(_ inning: String, _ size: CGFloat, _ weight: Font.Weight) -> Text {
    let num = inning.prefix { $0.isNumber }
    let suffix = inning.dropFirst(num.count)
    var t = Text("")
    if !num.isEmpty { t = t + Text(String(num)).font(montserrat(size, weight)) }
    if !suffix.isEmpty { t = t + Text(String(suffix)).font(notoKR(size, weight)).tracking(kKoreanTracking) }
    return t
}

// 임의 혼합 문자열에서 라틴 글자/숫자 런=Montserrat, 그 외(한글/기호/공백)=Noto.
// "6월 7일 (토)"(날짜) · "LG 트윈스"·"SSG 랜더스"(팀 풀네임) 등 한글+영숫자 혼합 대응.
@available(iOS 16.1, *)
func mixedScriptText(_ s: String, _ size: CGFloat, _ weight: Font.Weight) -> Text {
    var out = Text("")
    var buf = ""
    var bufIsLatin = false
    func isLatin(_ ch: Character) -> Bool { ch.isASCII && (ch.isLetter || ch.isNumber) }
    func flush() {
        guard !buf.isEmpty else { return }
        out = out + (bufIsLatin
            ? Text(buf).font(montserrat(size, weight))
            : Text(buf).font(notoKR(size, weight)).tracking(kKoreanTracking))
        buf = ""
    }
    for ch in s {
        let lat = isLatin(ch)
        if buf.isEmpty { buf.append(ch); bufIsLatin = lat }
        else if lat == bufIsLatin { buf.append(ch) }
        else { flush(); buf.append(ch); bufIsLatin = lat }
    }
    flush()
    return out
}

@available(iOS 16.1, *)
extension Color {
    /// 0xRRGGBB 정수 → Color.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue:  Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// 잠금화면 카드/DI 탭 → 해당 경기 페이지 universal link.
/// widgetURL은 NSUserActivity(webpageURL)로 앱에 전달되고, AppDelegate continue(userActivity:)가
/// path를 PushDeepLinkPlugin.stash에 보관 → 웹(native-push-deeplink)이 단일 pending 경로로 소비한다.
/// gameId는 엄격 allowlist(영숫자 1~32자, 예: 20260815HHKT0)만 통과 — '/'·dot-segment·
/// 특수문자는 percent-encoding 이전에 URL 생성 자체를 거부해 임의 경로 주입을 차단한다
/// (삼순 #1204 R1-③). 실패 시 nil → widgetURL 미설정(기존 동작 = 앱 열기).
func gameDeepLinkURL(_ gameId: String) -> URL? {
    guard gameId.range(of: "^[A-Za-z0-9]{1,32}$", options: .regularExpression) != nil else { return nil }
    return URL(string: "https://keubo.fan/games/\(gameId)")
}

// ⚠️ iOS 18.0 게이트(기존 16.1) — 애플워치 Smart Stack 전용 레이아웃(supplementalActivityFamilies)이
// iOS 18+/watchOS 11+ API인데, WidgetBundleBuilder가 #available의 else 분기를 지원하지 않아
// 16.1용 레거시 등록과 병행이 컴파일 불가(같은 Attributes에 이중 등록도 미정의 동작).
// iOS 16.1~17.x 기기는 이 빌드부터 Live Activity만 제외되고(홈 위젯·푸시는 유지),
// 앱 쪽(LiveActivityController.isEnabled)도 동일 게이트라 유령 activity가 생기지 않는다.
@available(iOS 18.0, *)
struct KBOLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: KBOGameAttributes.self) { context in
            // 잠금화면 / 배너 표시. activityBackgroundTint는 그라데이션 하단과 같은 "어두운 베이스"로
            // 깔아, 시스템 기본 배경이 가장자리에 비치지 않게 하면서도 카드의 어두운 그라데이션이
            // 단색으로 뭉개지지 않게 한다(이전엔 팀 컬러 솔리드를 깔아 그라데이션이 발산됨).
            KBOActivityCard(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color(hex: kCardDarkBase))
                .activitySystemActionForegroundColor(Color.white)
                // 잠금화면 카드 탭 → 해당 경기 페이지 딥링크(universal link). AppDelegate
                // continue(userActivity:)가 path를 PushDeepLinkPlugin.stash로 보관 → 웹이 소비.
                // (#cs 2026-08-15 하린아빠 실기기 QA — 카드 탭이 홈으로만 감)
                .widgetURL(gameDeepLinkURL(context.attributes.gameId))
        } dynamicIsland: { context in
            DynamicIsland {
                // 확장 — 양팀 로고 + 약어 + 점수 + 이닝 (다이아몬드는 공간상 잠금화면만)
                DynamicIslandExpandedRegion(.leading) {
                    DITeam(code: context.attributes.awayTeamCode, score: context.state.awayScore, isScheduled: context.state.isScheduled)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    DITeam(code: context.attributes.homeTeamCode, score: context.state.homeScore, isScheduled: context.state.isScheduled)
                }
                DynamicIslandExpandedRegion(.center) {
                    // 가운데에 N회초/말. 숫자=Montserrat, 회초/말=Noto. (경기 전엔 이닝 대신 예정 시각)
                    Group {
                        if context.state.isScheduled {
                            // startTime은 시각만(예: "18:00"). 비어 있으면 "경기 예정" 폴백.
                            Text(context.state.startTime.flatMap { $0.isEmpty ? nil : $0 } ?? "경기 예정").font(notoKR(12, .bold))
                        } else if context.state.isFinal {
                            Text("경기 종료").font(notoKR(13, .bold))
                        } else {
                            inningRun(context.state.inningText, 13, .bold)
                        }
                    }
                    .foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.7)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.state.isScheduled {
                        // 경기 전 — 예고선발 매치업(미확정이면 "미정").
                        Text("선발 \(starterDisplayName(context.state.awayStarter)) vs \(starterDisplayName(context.state.homeStarter))")
                            .font(.caption2).lineLimit(1)
                            .foregroundStyle(.secondary)
                    } else if !context.state.isFinal && !context.state.pitcherName.isEmpty {
                        Text("\(context.state.pitcherName) → \(context.state.batterName)")
                            .font(.caption2).lineLimit(1)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                // 간소화(2026-07-19 유저 건의: DI가 너무 커 배터리 잔량 가림). 로고 + 점수만.
                // 팀 약어 텍스트·이닝은 제거 — 팀은 로고로 식별하고, 이닝은 확장뷰/잠금카드에서 본다.
                // 경기 전(scheduled)엔 점수(0)를 숨긴다 — 시작도 안 한 경기에 0:0 노출 방지.
                HStack(spacing: 3) {
                    TeamLogo(code: context.attributes.awayTeamCode, size: 18)
                    if !context.state.isScheduled {
                        Text("\(context.state.awayScore)")
                            .font(montserrat(14, .bold)).monospacedDigit()
                    }
                }
            } compactTrailing: {
                // 배터리 인접 영역 — 점수 + 로고만으로 폭을 최소화해 잔량이 가리지 않게 한다
                // (약어·이닝 제거). 이전엔 이닝+점수+약어+로고 4요소라 우측이 배터리까지 밀었음.
                HStack(spacing: 3) {
                    if !context.state.isScheduled {
                        Text("\(context.state.homeScore)")
                            .font(montserrat(14, .bold)).monospacedDigit()
                    }
                    TeamLogo(code: context.attributes.homeTeamCode, size: 18)
                }
            } minimal: {
                // 경기 전엔 0:0 대신 시계 아이콘(시작 안 한 경기에 점수 노출 방지).
                if context.state.isScheduled {
                    Image(systemName: "clock").font(.system(size: 12, weight: .bold))
                } else {
                    Text("\(context.state.awayScore):\(context.state.homeScore)")
                        .font(montserrat(13, .bold)).monospacedDigit()
                }
            }
            // DI 전체(확장·compact·minimal 모든 표면) 탭 → 경기 페이지 딥링크.
            // 특정 영역 뷰에만 달면 다른 표면 탭이 미보장된다(삼순 #1204 R1-②).
            .widgetURL(gameDeepLinkURL(context.attributes.gameId))
        }
        // 애플워치 Smart Stack 노출 opt-in — .small 패밀리를 추가하면 워치에서 DI compact 축소판
        // 대신 KBOActivityCard의 워치 전용 레이아웃(KBOWatchSmallCard)이 렌더된다.
        .supplementalActivityFamilies([.small])
    }
}

// MARK: - 패밀리 라우터 — 같은 콘텐츠 클로저가 잠금화면(.medium)과 워치 Smart Stack(.small)
// 양쪽에 쓰이므로, activityFamily 환경값으로 레이아웃을 분기한다. 분기 없이 opt-in만 하면
// 워치가 폰 잠금 카드를 그대로 욱여넣어 깨진다.

@available(iOS 18.0, *)
struct KBOActivityCard: View {
    @Environment(\.activityFamily) private var family
    let attributes: KBOGameAttributes
    let state: KBOGameAttributes.ContentState

    var body: some View {
        switch family {
        case .small:
            KBOWatchSmallCard(attributes: attributes, state: state)
        case .medium:
            KBOLockScreenCard(attributes: attributes, state: state)
        @unknown default:
            KBOLockScreenCard(attributes: attributes, state: state)
        }
    }
}

// MARK: - 워치 Smart Stack 소형 카드 (ActivityFamily.small, iOS 18+/watchOS 11+)
//
// 폭·높이가 좁아 2단 구성: [로고+약어 | 점수:점수(또는 예정 시각) | 약어+로고] + 상태 한 줄.
// 잠금 카드의 다이아몬드·투수/타자·문자중계·예고선발은 생략한다(글랜서블 우선).
// 배경은 잠금 카드와 동일한 최애팀 그라데이션 — 손목에서도 팀 identity 유지.

@available(iOS 18.0, *)
struct KBOWatchSmallCard: View {
    let attributes: KBOGameAttributes
    let state: KBOGameAttributes.ContentState

    private var hasMyTeam: Bool {
        !attributes.myTeamCode.isEmpty &&
        (attributes.myTeamCode == attributes.awayTeamCode ||
         attributes.myTeamCode == attributes.homeTeamCode)
    }

    var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 3) {
                HStack(spacing: 3) {
                    TeamLogo(code: attributes.awayTeamCode, size: 16)
                    teamShortText(attributes.awayTeamCode, 12, .bold).lineLimit(1)
                }
                Spacer(minLength: 2)
                if state.isScheduled {
                    // 경기 전 — 점수(0:0) 대신 예정 시각.
                    Text(state.startTime.flatMap { $0.isEmpty ? nil : $0 } ?? "예정")
                        .font(montserrat(16, .bold)).monospacedDigit()
                } else {
                    HStack(spacing: 3) {
                        Text("\(state.awayScore)")
                            .font(montserrat(19, .black)).monospacedDigit()
                        Text(":").font(montserrat(12, .bold)).foregroundStyle(.white.opacity(0.5))
                        Text("\(state.homeScore)")
                            .font(montserrat(19, .black)).monospacedDigit()
                    }
                }
                Spacer(minLength: 2)
                HStack(spacing: 3) {
                    teamShortText(attributes.homeTeamCode, 12, .bold).lineLimit(1)
                    TeamLogo(code: attributes.homeTeamCode, size: 16)
                }
            }
            // 상태 한 줄: 예정="경기 예정"(+구장) / 진행=LIVE 이닝 pill + 아웃카운트 / 종료="경기 종료"
            HStack(spacing: 5) {
                if state.isScheduled {
                    Text(state.stadium.isEmpty ? "경기 예정" : "경기 예정 · \(state.stadium)")
                        .font(notoKR(11, .bold)).tracking(kKoreanTracking)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                } else if state.isFinal {
                    Text("경기 종료")
                        .font(notoKR(11, .bold)).tracking(kKoreanTracking)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.18)))
                } else {
                    (Text("LIVE ").font(montserrat(10, .bold)) + inningRun(state.inningText, 10, .bold))
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(Color.red.opacity(0.85)))
                        .lineLimit(1)
                    HStack(spacing: 3) {
                        Text("O").font(montserrat(10, .semibold)).foregroundStyle(.white.opacity(0.7))
                        HStack(spacing: 3) {
                            ForEach(0..<3, id: \.self) { i in
                                Circle()
                                    .fill(i < state.outs ? Color(hex: 0xFF4D4D) : Color.white.opacity(0.2))
                                    .frame(width: 6, height: 6)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .background(cardGradient(attributes.myTeamCode, hasMyTeam: hasMyTeam).ignoresSafeArea())
    }
}

// MARK: - 다이나믹 아일랜드 팀 (로고 + 점수). 가운데 이닝 영역 확보 위해 약어 텍스트는 생략
// (팀은 로고로 식별). compact 영역에선 약어를 유지한다.

@available(iOS 16.1, *)
struct DITeam: View {
    let code: String
    let score: Int
    var isScheduled: Bool = false
    var body: some View {
        HStack(spacing: 5) {
            TeamLogo(code: code, size: 30)
            // 경기 전엔 점수(0) 대신 팀 약어 — 가운데 예정 시각이 매치업을 보완.
            if isScheduled {
                teamShortText(code, 18, .bold)
            } else {
                Text("\(score)").font(montserrat(20, .bold)).monospacedDigit()
            }
        }
    }
}

// MARK: - 잠금화면 카드 (앱 MY TEAM 카드 레이아웃, BSO 제외)

@available(iOS 16.1, *)
struct KBOLockScreenCard: View {
    let attributes: KBOGameAttributes
    let state: KBOGameAttributes.ContentState
    /// 홈 위젯(medium)처럼 컨테이너가 카드 콘텐츠보다 클 때, 카드 배경이 컨테이너 전체를
    /// 채우도록 세로로 늘린다(콘텐츠는 상단 정렬). false면 콘텐츠 높이만큼만(잠금화면 LA 기존 동작).
    /// 이전엔 false라 medium에서 카드 배경(콘텐츠 높이)과 위젯 containerBackground 사이에
    /// 윗쪽 어두운 띠(seam)가 보였다.
    var fillHeight: Bool = false

    /// 홈위젯 stale 가드(B안) — live 스냅샷이 5h 넘게 갱신 안 됐을 때 true. LIVE 뱃지를 떼고
    /// '업데이트 필요'로 표기하며, 프리즈된 라이브 상세(아웃/주자/투수·타자/문자중계)는 숨긴다.
    /// '경기 종료' 단정은 피한다(스코어가 최종이 아닐 수 있음 — 삼순 조건). 잠금화면 LA는 기본 false.
    var isStale: Bool = false

    private var hasMyTeam: Bool {
        !attributes.myTeamCode.isEmpty &&
        (attributes.myTeamCode == attributes.awayTeamCode ||
         attributes.myTeamCode == attributes.homeTeamCode)
    }
    var body: some View {
        // spacing 4→3 (1.0.7 높이 다이어트 — lastPlay 줄 복원 여유 확보, 아래 padding 주석 참조)
        VStack(spacing: 3) {
            // 헤더: MY TEAM — 살짝 키우고(로고 14→18, 텍스트 10→13) medium에선 위 여백을 줘
            // 너무 상단에 쏠리지 않게 한다(하린아빠 요청). 잠금화면 LA는 위 여백 0(기존 유지).
            if hasMyTeam {
                HStack(spacing: 6) {
                    TeamLogo(code: attributes.myTeamCode, size: 16)
                    Text("MY TEAM")
                        .font(montserrat(11, .heavy)).tracking(1.0)
                    Spacer()
                }
                .padding(.top, fillHeight ? 5 : 0)
                .foregroundStyle(.white.opacity(0.92))
            }

            // medium(fillHeight) *종료(isFinal)* 상태에서만: 헤더 아래 점수를 남은 공간 세로 중앙으로
            // 분산해 아래 빈공간 어색함 해소. 라이브는 콘텐츠가 길어 자연 상단정렬 그대로(하린아빠:
            // "라이브는 그대로, 종료만"). 잠금화면 LA(fillHeight=false)도 영향 없음.
            if fillHeight && (state.isFinal || isStale) { Spacer(minLength: 0) }

            // 스코어 행: 원정[로고+풀네임] | 점수:점수 + LIVE이닝 | 홈[로고+풀네임]
            HStack(spacing: 4) {
                TeamBadge(code: attributes.awayTeamCode)
                VStack(spacing: 2) {
                    // 경기장(구장) — 가운데 점수 위에 표기 (하린아빠 요청)
                    if !state.stadium.isEmpty {
                        Text(state.stadium)
                            .font(notoKR(11, .medium)).tracking(kKoreanTracking)
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    if state.isScheduled {
                        // 경기 전 — 안드 승인본 언어와 동일: "경기 예정"(크게) + 예정 시각 pill.
                        // 양팀은 좌우 TeamBadge에, 구장은 위(stadium)에 이미 표기. 하단엔 예고선발.
                        Text("경기 예정")
                            .font(notoKR(18, .heavy)).tracking(kKoreanTracking)
                            .foregroundStyle(.white)
                        if let t = state.startTime, !t.isEmpty {
                            Text(t)
                                .font(notoKR(13, .heavy))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 10).padding(.vertical, 2)
                                .background(Capsule().fill(Color.black.opacity(0.28)))
                        }
                    } else {
                        HStack(spacing: 6) {
                            Text("\(state.awayScore)")
                                .font(montserrat(28, .black)).monospacedDigit()
                            Text(":").font(montserrat(16, .bold)).foregroundStyle(.white.opacity(0.5))
                            Text("\(state.homeScore)")
                                .font(montserrat(28, .black)).monospacedDigit()
                        }
                        Group {
                            if state.isFinal {
                                Text("경기 종료").font(notoKR(11, .bold))
                            } else if isStale {
                                // B안 — LIVE 떼고 중립 표기('경기 종료' 단정 X, 스코어 최종 아닐 수 있음).
                                Text("업데이트 필요").font(notoKR(11, .bold))
                            } else {
                                // LIVE + 숫자 = Montserrat, 회초/말 = Noto
                                Text("LIVE ").font(montserrat(11, .bold)) + inningRun(state.inningText, 11, .bold)
                            }
                        }
                        .padding(.horizontal, 7).padding(.vertical, 1)
                        .background(
                            Capsule().fill((state.isFinal || isStale) ? Color.white.opacity(0.18) : Color.red.opacity(0.85))
                        )
                    }
                }
                TeamBadge(code: attributes.homeTeamCode)
            }

            // 하단: 아웃카운트(B/S 제거) + 투수/타자(소속) + 다이아몬드 (진행 중에만, 경기 전 제외).
            // stale(5h+ 미갱신)이면 프리즈된 라이브 상세가 오히려 오해를 줘 숨긴다(B안).
            if !state.isFinal && !state.isScheduled && !isStale {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 3) {
                        // 아웃카운트만 유지
                        HStack(spacing: 5) {
                            Text("O")
                                .font(montserrat(13, .semibold))
                                .foregroundStyle(.white.opacity(0.7))
                            HStack(spacing: 4) { outDot(0); outDot(1); outDot(2) }
                        }
                        // 투수/타자 — 한 줄 병합(1.0.7 높이 다이어트: 두 줄 → 한 줄로
                        // lastPlay(문자중계) 줄 복원 여유 확보. 팀 소속 괄호는 폭 관계로 생략).
                        if !state.pitcherName.isEmpty || !state.batterName.isEmpty {
                            playersLine(pitcher: state.pitcherName, batter: state.batterName)
                        }
                    }
                    Spacer()
                    DiamondView(onFirst: state.onFirst, onSecond: state.onSecond, onThird: state.onThird)
                        .scaleEffect(0.72)  // 0.82→0.72 (1.0.7 높이 다이어트)
                        // scaleEffect는 시각만 줄이고 레이아웃 박스(52x40)는 그대로라 이 행 높이를
                        // 다이아가 지배했다. 시각 크기(~37x29)에 맞춰 박스를 clamp — 여기서 아낀
                        // 높이로 폰트 확대(+1~2pt)를 상쇄해 잠금 LA 높이 한도 내 유지.
                        .frame(width: 40, height: 32)
                }
                .padding(.top, 1)
                .overlay(alignment: .top) {
                    Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
                }
            }

            // 문자중계 최근 플레이 한 줄 (진행 중에만). 예: "오스틴 우중간 적시 2루타".
            // 이닝은 상단 LIVE 표기와 중복이라 서버 문구에서 제외(타자+결과만). 현장감 위해
            // 그레이 틱커 바 + 라이브 점(빨강). 좁은 카드라 한 줄 고정 + 축소 폴백 + 말줄임. 없으면 미표시.
            if !state.isFinal && !state.isScheduled && !isStale, let lp = state.lastPlay, !lp.isEmpty {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color(hex: 0xFF5A5A))
                        .frame(width: 6, height: 6)
                    Text(lp)
                        .font(notoKR(15, .medium)).tracking(kKoreanTracking)
                        .foregroundStyle(.white.opacity(0.92))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 2)   // 5→3→2 (폰트 2차 확대 상쇄)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color.white.opacity(0.11))
                )
                .padding(.top, 2)        // 4→3→2 (동일)
            }

            // 경기 전 — 예고선발 한 줄: "{원정선발}  선발투수  {홈선발}"(승인 목업). 미확정이면 "미정".
            // 구분선 아래 가운데 정렬. 이름=양쪽 안쪽 정렬, 가운데 라벨은 옅게.
            if state.isScheduled {
                HStack(spacing: 8) {
                    Text(starterDisplayName(state.awayStarter))
                        .font(notoKR(15, .bold)).tracking(kKoreanTracking).foregroundColor(.white)
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    Text("선발투수")
                        .font(notoKR(12, .medium)).tracking(kKoreanTracking).foregroundColor(.white.opacity(0.6))
                    Text(starterDisplayName(state.homeStarter))
                        .font(notoKR(15, .bold)).tracking(kKoreanTracking).foregroundColor(.white)
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 8)
                .overlay(alignment: .top) {
                    Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
                }
            }

            // 종료 상태에서만 트레일링 Spacer로 점수를 세로 중앙에. 라이브는 미적용(자연 상단정렬).
            if fillHeight && (state.isFinal || isStale) { Spacer(minLength: 0) }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        // 홈위젯 medium/large(fillHeight)는 HomeWidgetScheduledCard와 동일하게 상단 여백을 좌우보다
        // 작게(MY TEAM 위로) + 하단 여백 확보(삼순 의견 반영). 잠금화면 LA(fillHeight=false)는
        // 상하 대칭 10pt — #517의 13pt에서 축소(1.0.7 높이 다이어트: 투수/타자+lastPlay 포함
        // 풀 라이브 카드가 잠금 LA 높이 한도를 넘겨 상하 잘림 → 여백·행 병합으로 한도 내 복원).
        .padding(.top, fillHeight ? 10 : 8)
        .padding(.bottom, fillHeight ? 16 : 8)
        // medium 위젯: 카드가 위젯 높이를 꽉 채워 배경 seam(윗쪽 어두운 띠) 제거. 콘텐츠는 *상단* 정렬
        // 기본 — 라이브는 자연 상단정렬 그대로, 종료는 위 Spacer 2개로 점수가 세로 중앙에 온다.
        // 잠금화면 LA(fillHeight=false)는 콘텐츠 높이 그대로.
        .frame(maxWidth: .infinity, maxHeight: fillHeight ? .infinity : nil, alignment: .top)
        .background(
            ZStack(alignment: .topTrailing) {
                cardGradient(attributes.myTeamCode, hasMyTeam: hasMyTeam)
                // 배경 팀 로고 watermark (앱 MyTeamHero: absolute right-3 top-3 opacity-[0.08])
                if hasMyTeam {
                    TeamLogo(code: attributes.myTeamCode, size: 64)
                        .opacity(0.10)
                        .padding(.top, 10)
                        .padding(.trailing, 12)
                }
            }
            // 시스템이 Live Activity 컨테이너를 자체 라운딩하므로, 안쪽에서 따로 clipShape하지
            // 않는다(안쪽 라운딩 ↔ 컨테이너 가장자리 사이에 어두운 여백이 생기던 원인). gradient가
            // 컨테이너 가장자리까지 꽉 차고, 모서리는 시스템이 둥글게 깎는다.
            .ignoresSafeArea()
        )
    }

    // 아웃카운트 점 (채워진=빨강, 빈=반투명)
    private func outDot(_ i: Int) -> some View {
        Circle()
            .fill(i < state.outs ? Color(hex: 0xFF4D4D) : Color.white.opacity(0.2))
            .frame(width: 8, height: 8)
    }

    // 투수/타자 한 줄 — "투수 김윤식 · 타자 구자욱" (1.0.7: 기존 소속 포함 2줄에서 병합).
    private func playersLine(pitcher: String, batter: String) -> some View {
        HStack(spacing: 5) {
            if !pitcher.isEmpty {
                (Text("투수 ").font(notoKR(12, .medium)).foregroundColor(.white.opacity(0.6))
                 + Text(pitcher).font(notoKR(15, .bold)).foregroundColor(.white))
                    .tracking(kKoreanTracking)
            }
            if !pitcher.isEmpty && !batter.isEmpty {
                Text("·").font(notoKR(12, .medium)).foregroundColor(.white.opacity(0.4))
            }
            if !batter.isEmpty {
                (Text("타자 ").font(notoKR(12, .medium)).foregroundColor(.white.opacity(0.6))
                 + Text(batter).font(notoKR(15, .bold)).foregroundColor(.white))
                    .tracking(kKoreanTracking)
            }
        }
        .lineLimit(1).minimumScaleFactor(0.95)
    }
}

// MARK: - 팀 뱃지 (로고 원형 + 풀네임)

@available(iOS 16.1, *)
struct TeamBadge: View {
    let code: String
    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                Circle().fill(.white)
                TeamLogo(code: code, size: 21)
            }
            .frame(width: 31, height: 31)
            // 풀네임(롯데 자이언츠 / LG 트윈스) — 라틴=Montserrat, 한글=Noto. 좁으면 축소.
            mixedScriptText(teamFullName(code), 15, .heavy)
                .lineLimit(1).minimumScaleFactor(0.95)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 베이스 다이아몬드 (주자) — src/components/game/Diamond.tsx 이식
// 2루=위, 1루=오른쪽, 3루=왼쪽. 주자 있으면 빨강, 없으면 반투명.

@available(iOS 16.1, *)
struct DiamondView: View {
    let onFirst: Bool
    let onSecond: Bool
    let onThird: Bool

    private let active = Color(hex: 0xFF4D4D)
    private let empty = Color.white.opacity(0.22)
    private let emptyStroke = Color.white.opacity(0.4)

    var body: some View {
        ZStack {
            base(onSecond).offset(y: -13)  // 2루 (위)
            base(onFirst).offset(x: 13)    // 1루 (오른쪽)
            base(onThird).offset(x: -13)   // 3루 (왼쪽)
        }
        .frame(width: 52, height: 40)
    }

    private func base(_ on: Bool) -> some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(on ? active : empty)
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .stroke(on ? active : emptyStroke, lineWidth: 1)
            )
            .frame(width: 12, height: 12)
            .rotationEffect(.degrees(45))
    }
}

// MARK: - iOS 18 tinted/clear 위젯 모드 풀컬러 렌더링

extension Image {
    /// iOS 18+ 위젯 tinted(무늬)/clear 모드는 풀컬러 이미지를 흰 실루엣으로 강제 변환한다.
    /// 로고·선수 사진처럼 원본 색으로 보여야 하는 Image에 붙여 풀컬러 렌더링을 유지한다.
    @ViewBuilder
    func fullColorInAccentedWidget() -> some View {
        if #available(iOS 18.0, *) {
            self.widgetAccentedRenderingMode(.fullColor)
        } else {
            self
        }
    }
}

// MARK: - 팀 로고 이미지

@available(iOS 16.1, *)
struct TeamLogo: View {
    let code: String
    let size: CGFloat

    var body: some View {
        // 미리보기 더미 코드(XA/XH 등)는 로고 에셋이 없다 — 발자국 심볼로 대체(익명화).
        if UIImage(named: "Logo_\(code)") != nil {
            Image("Logo_\(code)")
                .resizable()
                .fullColorInAccentedWidget()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            Image(systemName: "pawprint.fill")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(Color(hex: 0x555555))
                .frame(width: size * 0.72, height: size * 0.72)
                .frame(width: size, height: size)
        }
    }
}
