// ActivityKit boundary double. Production convergence body is injected verbatim by
// la-recovery-caller-smoke.py; this is not device/OS or concurrency evidence.
import Foundation
struct KBOGameAttributes {
    let gameId: String
    let channelId: String?
    let recoveryAttempt: String?
}
enum State { case active, stale, ended }
enum Dismissal { case immediate }
final class FakeActivity {
    static var all: [FakeActivity] = []
    static var events: [String] = []
    static var blockEnd = false
    let id: String
    let attributes: KBOGameAttributes
    var activityState = State.active
    var contentState = 0
    init(_ id: String, game: String = "game", channel: String = "current", attempt: String? = nil) {
        self.id = id
        attributes = .init(gameId: game, channelId: channel, recoveryAttempt: attempt)
    }
    func end(using: Int, dismissalPolicy: Dismissal) async {
        Self.events.append("end:" + id)
        if !Self.blockEnd { activityState = .ended }
    }
}
enum Activity<T> {
    static var activities: [FakeActivity] { FakeActivity.all }
}
enum ChannelResult { case active(String?) }
final class Controller {
    var currentActivity: FakeActivity?
    func withGameSerialQueue(_ gameId: String, body: () async -> Void) async { await body() }
    func fetchActiveChannel(gameId: String) async -> ChannelResult { .active("current") }
    func observePushToken(_ card: FakeActivity, gameId: String) {}
    func forgetRecoveryAck(activityId: String) { FakeActivity.events.append("forget:" + activityId) }
    func ackChannelActivity(gameId: String, channelId: String, activityId: String) {
        FakeActivity.events.append("ack:" + activityId)
    }
    // PRODUCTION_BODY
}
@main struct CallerSmoke {
    static func main() async {
        for order in 0..<3 {
            let first = FakeActivity("a-first")
            let retry = FakeActivity("z-retry", attempt: "retry-1")
            let other = FakeActivity("other", game: "other-game")
            let c = Controller()
            FakeActivity.events = []
            FakeActivity.all = order == 0 ? [first, other] : order == 1 ? [retry, other] : [first, retry, other]
            await c.convergeRecoveryCards(gameId: "game")
            if order < 2 {
                FakeActivity.all.append(order == 0 ? retry : first)
                await c.convergeRecoveryCards(gameId: "game")
            }
            precondition(first.activityState == .ended && retry.activityState == .active)
            precondition(other.activityState == .active)
            precondition(c.currentActivity?.id == retry.id)
            precondition(FakeActivity.events.suffix(2) == ["forget:z-retry", "ack:z-retry"])
            let end = FakeActivity.events.firstIndex(of: "end:a-first")!
            let ack = FakeActivity.events.lastIndex(of: "ack:z-retry")!
            precondition(end < ack)
        }
        // Interrupted cleanup must not ACK; a later invocation converges again.
        let first = FakeActivity("a-first"), retry = FakeActivity("z-retry", attempt: "retry-1")
        FakeActivity.all = [first, retry]
        FakeActivity.events = []
        FakeActivity.blockEnd = true
        let c = Controller()
        await c.convergeRecoveryCards(gameId: "game")
        precondition(!FakeActivity.events.contains("ack:z-retry"))
        FakeActivity.blockEnd = false
        await c.convergeRecoveryCards(gameId: "game")
        precondition(first.activityState == .ended)
        precondition(FakeActivity.events.suffix(2) == ["forget:z-retry", "ack:z-retry"])
        print("PASS production convergence caller with ActivityKit boundary doubles")
    }
}
