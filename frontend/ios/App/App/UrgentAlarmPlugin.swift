import AlarmKit
import Capacitor
import CryptoKit
import Foundation
import SwiftUI

@available(iOS 26.0, *)
private struct UrgentMetadata: AlarmMetadata {}

private struct AlarmRecord: Codable {
    let fingerprint: String
    let fireAt: Double
}

private struct AlarmRegistry: Codable {
    var owner: String?
    var enabled = false
    var records: [String: AlarmRecord] = [:]
}

@available(iOS 26.0, *)
@MainActor
private final class UrgentAlarmStore {
    private let key = "mewmo.urgent-alarms.v1"
    private let manager = AlarmManager.shared
    private var registry: AlarmRegistry
    private var failures: [String: String] = [:]

    init() {
        registry = UserDefaults.standard.data(forKey: key)
            .flatMap { try? JSONDecoder().decode(AlarmRegistry.self, from: $0) } ?? AlarmRegistry()
    }

    private func persist() throws {
        UserDefaults.standard.set(try JSONEncoder().encode(registry), forKey: key)
    }

    private func existing() throws -> [Alarm] {
        return try manager.alarms
    }

    private func snapshot() throws -> JSObject {
        let authorization: String
        switch manager.authorizationState {
        case .authorized: authorization = "authorized"
        case .denied: authorization = "denied"
        case .notDetermined: authorization = "notDetermined"
        @unknown default: authorization = "denied"
        }
        var states: [String: String] = [:]
        if authorization == "authorized" {
            let alarms = try existing()
            for (id, record) in registry.records {
                if let alarm = alarms.first(where: { $0.id.uuidString.lowercased() == id }) {
                    states[id] = alarm.state == .alerting ? "alerting" : "scheduled"
                } else {
                    states[id] = record.fireAt <= Date().timeIntervalSince1970 ? "ended" : "not_scheduled"
                }
            }
        }
        states.merge(failures) { _, failure in failure }
        return ["available": true, "authorization": authorization,
                "enabled": registry.enabled, "states": states.mapValues { $0 as JSValue }]
    }

    func run(_ call: CAPPluginCall, operation: String) async throws -> JSObject {
        let owner = call.getString("owner")
        if operation == "bind" {
            guard owner == nil || (owner!.count <= 2048 && !owner!.isEmpty) else {
                throw NSError(domain: "MewmoAlarms", code: 1)
            }
            if owner != registry.owner || owner == nil {
                // All AlarmKit alarms returned here belong to this app, including orphaned records.
                if registry.enabled || !registry.records.isEmpty || manager.authorizationState == .authorized {
                    for alarm in try existing() {
                        try manager.cancel(id: alarm.id)
                    }
                }
                registry = AlarmRegistry(owner: owner)
                failures = [:]
                try persist()
            }
            return try snapshot()
        }
        guard owner != nil && owner == registry.owner else {
            throw NSError(domain: "MewmoAlarms", code: 2)
        }
        if operation == "disable" {
            if registry.enabled || !registry.records.isEmpty || manager.authorizationState == .authorized {
                for alarm in try existing() { try manager.cancel(id: alarm.id) }
            }
            registry.enabled = false
            registry.records = [:]
            failures = [:]
            try persist()
            return try snapshot()
        }
        if operation == "authorize" {
            if manager.authorizationState == .notDetermined {
                _ = try await manager.requestAuthorization()
            }
            if manager.authorizationState == .authorized && !registry.enabled {
                // Re-enabling starts clean, even after system permission or local storage changes.
                for alarm in try existing() { try manager.cancel(id: alarm.id) }
                registry.records = [:]
                failures = [:]
            }
            registry.enabled = manager.authorizationState == .authorized
            try persist()
            return try snapshot()
        }
        guard operation == "sync", let input = call.getArray("items", JSObject.self),
              input.count <= 10000 else {
            throw NSError(domain: "MewmoAlarms", code: 3)
        }
        // Validate the complete snapshot before cancellation or scheduling.
        var items: [(id: UUID, key: String, active: Bool, title: String, fireAt: Double)] = []
        for value in input {
            guard let rawId = value["id"] as? String, let id = UUID(uuidString: rawId),
                  let active = value["active"] as? Bool,
                  let title = value["title"] as? String, !title.isEmpty, title.count <= 180,
                  let fireAt = value["fireAt"] as? Double, fireAt.isFinite else {
                throw NSError(domain: "MewmoAlarms", code: 3)
            }
            items.append((id, id.uuidString.lowercased(), active, title, fireAt))
        }
        guard Set(items.map(\.key)).count == items.count else {
            throw NSError(domain: "MewmoAlarms", code: 3)
        }
        if !registry.enabled && registry.records.isEmpty && manager.authorizationState != .authorized {
            return try snapshot()
        }
        let alarms = try existing()
        let activeIds = Set(alarms.map { $0.id.uuidString.lowercased() })
        let wanted = Set(items.filter(\.active).map(\.key))
        let remove = call.getBool("complete") == true
            ? activeIds.union(registry.records.keys).subtracting(wanted)
            : Set(items.filter { !$0.active }.map(\.key))
        for id in remove {
            if activeIds.contains(id), let uuid = UUID(uuidString: id) {
                try manager.cancel(id: uuid)
            }
            registry.records.removeValue(forKey: id)
            failures.removeValue(forKey: id)
        }
        try persist()
        guard registry.enabled && manager.authorizationState == .authorized else {
            return try snapshot()
        }
        for item in items where item.active {
            failures.removeValue(forKey: item.key)
            let fingerprint = SHA256.hash(data: Data("\(item.fireAt)\n\(item.title)".utf8))
                .map { String(format: "%02x", $0) }.joined()
            let unchanged = registry.records[item.key]?.fingerprint == fingerprint
            // Do not recreate an unchanged alarm that the user dismissed in system UI.
            if unchanged && (activeIds.contains(item.key) || call.getBool("force") != true) { continue }
            if item.fireAt <= Date().timeIntervalSince1970 {
                // Do not stop an already-alerting, unchanged alarm on a routine refresh.
                if !unchanged && activeIds.contains(item.key) { try manager.cancel(id: item.id) }
                failures[item.key] = "past"
                continue
            }
            do {
                if activeIds.contains(item.key) { try manager.cancel(id: item.id) }
                let alert: AlarmPresentation.Alert
                if #available(iOS 26.1, *) {
                    alert = AlarmPresentation.Alert(title: "\(item.title)")
                } else {
                    let stop = AlarmButton(
                        text: call.getString("language")?.hasPrefix("zh") == true ? "停止" : "Stop",
                        textColor: .white, systemImageName: "stop.fill")
                    alert = AlarmPresentation.Alert(title: "\(item.title)", stopButton: stop)
                }
                let attributes = AlarmAttributes<UrgentMetadata>(
                    presentation: AlarmPresentation(alert: alert),
                    metadata: UrgentMetadata(), tintColor: Color(red: 0.52, green: 0.40, blue: 0.65))
                let configuration = AlarmManager.AlarmConfiguration<UrgentMetadata>.alarm(
                    schedule: .fixed(Date(timeIntervalSince1970: item.fireAt)),
                    attributes: attributes, sound: .default)
                _ = try await manager.schedule(id: item.id, configuration: configuration)
                registry.records[item.key] = AlarmRecord(fingerprint: fingerprint, fireAt: item.fireAt)
                try persist()
            } catch AlarmManager.AlarmError.maximumLimitReached {
                failures[item.key] = "limit"
            } catch {
                failures[item.key] = "failed"
            }
        }
        return try snapshot()
    }
}

@objc(MewmoUrgentAlarmsPlugin)
public class UrgentAlarmPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MewmoUrgentAlarmsPlugin"
    public let jsName = "MewmoUrgentAlarms"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "bind", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise)
    ]
    private var store: Any?
    private var pending: Task<Void, Never>?

    private func enqueue(_ call: CAPPluginCall, operation: String) {
        Task { @MainActor in
            let previous = self.pending
            self.pending = Task { @MainActor in
                // Serialize across async authorization/scheduling and account switches.
                await previous?.value
                guard #available(iOS 26.0, *) else {
                    call.resolve(["available": false, "authorization": "unavailable",
                                  "enabled": false, "states": [:]])
                    return
                }
                if self.store == nil { self.store = UrgentAlarmStore() }
                do {
                    let result = try await (self.store as! UrgentAlarmStore).run(call, operation: operation)
                    call.resolve(result)
                } catch {
                    call.reject("Could not update iPhone alarms. Existing alarms may still ring.", "ALARM_FAILED")
                }
            }
        }
    }

    @objc func bind(_ call: CAPPluginCall) { enqueue(call, operation: "bind") }
    @objc func authorize(_ call: CAPPluginCall) { enqueue(call, operation: "authorize") }
    @objc func disable(_ call: CAPPluginCall) { enqueue(call, operation: "disable") }
    @objc func sync(_ call: CAPPluginCall) { enqueue(call, operation: "sync") }
}
