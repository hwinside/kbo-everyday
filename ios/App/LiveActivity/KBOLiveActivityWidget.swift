//
//  KBOLiveActivityWidget.swift
//  KBO 크보팬 Live Activity (W2 디자인 슬라이스)
//
//  잠금화면 카드 + 다이나믹 아일랜드(compact/expanded) 레이아웃.
//  레퍼런스(네이버 스포츠 카드 + 앱 MY TEAM 카드)에 맞춰 재구성:
//  BSO 제거 → 스코어 + 이닝 + 구장 + 현재 투수/타자만. 최애팀(myTeamCode)
//  컬러 배경 그라데이션 + "MY TEAM" 라벨 + 최애팀 쪽 살짝 강조로 "내 응원팀 경기"
//  정체성을 준다. 로고는 Assets.xcassets의 `Logo_<코드>` imageset(벡터 SVG).
//

import SwiftUI
import WidgetKit
import ActivityKit

// MARK: - 팀 컬러 (src/lib/constants/teams.ts colorPrimary 하드코딩)

@available(iOS 16.1, *)
private func teamColor(_ code: String) -> Color {
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
                .padding(14)
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // 확장 상태 — 양팀 로고 크게 + 약어 + 점수
                DynamicIslandExpandedRegion(.leading) {
                    TeamLogoScore(code: context.attributes.awayTeamCode,
                                  score: context.state.awayScore,
                                  logoSize: 30)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TeamLogoScore(code: context.attributes.homeTeamCode,
                                  score: context.state.homeScore,
                                  logoSize: 30)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.isFinal ? "경기 종료" : context.state.inningText)
                        .font(.caption).bold()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if !context.state.isFinal {
                        Text("\(context.state.pitcherName) → \(context.state.batterName)")
                            .font(.caption2)
                            .lineLimit(1)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                // 원정 로고 + 점수
                HStack(spacing: 3) {
                    TeamLogo(code: context.attributes.awayTeamCode, size: 16)
                    Text("\(context.state.awayScore)")
                        .font(.caption2).bold().monospacedDigit()
                }
            } compactTrailing: {
                // 홈 로고 + 점수
                HStack(spacing: 3) {
                    Text("\(context.state.homeScore)")
                        .font(.caption2).bold().monospacedDigit()
                    TeamLogo(code: context.attributes.homeTeamCode, size: 16)
                }
            } minimal: {
                Text("\(context.state.awayScore):\(context.state.homeScore)")
                    .font(.caption2).bold()
                    .monospacedDigit()
            }
        }
    }
}

// MARK: - 잠금화면 카드

@available(iOS 16.1, *)
struct KBOLockScreenCard: View {
    let attributes: KBOGameAttributes
    let state: KBOGameAttributes.ContentState

    /// 최애팀이 이 경기에 참여하는지 (away/home 중 하나와 일치).
    private var hasMyTeam: Bool {
        !attributes.myTeamCode.isEmpty &&
        (attributes.myTeamCode == attributes.awayTeamCode ||
         attributes.myTeamCode == attributes.homeTeamCode)
    }

    /// 그라데이션 베이스 컬러 — 최애팀 컬러(있으면), 없으면 중립.
    private var accentColor: Color {
        hasMyTeam ? teamColor(attributes.myTeamCode) : Color(hex: 0x1A1A1A)
    }

    var body: some View {
        VStack(spacing: 10) {
            // 상단: MY TEAM 라벨 (최애팀 경기일 때만)
            if hasMyTeam {
                HStack(spacing: 5) {
                    Image(systemName: "heart.fill")
                        .font(.system(size: 9))
                    Text("MY TEAM")
                        .font(.system(size: 10, weight: .heavy))
                        .tracking(1.2)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.9))
            }

            // 양팀: 로고 + 약어 + 점수 (SSG 0 : LG 0)
            HStack(spacing: 8) {
                TeamColumn(code: attributes.awayTeamCode,
                           score: state.awayScore,
                           emphasized: attributes.myTeamCode == attributes.awayTeamCode)
                Text(":")
                    .font(.title3).bold()
                    .foregroundStyle(.white.opacity(0.6))
                TeamColumn(code: attributes.homeTeamCode,
                           score: state.homeScore,
                           emphasized: attributes.myTeamCode == attributes.homeTeamCode)
            }

            // 가운데: 이닝 + 구장 pill
            HStack(spacing: 6) {
                Text(state.isFinal ? "경기 종료" : state.inningText)
                    .font(.caption).bold()
                if !state.stadium.isEmpty {
                    Text("·")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.5))
                    Text(state.stadium)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(.white.opacity(0.15)))

            // 하단: 투수 → 타자 (진행 중에만)
            if !state.isFinal {
                Text("\(state.pitcherName) → \(state.batterName)")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .background(
            // 최애팀 컬러 그라데이션 (대각선) — "내 응원팀 경기" 정체성.
            LinearGradient(
                colors: [accentColor.opacity(0.92), accentColor.opacity(0.55)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// MARK: - 팀 컬럼 (로고 + 약어 + 점수)

@available(iOS 16.1, *)
struct TeamColumn: View {
    let code: String
    let score: Int
    /// 최애팀 쪽이면 굵게/약간 크게 강조.
    let emphasized: Bool

    var body: some View {
        VStack(spacing: 3) {
            TeamLogo(code: code, size: emphasized ? 34 : 30)
            Text(code)
                .font(.system(size: emphasized ? 13 : 12,
                              weight: emphasized ? .heavy : .semibold))
            Text("\(score)")
                .font(.system(size: emphasized ? 30 : 26,
                              weight: emphasized ? .heavy : .bold))
                .monospacedDigit()
        }
        .frame(minWidth: 56)
        .opacity(emphasized ? 1 : 0.92)
    }
}

// MARK: - 팀 로고 + 점수 (다이나믹 아일랜드 확장용)

@available(iOS 16.1, *)
struct TeamLogoScore: View {
    let code: String
    let score: Int
    let logoSize: CGFloat

    var body: some View {
        VStack(spacing: 2) {
            TeamLogo(code: code, size: logoSize)
            Text(code)
                .font(.caption2).bold()
            Text("\(score)")
                .font(.title3).bold()
                .monospacedDigit()
        }
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
