import Foundation
@main struct RecoverySmoke {
    static func main() {
        let first = RecoveryCardPolicy.Card(id: "a-first", channel: "current", attempt: nil)
        let retry = RecoveryCardPolicy.Card(id: "z-retry", channel: "current", attempt: "attempt-1")
        let old = RecoveryCardPolicy.Card(id: "0-old", channel: "old", attempt: "old-attempt")
        precondition(RecoveryCardPolicy.keep([first], channel: "current") == first.id)
        // first -> retry, retry -> delayed first, simultaneous arrivals in both orders.
        for arrivals in [[first,retry], [retry,first], [old,first,retry], [retry,old,first]] {
            precondition(RecoveryCardPolicy.keep(arrivals, channel: "current") == retry.id)
        }
        precondition(RecoveryCardPolicy.keep([old], channel: "current") == nil)
        precondition(RecoveryCardPolicy.keep([], channel: "current") == nil)
        print("PASS retry preference and current-generation isolation (pure policy, not ActivityKit)")
    }
}
