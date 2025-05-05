import Foundation
import React

@objcMembers
public class HotUpdaterModule: NSObject {
    
    /**
     * 채널을 설정합니다.
     */
    static public func setChannel(_ channel: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            HotUpdater.shared.setChannel(channel)
            resolve(nil)
        }
    }
    
    /**
     * React Native 앱을 리로드합니다.
     */
    static public func reload() {
        DispatchQueue.main.async {
            if let bundleURL = HotUpdater.bundleURL() {
                // React Native 브릿지에서 번들 URL 업데이트 및 리로드 
                // 참고: 실제 구현에서는 bridige를 통해 이 작업을 수행
                print("Reloading with bundle URL: \(bundleURL)")
                RCTTriggerReloadCommandListeners("HotUpdater requested reload")
            }
        }
    }
    
    /**
     * 앱 버전을 가져옵니다.
     */
    static public func getAppVersion(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            resolve(HotUpdater.shared.appVersion)
        }
    }
    
    /**
     * 번들을 업데이트합니다.
     */
    static public func updateBundle(_ bundleData: [String: Any], 
                                   resolve: @escaping RCTPromiseResolveBlock,
                                   reject: @escaping RCTPromiseRejectBlock) {
        guard let bundleId = bundleData["bundleId"] as? String,
              let zipUrlString = bundleData["zipUrl"] as? String else {
            reject("INVALID_PARAMS", "Invalid bundle data parameters", nil)
            return
        }
        
        // 이벤트 전송 함수
        let sendProgressEvent: (NSNumber) -> Void = { progress in
            // onProgress 이벤트 전송
            // 실제 구현에서는 RCTEventEmitter를 통해 이 작업을 수행
            NotificationCenter.default.post(
                name: NSNotification.Name("HotUpdaterProgressEvent"),
                object: nil,
                userInfo: ["progress": progress.doubleValue]
            )
        }
        
        HotUpdater.shared.updateBundle(
            bundleId: bundleId,
            zipUrlString: zipUrlString,
            progressCallback: sendProgressEvent
        ) { success, error in
            DispatchQueue.main.async {
                if success {
                    resolve([NSNumber(value: true)])
                } else {
                    reject("UPDATE_ERROR", error?.localizedDescription ?? "Unknown error", error)
                }
            }
        }
    }
}

// MARK: - Notification 확장
extension Notification.Name {
    /**
     * 핫 업데이트 진행 상태 알림
     */
    static let hotUpdaterProgress = Notification.Name("HotUpdaterProgressEvent")
}