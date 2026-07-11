//
//  KBOWatchWidgetBundle.swift
//  크보팬 워치 컴플리케이션 (WidgetKit, watchOS 9+).
//
//  워치페이스 accessory 슬롯에 최애팀 경기/순위를 상시 표시한다.
//  경기 중 = 라이브 스코어+상황, 경기 없음 = 순위·다음 경기(TimelineProvider).
//  데이터는 홈위젯/LA와 동일하게 keubo.fan 서버 API를 위젯이 직접 fetch(App Group 캐시).
//

import SwiftUI
import WidgetKit

@main
struct KBOWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        KBOWatchGameComplication()
    }
}
