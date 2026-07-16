//
//  WatchRootView.swift
//  크보팬 워치 앱 홈 — 최애팀 경기 카드 + 상태별 리치 정보(하린아빠 승인 목업).
//  구조: 순위 헤더 → 메인 경기카드(구장·로고·스코어·상태) → 상태별 하단 카드
//  (LIVE=아웃·주자·투타·최근 플레이 / 예정=선발 / 종료=다음 경기).
//  컴플리케이션 안내문은 삼순 NO-GO(화면 1/3 낭비)로 제거.
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
                        WatchDetailRows(snap: snap)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
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

// 홈 카드 — 구장(상단) + 로고/스코어(중앙) + 상태 한 줄(하단 중앙). 목업 패리티.
struct WatchGameCard: View {
    let snap: WatchSnapshot

    var body: some View {
        VStack(alignment: .center, spacing: 4) {
            if snap.kind == "noGame" {
                Text(snap.line)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if let venue = snap.venue {
                    Text(venue)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
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
                Text(snap.line)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(snap.isLive ? Color(red: 1.0, green: 0.42, blue: 0.48) : .secondary)
                    .lineLimit(1).minimumScaleFactor(0.7)
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

// 상태별 하단 카드 — LIVE=아웃·주자/투타/최근 플레이, 예정=선발, 종료=다음 경기.
struct WatchDetailRows: View {
    let snap: WatchSnapshot
    private let live = Color(red: 1.0, green: 0.42, blue: 0.48)

    var body: some View {
        VStack(spacing: 6) {
            if snap.isLive {
                // 아웃카운트 도트 + 주자 다이아몬드 한 줄
                row {
                    HStack(spacing: 6) {
                        Text("O").font(.system(size: 13, weight: .heavy))
                        HStack(spacing: 4) {
                            ForEach(0..<3, id: \.self) { i in
                                Circle()
                                    .fill(i < (snap.outs ?? 0) ? live : Color.white.opacity(0.22))
                                    .frame(width: 8, height: 8)
                            }
                        }
                        Spacer()
                        BaseDiamond(bases: snap.bases ?? WatchBases(first: false, second: false, third: false),
                                    size: 22)
                    }
                }
                if snap.pitcher != nil || snap.batter != nil {
                    row {
                        HStack(spacing: 5) {
                            if let p = snap.pitcher {
                                Text("투수").font(.system(size: 11)).foregroundStyle(.secondary)
                                Text(p).font(.system(size: 13, weight: .bold))
                            }
                            if snap.pitcher != nil && snap.batter != nil {
                                Circle().fill(live).frame(width: 3, height: 3)
                            }
                            if let b = snap.batter {
                                Text("타자").font(.system(size: 11)).foregroundStyle(.secondary)
                                Text(b).font(.system(size: 13, weight: .bold))
                            }
                            Spacer(minLength: 0)
                        }
                        .lineLimit(1).minimumScaleFactor(0.7)
                    }
                }
                if let play = snap.lastPlay {
                    row {
                        HStack(alignment: .top, spacing: 5) {
                            Circle().fill(live).frame(width: 5, height: 5).padding(.top, 4)
                            Text(play)
                                .font(.system(size: 12, weight: .medium))
                                .lineLimit(2).minimumScaleFactor(0.85)
                            Spacer(minLength: 0)
                        }
                    }
                }
            } else if snap.kind == "scheduled", let starters = snap.starters {
                row {
                    Text(starters)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            } else if snap.kind == "final", let nextLine = snap.nextLine {
                row {
                    VStack(spacing: 2) {
                        Text("다음 경기").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                        HStack(spacing: 4) {
                            Text("\(WatchTeam.short(snap.nextAwayCode ?? "")) vs \(WatchTeam.short(snap.nextHomeCode ?? ""))")
                                .font(.system(size: 13, weight: .bold))
                            if let v = snap.nextVenue {
                                Text("· \(v)").font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                        .lineLimit(1).minimumScaleFactor(0.7)
                        Text(nextLine)
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(1).minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    /// 공통 행 컨테이너 — 어두운 라운드 박스(목업의 하단 행 스타일).
    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.08)))
    }
}
