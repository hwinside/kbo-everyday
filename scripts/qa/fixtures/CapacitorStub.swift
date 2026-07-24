import UIKit

public let CAPPluginReturnPromise = "promise"

public protocol CAPBridgedPlugin {}

public protocol CAPBridgeProtocol: AnyObject {
    var viewController: UIViewController? { get }
}

open class CAPPlugin: NSObject {
    public var bridge: CAPBridgeProtocol?
}

public final class CAPPluginMethod {
    public init(name: String, returnType: String) {}
}

open class CAPPluginCall: NSObject {
    public func getString(_ name: String) -> String? { nil }
    public func getInt(_ name: String) -> Int? { nil }
    public func reject(_ message: String) {}
    public func resolve() {}
}

