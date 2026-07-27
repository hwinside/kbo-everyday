//
//  LiveActivityPlugin.swift
//  KBO 크보팬 — Capacitor 브리지 (W2)
//
//  JS(웹앱)에서 잠금화면 Live Activity를 제어하는 커스텀 플러그인.
//  경기룸 진입 시 game-live 데이터를 넘겨 start, 폴링으로 update, 종료 시 end.
//  실제 ActivityKit 호출은 LiveActivityController에 위임한다.
//
//  ⚠️ iOS 16.1+ 전용. 미만에서는 no-op으로 resolve(앱 동작 무영향).
//

import Foundation
import Capacitor
import WidgetKit

#if canImport(ActivityKit)
import ActivityKit
#endif

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeWidgetSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFavPlayers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMyTeam", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWidgetTapMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidgetTapMode", returnType: CAPPluginReturnPromise),
    ]

    /// 브리지 로드 시 — *포그라운드 JS 멀티캐스트* 콜백만 연결한다(조건4).
    /// observer 시작(observePushToStartToken/observeAllActivities)은 AppDelegate(네이티브 부팅)로
    /// 이동 → 백그라운드 push-to-start 깨우기(웹뷰 미기동)에서도 토큰을 잡게 했다. 네이티브
    /// register-device 등록 경로는 컨트롤러가 *항상 직접* 호출하므로, 여기 JS notify는 optional.
    public override func load() {
        if #available(iOS 16.1, *) {
            LiveActivityController.shared.onPushToken = { [weak self] gameId, token in
                // retainUntilConsumed: JS 리스너가 아직 안 붙었어도 이벤트를 버퍼링했다가
                // 부착 시 전달 → push token 유실로 (포그라운드) 서버 등록 누락 race 방지.
                self?.notifyListeners("liveActivityPushToken", data: ["gameId": gameId, "token": token], retainUntilConsumed: true)
            }
            LiveActivityController.shared.onPushToStartToken = { [weak self] token in
                // Slice B(빌드 16) — 서버 p2s input-push-channel 게이트 판정용 os 메이저 버전과
                // 진단용 frequentPushes를 register-start에 함께 보고한다(스펙 v4 §클라 1·4).
                var data: [String: Any] = [
                    "token": token,
                    "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
                ]
                #if canImport(ActivityKit)
                if #available(iOS 16.2, *) {
                    data["frequentPushes"] = ActivityAuthorizationInfo().frequentPushesEnabled
                }
                #endif
                self?.notifyListeners("liveActivityPushToStartToken", data: data, retainUntilConsumed: true)
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["started": false])
            return
        }
        guard let gameId = call.getString("gameId"),
              let awayTeam = call.getString("awayTeam"),
              let homeTeam = call.getString("homeTeam"),
              let awayTeamCode = call.getString("awayTeamCode"),
              let homeTeamCode = call.getString("homeTeamCode") else {
            call.reject("missing game info (gameId/teams)")
            return
        }
        // 최애팀 코드(강조용). 미설정/비참여 경기면 빈 문자열 → 위젯이 중립 표시.
        let myTeamCode = call.getString("myTeamCode") ?? ""
        let state = Self.parseState(call)
        Task {
            let started = await LiveActivityController.shared.start(
                gameId: gameId,
                awayTeam: awayTeam,
                homeTeam: homeTeam,
                awayTeamCode: awayTeamCode,
                homeTeamCode: homeTeamCode,
                myTeamCode: myTeamCode,
                state: state
            )
            call.resolve(["started": started])
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve()
            return
        }
        let state = Self.parseState(call)
        Task {
            await LiveActivityController.shared.update(state)
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve()
            return
        }
        // finalState 필드(top-level)가 오면 그걸로 종료(최종 스코어), 아니면 현재 상태로.
        // JS는 finalState를 top-level로 보냄(awayScore 존재 = 최종 상태 지정, 삼순 W2-②).
        let finalState: KBOGameAttributes.ContentState? =
            call.getInt("awayScore") != nil ? Self.parseState(call) : nil
        Task {
            await LiveActivityController.shared.end(finalState: finalState)
            call.resolve()
        }
    }

    @objc func isEnabled(_ call: CAPPluginCall) {
        if #available(iOS 16.1, *) {
            call.resolve(["enabled": LiveActivityController.shared.isEnabled])
        } else {
            call.resolve(["enabled": false])
        }
    }

    /// 홈 화면 위젯 스냅샷 직접 기록(JS 주도). 라이브 경기가 없을 때 홈 화면이
    /// *최애팀의 다음 예정 경기*(status="scheduled")를 기록하는 fallback 경로.
    /// live/final 스냅샷도 받을 수 있어 경기룸 밖 갱신에도 쓸 수 있다.
    /// ActivityKit 비의존(WidgetKit은 iOS 14+) — 16.1 미만에서도 안전하게 no-op/기록.
    @objc func writeWidgetSnapshot(_ call: CAPPluginCall) {
        guard let gameId = call.getString("gameId"),
              let awayTeamCode = call.getString("awayTeamCode"),
              let homeTeamCode = call.getString("homeTeamCode") else {
            call.reject("missing game info (gameId/teamCodes)")
            return
        }
        let status = call.getString("status") ?? "scheduled"
        var dict: [String: Any] = [
            "hasGame": true,
            "gameId": gameId,
            "awayTeamCode": awayTeamCode,
            "homeTeamCode": homeTeamCode,
            "myTeamCode": call.getString("myTeamCode") ?? "",
            "awayScore": call.getInt("awayScore") ?? 0,
            "homeScore": call.getInt("homeScore") ?? 0,
            "inning": call.getInt("inning") ?? 1,
            "isTopInning": call.getBool("isTopInning") ?? true,
            "outs": call.getInt("outs") ?? 0,
            "onFirst": call.getBool("onFirst") ?? false,
            "onSecond": call.getBool("onSecond") ?? false,
            "onThird": call.getBool("onThird") ?? false,
            "pitcherName": call.getString("pitcherName") ?? "",
            "lastPlay": call.getString("lastPlay") ?? "",
            "batterName": call.getString("batterName") ?? "",
            "stadium": call.getString("stadium") ?? "",
            "isFinal": status == "final",
            "status": status,
            "startText": call.getString("startText") ?? "",
            "dateText": call.getString("dateText") ?? "",
            "awayStarter": call.getString("awayStarter") ?? "",
            "homeStarter": call.getString("homeStarter") ?? "",
        ]
        // 다음 예정 경기(위젯 06:00 자동 전환 타깃) — live/final일 때만 JS가 실어 보낸다.
        if let next = call.getObject("next"),
           let nextGameId = next["gameId"] as? String,
           let nextAway = next["awayTeamCode"] as? String,
           let nextHome = next["homeTeamCode"] as? String {
            dict["next"] = [
                "gameId": nextGameId,
                "awayTeamCode": nextAway,
                "homeTeamCode": nextHome,
                "myTeamCode": (next["myTeamCode"] as? String) ?? "",
                "stadium": (next["stadium"] as? String) ?? "",
                "startText": (next["startText"] as? String) ?? "",
                "dateText": (next["dateText"] as? String) ?? "",
                "awayStarter": (next["awayStarter"] as? String) ?? "",
                "homeStarter": (next["homeStarter"] as? String) ?? "",
            ]
        }
        WidgetSnapshotStore.write(dict)
        call.resolve()
    }

    /// 최애선수 목록을 App Group(fav_players)에 기록 — 선수 카드 위젯 config(선수 선택 목록)용.
    /// JS setWidgetFavPlayers가 HomeClientShell에서 favPlayers 변경 시 호출한다. 위젯은 이 목록을
    /// DynamicOptions(FavPlayerQuery)로 읽어 선택지를 만든다(안드 setFavPlayers 이식). WidgetKit
    /// reloadAllTimelines은 iOS 14+ — 잠금화면 LA와 무관, 홈 위젯 타임라인만 갱신하므로 안전하다.
    @objc func setFavPlayers(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? "[]"
        UserDefaults(suiteName: WidgetSnapshotStore.appGroupId)?.set(json, forKey: "fav_players")
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    /// 최애팀 코드를 App Group(my_team)에 직접 기록 — 팀순위 위젯 하이라이트가 경기/스냅샷
    /// 흐름과 무관하게 항상 최신 값을 읽도록 한다(오프데이·팀변경 직후 stale 방지).
    @objc func setMyTeam(_ call: CAPPluginCall) {
        let code = call.getString("code") ?? ""
        guard !code.isEmpty else { call.resolve(); return }
        UserDefaults(suiteName: WidgetSnapshotStore.appGroupId)?.set(code, forKey: "my_team")
        WatchSyncManager.shared.syncMyTeam(code)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    /// 홈 위젯 탭 동작 모드를 App Group(widget_tap_mode)에 기록 — 'open'(탭 시 앱 실행, 기본)
    /// | 'refresh'(앱 안 열고 위젯만 재렌더). 위젯 익스텐션이 이 값을 읽어 탭 인텐트를 분기한다.
    /// refresh 새로고침 인텐트(Button intent)는 iOS 17+ 전용이라 구버전에선 저장돼도 무효(open처럼 동작).
    @objc func setWidgetTapMode(_ call: CAPPluginCall) {
        let raw = call.getString("mode") ?? "open"
        let mode = raw == "refresh" ? "refresh" : "open"
        UserDefaults(suiteName: WidgetSnapshotStore.appGroupId)?.set(mode, forKey: "widget_tap_mode")
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    /// 저장된 홈 위젯 탭 동작 모드 조회. 미설정 기본 'open'. refreshSupported는 '새로고침만'
    /// 옵션의 실제 동작 가능 여부(위젯 Button intent = iOS 17+)로, 설정 UI가 iOS16 이하에서
    /// 해당 옵션을 정직하게 비활성/안내하도록 capability를 함께 반환한다.
    @objc func getWidgetTapMode(_ call: CAPPluginCall) {
        let mode = UserDefaults(suiteName: WidgetSnapshotStore.appGroupId)?.string(forKey: "widget_tap_mode") ?? "open"
        let refreshSupported: Bool
        if #available(iOS 17, *) { refreshSupported = true } else { refreshSupported = false }
        call.resolve(["mode": mode, "refreshSupported": refreshSupported])
    }

    @available(iOS 16.1, *)
    private static func parseState(_ call: CAPPluginCall) -> KBOGameAttributes.ContentState {
        let status = call.getString("status") ?? "live"
        return KBOGameAttributes.ContentState(
            awayScore: call.getInt("awayScore") ?? 0,
            homeScore: call.getInt("homeScore") ?? 0,
            inning: call.getInt("inning") ?? 1,
            isTopInning: call.getBool("isTopInning") ?? true,
            balls: call.getInt("balls") ?? 0,
            strikes: call.getInt("strikes") ?? 0,
            outs: call.getInt("outs") ?? 0,
            onFirst: call.getBool("onFirst") ?? false,
            onSecond: call.getBool("onSecond") ?? false,
            onThird: call.getBool("onThird") ?? false,
            pitcherName: call.getString("pitcherName") ?? "",
            batterName: call.getString("batterName") ?? "",
            stadium: call.getString("stadium") ?? "",
            status: status == "final" ? .final : (status == "scheduled" ? .scheduled : .live),
            startTime: call.getString("startTime"),
            awayStarter: call.getString("awayStarter"),
            homeStarter: call.getString("homeStarter"),
            // 문자중계 한 줄(1.0.7) — 빈 문자열이면 nil로 정규화(카드 행 미렌더).
            lastPlay: (call.getString("lastPlay")?.isEmpty ?? true) ? nil : call.getString("lastPlay")
        )
    }
}
