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
func teamColor(_ code: String) -> Color {
    switch code {
    case "LG": return Color(hex: 0xC60C30)
    case "OB": return Color(hex: 0x131230)  // 두산
    case "KT": return Color(hex: 0x000000)
    case "SK": return Color(hex: 0xCE0E2D)  // SSG
    case "NC": return Color(hex: 0x315288)
    case "HT": return Color(hex: 0xEA0029)  // KIA
    case "LT": return Color(hex: 0x002856)  // 롯데
    case "SS": return Color(hex: 0x074CA1)  // 삼성
    case "HH": return Color(hex: 0xFF6600)  // 한화
    case "WO": return Color(hex: 0x820024)  // 키움
    default:   return Color(hex: 0x222222)
    }
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
            // 잠금화면 / 배너 표시
            KBOLockScreenCard(attributes: context.attributes, state: context.state)
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
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
                    Text(context.state.isFinal ? "경기 종료" : context.state.inningText)
                        .font(.caption).bold()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if !context.state.isFinal && !context.state.pitcherName.isEmpty {
                        Text("\(context.state.pitcherName) → \(context.state.batterName)")
                            .font(.caption2).lineLimit(1)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                HStack(spacing: 2) {
                    TeamLogo(code: context.attributes.awayTeamCode, size: 14)
                    Text(teamShortName(context.attributes.awayTeamCode))
                        .font(.system(size: 11, weight: .semibold))
                    Text("\(context.state.awayScore)")
                        .font(.system(size: 13, weight: .bold)).monospacedDigit()
                }
            } compactTrailing: {
                HStack(spacing: 2) {
                    Text("\(context.state.homeScore)")
                        .font(.system(size: 13, weight: .bold)).monospacedDigit()
                    Text(teamShortName(context.attributes.homeTeamCode))
                        .font(.system(size: 11, weight: .semibold))
                    TeamLogo(code: context.attributes.homeTeamCode, size: 14)
                }
            } minimal: {
                Text("\(context.state.awayScore):\(context.state.homeScore)")
                    .font(.caption2).bold().monospacedDigit()
            }
        }
    }
}

// MARK: - 다이나믹 아일랜드 팀 (로고 + 약어 + 점수)

@available(iOS 16.1, *)
struct DITeam: View {
    let code: String
    let score: Int
    var body: some View {
        HStack(spacing: 4) {
            TeamLogo(code: code, size: 22)
            Text(teamShortName(code)).font(.caption2).bold()
            Text("\(score)").font(.title3).bold().monospacedDigit()
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
    private var accentColor: Color {
        hasMyTeam ? teamColor(attributes.myTeamCode) : Color(hex: 0x1A1A1A)
    }

    // 투수/타자 소속 — 초(top)면 홈팀 투수·원정팀 타자, 말이면 반대.
    private var pitcherTeamCode: String {
        state.isTopInning ? attributes.homeTeamCode : attributes.awayTeamCode
    }
    private var batterTeamCode: String {
        state.isTopInning ? attributes.awayTeamCode : attributes.homeTeamCode
    }

    var body: some View {
        VStack(spacing: 8) {
            // 헤더: MY TEAM
            if hasMyTeam {
                HStack(spacing: 5) {
                    TeamLogo(code: attributes.myTeamCode, size: 16)
                    Text("MY TEAM")
                        .font(montserrat(11, .heavy)).tracking(1.0)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.92))
            }

            // 스코어 행: 원정[로고+풀네임] | 점수:점수 + LIVE이닝 | 홈[로고+풀네임]
            HStack(spacing: 4) {
                TeamBadge(code: attributes.awayTeamCode)
                VStack(spacing: 3) {
                    HStack(spacing: 9) {
                        Text("\(state.awayScore)")
                            .font(montserrat(30, .black)).monospacedDigit()
                        Text(":").font(montserrat(16, .bold)).foregroundStyle(.white.opacity(0.5))
                        Text("\(state.homeScore)")
                            .font(montserrat(30, .black)).monospacedDigit()
                    }
                    Text(state.isFinal ? "경기 종료" : "LIVE \(state.inningText)")
                        .font(notoKR(10, .bold))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(
                            Capsule().fill(state.isFinal ? Color.white.opacity(0.18) : Color.red.opacity(0.85))
                        )
                }
                TeamBadge(code: attributes.homeTeamCode)
            }

            // 하단: 아웃카운트(B/S 제거) + 투수/타자(소속) + 다이아몬드 (진행 중에만)
            if !state.isFinal {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 6) {
                        // 아웃카운트만 유지
                        HStack(spacing: 5) {
                            Text("O")
                                .font(montserrat(12, .semibold))
                                .foregroundStyle(.white.opacity(0.7))
                            HStack(spacing: 4) { outDot(0); outDot(1); outDot(2) }
                        }
                        // 투수/타자 — 소속 표기 + 폰트 키움
                        if !state.pitcherName.isEmpty {
                            playerLine(label: "투수", team: pitcherTeamCode, name: state.pitcherName)
                        }
                        if !state.batterName.isEmpty {
                            playerLine(label: "타자", team: batterTeamCode, name: state.batterName)
                        }
                    }
                    Spacer()
                    DiamondView(onFirst: state.onFirst, onSecond: state.onSecond, onThird: state.onThird)
                }
                .padding(.top, 3)
                .overlay(alignment: .top) {
                    Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
                }
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            ZStack(alignment: .topTrailing) {
                LinearGradient(
                    colors: [accentColor.opacity(0.92), accentColor.opacity(0.55)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
                // 배경 팀 로고 watermark (앱 MyTeamHero: absolute right-3 top-3 opacity-[0.08])
                if hasMyTeam {
                    TeamLogo(code: attributes.myTeamCode, size: 64)
                        .opacity(0.13)
                        .padding(.top, 10)
                        .padding(.trailing, 12)
                }
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    // 아웃카운트 점 (채워진=빨강, 빈=반투명)
    private func outDot(_ i: Int) -> some View {
        Circle()
            .fill(i < state.outs ? Color(hex: 0xE53935) : Color.white.opacity(0.18))
            .frame(width: 8, height: 8)
    }

    // 투수/타자 행 — "투수 (LG) 웰스" 형태, 폰트 키움. 라벨·소속=한글, 이름=한글.
    private func playerLine(label: String, team: String, name: String) -> some View {
        HStack(spacing: 6) {
            Text("\(label) (\(teamShortName(team)))")
                .font(notoKR(13, .medium))
                .foregroundStyle(.white.opacity(0.72))
            Text(name)
                .font(notoKR(16, .bold))
        }
        .lineLimit(1).minimumScaleFactor(0.8)
    }
}

// MARK: - 팀 뱃지 (로고 원형 + 풀네임)

@available(iOS 16.1, *)
struct TeamBadge: View {
    let code: String
    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle().fill(.white)
                TeamLogo(code: code, size: 26)
            }
            .frame(width: 38, height: 38)
            Text(teamShortName(code))
                .font(montserrat(16, .heavy))
                .lineLimit(1).minimumScaleFactor(0.7)
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

    private let active = Color(hex: 0xE53935)
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
