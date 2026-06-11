//
//  KBOLiveActivityWidget.swift
//  KBO 크보팬 Live Activity (W1 토대)
//
//  잠금화면 카드 + 다이나믹 아일랜드(compact/expanded) 레이아웃.
//  W1 범위: 더미 ContentState로 잠금화면에 카드가 뜨는 것까지 확인.
//  로고는 W1에선 팀 코드 텍스트로 대체(에셋 의존 제거), 이후 슬라이스에서 이미지화.
//

import SwiftUI
import WidgetKit
import ActivityKit

@available(iOS 16.1, *)
struct KBOLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: KBOGameAttributes.self) { context in
            // 잠금화면 / 배너 표시
            KBOLockScreenCard(attributes: context.attributes, state: context.state)
                .padding(14)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // 확장 상태
                DynamicIslandExpandedRegion(.leading) {
                    TeamScoreView(code: context.attributes.awayTeamCode,
                                  score: context.state.awayScore)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TeamScoreView(code: context.attributes.homeTeamCode,
                                  score: context.state.homeScore)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.state.inningText)
                            .font(.caption).bold()
                        if !context.state.isFinal {
                            Text(context.state.countText)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("경기 종료")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if !context.state.isFinal {
                        HStack(spacing: 8) {
                            BaseDiamond(onFirst: context.state.onFirst,
                                        onSecond: context.state.onSecond,
                                        onThird: context.state.onThird)
                            Text("\(context.state.pitcherName) → \(context.state.batterName)")
                                .font(.caption2)
                                .lineLimit(1)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Text(context.attributes.awayTeamCode)
                    .font(.caption2).bold()
            } compactTrailing: {
                Text("\(context.state.awayScore):\(context.state.homeScore)")
                    .font(.caption2).bold()
                    .monospacedDigit()
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

    var body: some View {
        VStack(spacing: 10) {
            // 상단: 양팀 + 스코어
            HStack {
                TeamScoreView(code: attributes.awayTeamCode, score: state.awayScore)
                Spacer()
                VStack(spacing: 2) {
                    Text(state.isFinal ? "경기 종료" : state.inningText)
                        .font(.subheadline).bold()
                    if !state.isFinal {
                        Text(state.countText)
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.7))
                            .monospacedDigit()
                    }
                }
                Spacer()
                TeamScoreView(code: attributes.homeTeamCode, score: state.homeScore)
            }

            // 하단: 주자 + 투수/타자 (진행 중에만)
            if !state.isFinal {
                HStack(spacing: 10) {
                    BaseDiamond(onFirst: state.onFirst,
                                onSecond: state.onSecond,
                                onThird: state.onThird)
                    Text("\(state.pitcherName) → \(state.batterName)")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.8))
                        .lineLimit(1)
                    Spacer()
                }
            }
        }
        .foregroundStyle(.white)
    }
}

// MARK: - 팀 + 스코어

@available(iOS 16.1, *)
struct TeamScoreView: View {
    let code: String
    let score: Int

    var body: some View {
        VStack(spacing: 2) {
            Text(code)
                .font(.caption).bold()
            Text("\(score)")
                .font(.title2).bold()
                .monospacedDigit()
        }
    }
}

// MARK: - 주자 다이아몬드

@available(iOS 16.1, *)
struct BaseDiamond: View {
    let onFirst: Bool
    let onSecond: Bool
    let onThird: Bool

    private let size: CGFloat = 7

    var body: some View {
        // 2루(위) / 3루(좌) · 1루(우) — 다이아몬드 배치
        VStack(spacing: 2) {
            base(onSecond)
            HStack(spacing: 12) {
                base(onThird)
                base(onFirst)
            }
        }
    }

    @ViewBuilder
    private func base(_ occupied: Bool) -> some View {
        Rectangle()
            .fill(occupied ? Color.yellow : Color.white.opacity(0.25))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(45))
    }
}
