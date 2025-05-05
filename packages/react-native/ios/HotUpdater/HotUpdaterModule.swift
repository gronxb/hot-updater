import Foundation
import React

@objcMembers
public class HotUpdaterModule: HotUpdater {
    
    // MARK: - RCTEventEmitter Override
    override public func supportedEvents() -> [String] {
        return ["onProgress"]
    }
    
    /**
     * 채널을 설정합니다.
     */
    @objc
    public func setChannel(_ channel: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            let prefs = UserDefaults.standard
            prefs.set(channel, forKey: "HotUpdaterChannel")
            prefs.synchronize()
            resolve(nil)
        }
    }
    
    /**
     * React Native 앱을 리로드합니다.
     */
    @objc
    public func reload() {
        DispatchQueue.main.async {
            if HotUpdater.bundleURL() != nil {
                RCTTriggerReloadCommandListeners("HotUpdater requested reload")
            }
        }
    }
    
    /**
     * 앱 버전을 가져옵니다.
     */
    @objc
    public func getAppVersion(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            resolve(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
        }
    }
    
    /**
     * 번들을 업데이트합니다.
     */
    @objc
    public func updateBundle(_ bundleData: [String: Any], 
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
        guard let bundleId = bundleData["bundleId"] as? String,
              let zipUrlString = bundleData["zipUrl"] as? String else {
            reject("INVALID_PARAMS", "Invalid bundle data parameters", nil)
            return
        }
        
        // 이벤트 전송 함수
        let sendProgressEvent: (NSNumber) -> Void = { [weak self] progress in
            self?.sendEvent(withName: "onProgress", body: ["progress": progress.doubleValue])
        }
        
        updateBundle(bundleId: bundleId,
                    zipUrlString: zipUrlString,
                    progressCallback: sendProgressEvent) { success, error in
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
