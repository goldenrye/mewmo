import AVFoundation
import Capacitor
import Speech
import UIKit

@objc(MewmoSpeechPlugin)
public class SpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MewmoSpeechPlugin"
    public let jsName = "MewmoSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var active: CAPPluginCall?
    private var requestId = ""
    private var engine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var timer: Timer?
    private var transcript = ""
    private var observers: [NSObjectProtocol] = []
    private var ownsAudioSession = false

    public override func load() {
        for notification in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
                self?.finish(error: "CANCELLED")
            })
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        timer?.invalidate()
        task?.cancel()
        engine?.stop()
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.active == nil else {
                call.reject("Speech recognition is already running.", "BUSY")
                return
            }
            guard let id = call.getString("requestId"),
                  let language = call.getString("language"), ["en-US", "zh-CN"].contains(language),
                  UIApplication.shared.applicationState == .active else {
                call.reject("Speech recognition is unavailable.", "UNAVAILABLE")
                return
            }
            self.active = call
            self.requestId = id
            self.transcript = ""
            SFSpeechRecognizer.requestAuthorization { authorization in
                DispatchQueue.main.async {
                    guard self.active === call else { return }
                    guard authorization == .authorized else { self.finish(error: "PERMISSION"); return }
                    AVAudioSession.sharedInstance().requestRecordPermission { allowed in
                        DispatchQueue.main.async {
                            guard self.active === call else { return }
                            guard allowed else { self.finish(error: "PERMISSION"); return }
                            self.begin(call, language: language)
                        }
                    }
                }
            }
        }
    }

    private func begin(_ call: CAPPluginCall, language: String) {
        guard UIApplication.shared.applicationState == .active,
              let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)),
              recognizer.isAvailable else {
            finish(error: "UNAVAILABLE")
            return
        }
        self.recognizer = recognizer
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
            ownsAudioSession = true
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                finish(error: "UNAVAILABLE")
                return
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            self.engine = engine
            self.request = request
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self = self, self.active === call else { return }
                    if let result = result {
                        self.transcript = result.bestTranscription.formattedString
                        self.notifyListeners("partial", data: ["requestId": self.requestId, "text": self.transcript])
                        if result.isFinal { self.finish(); return }
                    }
                    if error != nil { self.finish(error: "UNAVAILABLE") }
                }
            }
            engine.prepare()
            try engine.start()
            notifyListeners("partial", data: ["requestId": requestId, "text": ""])
            timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.endAudio() }
        } catch {
            finish(error: "UNAVAILABLE")
        }
    }

    private func stopAudio() {
        if let engine = engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            self.engine = nil
        }
        request?.endAudio()
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsAudioSession = false
        }
    }

    private func endAudio() {
        guard active != nil else { return }
        // Stop during a permission prompt must not start recording later.
        guard request != nil else { finish(error: "CANCELLED"); return }
        stopAudio()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.finish() }
    }

    private func finish(error: String? = nil) {
        guard let call = active else { return }
        active = nil
        timer?.invalidate()
        timer = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        transcript = ""
        requestId = ""
        if let error = error { call.reject("Speech recognition did not complete.", error) }
        else if text.isEmpty { call.reject("No speech was recognized.", "NO_SPEECH") }
        else { call.resolve(["text": text]) }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if call.getString("requestId") == self.requestId { self.endAudio() }
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if call.getString("requestId") == self.requestId { self.finish(error: "CANCELLED") }
            call.resolve()
        }
    }
}
