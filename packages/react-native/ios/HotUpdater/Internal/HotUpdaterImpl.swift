import Foundation
import SSZipArchive // SSZipArchive가 Swift에서 접근 가능한지 확인하세요
import React // RCTPromiseResolveBlock/RejectBlock을 위해 React 임포트

// Objective-C에서 이 클래스에 접근 가능하도록 설정
@objcMembers public class HotUpdaterImpl: NSObject { // *** 클래스 이름 변경됨 ***

    private let fileManager = FileManager.default
    // URLSessionConfiguration.default를 사용하고 delegate를 self로 설정하여 진행률 추적
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        // delegateQueue를 nil로 설정하면 메인 스레드가 아닌 별도의 직렬 대기열에서 콜백이 실행됩니다.
        // UI 업데이트는 메인 스레드에서 수행해야 합니다. NotificationCenter를 사용하므로 여기서는 괜찮습니다.
        return URLSession(configuration: configuration, delegate: nil, delegateQueue: nil)
    }()


    // 다운로드 작업 및 진행률 핸들러 추적 (내부적으로 필요한 경우)
    // NotificationCenter는 ObjC로 진행률을 보고하는 데 사용됩니다.
    // HotUpdaterPrefs 인스턴스에 접근합니다. configure가 호출되었는지 확인하세요.
    private let prefs = HotUpdaterPrefs.shared

    public override init() {
        super.init()
        // 앱 버전으로 HotUpdaterPrefs 구성
        prefs.configure(appVersion: HotUpdaterImpl.appVersion)
    }


    public static var appVersion: String? {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    // MARK: - 상수 & 환경설정 접근 (여기서는 변경 필요 없음)

    public func setChannel(_ channel: String?) {
        // HotUpdaterPrefs 인스턴스를 통해 채널 저장
        prefs.setItem(channel, forKey: "HotUpdaterChannel")
        print("[HotUpdaterImpl] Channel set to: \(channel ?? "nil")")
    }

    public func getChannel() -> String? {
        // HotUpdaterPrefs 인스턴스를 통해 채널 검색
        return prefs.getItem(forKey: "HotUpdaterChannel") // 수정: getItemForKey -> getItem
    }

    // MARK: - 번들 URL 관리 (여기서는 변경 필요 없음)

    private func setBundleURLInternal(localPath: String?) {
        print("[HotUpdaterImpl] Setting bundle URL to: \(localPath ?? "nil")")
        // HotUpdaterPrefs 인스턴스를 통해 번들 URL 저장
        prefs.setItem(localPath, forKey: "HotUpdaterBundleURL")
    }

    private func cachedURLFromBundle() -> URL? {
        // HotUpdaterPrefs 인스턴스를 통해 번들 URL 검색
        guard let savedURLString = prefs.getItem(forKey: "HotUpdaterBundleURL"), // 수정: getItemForKey -> getItem
              let bundleURL = URL(string: savedURLString),
              fileManager.fileExists(atPath: bundleURL.path) else {
            return nil
        }
        return bundleURL
    }

    private func fallbackURL() -> URL? {
        return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    }

    // 번들 URL 메서드를 인스턴스 메서드로 변경
    public func bundleURL() -> URL? {
        let url = cachedURLFromBundle()
        print("[HotUpdaterImpl] Resolved bundle URL: \(url?.absoluteString ?? "Fallback")")
        return url ?? self.fallbackURL()
    }

    // MARK: - 번들 업데이트 로직 - JS에서 진입점

    // *** RCT_EXPORT_METHOD 호출을 처리하는 새 메소드 ***
    // Objective-C에서 직접 딕셔너리 및 promise 블록을 받음
    @objc public func updateBundleFromJS(_ params: NSDictionary?,
                                         resolver resolve: @escaping RCTPromiseResolveBlock,
                                         rejecter reject: @escaping RCTPromiseRejectBlock) {

        // 1. 인수 구문 분석 및 유효성 검사
        guard let data = params else {
            print("[HotUpdaterImpl] Error: params dictionary is nil")
            let error = NSError(domain: "HotUpdaterError", code: 101, userInfo: [NSLocalizedDescriptionKey: "Missing params dictionary"])
            reject("UPDATE_ERROR", error.localizedDescription, error)
            return
        }

        guard let bundleId = data["bundleId"] as? String, !bundleId.isEmpty else {
            print("[HotUpdaterImpl] Error: Missing or empty 'bundleId'")
            let error = NSError(domain: "HotUpdaterError", code: 102, userInfo: [NSLocalizedDescriptionKey: "Missing or empty 'bundleId'"])
            reject("UPDATE_ERROR", error.localizedDescription, error)
            return
        }

        let zipUrlString = data["zipUrl"] as? String ?? "" // 리셋을 위해 빈 문자열 허용

        var zipUrl: URL? = nil
        if !zipUrlString.isEmpty {
            guard let url = URL(string: zipUrlString) else {
                print("[HotUpdaterImpl] Error: Invalid 'zipUrl': \(zipUrlString)")
                let error = NSError(domain: "HotUpdaterError", code: 103, userInfo: [NSLocalizedDescriptionKey: "Invalid 'zipUrl' provided: \(zipUrlString)"])
                reject("UPDATE_ERROR", error.localizedDescription, error)
                return
            }
            zipUrl = url
        }

        print("[HotUpdaterImpl] updateBundleFromJS called with bundleId: \(bundleId), zipUrl: \(zipUrl?.absoluteString ?? "nil")")

        // 2. 내부 업데이트 로직 호출
        // promise 블록을 직접 전달하거나 완료 핸들러 사용
        updateBundleInternal(bundleId: bundleId, zipUrl: zipUrl) { success, error in
            // 내부 업데이트 로직 완료 시 이 완료 블록 실행
            if success {
                print("[HotUpdaterImpl] Update successful for \(bundleId). Resolving promise.")
                resolve(true) // 성공 bool로 resolve
            } else {
                let resolvedError = error ?? NSError(domain: "HotUpdaterError", code: 999, userInfo: [NSLocalizedDescriptionKey: "Unknown update error"])
                print("[HotUpdaterImpl] Update failed for \(bundleId): \(resolvedError.localizedDescription). Rejecting promise.")
                reject("UPDATE_ERROR", resolvedError.localizedDescription, resolvedError)
            }
        }
    }


    // MARK: - 내부 업데이트 로직 (이전 updateBundle)

    private func updateBundleInternal(bundleId: String, zipUrl: URL?,
                                      completion: @escaping (Bool, Error?) -> Void) { // Internal로 이름 변경


        // --- nil zipUrl 처리 (리셋 시나리오) ---
        guard let validZipUrl = zipUrl else {
            print("[HotUpdaterImpl] zipUrl is nil, resetting bundle URL.")
            setBundleURLInternal(localPath: nil)
            cleanupOldBundles(currentBundleId: nil)
            completion(true, nil)
            return
        }

        let storeDir = bundleStoreDir()
        let finalBundleDir = (storeDir as NSString).appendingPathComponent(bundleId)

        // --- 캐시 확인 ---
        if fileManager.fileExists(atPath: finalBundleDir),
           let existingBundlePath = findBundleFile(in: finalBundleDir) {
            print("[HotUpdaterImpl] Using cached bundle at path: \(existingBundlePath)")
            try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
            setBundleURLInternal(localPath: existingBundlePath)
            cleanupOldBundles(currentBundleId: bundleId)
            completion(true, nil)
            return
        } else if fileManager.fileExists(atPath: finalBundleDir) {
             print("[HotUpdaterImpl] Cached directory exists but invalid, removing: \(finalBundleDir)")
             try? fileManager.removeItem(atPath: finalBundleDir)
        }

        // --- 디렉토리 준비 ---
        let tempDirectory = tempDir()
        _ = try? fileManager.removeItem(atPath: tempDirectory)
        guard createDir(at: tempDirectory), createDir(at: storeDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create temporary or bundle store directories"])
            completion(false, error)
            return
        }
        let tempZipFile = (tempDirectory as NSString).appendingPathComponent("bundle.zip")
        let extractedDir = (tempDirectory as NSString).appendingPathComponent("extracted")
        guard createDir(at: extractedDir) else {
            let error = NSError(domain: "HotUpdaterError", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to create extracted directory"])
            completion(false, error)
            return
        }
        // --- 다운로드 ---
        print("[HotUpdaterImpl] Starting download from \(validZipUrl)")
        
        // 먼저 task 변수 선언
        var task: URLSessionDownloadTask!
        
        // 클로저 내부에서 사용할 다운로드 완료 핸들러 정의
        let downloadCompletionHandler: (URL?, URLResponse?, Error?) -> Void = { [weak self] location, response, error in
            guard let self = self else {
                completion(false, NSError(domain: "HotUpdaterError", code: 998, userInfo: [NSLocalizedDescriptionKey: "Self deallocated during download"]))
                return
            }

            // 성공/오류에 관계없이 항상 완료 알림 게시
            // ObjC 래퍼는 이를 사용하여 관찰자 정리
            defer {
                NotificationCenter.default.post(name: .downloadDidFinish, object: task)
                // 작업 완료 시 KVO 관찰자 제거 (중요!)
                 DispatchQueue.main.async { // KVO 제거는 관찰자를 추가한 스레드(여기서는 메인 스레드 가정) 또는 안전한 곳에서 수행
                    // downloadTask에서 self에 대한 참조가 더 이상 유효하지 않을 수 있으므로 안전하게 제거
                    // NotificationCenter를 통해 완료를 알리는 것이 더 안전할 수 있음
                    // 또는 downloadTask 객체 자체를 추적하고 완료 시 제거
                     print("[HotUpdaterImpl] Attempting to remove observers post-download.")
                     // downloadTask 인스턴스가 여전히 유효하다면... (캡처 리스트 사용으로 self는 약한 참조)
                     // 이 블록 실행 시점에 downloadTask가 유효하다는 보장은 없음.
                     // NotificationCenter 리스너에서 정리하는 것이 더 견고함.
                     // 아래 두 줄은 ObjC 래퍼에서 Notification을 받고 정리한다고 가정하고 주석 처리하거나 제거할 수 있습니다.
                     // task.removeObserver(self, forKeyPath: #keyPath(URLSessionDownloadTask.countOfBytesReceived), context: nil)
                     // task.removeObserver(self, forKeyPath: #keyPath(URLSessionDownloadTask.countOfBytesExpectedToReceive), context: nil)
                 }
            }


            if let error = error {
                print("[HotUpdaterImpl] Download failed: \(error.localizedDescription)")
                try? self.fileManager.removeItem(atPath: tempDirectory)
                completion(false, error)
                return
            }
            guard let location = location else {
                 let error = NSError(domain: "HotUpdaterError", code: 4, userInfo: [NSLocalizedDescriptionKey: "Download location URL is nil"])
                 try? self.fileManager.removeItem(atPath: tempDirectory)
                 completion(false, error)
                 return
            }

            // --- 다운로드된 파일 이동 ---
             do {
                 try? self.fileManager.removeItem(atPath: tempZipFile)
                 try self.fileManager.moveItem(at: location, to: URL(fileURLWithPath: tempZipFile))
             } catch let moveError {
                 print("[HotUpdaterImpl] Failed to move downloaded file: \(moveError.localizedDescription)")
                 try? self.fileManager.removeItem(atPath: tempDirectory)
                 completion(false, moveError)
                 return
             }
            // --- Zip 압축 해제 ---
            // SSZipArchive.unzipFile은 반환 값이 없는 void 타입이므로 try-catch로 오류 처리
            do {
                try SSZipArchive.unzipFile(atPath: tempZipFile, toDestination: extractedDir, overwrite: true, password: nil)
                
                // 압축 해제 후 디렉토리가 존재하고 내용물이 있는지 확인
                if !self.fileManager.fileExists(atPath: extractedDir) {
                    throw NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "압축 해제 디렉토리가 존재하지 않습니다"])
                }
                
                // 디렉토리 내용물 확인
                let contents = try self.fileManager.contentsOfDirectory(atPath: extractedDir)
                if contents.isEmpty {
                    throw NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "압축 해제된 파일이 없습니다"])
                }
            } catch let unzipError {
                print("[HotUpdaterImpl] 압축 해제 실패: \(unzipError.localizedDescription)")
                let error = NSError(domain: "HotUpdaterError", code: 5, userInfo: [NSLocalizedDescriptionKey: "Failed to unzip file: \(unzipError.localizedDescription)"])
                try? self.fileManager.removeItem(atPath: tempDirectory)
                completion(false, error)
                return
            }

            // --- 추출된 번들 확인 ---
             guard let _ = self.findBundleFile(in: extractedDir) else { // 사용되지 않으므로 _ 사용
                  let error = NSError(domain: "HotUpdaterError", code: 6, userInfo: [NSLocalizedDescriptionKey: "index.ios.bundle or main.jsbundle not found in extracted files"])
                  try? self.fileManager.removeItem(atPath: tempDirectory)
                  completion(false, error)
                  return
             }

            // --- 추출된 파일을 최종 위치로 이동 ---
             do {
                 try? self.fileManager.removeItem(atPath: finalBundleDir)
                 try self.fileManager.moveItem(atPath: extractedDir, toPath: finalBundleDir)
                 try? self.fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
             } catch {
                 print("[HotUpdaterImpl] Move failed, attempting copy: \(error.localizedDescription)")
                 do {
                    try self.fileManager.copyItem(atPath: extractedDir, toPath: finalBundleDir)
                    try self.fileManager.removeItem(atPath: extractedDir) // 복사 성공 후 원본 제거
                    try? self.fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: finalBundleDir)
                 } catch let copyError {
                    print("[HotUpdaterImpl] Copy also failed: \(copyError.localizedDescription)")
                    try? self.fileManager.removeItem(atPath: tempDirectory) // 임시 디렉토리 정리
                    try? self.fileManager.removeItem(atPath: finalBundleDir) // 실패한 최종 디렉토리 정리 시도
                    completion(false, copyError)
                    return
                 }
             }

             // --- 최종 확인 및 설정 ---
             guard let finalBundlePath = self.findBundleFile(in: finalBundleDir) else {
                 let error = NSError(domain: "HotUpdaterError", code: 7, userInfo: [NSLocalizedDescriptionKey: "Bundle file not found in final directory after move/copy"])
                 try? self.fileManager.removeItem(atPath: finalBundleDir) // 문제 발생 시 최종 디렉토리 정리
                 try? self.fileManager.removeItem(atPath: tempDirectory) // 임시 디렉토리 정리
                 completion(false, error)
                 return
             }

            print("[HotUpdaterImpl] Bundle update successful. Path: \(finalBundlePath)")
            self.setBundleURLInternal(localPath: finalBundlePath)
            self.cleanupOldBundles(currentBundleId: bundleId)
            try? self.fileManager.removeItem(atPath: tempDirectory) // 성공 시 임시 디렉토리 정리
            completion(true, nil)
        }
        
        // 이제 다운로드 작업 생성 및 할당
        task = session.downloadTask(with: validZipUrl, completionHandler: downloadCompletionHandler)

        // --- 진행률 보고 설정 ---
        // KVO 또는 NotificationCenter를 사용하여 진행률 업데이트 (ObjC 래퍼가 관찰)
        // 작업 재개 전에 진행률 관찰자 추가

        // options 매개변수에 NSKeyValueObservingOptions.new 명시적으로 지정
        task.addObserver(self, forKeyPath: #keyPath(URLSessionDownloadTask.countOfBytesReceived), options: [NSKeyValueObservingOptions.new], context: nil as UnsafeMutableRawPointer?)
        task.addObserver(self, forKeyPath: #keyPath(URLSessionDownloadTask.countOfBytesExpectedToReceive), options: [NSKeyValueObservingOptions.new], context: nil as UnsafeMutableRawPointer?)
        // 참고: KVO 관찰자는 제거해야 합니다! 이것은 observeValue 또는 작업 완료 시 발생해야 합니다.
        // 여기서는 downloadDidFinish 알림을 사용하여 ObjC 측에서 정리한다고 가정합니다.

        // 다운로드 시작
        task.resume()
    }

    // MARK: - 다운로드 진행률 KVO

    override public func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey : Any]?, context: UnsafeMutableRawPointer?) {

        // <<< FIX for Line 263/264 context check >>>
        // context가 nil인지 확인 (addObserver에서 nil로 설정했으므로)
        guard context == nil else {
             // 우리가 설정하지 않은 다른 컨텍스트의 KVO 알림이면 super 호출
             super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
             return
        }

        guard let task = object as? URLSessionDownloadTask,
              (keyPath == #keyPath(URLSessionDownloadTask.countOfBytesReceived) || keyPath == #keyPath(URLSessionDownloadTask.countOfBytesExpectedToReceive))
        else {
            // 관련 없는 KVO 알림이면 super 호출 (이 경우는 거의 발생하지 않음)
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
            return
        }

        // 0으로 나누는 것을 방지하기 위해 totalBytesExpected > 0 확인
        let totalBytesExpected = task.countOfBytesExpectedToReceive
        let totalBytesReceived = task.countOfBytesReceived

        if totalBytesExpected > 0 {
            let progress = Double(totalBytesReceived) / Double(totalBytesExpected)
            // ObjC 래퍼가 관찰할 알림 게시
            // userInfo에 필요한 값 전달
             let progressInfo: [String: Any] = [
                 "progress": progress,
                 "totalBytesReceived": totalBytesReceived,
                 "totalBytesExpected": totalBytesExpected
             ]
             NotificationCenter.default.post(name: .downloadProgressUpdate, object: task, userInfo: progressInfo)

            // 디버깅 로그 (필요한 경우)
            // print(String(format: "[HotUpdaterImpl] Progress: %.2f%% (%lld / %lld bytes)", progress * 100, totalBytesReceived, totalBytesExpected))

        } else {
            // totalBytesExpected가 0이거나 아직 알 수 없는 경우 (다운로드 시작 전)
            // print("[HotUpdaterImpl] Progress: Waiting for total size...")
             NotificationCenter.default.post(name: .downloadProgressUpdate, object: task, userInfo: ["progress": 0.0, "totalBytesReceived": 0, "totalBytesExpected": 0])
        }

        // KVO 관찰자 제거는 다운로드 완료 핸들러 또는 downloadDidFinish 알림 리스너에서 수행하는 것이 더 안전합니다.
        // 여기서 제거하면 진행 중인 알림이 누락될 수 있습니다.
    }


    // MARK: - 파일 유틸리티 (여기서는 변경 필요 없음)

    private func documentsPath() -> String {
       return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }
    private func bundleStoreDir() -> String {
       return (documentsPath() as NSString).appendingPathComponent("bundle-store")
    }
    private func tempDir() -> String {
        return (documentsPath() as NSString).appendingPathComponent("bundle-temp")
    }
    private func createDir(at path: String) -> Bool {
        do {
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch {
            print("[HotUpdaterImpl] Failed to create directory at \(path): \(error)")
            return false
        }
    }
    private func findBundleFile(in directoryPath: String) -> String? {
        do {
            let items = try fileManager.contentsOfDirectory(atPath: directoryPath)
            // 먼저 'index.ios.bundle'을 찾고, 없으면 'main.jsbundle'을 찾습니다.
            if let bundleFile = items.first(where: { $0 == "index.ios.bundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            } else if let bundleFile = items.first(where: { $0 == "main.jsbundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            }
        } catch {
            print("[HotUpdaterImpl] Error listing directory contents at \(directoryPath): \(error)")
        }
        print("[HotUpdaterImpl] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
        return nil // 찾을 수 없거나 오류 발생 시 nil 반환
    }

    private func cleanupOldBundles(currentBundleId: String?) {
        let storeDir = bundleStoreDir()
        guard let contents = try? fileManager.contentsOfDirectory(atPath: storeDir) else {
             print("[HotUpdaterImpl] Failed to list contents of bundle store directory: \(storeDir)")
            return
        }

        var bundleDirs = [(path: String, modDate: Date)]()

        for item in contents {
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
            var isDir: ObjCBool = false
            // 디렉토리인지 확인하고, 메타데이터를 가져올 수 있는지 확인
            if fileManager.fileExists(atPath: fullPath, isDirectory: &isDir), isDir.boolValue {
                do {
                    let attributes = try fileManager.attributesOfItem(atPath: fullPath)
                    if let modDate = attributes[.modificationDate] as? Date {
                        bundleDirs.append((path: fullPath, modDate: modDate))
                    } else {
                        // 수정 날짜를 가져올 수 없는 경우 오래된 것으로 간주
                        bundleDirs.append((path: fullPath, modDate: .distantPast))
                         print("[HotUpdaterImpl] Warning: Could not get modification date for \(fullPath), treating as old.")
                    }
                } catch {
                     print("[HotUpdaterImpl] Warning: Could not get attributes for \(fullPath): \(error)")
                     bundleDirs.append((path: fullPath, modDate: .distantPast)) // 오류 발생 시 오래된 것으로 간주
                }
            }
        }

        // 최신 수정 날짜 순으로 정렬 (내림차순)
        bundleDirs.sort { $0.modDate > $1.modDate }

        // 유지할 번들 결정 (최대 2개: 현재 사용 중인 번들과 가장 최근 번들)
        var bundlesToKeep = Set<String>()

        // 현재 사용 중인 번들 ID가 있고, 해당 경로가 존재하면 유지 목록에 추가
        if let currentId = currentBundleId, let currentPath = bundleDirs.first(where: { ($0.path as NSString).lastPathComponent == currentId })?.path {
            bundlesToKeep.insert(currentPath)
            print("[HotUpdaterImpl] Keeping current bundle: \(currentId)")
        }

        // 가장 최근에 수정된 번들 유지 (현재 번들과 같을 수도 있음)
        if let latestBundle = bundleDirs.first {
            bundlesToKeep.insert(latestBundle.path)
             print("[HotUpdaterImpl] Keeping latest bundle (by mod date): \((latestBundle.path as NSString).lastPathComponent)")
        }

        // 제거할 번들 결정 (유지 목록에 없는 모든 번들)
        let bundlesToRemove = bundleDirs.filter { !bundlesToKeep.contains($0.path) }

        if bundlesToRemove.isEmpty {
            print("[HotUpdaterImpl] No old bundles to remove.")
        } else {
            print("[HotUpdaterImpl] Found \(bundlesToRemove.count) old bundle(s) to remove.")
        }


        for oldBundle in bundlesToRemove {
            do {
                try fileManager.removeItem(atPath: oldBundle.path)
                print("[HotUpdaterImpl] Removed old bundle: \((oldBundle.path as NSString).lastPathComponent)")
            } catch {
                print("[HotUpdaterImpl] Failed to remove old bundle at \(oldBundle.path): \(error)")
            }
        }
    }
}


// 사용자 정의 알림 이름 (여기서는 변경 필요 없음)
extension Notification.Name {
    static let downloadProgressUpdate = Notification.Name("HotUpdaterDownloadProgressUpdate")
    static let downloadDidFinish = Notification.Name("HotUpdaterDownloadDidFinish")
}

// KVO를 위한 키 경로 (Swift 4+ 필요)
// 이 extension은 URLSessionDownloadTask의 속성을 KVO 가능하게 만듭니다.
// 실제 값은 URLSessionDownloadTask의 인스턴스에서 가져오지만,
// KVO 메커니즘이 작동하려면 @objc dynamic 속성 선언이 필요할 수 있습니다.
extension URLSessionDownloadTask {
    // <<< FIX for Line 381 & 382 >>>
    // 'open override' 추가. 접근 수준(open)과 재정의(override) 명시.
    // 기본 구현을 반환하거나 필요에 따라 0을 반환합니다. KVO 트리거 목적.
    @objc dynamic open override var countOfBytesReceived: Int64 {
        return super.countOfBytesReceived // 기본값 반환 또는 필요시 `return 0` 유지
    }

    @objc dynamic open override var countOfBytesExpectedToReceive: Int64 {
        return super.countOfBytesExpectedToReceive // 기본값 반환 또는 필요시 `return 0` 유지
    }
}