//
//  WatchRootView.swift
//  크보팬 워치 앱 홈 — 최애팀 경기 카드 + 상태별 리치 정보(하린아빠 승인 목업).
//  구조: 순위 헤더 → 메인 경기카드(구장·로고·스코어·상태) → 상태별 하단 카드
//  (LIVE=아웃·주자·투타·최근 플레이 / 예정=선발 / 종료=승·패·세이브 투수 — 다음 경기 미표시, 하린아빠 7/17).
//  컴플리케이션 안내문은 삼순 NO-GO(화면 1/3 낭비)로 제거.
//

import SwiftUI

struct WatchRootView: View {
    @EnvironmentObject private var session: WatchSessionStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var snap: WatchSnapshot?
    // LIVE 화면 체류 중 갱신용(삼순 블로커 2) — 라이브일 때만 refetch
    private let liveTimer = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(spacing: 4) {
                // 승인 목업 상단: "크보팬" + 우측 "● MY TEAM" 한 줄(공간 압축 겸용)
                HStack(alignment: .firstTextBaseline) {
                    watchMixedText("크보팬", 14, .heavy)
                    Spacer()
                    HStack(spacing: 3) {
                        Circle()
                            .fill(Color(red: 1.0, green: 0.42, blue: 0.48))
                            .frame(width: 5, height: 5)
                        Text("MY TEAM")
                            .font(watchMontserrat(10, .bold))
                            .foregroundStyle(.secondary)
                    }
                }

                if let snap {
                    if snap.kind == "noTeam" {
                        watchMixedText("iPhone 크보팬 앱에서 최애팀을 선택하면 자동으로 동기화돼요.", 12, .regular)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        // 팀컬러 순위 헤더를 카드 위로 — 갤워치 타일 header(snap) 디자인 패리티.
                        if !snap.rankLine.isEmpty {
                            watchMixedText("\(WatchTeam.short(snap.myTeamCode)) · \(snap.rankLine)", 12, .bold)
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
        // 열린 LIVE 화면 실시간 갱신(삼순 블로커 2): 30s 타이머 + 재진입(scenePhase) refetch
        .onReceive(liveTimer) { _ in
            if snap?.isLive == true { reload() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { reload() }
        }
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
                watchMixedText(snap.line, 14, .semibold)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if let venue = snap.venue {
                    watchMixedText(venue, 11, .semibold)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 3) {
                    // 팀로고 바깥쪽 배치 — 갤워치 타일 matchupRow(`[로고]LG 3:2 KT[로고]`) 패리티.
                    // 40mm + `두산 10 : 9 롯데` 최악 폭 대비: 스코어는 절대 잘리지 않게
                    // layoutPriority 최상위 + monospacedDigit(삼순 블로커 1), 팀명이 먼저 축소.
                    teamLogo(snap.awayCode)
                    teamText(WatchTeam.short(snap.awayCode))
                    Spacer(minLength: 2)
                    if snap.hasScore {
                        Text("\(snap.awayScore) : \(snap.homeScore)")
                            .font(watchMontserrat(18, .black))
                            .monospacedDigit()
                            .lineLimit(1).minimumScaleFactor(0.7)
                            .layoutPriority(2)
                    } else {
                        Text("vs").font(watchMontserrat(14, .semibold)).foregroundStyle(.secondary)
                            .layoutPriority(2)
                    }
                    Spacer(minLength: 2)
                    teamText(WatchTeam.short(snap.homeCode))
                    teamLogo(snap.homeCode)
                }
                // 목업 v2: LIVE 카드줄은 "LIVE 7회말"만 — 아웃은 하단 도트 행과 중복이라 제거(컴플리케이션 line은 유지)
                watchMixedText(snap.isLive
                    ? snap.line.replacingOccurrences(of: #" · \d+사$"#, with: "", options: .regularExpression)
                    : snap.line, 12, .semibold)
                    .foregroundStyle(snap.isLive ? Color(red: 1.0, green: 0.42, blue: 0.48) : .secondary)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        // 최애팀 컬러 은은한 틴트 — 갤워치 타일 card(cardTint) 디자인 패리티.
        .background(RoundedRectangle(cornerRadius: 12).fill(WatchTeam.cardTint(snap.myTeamCode)))
    }

    private func teamText(_ name: String) -> some View {
        watchMixedText(name, 14, .bold)
            .lineLimit(1).minimumScaleFactor(0.6)
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

// 상태별 하단 카드 — LIVE=아웃·주자/투타/최근 플레이, 예정=선발, 종료=승/패(+세이브) 투수.
struct WatchDetailRows: View {
    let snap: WatchSnapshot
    private let live = Color(red: 1.0, green: 0.42, blue: 0.48)

    var body: some View {
        VStack(spacing: 4) {
            if snap.isLive {
                // 아웃카운트 도트 + 주자 다이아몬드 한 줄
                row {
                    HStack(spacing: 6) {
                        Text("O").font(watchMontserrat(13, .heavy))
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
                                watchMixedText("투수", 11, .regular).foregroundStyle(.secondary)
                                watchMixedText(p, 13, .bold)
                            }
                            if snap.pitcher != nil && snap.batter != nil {
                                Circle().fill(live).frame(width: 3, height: 3)
                            }
                            if let b = snap.batter {
                                watchMixedText("타자", 11, .regular).foregroundStyle(.secondary)
                                watchMixedText(b, 13, .bold)
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
                            watchMixedText(play, 12, .medium)
                                .lineLimit(2).minimumScaleFactor(0.85)
                            Spacer(minLength: 0)
                        }
                    }
                }
            } else if snap.kind == "scheduled", let starters = snap.starters {
                // 목업 v2: `선발 소형준 ● 웰스` — 라벨 secondary + 이름 bold + 핑크 도트 구분
                row {
                    HStack(spacing: 5) {
                        watchMixedText("선발", 11, .regular).foregroundStyle(.secondary)
                        let names = starters.hasPrefix("선발 ") ? String(starters.dropFirst(3)) : starters
                        let parts = names.components(separatedBy: " · ")
                        if parts.count == 2 {
                            watchMixedText(parts[0], 13, .bold)
                            Circle().fill(live).frame(width: 3, height: 3)
                            watchMixedText(parts[1], 13, .bold)
                        } else {
                            watchMixedText(names.replacingOccurrences(of: " vs ", with: " · "), 13, .bold)
                        }
                    }
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .frame(maxWidth: .infinity)
                }
            } else if snap.kind == "final", snap.winPitcher != nil || snap.losePitcher != nil {
                // 승/패(+세) 투수 한 줄 — 목업 7/17. 40mm fold-in 보장 위해 단일 행(세이브는 '세' 축약).
                row {
                    HStack(spacing: 5) {
                        if let w = snap.winPitcher {
                            watchMixedText("승", 11, .regular).foregroundStyle(.secondary)
                            watchMixedText(w, 13, .bold)
                        }
                        if snap.winPitcher != nil && snap.losePitcher != nil {
                            Circle().fill(live).frame(width: 3, height: 3)
                        }
                        if let l = snap.losePitcher {
                            watchMixedText("패", 11, .regular).foregroundStyle(.secondary)
                            watchMixedText(l, 13, .bold)
                        }
                        if let sv = snap.savePitcher {
                            Circle().fill(live).frame(width: 3, height: 3)
                            watchMixedText("세", 11, .regular).foregroundStyle(.secondary)
                            watchMixedText(sv, 13, .bold)
                        }
                    }
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    /// 공통 행 컨테이너 — 어두운 라운드 박스(목업의 하단 행 스타일).
    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.08)))
    }
}
