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
                        // 팀컬러 순위 헤더를 카드 위로 — 갤워치 타일 header(snap) 디자인 패리티.
                        if !snap.rankLine.isEmpty {
                            Text("\(WatchTeam.short(snap.myTeamCode)) · \(snap.rankLine)")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(WatchTeam.highlightColor(snap.myTeamCode))
                                .lineLimit(1).minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                        WatchGameCard(snap: snap)
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
                HStack(spacing: 4) {
                    // 팀로고 바깥쪽 배치 — 갤워치 타일 matchupRow(`[로고]LG 3:2 KT[로고]`) 패리티.
                    // 40mm + `두산 10 : 9 롯데` 최악 폭 대비 텍스트만 축소 허용(로고 고정).
                    teamLogo(snap.awayCode)
                    teamText(WatchTeam.short(snap.awayCode))
                    Spacer(minLength: 4)
                    if snap.hasScore {
                        Text("\(snap.awayScore) : \(snap.homeScore)")
                            .font(.system(size: 18, weight: .black)).monospacedDigit()
                            .lineLimit(1).minimumScaleFactor(0.7)
                    } else {
                        Text("vs").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    teamText(WatchTeam.short(snap.homeCode))
                    teamLogo(snap.homeCode)
                }
                HStack(spacing: 5) {
                    Text(snap.line)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(snap.isLive ? Color(red: 1.0, green: 0.42, blue: 0.48) : .secondary)
                    if snap.isLive, let b = snap.bases, b.any {
                        BaseDiamond(bases: b, size: 15)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity)
        // 최애팀 컬러 은은한 틴트 — 갤워치 타일 card(cardTint) 디자인 패리티.
        .background(RoundedRectangle(cornerRadius: 12).fill(WatchTeam.cardTint(snap.myTeamCode)))
    }

    private func teamText(_ name: String) -> some View {
        Text(name)
            .font(.system(size: 15, weight: .bold))
            .lineLimit(1).minimumScaleFactor(0.7)
    }

    /// 팀 로고 20pt — 미지의 코드(익명 더미 등)는 미렌더(텍스트만). 갤워치 teamLogo(24dp) 대응.
    @ViewBuilder private func teamLogo(_ code: String) -> some View {
        if let asset = WatchTeam.logoAsset(code) {
            Image(asset)
                .resizable()
                .scaledToFit()
                .frame(width: 20, height: 20)
        }
    }
}
