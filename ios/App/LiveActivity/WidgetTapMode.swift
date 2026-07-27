//
//  WidgetTapMode.swift
//  KBO 크보팬 — 홈 위젯 탭 동작(앱 열기 / 새로고침만) 공용 헬퍼 + 인텐트
//
//  App Group(widget_tap_mode)에 저장된 모드를 위젯 익스텐션이 읽어, 탭 시 앱을 열지
//  (기본, widgetURL 미사용) 아니면 위젯만 새로고침할지 분기한다. '새로고침만'은
//  AppIntent(Button intent) 기반이라 iOS 17+ 전용 — 그 미만/‘open’은 기존 동작(앱 열림).
//
//  ⚠️ App(플러그인) 타깃과 LiveActivityExtension(위젯) 타깃 양쪽에 컴파일된다
//     (LiveActivity 폴더가 PBXFileSystemSynchronizedRootGroup으로 두 타깃 공유). 헬퍼/인텐트는
//     위젯에서만 실제 사용되며, App 타깃 컴파일은 무해(미사용 심볼).
//

import Foundation
import SwiftUI
import WidgetKit
import AppIntents

/// App Group 식별자 — 익스텐션 로컬 리터럴(KBOHomeWidget kAppGroup 등과 동일 값).
/// WidgetSnapshotStore는 App 타깃 전용이라 익스텐션엔 없어 참조 불가 → 파일 로컬 상수로 소유한다.
private let kTapModeAppGroup = "group.fan.keubo.app"

/// 홈 위젯 탭 동작이 '새로고침만'(refresh)인지 여부 — App Group에서 읽는다.
/// 미설정/‘open’은 false → 위젯 탭 시 기존 동작(앱 열림). 저장은 LiveActivityPlugin.setWidgetTapMode.
func widgetTapRefreshOnly() -> Bool {
    UserDefaults(suiteName: kTapModeAppGroup)?
        .string(forKey: "widget_tap_mode") == "refresh"
}

/// 위젯 타임라인을 새로고침하는 AppIntent — '새로고침만' 모드에서 위젯 탭 시 실행(iOS 17+).
/// 앱을 열지 않고 WidgetCenter.reloadAllTimelines만 트리거해 최신 스냅샷으로 다시 렌더한다.
@available(iOS 17.0, *)
struct RefreshWidgetsIntent: AppIntent {
    static var title: LocalizedStringResource = "위젯 새로고침"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

@available(iOS 16.1, *)
extension View {
    /// '새로고침만'(refresh) 모드일 때만(iOS 17+) 위젯 콘텐츠를 새로고침 인텐트 버튼으로 감싼다.
    /// ‘open’/iOS16 이하는 기존 그대로(탭 시 앱 열림). 배경/마진 modifier는 이 래핑 바깥에 유지할 것.
    @ViewBuilder
    func widgetTapRefreshWrap() -> some View {
        if #available(iOS 17.0, *), widgetTapRefreshOnly() {
            Button(intent: RefreshWidgetsIntent()) { self }
                .buttonStyle(.plain)
        } else {
            self
        }
    }
}
