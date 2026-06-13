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
    default:   return 0x222222
    }
}

@available(iOS 16.1, *)
func teamColor(_ code: String) -> Color { Color(hex: teamColorHex(code)) }

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
    default:   return code
    }
}

// MARK: - 폰트 (숫자·영어 = Montserrat / 한글 = Noto Sans KR).
// 가변 폰트(.ttf) 2종을 Extension 번들에 포함 + Info.plist UIAppFonts 등록.
// 가변축 wght 기본값이 Thin이라 아래 helper는 항상 .weight()를 적용해 굵기 축을 지정한다.
// 등록 실패 시에도 시스템 폰트로 graceful fallback.

@available(iOS 16.1, *)
func montserrat(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
    Font.custom("Montserrat", size: size).weight(weight)
}

@available(iOS 16.1, *)
func notoKR(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    Font.custom("Noto Sans KR", size: size).weight(weight)
}

// 혼합 문자열을 글자 종류별 폰트로 — 영숫자(LIVE/점수/LG·SSG 약어)=Montserrat, 한글=Noto.
// SwiftUI Text 연결로 per-run 폰트를 지정한다.

// 팀 약어가 라틴(LG/KT/SSG/NC/KIA)이면 Montserrat, 한글(롯데/두산/삼성/한화/키움)이면 Noto.
@available(iOS 16.1, *)
func teamShortText(_ code: String, _ size: CGFloat, _ weight: Font.Weight) -> Text {
    let s = teamShortName(code)
    let isLatin = s.allSatisfy { $0.isASCII }
    return Text(s).font(isLatin ? montserrat(size, weight) : notoKR(size, weight))
}

// "2회초" → "2"(Montserrat) + "회초"(Noto). 숫자 접두부와 한글 접미부를 분리.
@available(iOS 16.1, *)
func inningRun(_ inning: String, _ size: CGFloat, _ weight: Font.Weight) -> Text {
    let num = inning.prefix { $0.isNumber }
    let suffix = inning.dropFirst(num.count)
    var t = Text("")
    if !num.isEmpty { t = t + Text(String(num)).font(montserrat(size, weight)) }
    if !suffix.isEmpty { t = t + Text(String(suffix)).font(notoKR(size, weight)) }
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
        out = out + Text(buf).font(bufIsLatin ? montserrat(size, weight) : notoKR(size, weight))
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

@available(iOS 16.1, *)
struct KBOLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: KBOGameAttributes.self) { context in
            // 잠금화면 / 배너 표시. activityBackgroundTint는 그라데이션 하단과 같은 "어두운 베이스"로
            // 깔아, 시스템 기본 배경이 가장자리에 비치지 않게 하면서도 카드의 어두운 그라데이션이
            // 단색으로 뭉개지지 않게 한다(이전엔 팀 컬러 솔리드를 깔아 그라데이션이 발산됨).
            KBOLockScreenCard(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color(hex: kCardDarkBase))
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // 확장 — 양팀 로고 + 약어 + 점수 + 이닝 (다이아몬드는 공간상 잠금화면만)
                DynamicIslandExpandedRegion(.leading) {
                    DITeam(code: context.attributes.awayTeamCode, score: context.state.awayScore)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    DITeam(code: context.attributes.homeTeamCode, score: context.state.homeScore)
                }
                DynamicIslandExpandedRegion(.center) {
                    // 가운데에 N회초/말. 숫자=Montserrat, 회초/말=Noto.
                    Group {
                        if context.state.isFinal {
                            Text("경기 종료").font(notoKR(13, .bold))
                        } else {
                            inningRun(context.state.inningText, 13, .bold)
                        }
                    }
                    .foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.7)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if !context.state.isFinal && !context.state.pitcherName.isEmpty {
                        Text("\(context.state.pitcherName) → \(context.state.batterName)")
                            .font(.caption2).lineLimit(1)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                // 로고 + 약어(라틴=Montserrat) + 점수(Montserrat) — B안
                HStack(spacing: 2) {
                    TeamLogo(code: context.attributes.awayTeamCode, size: 18)
                    teamShortText(context.attributes.awayTeamCode, 11, .semibold).lineLimit(1)
                    Text("\(context.state.awayScore)")
                        .font(montserrat(14, .bold)).monospacedDigit()
                }
            } compactTrailing: {
                // 노치 바로 우측에 N회초/말(센터 인접) + 점수 + 약어 + 로고.
                HStack(spacing: 2) {
                    if !context.state.isFinal && !context.state.inningText.isEmpty {
                        inningRun(context.state.inningText, 10, .semibold)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                    }
                    Text("\(context.state.homeScore)")
                        .font(montserrat(14, .bold)).monospacedDigit()
                    teamShortText(context.attributes.homeTeamCode, 11, .semibold).lineLimit(1)
                    TeamLogo(code: context.attributes.homeTeamCode, size: 18)
                }
            } minimal: {
                Text("\(context.state.awayScore):\(context.state.homeScore)")
                    .font(montserrat(13, .bold)).monospacedDigit()
            }
        }
    }
}

// MARK: - 다이나믹 아일랜드 팀 (로고 + 점수). 가운데 이닝 영역 확보 위해 약어 텍스트는 생략
// (팀은 로고로 식별). compact 영역에선 약어를 유지한다.

@available(iOS 16.1, *)
struct DITeam: View {
    let code: String
    let score: Int
    var body: some View {
        HStack(spacing: 5) {
            TeamLogo(code: code, size: 30)
            Text("\(score)").font(montserrat(20, .bold)).monospacedDigit()
        }
    }
}

// MARK: - 잠금화면 카드 (앱 MY TEAM 카드 레이아웃, BSO 제외)

@available(iOS 16.1, *)
struct KBOLockScreenCard: View {
    let attributes: KBOGameAttributes
    let state: KBOGameAttributes.ContentState

    private var hasMyTeam: Bool {
        !attributes.myTeamCode.isEmpty &&
        (attributes.myTeamCode == attributes.awayTeamCode ||
         attributes.myTeamCode == attributes.homeTeamCode)
    }
    // 투수/타자 소속 — 초(top)면 홈팀 투수·원정팀 타자, 말이면 반대.
    private var pitcherTeamCode: String {
        state.isTopInning ? attributes.homeTeamCode : attributes.awayTeamCode
    }
    private var batterTeamCode: String {
        state.isTopInning ? attributes.awayTeamCode : attributes.homeTeamCode
    }

    var body: some View {
        VStack(spacing: 4) {
            // 헤더: MY TEAM
            if hasMyTeam {
                HStack(spacing: 5) {
                    TeamLogo(code: attributes.myTeamCode, size: 14)
                    Text("MY TEAM")
                        .font(montserrat(10, .heavy)).tracking(1.0)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.92))
            }

            // 스코어 행: 원정[로고+풀네임] | 점수:점수 + LIVE이닝 | 홈[로고+풀네임]
            HStack(spacing: 4) {
                TeamBadge(code: attributes.awayTeamCode)
                VStack(spacing: 2) {
                    // 경기장(구장) — 가운데 점수 위에 표기 (하린아빠 요청)
                    if !state.stadium.isEmpty {
                        Text(state.stadium)
                            .font(notoKR(9, .medium))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    HStack(spacing: 8) {
                        Text("\(state.awayScore)")
                            .font(montserrat(22, .black)).monospacedDigit()
                        Text(":").font(montserrat(13, .bold)).foregroundStyle(.white.opacity(0.5))
                        Text("\(state.homeScore)")
                            .font(montserrat(22, .black)).monospacedDigit()
                    }
                    Group {
                        if state.isFinal {
                            Text("경기 종료").font(notoKR(9, .bold))
                        } else {
                            // LIVE + 숫자 = Montserrat, 회초/말 = Noto
                            Text("LIVE ").font(montserrat(9, .bold)) + inningRun(state.inningText, 9, .bold)
                        }
                    }
                    .padding(.horizontal, 6).padding(.vertical, 1.5)
                    .background(
                        Capsule().fill(state.isFinal ? Color.white.opacity(0.18) : Color.red.opacity(0.85))
                    )
                }
                TeamBadge(code: attributes.homeTeamCode)
            }

            // 하단: 아웃카운트(B/S 제거) + 투수/타자(소속) + 다이아몬드 (진행 중에만)
            if !state.isFinal {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        // 아웃카운트만 유지
                        HStack(spacing: 5) {
                            Text("O")
                                .font(montserrat(11, .semibold))
                                .foregroundStyle(.white.opacity(0.7))
                            HStack(spacing: 4) { outDot(0); outDot(1); outDot(2) }
                        }
                        // 투수/타자 — 소속 표기
                        if !state.pitcherName.isEmpty {
                            playerLine(label: "투수", team: pitcherTeamCode, name: state.pitcherName)
                        }
                        if !state.batterName.isEmpty {
                            playerLine(label: "타자", team: batterTeamCode, name: state.batterName)
                        }
                    }
                    Spacer()
                    DiamondView(onFirst: state.onFirst, onSecond: state.onSecond, onThird: state.onThird)
                        .scaleEffect(0.82)
                }
                .padding(.top, 2)
                .overlay(alignment: .top) {
                    Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
                }
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(
            ZStack(alignment: .topTrailing) {
                cardGradient(attributes.myTeamCode, hasMyTeam: hasMyTeam)
                // 배경 팀 로고 watermark (앱 MyTeamHero: absolute right-3 top-3 opacity-[0.08])
                if hasMyTeam {
                    TeamLogo(code: attributes.myTeamCode, size: 64)
                        .opacity(0.13)
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
            .frame(width: 7, height: 7)
    }

    // 투수/타자 행 — "투수 (LG) 웰스". 라벨/괄호/이름=Noto, 라틴 약어(LG/SSG)=Montserrat.
    private func playerLine(label: String, team: String, name: String) -> some View {
        HStack(spacing: 5) {
            (Text("\(label) (").font(notoKR(11, .medium))
             + teamShortText(team, 11, .medium)
             + Text(")").font(notoKR(11, .medium)))
                .foregroundStyle(.white.opacity(0.72))
            Text(name)
                .font(notoKR(13, .bold))
        }
        .lineLimit(1).minimumScaleFactor(0.8)
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
                TeamLogo(code: code, size: 19)
            }
            .frame(width: 28, height: 28)
            // 풀네임(롯데 자이언츠 / LG 트윈스) — 라틴=Montserrat, 한글=Noto. 좁으면 축소.
            mixedScriptText(teamFullName(code), 13, .heavy)
                .lineLimit(1).minimumScaleFactor(0.55)
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

// MARK: - 팀 로고 이미지

@available(iOS 16.1, *)
struct TeamLogo: View {
    let code: String
    let size: CGFloat

    var body: some View {
        Image("Logo_\(code)")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
    }
}
