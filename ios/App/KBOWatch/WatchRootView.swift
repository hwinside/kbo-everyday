//
//  WatchRootView.swift
//  크보팬 워치 앱 홈 — 최애팀 오늘 경기 카드(3초 컷) + 순위 + 컴플리케이션 안내.
//

import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchSessionStore
    @State private var snap: WatchSnapshot?

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("크보팬")
                    .font(.system(size: 16, weight: .heavy))
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let snap {
                    if snap.kind == "noTeam" {
                        Text("iPhone 크보팬 앱에서 최애팀을 선택하면 자동으로 동기화돼요.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        WatchGameCard(snap: snap)
                        if !snap.rankLine.isEmpty {
                            Text("\(WatchTeam.short(snap.myTeamCode)) \(snap.rankLine)")
                                .font(.system(size: 13, weight: .semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }

                Text("워치페이스를 길게 눌러 크보팬 컴플리케이션을 추가하면 손목만 들어도 경기를 확인할 수 있어요.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 4)
        }
        .onAppear(perform: reload)
        .onChange(of: session.myTeamCode) { _, _ in reload() }
    }

    private func reload() {
        WatchFetcher.fetch { result in
            DispatchQueue.main.async { snap = result }
        }
    }
}

// 홈 카드 — 컴플리케이션 rectangular와 같은 정보 밀도(스코어/매치업 + 상황 한 줄).
struct WatchGameCard: View {
    let snap: WatchSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if snap.kind == "noGame" {
                Text(snap.line)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack {
                    Text(WatchTeam.short(snap.awayCode)).font(.system(size: 15, weight: .bold))
                    Spacer()
                    if snap.hasScore {
                        Text("\(snap.awayScore) : \(snap.homeScore)")
                            .font(.system(size: 18, weight: .black)).monospacedDigit()
                    } else {
                        Text("vs").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(WatchTeam.short(snap.homeCode)).font(.system(size: 15, weight: .bold))
                }
                Text(snap.line)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(snap.isLive ? Color(red: 1.0, green: 0.42, blue: 0.48) : .secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.12)))
    }
}
