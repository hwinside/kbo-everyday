import Capacitor
import FBSDKCoreKit

@objc(MetaAppEventsPlugin)
public class MetaAppEventsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MetaAppEventsPlugin"
    public let jsName = "MetaAppEvents"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "logEvent", returnType: CAPPluginReturnPromise),
    ]

    @objc func logEvent(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("name is required")
            return
        }

        let rawParameters = call.getObject("parameters") ?? [:]
        let parameters = rawParameters.reduce(into: [AppEvents.ParameterName: Any]()) { result, item in
            guard let value = normalizeParameterValue(item.value) else { return }
            result[AppEvents.ParameterName(item.key)] = value
        }

        AppEvents.shared.logEvent(AppEvents.Name(name), parameters: parameters)
        call.resolve()
    }

    private func normalizeParameterValue(_ value: Any) -> Any? {
        switch value {
        case let string as String:
            return string
        case let number as NSNumber:
            return number
        case let bool as Bool:
            return bool
        default:
            return nil
        }
    }
}
