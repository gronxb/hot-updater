// Injected into the existing native test file by run_native_transfer_benchmark.py.
// It uses that suite's filesystem/preferences fixtures and the production downloader.
import Darwin

private struct TransferScenario: Decodable {
    struct Asset: Decodable {
        struct Patch: Decodable { let baseHash: String; let hash: String; let file: String }
        let file: String
        let fileHash: String
        let compression: String?
        let patch: Patch?
    }
    let name: String
    let mode: String
    let manifestHash: String
    let archiveHash: String
    let assets: [String: Asset]
}

struct NativeTransferBenchmark {
    @Test func measuresNativeInstaller() throws {
        let fixtureRoot = Bundle.module.url(forResource: "NativeTransferFixtures", withExtension: nil)!
        let scenarios = try JSONDecoder().decode([TransferScenario].self, from: Data(contentsOf: fixtureRoot.appendingPathComponent("scenarios.json")))
        let downloader = URLSessionDownloadService()
        for scenario in scenarios {
            for round in 0..<5 {
                let root = try makeWorkingDirectory()
                defer { cleanupWorkingDirectory(root) }
                let preferences = InMemoryPreferencesService()
                let baseURL = URL(string: "__BASE_URL__/\(scenario.name)/")!
                let metrics = NativeTransferMetrics(root: root)
                let network = MeasuredNativeDownloadService(downloader: downloader, metrics: metrics)
                if scenario.mode == "ota" {
                    let base = root.appendingPathComponent("bundle-store/benchmark-base")
                    try FileManager.default.createDirectory(at: base.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: fixtureRoot.appendingPathComponent("\(scenario.name)/base"), to: base)
                    try preferences.setItem(base.appendingPathComponent("index.ios.bundle").path, forKey: "HotUpdaterBundleURL")
                }
                #if canImport(HotUpdaterCore)
                let resolver = IOSBuiltInAssetResolver(cacheURL: root.appendingPathComponent("builtin-index.json"))
                if scenario.mode == "builtin" {
                    resolver.use(bundle: try #require(Bundle(url: fixtureRoot.appendingPathComponent("\(scenario.name)/base"))))
                }
                let service = BundleFileStorageService(fileSystem: TestFileSystemService(documentsDirectory: root), downloadService: network,
                    preferences: preferences, isolationKey: testIsolationKey, builtInBundleIdProvider: { "builtin" }, builtInAssetResolver: resolver)
                let descriptors = scenario.assets.mapValues { asset in
                    ChangedAssetDescriptor(fileUrl: baseURL.appendingPathComponent(asset.file), fileHash: asset.fileHash,
                        fileCompression: asset.compression, patch: asset.patch.map { patch in
                            BsdiffPatchDescriptor(algorithm: "bsdiff", baseBundleId: "benchmark-base", baseFileHash: patch.baseHash,
                                patchFileHash: patch.hash, patchUrl: baseURL.appendingPathComponent(patch.file))
                        })
                }
                #else
                let service = BundleFileStorageService(fileSystem: TestFileSystemService(documentsDirectory: root), downloadService: network,
                    decompressService: DecompressService(), preferences: preferences, isolationKey: testIsolationKey, builtInBundleIdProvider: { "builtin" })
                #endif
                let done = DispatchSemaphore(value: 0)
                var failure: Error?
                metrics.start()
                let completion: (Result<Bool, Error>) -> Void = { result in
                    if case .failure(let error) = result { failure = error }
                    metrics.finish()
                    done.signal()
                }
                #if canImport(HotUpdaterCore)
                service.updateBundle(bundleId: "benchmark-target", manifestUrl: baseURL.appendingPathComponent("manifest.json"),
                    manifestFileHash: scenario.manifestHash, assets: descriptors,
                    progressHandler: { metrics.progress($0) }, completion: completion)
                #else
                service.updateBundle(bundleId: "benchmark-target", fileUrl: baseURL.appendingPathComponent("bundle.zip"), fileHash: scenario.archiveHash,
                    manifestUrl: nil, manifestFileHash: nil, changedAssets: nil,
                    progressHandler: { metrics.progress($0) }, completion: completion)
                #endif
                #expect(done.wait(timeout: .now() + 180) == .success)
                if let failure { throw failure }
                for (path, asset) in scenario.assets {
                    #expect(HashUtils.verifyHash(fileURL: root.appendingPathComponent("bundle-store/benchmark-target/\(path)"), expectedHash: asset.fileHash))
                }
                var row = metrics.result()
                row["scenario"] = scenario.name
                row["round"] = round
                row["protocol"] = "__PROTOCOL__"
                print("NATIVE_TRANSFER_RESULT " + String(data: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
            }
        }
    }
}

private final class NativeTransferMetrics {
    private let root: URL
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var started = 0.0
    private var ended = 0.0
    private var manifestFinished = 0.0
    private var firstAssetStarted = 0.0
    private var networkEnded = 0.0
    private var bytes: Int64 = 0
    private var requests = 0
    private var active = 0
    private var maxActive = 0
    private var initialRSS: UInt64 = 0
    private var peakRSS: UInt64 = 0
    private var peakDisk: Int64 = 0
    private var prepared = 0.0
    init(root: URL) { self.root = root }
    private func now() -> Double { ProcessInfo.processInfo.systemUptime }
    func start() {
        initialRSS = residentSize()
        peakRSS = initialRSS
        started = now()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        self.timer = timer
        timer.schedule(deadline: .now(), repeating: .milliseconds(50))
        timer.setEventHandler { self.sample() }
        timer.resume()
    }
    func finish() { sample(); lock.lock(); ended = now(); lock.unlock(); timer?.cancel() }
    func begin(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        requests += 1; active += 1; maxActive = max(maxActive, active)
        if url.lastPathComponent != "manifest.json", firstAssetStarted == 0 { firstAssetStarted = now() }
    }
    func downloaded(_ url: URL, file: URL?) {
        lock.lock(); defer { lock.unlock() }
        if let file, let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize { bytes += Int64(size) }
        active -= 1; networkEnded = now()
        if url.lastPathComponent == "manifest.json" { manifestFinished = networkEnded }
    }
    func progress(_ payload: UpdateProgressPayload) {
        lock.lock(); defer { lock.unlock() }
        if payload.progress >= 0.15 && payload.progress <= 0.2 { prepared = now() }
    }
    private func sample() {
        let rss = residentSize()
        var disk: Int64 = 0
        if let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in enumerator {
                if let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), values.isRegularFile == true { disk += Int64(values.fileSize ?? 0) }
            }
        }
        lock.lock(); peakRSS = max(peakRSS, rss); peakDisk = max(peakDisk, disk); lock.unlock()
    }
    func result() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["elapsedMs": (ended-started)*1000, "preparationMs": manifestFinished > 0 ? max(0, (firstAssetStarted > 0 ? firstAssetStarted : prepared)-manifestFinished)*1000 : 0,
            "postNetworkMs": max(0,ended-networkEnded)*1000, "requests": requests, "bytes": bytes, "maxConcurrentRequests": maxActive,
            "peakStoreAndTempBytes": peakDisk, "initialRSSBytes": initialRSS, "peakRSSBytes": peakRSS]
    }
    private func residentSize() -> UInt64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? UInt64(info.resident_size) : 0
    }
}

private final class MeasuredNativeDownloadService: DownloadService {
    let downloader: URLSessionDownloadService
    let metrics: NativeTransferMetrics
    init(downloader: URLSessionDownloadService, metrics: NativeTransferMetrics) { self.downloader = downloader; self.metrics = metrics }
    func downloadFile(from url: URL, to destination: String, fileSizeHandler: ((Int64) -> Void)?, progressHandler: @escaping (DownloadProgress) -> Void,
                      completion: @escaping (Result<URL, Error>) -> Void) -> URLSessionDownloadTask? {
        metrics.begin(url)
        return downloader.downloadFile(from: url, to: destination, fileSizeHandler: fileSizeHandler, progressHandler: progressHandler) { result in
            self.metrics.downloaded(url, file: try? result.get())
            completion(result)
        }
    }
}
