//
//  KBOWidgetBundle.swift
//  KBO 크보팬 Live Activity (W1 토대)
//
//  Widget Extension 진입점.
//  - KBOLiveActivityWidget: 잠금화면/다이나믹 아일랜드 Live Activity
//  - KBOHomeWidget: 홈 화면 위젯 (잠금화면 카드와 동일 디자인)
//  - KBOTeamRankWidget: 팀 순위표 위젯 (systemLarge)
//  - KBOPlayerCardWidget: 최애선수 카드 위젯 (systemMedium/Large, iOS 17 AppIntent 선택)
//

import SwiftUI
import WidgetKit

@main
struct KBOWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            KBOLiveActivityWidget()
            KBOHomeWidget()
            KBOTeamRankWidget()
        }
        if #available(iOS 17.0, *) {
            KBOPlayerCardWidget()
        }
    }
}
