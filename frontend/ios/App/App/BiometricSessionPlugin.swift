import Capacitor
import CryptoKit
import Foundation
import LocalAuthentication
import Security

private struct BiometricSession: Codable {
    let token: String
    let userId: String
    let server: String
}

private enum BiometricPreferencePolicy {
    static func keepEnabled(enabled: Bool, preserve: Bool, owner: String?, userId: String?) -> Bool {
        enabled && preserve && (userId == nil || owner == userId)
    }
}

@objc(MewmoBiometricsPlugin)
public class BiometricSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MewmoBiometricsPlugin"
    public let jsName = "MewmoBiometrics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "store", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "com.mewmo.biometric-session")

    private func prompt(_ call: CAPPluginCall, english: String, chinese: String) -> String {
        let language = call.getString("language") ?? Locale.preferredLanguages.first ?? "en"
        return language.lowercased().hasPrefix("zh") ? chinese : english
    }

    private func server(_ call: CAPPluginCall) -> String? {
        guard let value = call.getString("server"), let url = URL(string: value),
              url.scheme == "https", url.host != nil, url.user == nil,
              url.password == nil, url.query == nil, url.fragment == nil else {
            call.reject("An HTTPS API address is required.", "INVALID_SERVER")
            return nil
        }
        return value
    }

    private func key(_ server: String) -> String {
        SHA256.hash(data: Data(server.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func preference(_ server: String) -> String {
        "mewmo.biometric.enabled." + key(server)
    }

    private func credentialState(_ server: String) -> String {
        UserDefaults.standard.string(forKey: preference(server) + ".session") ?? "unchecked"
    }

    private func query(_ server: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "com.jpi.mewmo") + ".biometric-session",
            kSecAttrAccount as String: key(server),
            kSecAttrSynchronizable as String: false
        ]
    }

    @objc func status(_ call: CAPPluginCall) {
        guard let server = server(call) else { return }
        queue.async {
            let context = LAContext()
            let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            let label = context.biometryType == .touchID ? "Touch ID" : "Face ID"
            call.resolve([
                "available": available,
                // Non-secret preference metadata never authorizes sign-in.
                "enabled": UserDefaults.standard.bool(forKey: self.preference(server)),
                // This is a local renewal hint, never proof that the server accepts a session.
                "sessionState": self.credentialState(server),
                "label": label
            ])
        }
    }

    @objc func store(_ call: CAPPluginCall) {
        guard let server = server(call) else { return }
        guard let token = call.getString("token"),
              token.range(of: "^[A-Za-z0-9_-]{64}$", options: .regularExpression) != nil,
              let userId = call.getString("userId"), UUID(uuidString: userId) != nil else {
            call.reject("Sign in with your password first.", "INVALID_SESSION")
            return
        }
        let context = LAContext()
        context.localizedFallbackTitle = ""
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            call.reject("Set up Face ID or Touch ID in iPhone Settings first.", "UNAVAILABLE")
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: prompt(call, english: "Enable biometric sign-in for Mewmo",
                                                       chinese: "为 Mewmo 启用生物识别登录")) { success, _ in
            guard success else {
                call.reject("Biometric setup was not completed. Your password still works.", "AUTH_FAILED")
                return
            }
            self.queue.async {
                guard let access = SecAccessControlCreateWithFlags(
                    nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil
                ), let data = try? JSONEncoder().encode(BiometricSession(token: token, userId: userId, server: server)) else {
                    call.reject("Could not protect this session.", "STORAGE_FAILED")
                    return
                }
                let deleted = SecItemDelete(self.query(server) as CFDictionary)
                guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
                    call.reject("Could not replace the saved session.", "STORAGE_FAILED")
                    return
                }
                UserDefaults.standard.set("missing", forKey: self.preference(server) + ".session")
                var attributes = self.query(server)
                attributes[kSecAttrAccessControl as String] = access
                attributes[kSecValueData as String] = data
                attributes[kSecUseAuthenticationContext as String] = context
                guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else {
                    call.reject("Could not save this session securely.", "STORAGE_FAILED")
                    return
                }
                UserDefaults.standard.set(true, forKey: self.preference(server))
                UserDefaults.standard.set(userId, forKey: self.preference(server) + ".owner")
                UserDefaults.standard.set("unchecked", forKey: self.preference(server) + ".session")
                call.resolve()
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        guard let server = server(call) else { return }
        queue.async {
            let context = LAContext()
            context.localizedReason = self.prompt(call, english: "Sign in to Mewmo", chinese: "登录 Mewmo")
            context.localizedFallbackTitle = ""
            // A fresh context and Keychain ACL enforce biometrics on every retrieval.
            var request = self.query(server)
            request[kSecReturnData as String] = true
            request[kSecMatchLimit as String] = kSecMatchLimitOne
            request[kSecUseAuthenticationContext as String] = context
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            guard status == errSecSuccess else {
                if status == errSecItemNotFound {
                    UserDefaults.standard.set("missing", forKey: self.preference(server) + ".session")
                    call.reject("Sign in with your password and enable Face ID again.", "MISSING_SESSION")
                } else if status == errSecUserCanceled {
                    call.reject("Sign-in cancelled. Try again or use your password.", "CANCELLED")
                } else {
                    call.reject("Biometric sign-in is unavailable. Try again or use your password.", "AUTH_FAILED")
                }
                return
            }
            guard let data = result as? Data,
                  let session = try? JSONDecoder().decode(BiometricSession.self, from: data),
                  session.server == server else {
                UserDefaults.standard.set("invalid", forKey: self.preference(server) + ".session")
                call.reject("The saved session could not be read. Use your password.", "INVALID_SESSION")
                return
            }
            // Bind preferences from older app versions only after a protected Keychain read.
            UserDefaults.standard.set(session.userId, forKey: self.preference(server) + ".owner")
            call.resolve(["token": session.token, "userId": session.userId])
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard let server = server(call) else { return }
        let preserve = call.getBool("preservePreference") ?? false
        let userId = call.getString("userId")
        let reason = call.getString("reason") ?? "missing"
        guard ["missing", "invalid", "rejected"].contains(reason) else {
            call.reject("Invalid saved-session state.", "INVALID_SESSION")
            return
        }
        queue.async {
            let status = SecItemDelete(self.query(server) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                call.reject("Could not remove the saved session. Please try again.", "STORAGE_FAILED")
                return
            }
            let preference = self.preference(server)
            let owner = UserDefaults.standard.string(forKey: preference + ".owner")
            let keepPreference = BiometricPreferencePolicy.keepEnabled(
                enabled: UserDefaults.standard.bool(forKey: preference),
                preserve: preserve, owner: owner, userId: userId
            )
            if keepPreference {
                UserDefaults.standard.set(reason, forKey: preference + ".session")
            } else {
                UserDefaults.standard.set(false, forKey: preference)
                UserDefaults.standard.removeObject(forKey: preference + ".owner")
                UserDefaults.standard.removeObject(forKey: preference + ".session")
            }
            call.resolve()
        }
    }
}

class MewmoBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BiometricSessionPlugin())
        bridge?.registerPluginInstance(SpeechPlugin())
        bridge?.registerPluginInstance(UrgentAlarmPlugin())
    }
}
