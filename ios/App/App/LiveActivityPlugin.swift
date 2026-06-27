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
    ]

    /// 브리지 로드 시 — Activity push token 발급 콜백을 JS 이벤트로 연결 (W3 APNs 등록).
    public override func load() {
        if #available(iOS 16.1, *) {
            LiveActivityController.shared.onPushToken = { [weak self] gameId, token in
                // retainUntilConsumed: JS 리스너가 아직 안 붙었어도 이벤트를 버퍼링했다가
                // 부착 시 전달 → push token 유실로 서버 등록이 누락되는 race 방지(삼순 W3a NO-GO).
                self?.notifyListeners("liveActivityPushToken", data: ["gameId": gameId, "token": token], retainUntilConsumed: true)
            }
            // W3b — push-to-start 토큰(iOS 17.2+). 앱 부팅 즉시 관찰 시작해 디바이스 토큰을
            // JS로 전달 → 서버 등록. retainUntilConsumed로 리스너 부착 전 발급분도 버퍼링.
            LiveActivityController.shared.onPushToStartToken = { [weak self] token in
                self?.notifyListeners("liveActivityPushToStartToken", data: ["token": token], retainUntilConsumed: true)
            }
            LiveActivityController.shared.observePushToStartToken()
            // W3b — 원격(push-to-start) 생성 Activity도 per-activity update 토큰을 등록하도록
            // 모든 Activity 생성을 관찰. 없으면 자동시작 카드가 갱신 안 됨(삼순 NO-GO ①).
            LiveActivityController.shared.observeAllActivities()
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
        let dict: [String: Any] = [
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
            "batterName": call.getString("batterName") ?? "",
            "stadium": call.getString("stadium") ?? "",
            "isFinal": status == "final",
            "status": status,
            "startText": call.getString("startText") ?? "",
            "dateText": call.getString("dateText") ?? "",
        ]
        WidgetSnapshotStore.write(dict)
        call.resolve()
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
            startTime: call.getString("startTime")
        )
    }
}
