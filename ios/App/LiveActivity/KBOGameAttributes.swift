//
//  KBOGameAttributes.swift
//  KBO 크보팬 Live Activity (W1 토대)
//
//  잠금화면 라이브 스코어 카드의 데이터 모델.
//  - static(불변): 경기 식별 + 양팀 정보
//  - ContentState(가변): 스코어/이닝/BSO/주자/투수타자 — push/로컬 update로 갱신
//
//  ⚠️ Live Activity는 iOS 16.1+ 전용. 메인 앱(배포타깃 15.0)에서 호출 시
//  반드시 `if #available(iOS 16.1, *)`로 가드한다.
//

import Foundation
import ActivityKit

@available(iOS 16.1, *)
struct KBOGameAttributes: ActivityAttributes {

    // 경기 진행 상태
    enum GameStatus: String, Codable, Hashable {
        case scheduled  // 경기 전 (시작 30분 전부터 잠금화면에 미리 표시)
        case live       // 진행 중
        case final      // 종료 (W4: dismissal-date = now + 15m 후 자동 제거)
    }

    /// 매 업데이트마다 바뀌는 동적 상태. dedup은 이 값의 hash로 판단한다(W3).
    public struct ContentState: Codable, Hashable {
        var awayScore: Int
        var homeScore: Int

        var inning: Int          // 1 이상
        var isTopInning: Bool    // true = 초, false = 말

        var balls: Int           // 0...3
        var strikes: Int         // 0...2
        var outs: Int            // 0...2

        var onFirst: Bool
        var onSecond: Bool
        var onThird: Bool

        var pitcherName: String
        var batterName: String

        var stadium: String     // 구장명 (game-live 제공) — 잠금화면 pill 표시용

        var status: GameStatus

        /// 경기 전(scheduled) 예정 시각 라벨(예: "18:30 경기 예정"). live/final이면 nil.
        /// 옵셔널+기본 nil — 구버전 스냅샷/기존 ContentState() 호출과 Codable 하위호환.
        var startTime: String? = nil

        /// 예고선발 투수명(원정/홈) — scheduled 카드에서만 표기. 미확정/live/final이면 nil.
        /// 옵셔널+기본 nil로 Codable 하위호환(구버전 페이로드에 없어도 디코드 성공).
        var awayStarter: String? = nil
        var homeStarter: String? = nil

        /// 진행 중(live) 문자중계 최근 플레이 한 줄(예: "7회초 안재석 삼진 아웃"). scheduled/final이면 nil.
        /// 옵셔널+기본 nil로 Codable 하위호환(구버전 페이로드에 없어도 디코드 성공).
        var lastPlay: String? = nil

        // MARK: 표시용 파생값

        /// "7회초" / "9회말"
        var inningText: String {
            "\(inning)회\(isTopInning ? "초" : "말")"
        }

        /// "B 2  S 1  O 1"
        var countText: String {
            "B \(balls)  S \(strikes)  O \(outs)"
        }

        var isFinal: Bool { status == .final }
        var isScheduled: Bool { status == .scheduled }
    }

    // MARK: static (Activity 시작 시 1회 확정)
    var gameId: String
    var awayTeam: String      // 원정팀 풀네임 (예: "LG")
    var homeTeam: String      // 홈팀 풀네임
    var awayTeamCode: String  // 로고/약어용 코드 (예: "LG")
    var homeTeamCode: String
    var myTeamCode: String     // 최애팀 코드 — 잠금화면 컬러/MY TEAM 강조용 (없으면 "")
}
