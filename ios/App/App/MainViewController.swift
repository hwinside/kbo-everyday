//
//  MainViewController.swift
//  KBO 크보팬
//
//  Capacitor 8은 capacitor.config.json의 packageClassList(=npm 플러그인)만 자동 등록한다.
//  앱 타깃에 직접 둔 커스텀 플러그인(LiveActivityPlugin)은 거기 없으므로 UNIMPLEMENTED가 된다.
//  → 브리지 로드 시점에 수동 등록한다. (cap sync가 config를 덮어써도 안 깨지는 방식)
//
//  Main.storyboard의 root view controller customClass가 이 클래스를 가리킨다.
//

import Capacitor

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(MetaAppEventsPlugin())
        bridge?.registerPluginInstance(AppReviewPlugin())
        bridge?.registerPluginInstance(NewsArticleBrowserPlugin())
        bridge?.registerPluginInstance(PushDeepLinkPlugin())
        bridge?.registerPluginInstance(VenueMediaLibraryPlugin())
    }
}
