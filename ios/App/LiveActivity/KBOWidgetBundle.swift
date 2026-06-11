//
//  KBOWidgetBundle.swift
//  KBO 크보팬 Live Activity (W1 토대)
//
//  Widget Extension 진입점. v1은 Live Activity 1종만 포함.
//  홈 화면 위젯(WidgetKit)은 v1.1에서 이 번들에 추가.
//

import SwiftUI
import WidgetKit

@main
struct KBOWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            KBOLiveActivityWidget()
        }
    }
}
