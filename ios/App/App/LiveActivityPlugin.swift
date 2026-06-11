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
    ]

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
        let started = LiveActivityController.shared.start(
            gameId: gameId,
            awayTeam: awayTeam,
            homeTeam: homeTeam,
            awayTeamCode: awayTeamCode,
            homeTeamCode: homeTeamCode,
            state: Self.parseState(call)
        )
        call.resolve(["started": started])
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
        // finalState가 넘어오면 그걸로 종료(최종 스코어 표시), 아니면 현재 상태로
        let finalState: KBOGameAttributes.ContentState? =
            call.getObject("state") != nil ? Self.parseState(call) : nil
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
            status: status == "final" ? .final : .live
        )
    }
}
