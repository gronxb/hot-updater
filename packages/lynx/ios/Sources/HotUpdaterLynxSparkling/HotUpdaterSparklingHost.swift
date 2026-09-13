import CryptoKit
import Foundation
import HotUpdaterLynxArtifact
import Lynx
import Sparkling
import SparklingMethod
import UIKit

public struct HotUpdaterSparklingConfiguration {
    public let controller: LynxControllerConfiguration

    public init(
        storeURL: URL,
        runtimeId: String,
        binaryIdentity: String? = nil,
        embeddedDirectory: URL,
        embeddedBundleId: String,
        embeddedManifestDigest: String,
        minimumBundleId: String,
        appVersion: String,
        channel: String,
        cohort: String,
        publicKeyPEM: String? = nil,
        startupResourcePaths: Set<String> = [],
        fingerprintHash: String? = nil
    ) throws {
        let metadataURL = embeddedDirectory.appendingPathComponent(
            "hot-updater-lynx.json"
        )
        let manifestURL = embeddedDirectory.appendingPathComponent(
            "manifest.json"
        )
        let metadata = try JSONDecoder().decode(
            EmbeddedMetadata.self,
            from: Data(contentsOf: metadataURL)
        )
        guard metadata.schemaVersion == 1,
              metadata.runtimeId == runtimeId,
              metadata.platform == "ios",
              metadata.bundleId == embeddedBundleId else {
            throw HotUpdaterSparklingError.invalidEmbeddedArtifact
        }
        let manifest = try Data(contentsOf: manifestURL)
        let digest = SHA256.hash(data: manifest).map {
            String(format: "%02x", $0)
        }.joined()
        guard digest == embeddedManifestDigest,
              !minimumBundleId.isEmpty else {
            throw HotUpdaterSparklingError.invalidEmbeddedArtifact
        }
        let resolvedBinaryIdentity: String
        if let binaryIdentity {
            resolvedBinaryIdentity = binaryIdentity
        } else {
            guard let executable = Bundle.main.executableURL else {
                throw HotUpdaterSparklingError.invalidBinaryIdentity
            }
            resolvedBinaryIdentity = SHA256.hash(
                data: try Data(contentsOf: executable)
            ).map { String(format: "%02x", $0) }.joined()
        }
        controller = LynxControllerConfiguration(
            root: storeURL,
            runtimeId: runtimeId,
            binaryIdentity: resolvedBinaryIdentity,
            embeddedDirectory: embeddedDirectory,
            embeddedBundleId: embeddedBundleId,
            embeddedManifestDigest: embeddedManifestDigest,
            minimumBundleId: minimumBundleId,
            appVersion: appVersion,
            channel: channel,
            cohort: cohort,
            publicKeyPEM: publicKeyPEM,
            startupResourcePaths: startupResourcePaths,
            fingerprintHash: fingerprintHash
        )
    }
}

public typealias HotUpdaterSparklingEventHandler = (
    _ name: String,
    _ details: [String: Any]
) -> Void

public enum HotUpdaterSparklingError: LocalizedError {
    case invalidEmbeddedArtifact
    case invalidBinaryIdentity
    case noDefaultResourceLoader
    case reconstructionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEmbeddedArtifact:
            return "The embedded Lynx artifact does not match the native host"
        case .invalidBinaryIdentity:
            return "The application executable is unavailable"
        case .noDefaultResourceLoader:
            return "Sparkling did not register its default resource loader"
        case .reconstructionFailed(let message):
            return "Managed Lynx generation reconstruction failed: \(message)"
        }
    }
}

private struct EmbeddedMetadata: Decodable {
    let schemaVersion: Int
    let bundleId: String
    let platform: String
    let runtimeId: String
}

/** Owns every Sparkling container in one replaceable native generation. */
public final class HotUpdaterSparklingHost {
    private let configuration: HotUpdaterSparklingConfiguration
    fileprivate let events: HotUpdaterSparklingEventHandler?
    private let fallback: SPKResourceLoaderProtocol
    private var controller: LynxController
    fileprivate var generationEvents: SparklingGenerationEvents
    fileprivate var generationId: String { generationEvents.id }
    private var containers: [ObjectIdentifier: WeakContainer] = [:]
    private var replacing = false
    private var closed = false

    public init(
        configuration: HotUpdaterSparklingConfiguration,
        events: HotUpdaterSparklingEventHandler? = nil
    ) throws {
        precondition(Thread.isMainThread)
        guard let fallback = SPKKit.DIContainer.resolve(
            SPKResourceLoaderProtocol.self
        ) else {
            throw HotUpdaterSparklingError.noDefaultResourceLoader
        }
        self.configuration = configuration
        self.events = events
        self.fallback = fallback
        controller = try LynxController(configuration: configuration.controller)
        generationEvents = SparklingGenerationEvents(sink: events)
    }

    public func makeViewController(
        primary: Bool? = nil
    ) throws -> HotUpdaterSparklingViewController {
        try makeViewControllers(
            count: 1,
            firstPrimary: primary ?? containers.isEmpty
        ).first!
    }

    /** Atomically attaches a primary and its secondaries before publishing membership. */
    public func makeViewControllers(
        count: Int,
        firstPrimary: Bool? = nil
    ) throws -> [HotUpdaterSparklingViewController] {
        requireMainThread()
        guard !closed else {
            throw HotUpdaterSparklingError.reconstructionFailed(
                "The managed Lynx host is closed"
            )
        }
        compactContainers()
        precondition(count > 0, "At least one managed view is required")
        let isPrimary = firstPrimary ?? containers.isEmpty
        precondition(isPrimary == containers.isEmpty,
                     "Create exactly one primary before managed secondary views")
        let created = (0..<count).map { index in
            HotUpdaterSparklingViewController(
                host: self,
                primary: isPrimary && index == 0
            )
        }
        created.forEach {
            containers[ObjectIdentifier($0)] = WeakContainer($0)
            $0.loadViewIfNeeded()
        }
        do {
            try attach(created)
        } catch {
            guard recordGenerationFailure(in: created) else {
                failClosed(
                    created,
                    reason: "failureClassificationFailed",
                    message: error.localizedDescription
                )
                throw error
            }
            let replacement = replaceGeneration(
                reason: "initialAttachFailed",
                retry: true
            )
            if created.allSatisfy({ $0.containerGeneration != nil }) {
                return created
            }
            try replacement.get()
            throw error
        }
        if isPrimary {
            emitGenerationStarted(reason: "initial")
        }
        return created
    }

    /** Captures retired authorities for a nonproduction integration assertion. */
    public func captureDiagnosticAuthorities() -> HotUpdaterSparklingStaleProbe {
        HotUpdaterSparklingStaleProbe(
            authorities: containers.values.compactMap { weakContainer in
                guard let container = weakContainer.value,
                      let generation = container.containerGeneration else {
                    return nil
                }
                return StaleAuthority(
                    controller: generation.controller,
                    context: generation.context,
                    details: details(
                        controller: generation.controller,
                        context: generation.context,
                        generation: generation.events
                    )
                )
            },
            events: events
        )
    }

    fileprivate func remove(_ container: HotUpdaterSparklingViewController) {
        requireMainThread()
        guard containers[ObjectIdentifier(container)] != nil else { return }
        if container.primary {
            vacateGeneration(reason: "primaryRemoved")
            return
        }
        containers.removeValue(forKey: ObjectIdentifier(container))
        container.retire()
    }

    fileprivate func containerDeinitialized(
        _ identifier: ObjectIdentifier,
        primary: Bool,
        contextId: String?
    ) {
        requireMainThread()
        guard containers.removeValue(forKey: identifier) != nil else { return }
        guard primary else { return }
        vacateGeneration(
            reason: "primaryDeinitialized",
            retiredPrimaryContextId: contextId
        )
    }

    fileprivate func reload(
        from generationController: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        requireMainThread()
        let current = generation === generationEvents &&
            controller === generationController &&
            (try? generationController.getState(context)) != nil
        if !current {
            generation.emit("staleReloadRejected", details(
                controller: generationController,
                context: context,
                generation: generation
            ).merging(["code": "STALE_CONTEXT"]) { _, new in new })
        }
        completion(SparklingReloadContract.run(
            closed: closed,
            replacing: replacing,
            current: current,
            error: reloadError
        ) {
            replaceGeneration(reason: "reload", retry: true)
        })
    }

    fileprivate func recover(
        _ message: String,
        from generationController: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents
    ) {
        guard !closed, !replacing else { return }
        guard generation === generationEvents,
              controller === generationController,
              (try? generationController.getState(context)) != nil else {
            generation.emit("staleRecoveryRejected", details(
                controller: generationController,
                context: context,
                generation: generation
            ).merging([
                "code": "STALE_CONTEXT",
                "message": message,
            ]) { _, new in new })
            return
        }
        generation.emit("generationFailed", details(
            controller: generationController,
            context: context,
            generation: generation
        ).merging(["message": message]) { _, new in new })
        let current = containers.values.compactMap(\.value)
        guard recordGenerationFailure(in: current) else {
            failClosed(
                current,
                reason: "failureClassificationFailed",
                message: message
            )
            return
        }
        replaceGeneration(reason: "recovery", retry: true)
    }

    @discardableResult
    private func replaceGeneration(
        reason: String,
        retry: Bool
    ) -> Result<Void, Error> {
        requireMainThread()
        guard !closed else {
            return .failure(reloadError(
                "HOST_CLOSED",
                "The managed Lynx host is closed"
            ))
        }
        guard !replacing else {
            return .failure(reloadError(
                "RELOAD_BUSY",
                "A managed Lynx generation replacement is already running"
            ))
        }
        replacing = true
        defer { replacing = false }
        compactContainers()
        let current = containers.values.compactMap(\.value)
        let generation = generationEvents
        let retired = retirementDetails(
            current,
            reason: reason,
            generation: generation
        )
        generation.beginRetirement(retired)
        do {
            current.forEach { $0.retire() }
            try controller.close()
            generation.finishRetirement(retired)
            try startGeneration()
            do {
                try attach(current)
            } catch {
                let classified = recordGenerationFailure(in: current)
                let retryGeneration = generationEvents
                let retryRetired = retirementDetails(
                    current,
                    reason: "reconstructionRetry",
                    generation: retryGeneration
                )
                retryGeneration.beginRetirement(retryRetired)
                current.forEach { $0.retire() }
                try controller.close()
                retryGeneration.finishRetirement(retryRetired)
                guard classified else {
                    containers.removeAll()
                    closed = true
                    emitReconstructionFailed(
                        retryRetired,
                        reason: "failureClassificationFailed",
                        message: error.localizedDescription
                    )
                    return .failure(reloadError(
                        "RECONSTRUCTION_FAILED",
                        "Managed generation failure could not be durably classified"
                    ))
                }
                guard retry else { throw error }
                try startGeneration()
                try attach(current)
            }
            emitGenerationStarted(reason: reason)
            return .success(())
        } catch {
            _ = recordGenerationFailure(in: current)
            let failedGeneration = generationEvents
            let failedRetired = retirementDetails(
                current,
                reason: "reconstructionFailed",
                generation: failedGeneration
            )
            failedGeneration.beginRetirement(failedRetired)
            current.forEach { $0.retire() }
            try? controller.close()
            failedGeneration.finishRetirement(failedRetired)
            containers.removeAll()
            closed = true
            emitReconstructionFailed(
                failedRetired,
                reason: reason,
                message: error.localizedDescription
            )
            return .failure(reloadError(
                "RECONSTRUCTION_FAILED",
                error.localizedDescription
            ))
        }
    }

    private func reloadError(_ code: String, _ message: String) -> Error {
        LynxPolicyError(code: code, message: message)
    }

    private func attach(
        _ containers: [HotUpdaterSparklingViewController]
    ) throws {
        for container in containers.sorted(by: { $0.primary && !$1.primary }) {
            try container.attach(to: controller, generation: generationEvents)
        }
    }

    public func close() {
        requireMainThread()
        guard !closed else { return }
        closed = true
        let current = containers.values.compactMap(\.value)
        let generation = generationEvents
        let retired = retirementDetails(
            current,
            reason: "close",
            generation: generation
        )
        generation.beginRetirement(retired)
        current.forEach { $0.retire() }
        containers.removeAll()
        try? controller.close()
        generation.finishRetirement(retired)
    }

    deinit {
        assert(Thread.isMainThread)
        if !closed {
            containers.values.compactMap(\.value).forEach { $0.retire() }
            try? controller.close()
        }
    }

    fileprivate func loader(
        controller: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents
    ) -> HotUpdaterSparklingResourceLoader {
        HotUpdaterSparklingResourceLoader(
            controller: controller,
            context: context,
            generation: generation,
            fallback: fallback,
            recover: { [weak self] message in
                self?.recover(
                    message,
                    from: controller,
                    context: context,
                    generation: generation
                )
            }
        )
    }

    private func details(
        controller: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents
    ) -> [String: Any] {
        return [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
        ]
    }

    private func compactContainers() {
        containers = containers.filter { $0.value.value != nil }
    }

    private func recordGenerationFailure(
        in containers: [HotUpdaterSparklingViewController]
    ) -> Bool {
        guard let primary = containers.first(where: \.primary)?
            .containerGeneration else { return false }
        do {
            return try primary.controller.reportFailure(
                primary.context,
                fatal: true,
                allowConfirmed: true
            )
        } catch {
            return false
        }
    }

    private func failClosed(
        _ current: [HotUpdaterSparklingViewController],
        reason: String,
        message: String
    ) {
        let generation = generationEvents
        let retired = retirementDetails(
            current,
            reason: reason,
            generation: generation
        )
        generation.beginRetirement(retired)
        current.forEach { $0.retire() }
        try? controller.close()
        generation.finishRetirement(retired)
        containers.removeAll()
        closed = true
        emitReconstructionFailed(
            retired,
            reason: reason,
            message: message
        )
    }

    private func emitReconstructionFailed(
        _ retired: [String: Any],
        reason: String,
        message: String
    ) {
        events?("generationReconstructionFailed", retired.merging([
            "reason": reason,
            "message": message,
        ]) { _, new in new })
    }

    private func retirementDetails(
        _ current: [HotUpdaterSparklingViewController],
        reason: String,
        generation: SparklingGenerationEvents,
        retiredPrimaryContextId: String? = nil
    ) -> [String: Any] {
        let primaryContextId = current.first(where: \.primary)?.contextId
            ?? retiredPrimaryContextId
        var contextIds = current.compactMap(\.contextId)
        if let retiredPrimaryContextId,
           !contextIds.contains(retiredPrimaryContextId) {
            contextIds.append(retiredPrimaryContextId)
        }
        return [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.id,
            "contextIds": contextIds,
            "primaryContextId": hotUpdaterJSONValue(
                primaryContextId
            ),
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "reason": reason,
        ]
    }

    private func emitGenerationStarted(reason: String) {
        generationEvents.emit("generationStarted", [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generationId,
            "contextIds": containers.values.compactMap(\.value?.contextId),
            "primaryContextId": hotUpdaterJSONValue(
                containers.values.compactMap(\.value)
                    .first(where: \.primary)?.contextId
            ),
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "reason": reason,
        ])
    }

    private func requireMainThread() {
        precondition(Thread.isMainThread,
                     "Managed Lynx generations require the main thread")
    }

    private func startGeneration() throws {
        controller = try LynxController(configuration: configuration.controller)
        generationEvents = SparklingGenerationEvents(sink: events)
    }

    private func vacateGeneration(
        reason: String,
        retiredPrimaryContextId: String? = nil
    ) {
        requireMainThread()
        guard !closed, !replacing else { return }
        replacing = true
        defer { replacing = false }
        compactContainers()
        let current = containers.values.compactMap(\.value)
        let generation = generationEvents
        let retired = retirementDetails(
            current,
            reason: reason,
            generation: generation,
            retiredPrimaryContextId: retiredPrimaryContextId
        )
        generation.beginRetirement(retired)
        current.forEach { $0.retire() }
        containers.removeAll()
        try? controller.close()
        generation.finishRetirement(retired)
        do {
            try startGeneration()
        } catch {
            closed = true
            emitReconstructionFailed(
                retired,
                reason: reason,
                message: error.localizedDescription
            )
        }
    }
}

fileprivate struct StaleAuthority {
    let controller: LynxController
    let context: LynxLaunchContext
    let details: [String: Any]
}

public final class HotUpdaterSparklingStaleProbe {
    private let authorities: [StaleAuthority]
    private let events: HotUpdaterSparklingEventHandler?

    fileprivate init(
        authorities: [StaleAuthority],
        events: HotUpdaterSparklingEventHandler?
    ) {
        self.authorities = authorities
        self.events = events
    }

    public func verifyStaleAuthorities() {
        authorities.forEach { authority in
            let rejected = (try? authority.controller.getState(
                authority.context
            )) == nil
            precondition(rejected, "A retired Lynx context retained authority")
            events?("staleContextRejected", authority.details.merging([
                "code": "STALE_CONTEXT",
            ]) { old, _ in old })
        }
    }
}

private final class WeakContainer {
    weak var value: HotUpdaterSparklingViewController?
    init(_ value: HotUpdaterSparklingViewController) {
        self.value = value
    }
}

public final class HotUpdaterSparklingViewController: UIViewController {
    fileprivate let primary: Bool
    private weak var host: HotUpdaterSparklingHost?
    private var child: UIViewController?
    private var generation: ContainerGeneration?
    fileprivate var containerGeneration: ContainerGeneration? { generation }
    fileprivate var contextId: String? { generation?.context.id }

    fileprivate init(host: HotUpdaterSparklingHost, primary: Bool) {
        self.host = host
        self.primary = primary
        super.init(nibName: nil, bundle: nil)
    }

    public required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
    }

    fileprivate func attach(
        to controller: LynxController,
        generation: SparklingGenerationEvents
    ) throws {
        guard self.generation == nil, child == nil, let host else {
            throw HotUpdaterSparklingError.reconstructionFailed(
                "Container is detached or already bound"
            )
        }
        let context = controller.createContext(primary: primary)
        let loader = host.loader(
            controller: controller,
            context: context,
            generation: generation
        )
        let provider = SPKLynxResourceProvider()
        provider.resourceLoader = loader
        let lifecycle = HotUpdaterSparklingLifecycle(
            controller: controller,
            context: context,
            generation: generation,
            primary: primary,
            recover: { [weak host] message in
                host?.recover(
                    message,
                    from: controller,
                    context: context,
                    generation: generation
                )
            }
        )
        let module = HotUpdaterLynxModuleContext(
            controller: controller,
            launch: context,
            reload: primary ? { [weak host] completion in
                guard let host else {
                    completion(.failure(LynxPolicyError(
                        code: "HOST_CLOSED",
                        message: "The managed Lynx host was released"
                    )))
                    return
                }
                host.reload(
                    from: controller,
                    context: context,
                    generation: generation,
                    completion: completion
                )
            } : nil,
            didConfirm: primary ? { confirmation in
                generation.emit("jsReady", [
                    "processId": ProcessInfo.processInfo.processIdentifier,
                    "generationId": generation.id,
                    "contextId": context.id,
                    "attemptId": controller.attemptId,
                    "bundleId": controller.runningSelection.bundleId,
                    "releaseId": hotUpdaterJSONValue(
                        controller.runningSelection.releaseId
                    ),
                    "confirmation": confirmation.dictionary,
                ])
            } : nil
        )
        let sparkling = SPKContext()
        sparkling.containerLifecycleDelegate = lifecycle
        sparkling.templateProvider = provider
        sparkling.imageFetcher = provider
        sparkling.dynamicComponentFetcher = provider
        sparkling.lynxModule = [NSStringFromClass(HotUpdaterLynx.self): module]
        sparkling.rawViewBuilderBlock = { raw in
            guard let builder = raw as? LynxViewBuilder else { return }
            builder.fetcher = provider
            builder.addLynxResourceProvider(
                LYNX_PROVIDER_TYPE_EXTERNAL_JS,
                provider: provider
            )
        }

        self.generation = ContainerGeneration(
            controller: controller,
            context: context,
            events: generation,
            loader: loader,
            provider: provider,
            lifecycle: lifecycle,
            module: module
        )
        let artifact = try controller.begin(context)

        var url = URLComponents(string: "hybrid://lynxview_page")!
        url.queryItems = [
            URLQueryItem(
                name: "bundle",
                value: "hot-updater:///\(artifact.entry)"
            ),
            URLQueryItem(name: "hide_status_bar", value: "1"),
            URLQueryItem(name: "hide_nav_bar", value: "1"),
        ]
        generation.emit("generationWillEvaluate", [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.id,
            "contextId": context.id,
            "bundleId": artifact.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "attemptId": controller.attemptId,
            "primary": primary,
        ])
        let next = SPKRouter.create(
            withURL: url.string!,
            context: sparkling,
            frame: view.bounds
        )
        child = next
        addChild(next)
        next.view.frame = view.bounds
        view.addSubview(next.view)
        next.didMove(toParent: self)
    }

    fileprivate func retire() {
        guard let generation else { return }
        self.generation = nil
        generation.module.invalidate()
        if let child {
            child.willMove(toParent: nil)
            child.view.removeFromSuperview()
            child.removeFromParent()
            self.child = nil
        }
        generation.controller.destroy(generation.context)
    }

    public func close() {
        host?.remove(self)
    }

    /** Nonproduction integration hook exercising the packaged fatal path. */
    public func triggerFatalFailureForDiagnostics(
        _ message: String = "diagnostic fatal failure"
    ) {
        guard let generation, let host else {
            preconditionFailure("The managed Lynx context is detached")
        }
        let details: [String: Any] = [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.events.id,
            "contextId": generation.context.id,
            "attemptId": generation.controller.attemptId,
            "bundleId": generation.controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                generation.controller.runningSelection.releaseId
            ),
            "message": message,
        ]
        generation.events.emit("runtimeFailed", details)
        host.recover(
            message,
            from: generation.controller,
            context: generation.context,
            generation: generation.events
        )
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        child?.view.frame = view.bounds
    }

    deinit {
        let current = generation
        generation = nil
        if let host {
            host.containerDeinitialized(
                ObjectIdentifier(self),
                primary: primary,
                contextId: current?.context.id
            )
            if !primary, let current {
                current.controller.destroy(current.context)
            }
        } else if let current {
            current.controller.destroy(current.context)
        }
    }
}

fileprivate final class ContainerGeneration {
    let controller: LynxController
    let context: LynxLaunchContext
    let events: SparklingGenerationEvents
    let loader: HotUpdaterSparklingResourceLoader
    let provider: SPKLynxResourceProvider
    let lifecycle: HotUpdaterSparklingLifecycle
    let module: HotUpdaterLynxModuleContext

    init(
        controller: LynxController,
        context: LynxLaunchContext,
        events: SparklingGenerationEvents,
        loader: HotUpdaterSparklingResourceLoader,
        provider: SPKLynxResourceProvider,
        lifecycle: HotUpdaterSparklingLifecycle,
        module: HotUpdaterLynxModuleContext
    ) {
        self.controller = controller
        self.context = context
        self.events = events
        self.loader = loader
        self.provider = provider
        self.lifecycle = lifecycle
        self.module = module
    }
}

private final class HotUpdaterSparklingResource: NSObject,
    SPKResourceProtocol {
    let resourceData: Data?
    init(_ data: Data) { resourceData = data }
}

fileprivate final class HotUpdaterSparklingResourceLoader: NSObject,
    SPKResourceLoaderProtocol {
    private let controller: LynxController
    private let context: LynxLaunchContext
    private let generation: SparklingGenerationEvents
    private let fallback: SPKResourceLoaderProtocol
    private let recover: (String) -> Void

    init(
        controller: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents,
        fallback: SPKResourceLoaderProtocol,
        recover: @escaping (String) -> Void
    ) {
        self.controller = controller
        self.context = context
        self.generation = generation
        self.fallback = fallback
        self.recover = recover
    }

    func loadResource(
        withURL url: URL?,
        completion: @escaping SPKResourceCompletionHandler
    ) -> SPKResourceLoaderTaskProtocol? {
        guard let managed = managedURL(url) else {
            return fallback.loadResource(withURL: url, completion: completion)
        }
        let path = String(managed.path.dropFirst())
        do {
            try generation.resourceOperation {
                let data = try controller.resource(
                    managed.absoluteString,
                    context: context
                )
                let details = resourceDetails(path: path, data: data)
                let event: String
                if path.hasSuffix(".ttf") || path.hasSuffix(".otf") {
                    guard let source = CGDataProvider(data: data as CFData),
                          CGFont(source) != nil else {
                        throw HotUpdaterSparklingError.reconstructionFailed(
                            "Managed font could not be decoded"
                        )
                    }
                    event = "fontLoaded"
                } else {
                    event = "resourceLoaded"
                }
                guard generation.resourceLoaded(
                    event,
                    details: details.merging(["bytes": data.count]) { _, new in new }
                ) else {
                    throw HotUpdaterSparklingError.reconstructionFailed(
                        "Managed resource belongs to a retired generation"
                    )
                }
                if context.primary {
                    try controller.observedResource(path, context: context)
                }
                completion(HotUpdaterSparklingResource(data), nil)
            }
        } catch {
            fail(error)
            completion(nil, error)
        }
        return nil
    }

    func loadImage(
        withURL url: URL?,
        completion: @escaping SPKResourceImageCompletionHandler
    ) -> SPKResourceLoaderTaskProtocol? {
        guard let managed = managedURL(url) else {
            return fallback.loadImage(withURL: url, completion: completion)
        }
        let path = String(managed.path.dropFirst())
        do {
            try generation.resourceOperation {
                let data = try controller.resource(
                    managed.absoluteString,
                    context: context
                )
                let details = resourceDetails(path: path, data: data)
                guard let image = UIImage(data: data) else {
                    throw HotUpdaterSparklingError.reconstructionFailed(
                        "Managed image could not be decoded"
                    )
                }
                guard generation.resourceLoaded(
                    "imageLoaded",
                    details: details.merging(["bytes": data.count]) { _, new in new }
                ) else {
                    throw HotUpdaterSparklingError.reconstructionFailed(
                        "Managed image belongs to a retired generation"
                    )
                }
                if context.primary {
                    try controller.observedResource(path, context: context)
                }
                completion(image, nil)
            }
        } catch {
            fail(error)
            completion(nil, error)
        }
        return nil
    }

    private func managedURL(_ url: URL?) -> URL? {
        guard let url else { return nil }
        if url.scheme == "hot-updater" { return url }
        let root = controller.runningArtifact.directory.path + "/"
        guard url.isFileURL, url.path.hasPrefix(root) else { return nil }
        return URL(
            string: "hot-updater:///" + String(url.path.dropFirst(root.count))
        )
    }

    private func resourceDetails(path: String, data: Data) -> [String: Any] {
        [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "path": path,
            "sha256": SHA256.hash(data: data).map {
                String(format: "%02x", $0)
            }.joined(),
        ]
    }

    private func fail(_ error: Error) {
        generation.emit("resourceFailed", [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "message": error.localizedDescription,
        ])
        DispatchQueue.main.async { [recover] in
            recover(error.localizedDescription)
        }
    }
}

fileprivate final class HotUpdaterSparklingLifecycle: NSObject,
    SPKContainerLifecycleProtocol {
    private let controller: LynxController
    private let context: LynxLaunchContext
    private let generation: SparklingGenerationEvents
    private let primary: Bool
    private let recover: (String) -> Void

    init(
        controller: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents,
        primary: Bool,
        recover: @escaping (String) -> Void
    ) {
        self.controller = controller
        self.context = context
        self.generation = generation
        self.primary = primary
        self.recover = recover
    }

    func containerDidFirstScreen(_ container: SPKContainerProtocol) {
        do {
            guard generation.emit("firstContent", [
                "processId": ProcessInfo.processInfo.processIdentifier,
                "generationId": generation.id,
                "contextId": context.id,
                "attemptId": controller.attemptId,
                "bundleId": controller.runningSelection.bundleId,
                "releaseId": hotUpdaterJSONValue(
                    controller.runningSelection.releaseId
                ),
            ]) else { return }
            if primary {
                try controller.observedContent(context)
            }
        } catch {
            generation.emit("staleContentRejected", [
                "processId": ProcessInfo.processInfo.processIdentifier,
                "generationId": generation.id,
                "contextId": context.id,
                "message": error.localizedDescription,
            ])
        }
    }

    func container(
        _ container: SPKContainerProtocol,
        didLoadFailedWithURL url: URL?,
        error: Error?
    ) {
        fail(error)
    }

    func container(
        _ container: SPKContainerProtocol,
        didRecieveError error: Error?
    ) {
        guard let lynx = error as? LynxError, lynx.isFatal else {
            generation.emit("runtimeWarning", [
                "processId": ProcessInfo.processInfo.processIdentifier,
                "generationId": generation.id,
                "contextId": context.id,
                "attemptId": controller.attemptId,
                "bundleId": controller.runningSelection.bundleId,
                "releaseId": hotUpdaterJSONValue(
                    controller.runningSelection.releaseId
                ),
                "message": error?.localizedDescription ?? "unknown",
            ])
            return
        }
        fail(error)
    }

    private func fail(_ error: Error?) {
        let message = error?.localizedDescription ?? "Lynx startup failed"
        generation.emit("runtimeFailed", [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "message": message,
        ])
        DispatchQueue.main.async { [recover] in recover(message) }
    }
}
