import Foundation
import React // RCTEventEmitter, Promises, RCTTriggerReloadCommandListeners 등 포함

#if canImport(React_RCTAppDelegate)
import React_RCTAppDelegate
#elseif canImport(React)
import React
#endif

// FIX: 클래스 이름을 HotUpdaterModule로 변경
@objc(HotUpdaterModule) // 모듈 이름을 명시적으로 Objective-C에 노출
@objcMembers // Objective-C에서 접근 가능하도록 설정
public class HotUpdaterModule: RCTEventEmitter { // 클래스 이름 변경됨

    // FIX: 공유 인스턴스 타입 및 이름 변경
    // 공유 인스턴스 (싱글톤) - HotUpdater.mm에서 접근
    public static let shared = HotUpdaterModule() // 타입 및 이름 변경됨

    // 실제 로직을 처리하는 구현체 인스턴스
    private let implementation = HotUpdaterImpl.shared

    // 싱글톤이므로 private init
    private override init() {
        super.init()
    }

    // MARK: - RCTEventEmitter 필수 구현

    // JavaScript로 보낼 이벤트 이름 목록
    override public func supportedEvents() -> [String]! {
        return ["onProgress"]
    }

    // 메인 스레드에서 초기화 필요한지 여부
    override public static func requiresMainQueueSetup() -> Bool {
        return true
    }

    // MARK: - Static Methods (Objective-C 클래스 메소드에서 호출)

    // AppDelegate 등에서 현재 번들 URL을 얻기 위한 정적 메소드
    public static func bundleURL() -> URL? {
        return HotUpdaterImpl.bundleURL()
    }

    // MARK: - Instance Methods (Objective-C 인스턴스 메소드에서 호출)

    /**
     * JavaScript에서 채널 설정 요청 시 호출됨
     */
    public func setChannel(_ channel: String,
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
        self.implementation.updateChannel(channel) // 내부 로직은 그대로
        print("HotUpdaterModule.swift: Channel set to \(channel)") // 로그 클래스 이름 변경
        resolve(nil)
    }

    /**
     * JavaScript에서 앱 리로드 요청 시 호출됨
     */
    public func reload() {
        DispatchQueue.main.async {
            if HotUpdaterImpl.bundleURL() != HotUpdaterImpl.fallbackURL() {
                print("HotUpdaterModule.swift: Requesting RN reload.") // 로그 클래스 이름 변경
                RCTTriggerReloadCommandListeners("HotUpdater requested reload")
            } else {
                 print("HotUpdaterModule.swift: Reload requested, but only fallback bundle is active. Ignoring.") // 로그 클래스 이름 변경
            }
        }
    }

    /**
     * JavaScript에서 네이티브 앱 버전 요청 시 호출됨
     */
    public func getAppVersion(resolve: @escaping RCTPromiseResolveBlock,
                              reject: @escaping RCTPromiseRejectBlock) {
        resolve(self.implementation.appVersion)
    }

    /**
     * JavaScript에서 번들 업데이트 요청 시 호출됨
     */
    public func updateBundle(_ bundleData: [String: Any],
                             resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {

        guard let bundleId = bundleData["bundleId"] as? String, !bundleId.isEmpty else {
             reject("INVALID_PARAM", "Missing or invalid 'bundleId'", nil)
             return
        }
        let zipUrlString = bundleData["zipUrl"] as? String ?? ""
        print("HotUpdaterModule.swift: Received update request. ID: \(bundleId), URL: '\(zipUrlString)'") // 로그 클래스 이름 변경

        let progressCallback: (NSNumber) -> Void = { [weak self] progress in
             self?.sendEvent(withName: "onProgress", body: ["progress": progress.doubleValue])
        }

        implementation.updateBundle(bundleId: bundleId,
                                   zipUrlString: zipUrlString,
                                   progressCallback: progressCallback) { success, error in
             DispatchQueue.main.async {
                 if success {
                     print("HotUpdaterModule.swift: Update successful for \(bundleId). Resolving promise.") // 로그 클래스 이름 변경
                     resolve(true)
                 } else {
                     let errorCode = (error as NSError?)?.code ?? -1
                     let errorDescription = error?.localizedDescription ?? "Unknown update error"
                     print("HotUpdaterModule.swift: Update failed for \(bundleId). Error: \(errorDescription) (Code: \(errorCode)). Rejecting promise.") // 로그 클래스 이름 변경
                     reject("UPDATE_FAILED", errorDescription, error)
                 }
             }
        }
    }

    // MARK: - Constants (JavaScript로 내보낼 상수)

    override public func constantsToExport() -> [AnyHashable : Any]! {
         return [
             "minBundleId": implementation.minBundleId,
             "initialAppVersion": implementation.appVersion,
             "initialChannel": implementation.channel ?? NSNull()
         ]
     }
}