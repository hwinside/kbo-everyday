//
//  KBOWidgetBundle.swift
//  KBO 크보팬 Live Activity (W1 토대)
//
//  Widget Extension 진입점.
//  - KBOLiveActivityWidget: 잠금화면/다이나믹 아일랜드 Live Activity
//  - KBOHomeWidget: 홈 화면 위젯 (잠금화면 카드와 동일 디자인)
//

import SwiftUI
import WidgetKit

@main
struct KBOWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            KBOLiveActivityWidget()
            KBOHomeWidget()
        }
    }
}
