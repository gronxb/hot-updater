import CryptoKit
import Foundation
import HotUpdaterLynxArtifact
import Lynx
import Sparkling
import SparklingMethod
import Sparkling_Router
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
    case navigationUnavailable
    case reconstructionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEmbeddedArtifact:
            return "The embedded Lynx artifact does not match the native host"
        case .invalidBinaryIdentity:
            return "The application executable is unavailable"
        case .noDefaultResourceLoader:
            return "Sparkling did not register its default resource loader"
        case .navigationUnavailable:
            return "The managed Sparkling navigation stack is unavailable"
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

/** Owns one real full-page Sparkling navigation stack and its generation. */
public final class HotUpdaterSparklingHost: NSObject,
    UINavigationControllerDelegate {
    private let configuration: HotUpdaterSparklingConfiguration
    let events: HotUpdaterSparklingEventHandler?
    let eventJournal: SparklingGenerationEventJournal
    private let fallback: SPKResourceLoaderProtocol
    var controller: LynxController
    var generationEvents: SparklingGenerationEvents
    fileprivate var generationId: String { generationEvents.id }
    var pages: [ManagedPage] = []
    private weak var navigationController:
        HotUpdaterSparklingViewController?
    private var transitionInFlight: LynxManagedTransitionAcceptance?
    private var recoveredTerminalEventsEmitted = false
    private var closed = false
    private let launchConfiguration: [String: String]
#if HOT_UPDATER_LYNX_DIAGNOSTICS
    var failNextSecondaryAdmissionForDiagnostics = false
    var holdNextSecondaryAdmissionForDiagnostics = false
    lazy var diagnosticsModuleContext = HotUpdaterLynxDiagnosticsContext(
        host: self
    )
#endif
    private lazy var routerService = HotUpdaterSparklingRouterService(host: self)

    public init(
        configuration: HotUpdaterSparklingConfiguration,
        events: HotUpdaterSparklingEventHandler? = nil,
        launchConfiguration: [String: String] = [:]
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
        self.launchConfiguration = launchConfiguration
        let initialController = try LynxController(
            configuration: configuration.controller
        )
        controller = initialController
        eventJournal = SparklingGenerationEventJournal(
            file: initialController.generationEventJournalURL
        )
        generationEvents = SparklingGenerationEvents(
            journal: eventJournal,
            runtimeId: configuration.controller.runtimeId,
            processId: String(ProcessInfo.processInfo.processIdentifier),
            bundleId: initialController.runningSelection.bundleId,
            releaseId: initialController.runningSelection.releaseId,
            sink: events
        )
        super.init()
        DIProviderRegistry.provider.pipeShared().register(
            RouterService.self,
            scope: .container
        ) { [routerService] in routerService }
        MethodRegistry.global.register(methods: [
            HotUpdaterManagedOpenMethod(host: self),
            HotUpdaterManagedCloseMethod(host: self),
        ])
    }

    public func makeViewController(
        primary: Bool? = nil
    ) throws -> HotUpdaterSparklingViewController {
        requireMainThread()
        guard !closed, navigationController == nil,
              primary != false else {
            throw HotUpdaterSparklingError.navigationUnavailable
        }
        let navigation = HotUpdaterSparklingViewController(host: self)
        navigation.delegate = self
        navigation.setNavigationBarHidden(true, animated: false)
        navigationController = navigation
        let logical = controller.recoveryPages.isEmpty
            ? [LynxManagedLogicalPage(entry: controller.runningArtifact.entry)]
            : controller.recoveryPages
        do {
            try buildStack(logical, in: navigation)
            emitGenerationStarted(reason: logical.count == 1
                ? "initial"
                : "startupRecovery")
            return navigation
        } catch {
            if controller.runningSelection.bundleId
                != configuration.controller.embeddedBundleId {
                recoverReconstruction(
                    logical,
                    navigation: navigation,
                    transitionId: controller.managedTransitionId,
                    message: error.localizedDescription
                )
                if !closed, !pages.isEmpty { return navigation }
            }
            failClosed(
                reason: "initialAttachFailed",
                message: error.localizedDescription
            )
            throw error
        }
    }

    /** Compatibility surface that deliberately forbids split-view pseudo-pages. */
    public func makeViewControllers(
        count: Int,
        firstPrimary: Bool? = nil
    ) throws -> [HotUpdaterSparklingViewController] {
        guard count == 1, firstPrimary != false else {
            throw HotUpdaterSparklingError.reconstructionFailed(
                "Managed Sparkling pages use one native navigation stack"
            )
        }
        return [try makeViewController(primary: true)]
    }

    public var orderedPageEntries: [String] {
        pages.map(\.logical.entry)
    }

    public var topPageEntry: String? {
        pages.last?.logical.entry
    }

    func transition(
        _ trigger: String,
        from generationController: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents,
        completion: @escaping (
            Result<LynxManagedTransitionAcceptance, Error>
        ) -> Void
    ) {
        requireMainThread()
        guard !closed else {
            completion(.failure(reloadError(
                "HOST_CLOSED",
                "The managed Lynx host is closed"
            )))
            return
        }
        guard transitionInFlight == nil else {
            completion(.failure(reloadError(
                "TRANSITION_IN_PROGRESS",
                "A managed transition is already accepted"
            )))
            return
        }
        guard generation === generationEvents,
              controller === generationController,
              pages.first?.generation.context === context,
              (try? generationController.getState(context)) != nil else {
            generation.emit("staleReloadRejected", [
                "code": "STALE_CONTEXT",
                "generationId": generation.id,
                "contextId": context.id,
            ])
            completion(.failure(reloadError(
                "CONTEXT_REJECTED",
                "The requesting Lynx generation is no longer current"
            )))
            return
        }
        let logical = pages.map(\.logical)
        let pendingPages = pages.compactMap { page -> (ManagedPage, String)? in
            guard let attempt = try? controller.pendingPageAttemptId(
                page.generation.context
            ) else { return nil }
            return (page, attempt)
        }
        do {
            let acceptance = try controller.acceptManagedTransition(
                context,
                trigger: trigger,
                stack: logical
            )
            transitionInFlight = acceptance
            pendingPages.forEach { page, pageAttemptId in
                emitPageAttemptTerminal(
                    page,
                    pageAttemptId: pageAttemptId,
                    terminal: "authorized-cancel",
                    reason: "managedTransition",
                    transitionId: acceptance.transitionId
                )
            }
            generation.emit("transitionAccepted", currentStackDetails().merging([
                "processId": String(ProcessInfo.processInfo.processIdentifier),
                "status": acceptance.status,
                "transitionId": acceptance.transitionId,
                "trigger": trigger,
                "generationId": generation.id,
                "contextId": context.id,
                "sourceContextId": context.id,
                "attemptId": controller.attemptId,
                "bundleId": controller.runningSelection.bundleId,
                "releaseId": hotUpdaterJSONValue(
                    controller.runningSelection.releaseId
                ),
                "stack": logical.map(\.entry),
            ]) { _, new in new })
            completion(.success(acceptance))
            DispatchQueue.main.async { [weak self] in
                self?.performAcceptedTransition(
                    acceptance,
                    trigger: trigger,
                    logical: logical
                )
            }
        } catch {
            completion(.failure(error))
        }
    }

    private func performAcceptedTransition(
        _ acceptance: LynxManagedTransitionAcceptance,
        trigger: String,
        logical: [LynxManagedLogicalPage]
    ) {
        requireMainThread()
        guard transitionInFlight == acceptance,
              let navigationController, !closed else { return }
        retireCurrentGeneration(reason: trigger)
        do {
            try startGeneration()
            try buildStack(logical, in: navigationController)
            transitionInFlight = nil
            emitGenerationStarted(
                reason: trigger,
                transitionId: acceptance.transitionId
            )
        } catch {
            recoverReconstruction(
                logical,
                navigation: navigationController,
                transitionId: acceptance.transitionId,
                message: error.localizedDescription
            )
        }
    }

    private func recoverReconstruction(
        _ logical: [LynxManagedLogicalPage],
        navigation: HotUpdaterSparklingViewController,
        transitionId: String?,
        message: String
    ) {
        let mayRetry = controller.runningSelection.bundleId
            != configuration.controller.embeddedBundleId
        do {
            _ = try recordGenerationFailure()
        } catch {
            transitionInFlight = nil
            failClosed(
                reason: "terminalPersistenceFailed",
                message: error.localizedDescription
            )
            return
        }
        retireCurrentGeneration(reason: "reconstructionRecovery")
        guard mayRetry else {
            transitionInFlight = nil
            failClosed(reason: "embeddedFailure", message: message)
            return
        }
        do {
            try startGeneration()
            try buildStack(logical, in: navigation)
            transitionInFlight = nil
            emitGenerationStarted(
                reason: "recovery",
                transitionId: transitionId
            )
        } catch {
            transitionInFlight = nil
            failClosed(
                reason: "reconstructionFailed",
                message: error.localizedDescription
            )
        }
    }

    fileprivate func open(
        rawRoute: String,
        options: HotUpdaterSparklingOpenOptions,
        source: PipeContainer
    ) throws {
        requireMainThread()
        guard !closed, transitionInFlight == nil,
              let navigationController else {
            throw HotUpdaterSparklingNavigationError.staleSource
        }
        guard let sourcePage = managedPage(for: source),
              sourcePage === pages.last,
              sourcePage.generation.events === generationEvents,
              sourcePage.generation.controller === controller else {
            throw HotUpdaterSparklingNavigationError.staleSource
        }
        try openAuthorized(
            rawRoute: rawRoute,
            options: options,
            sourcePage: sourcePage,
            navigationController: navigationController
        )
    }

    private func openAuthorized(
        rawRoute: String,
        options: HotUpdaterSparklingOpenOptions,
        sourcePage: ManagedPage,
        navigationController: HotUpdaterSparklingViewController
    ) throws {
        guard sourcePage === pages.last,
              sourcePage.generation.events === generationEvents,
              sourcePage.generation.controller === controller else {
            throw HotUpdaterSparklingNavigationError.staleSource
        }
        let route = try HotUpdaterSparklingRouteParser.parse(
            rawRoute,
            allowlistedEntries: Set(controller.runningArtifact.pageEntries)
        )
        let logical = LynxManagedLogicalPage(
            entry: route.entry,
            parameters: route.parameters.map {
                .init(name: $0.name, value: $0.value)
            }
        )
        let stack = pages.map(\.logical) + [logical]
        try HotUpdaterSparklingStackContract.validatePageCount(stack.count)
        let page: ManagedPage
        do {
            page = try buildPage(
                logical,
                primary: false,
                stack: stack
            )
        } catch let error as ManagedPageConstructionError {
            recoverReconstruction(
                stack,
                navigation: navigationController,
                transitionId: controller.managedTransitionId,
                message: error.localizedDescription
            )
            throw error
        }
        pages.append(page)
        do {
            try activate(page)
            navigationController.pushViewController(
                page.container,
                animated: options.animated
            )
            emitStack("pageOpened", page: page)
        } catch {
            throw error
        }
    }

#if HOT_UPDATER_LYNX_DIAGNOSTICS
    public func exerciseNavigationStackBoundaryForDiagnostics() throws
        -> [String: Any] {
        requireMainThread()
        let before = currentStackDetails()
        var acceptedDepths: [Int] = []
        var acceptedContextIds: [String] = []
        let route = "hybrid://lynxview_page?bundle=detail.lynx.bundle"
        let options = try HotUpdaterSparklingOpenOptions(
            replace: false,
            useSystemBrowser: false,
            animated: false
        )
        while pages.count
                < HotUpdaterSparklingStackContract.maximumPageCount {
            guard let source = pages.last, let navigationController else {
                throw HotUpdaterSparklingError.navigationUnavailable
            }
            try openAuthorized(
                rawRoute: route,
                options: options,
                sourcePage: source,
                navigationController: navigationController
            )
            acceptedDepths.append(pages.count)
            acceptedContextIds.append(
                pages.last!.generation.context.id
            )
        }
        let beforeRejected = currentStackDetails()
        let nativeBeforeRejected = navigationController?.viewControllers.count
            ?? 0
        let rejectionCode: String
        do {
            guard let navigationController else {
                throw HotUpdaterSparklingError.navigationUnavailable
            }
            try openAuthorized(
                rawRoute: route,
                options: options,
                sourcePage: pages.last!,
                navigationController: navigationController
            )
            rejectionCode = "MISSING_REJECTION"
        } catch {
            rejectionCode = "STACK_LIMIT_EXCEEDED"
        }
        return [
            "acceptedDepths": acceptedDepths,
            "acceptedContextIds": acceptedContextIds,
            "rejectionCode": rejectionCode,
            "before": before,
            "beforeRejected": beforeRejected,
            "afterRejected": currentStackDetails(),
            "nativeDepthBeforeRejected": nativeBeforeRejected,
            "nativeDepthAfterRejected": navigationController?
                .viewControllers.count ?? 0,
        ]
    }
#endif

    fileprivate func close(
        source: PipeContainer,
        requestedContainerId: String?,
        animated: Bool
    ) throws {
        requireMainThread()
        guard !closed, transitionInFlight == nil,
              let navigationController,
              let page = managedPage(for: source),
              page === pages.last,
              !page.primary,
              page.generation.events === generationEvents,
              page.generation.controller === controller else {
            throw HotUpdaterSparklingNavigationError.staleSource
        }
        try HotUpdaterSparklingStackContract.authorizeTop(
            sourceContextId: page.generation.context.id,
            requestedContainerId: requestedContainerId,
            topContextId: page.generation.context.id,
            topContainerId: source.spk_containerID ?? page.container.containerID
        )
        let cancelled = try controller.cancelPage(
            page.generation.context,
            reason: .sparklingClose
        )
        guard navigationController.popViewController(animated: animated)
                === page.container else {
            throw HotUpdaterSparklingError.navigationUnavailable
        }
        pages.removeLast()
        if cancelled, let pageAttemptId = page.pageAttemptId {
            emitPageAttemptTerminal(
                page,
                pageAttemptId: pageAttemptId,
                terminal: "authorized-cancel",
                reason: "sparklingClose"
            )
        }
        emitStack("pageClosed", page: page)
        retire(page)
    }

    public func navigationController(
        _ navigationController: UINavigationController,
        didShow viewController: UIViewController,
        animated: Bool
    ) {
        requireMainThread()
        guard !closed, transitionInFlight == nil else { return }
        let live = Set(
            navigationController.viewControllers.map(ObjectIdentifier.init)
        )
        let removed = pages.filter {
            !live.contains(ObjectIdentifier($0.container))
        }
        guard !removed.isEmpty else { return }
        for page in removed.reversed() {
            guard page === pages.last, !page.primary else {
                failClosed(
                    reason: "invalidNativeBack",
                    message: "Native navigation removed a non-top managed page"
                )
                return
            }
            do {
                let cancelled = try controller.cancelPage(
                    page.generation.context,
                    reason: .nativeBack
                )
                pages.removeLast()
                if cancelled, let pageAttemptId = page.pageAttemptId {
                    emitPageAttemptTerminal(
                        page,
                        pageAttemptId: pageAttemptId,
                        terminal: "authorized-cancel",
                        reason: "nativeBack"
                    )
                }
            } catch {
                failClosed(
                    reason: "pageCancellationFailed",
                    message: error.localizedDescription
                )
                return
            }
            emitStack("nativeBack", page: page)
            retire(page)
        }
    }

    func pageFailed(
        _ failure: ManagedPageFailure,
        controller generationController: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents
    ) {
        requireMainThread()
        guard !closed, transitionInFlight == nil,
              generation === generationEvents,
              generationController === controller,
              let page = pages.first(where: {
                  $0.generation.context === context
              }) else {
            generation.emit("staleRecoveryRejected", [
                "code": "STALE_CONTEXT",
                "generationId": generation.id,
                "contextId": context.id,
                "message": failure.message,
            ])
            return
        }
        let pendingPages = pages.compactMap { candidate -> (ManagedPage, String)? in
            guard let attempt = try? controller.pendingPageAttemptId(
                candidate.generation.context
            ) else { return nil }
            return (candidate, attempt)
        }
        let classified: Bool
        do {
            if page.primary {
                classified = try controller.reportFailure(
                    context,
                    fatal: true
                )
            } else {
                classified = try controller.reportPageFailure(
                    context,
                    failureCode: failure.code,
                    failureResourcePath: failure.resourcePath
                )
            }
        } catch {
            failClosed(
                reason: "terminalPersistenceFailed",
                message: error.localizedDescription
            )
            return
        }
        guard classified, let navigationController else {
            generation.emit("runtimeWarning", details(for: page).merging([
                "message": failure.message,
            ]) { _, new in new })
            return
        }
        pendingPages.forEach { candidate, pageAttemptId in
            emitPageAttemptTerminal(
                candidate,
                pageAttemptId: pageAttemptId,
                terminal: "verified-fatal",
                reason: "verifiedFatal",
                failure: candidate === page ? failure : nil
            )
        }
        generation.emit("generationFailed", details(for: page).merging([
            "message": failure.message,
        ]) { _, new in new })
        let logical = pages.map(\.logical)
        recoverReconstruction(
            logical,
            navigation: navigationController,
            transitionId: controller.managedTransitionId,
            message: failure.message
        )
    }

    private func buildStack(
        _ logical: [LynxManagedLogicalPage],
        in navigation: HotUpdaterSparklingViewController
    ) throws {
        try HotUpdaterSparklingStackContract.validateReconstruction(
            logical.map {
                .init(
                    entry: $0.entry,
                    parameters: $0.parameters.map {
                        .init(name: $0.name, value: $0.value)
                    }
                )
            },
            allowlistedEntries: Set(controller.runningArtifact.pageEntries)
        )
        guard logical.first?.entry == controller.runningArtifact.entry else {
            throw HotUpdaterSparklingError.reconstructionFailed(
                "The primary page does not match the selected artifact entry"
            )
        }
        pages = []
        for (index, page) in logical.enumerated() {
            let managed = try buildPage(
                page,
                primary: index == 0,
                stack: Array(logical.prefix(index + 1))
            )
            pages.append(managed)
            do {
                try activate(managed)
            } catch {
                let failure = (error as? ManagedPageFailure)
                    ?? ManagedPageFailure(error: error)
                if managed.primary {
                    _ = try controller.reportFailure(
                        managed.generation.context,
                        fatal: true,
                        allowConfirmed: true
                    )
                } else {
                    let pendingPages = pages.compactMap {
                        candidate -> (ManagedPage, String)? in
                        guard let attempt = try? controller.pendingPageAttemptId(
                            candidate.generation.context
                        ) else { return nil }
                        return (candidate, attempt)
                    }
                    if try controller.reportPageFailure(
                        managed.generation.context,
                        failureCode: failure.code,
                        failureResourcePath: failure.resourcePath
                    ) {
                        pendingPages.forEach { candidate, pageAttemptId in
                            emitPageAttemptTerminal(
                                candidate,
                                pageAttemptId: pageAttemptId,
                                terminal: "verified-fatal",
                                reason: "verifiedFatal",
                                failure: candidate === managed
                                    ? failure
                                    : nil
                            )
                        }
                        generationEvents.emit(
                            "generationFailed",
                            details(for: managed).merging([
                                "message": failure.message,
                            ]) { _, new in new }
                        )
                    }
                }
                throw error
            }
        }
        navigation.setViewControllers(
            pages.map(\.container),
            animated: false
        )
    }

    private func buildPage(
        _ logical: LynxManagedLogicalPage,
        primary: Bool,
        stack: [LynxManagedLogicalPage]
    ) throws -> ManagedPage {
        let generationController = controller
        let generation = generationEvents
        let context = generationController.createContext(primary: primary)
        let artifact = try generationController.begin(
            context,
            pageEntry: logical.entry,
            generationId: generation.id,
            stack: stack
        )
        let pageAttemptId = try generationController.pendingPageAttemptId(
            context
        )
        let loader = HotUpdaterSparklingResourceLoader(
            controller: generationController,
            context: context,
            pageEntry: logical.entry,
            generation: generation,
            fallback: fallback,
            failed: { [weak self] failure in
                self?.pageFailed(
                    failure,
                    controller: generationController,
                    context: context,
                    generation: generation
                )
            }
        )
        let provider = SPKLynxResourceProvider()
        provider.resourceLoader = loader
#if HOT_UPDATER_LYNX_DIAGNOSTICS
        let failAfterFirstContent = !primary
            && failNextSecondaryAdmissionForDiagnostics
        if failAfterFirstContent {
            failNextSecondaryAdmissionForDiagnostics = false
        }
        let holdAppReady = !primary
            && holdNextSecondaryAdmissionForDiagnostics
        if holdAppReady {
            holdNextSecondaryAdmissionForDiagnostics = false
        }
#endif
        let pageFailureHandler: (ManagedPageFailure) -> Void = {
            [weak self] failure in
            self?.pageFailed(
                failure,
                controller: generationController,
                context: context,
                generation: generation
            )
        }
#if HOT_UPDATER_LYNX_DIAGNOSTICS
        let lifecycle = HotUpdaterSparklingLifecycle(
            controller: generationController,
            context: context,
            pageEntry: logical.entry,
            generation: generation,
            failAfterFirstContentForDiagnostics: failAfterFirstContent,
            failed: pageFailureHandler
        )
#else
        let lifecycle = HotUpdaterSparklingLifecycle(
            controller: generationController,
            context: context,
            pageEntry: logical.entry,
            generation: generation,
            failed: pageFailureHandler
        )
#endif
        let module = HotUpdaterLynxModuleContext(
            controller: generationController,
            launch: context,
            transition: primary ? { [weak self] trigger, completion in
                guard let self else {
                    completion(.failure(LynxPolicyError(
                        code: "HOST_CLOSED",
                        message: "The managed Lynx host was released"
                    )))
                    return
                }
                self.transition(
                    trigger,
                    from: generationController,
                    context: context,
                    generation: generation,
                    completion: completion
                )
            } : nil,
            didConfirm: { [weak self] confirmation in
                guard let self else { return }
                let pageDetails = self.pages.first(where: {
                    $0.generation.context === context
                }).map(self.details(for:)) ?? self.baseDetails(
                    controller: generationController,
                    context: context,
                    generation: generation,
                    pageEntry: logical.entry,
                    pageAttemptId: pageAttemptId
                )
                if !primary, confirmation.status == "PAGE_ADMITTED",
                   let page = self.pages.first(where: {
                       $0.generation.context === context
                   }), let pageAttemptId {
                    self.emitPageAttemptTerminal(
                        page,
                        pageAttemptId: pageAttemptId,
                        terminal: "admitted",
                        reason: "admission"
                    )
                }
                generation.emit(
                    primary ? "jsReady" : "pageAdmitted",
                    pageDetails.merging([
                        "confirmation": confirmation.dictionary,
                        "transitionId": hotUpdaterJSONValue(
                            confirmation.transitionId
                        ),
                    ]) { _, new in new }
                )
            },
            appReady: { completion in
#if HOT_UPDATER_LYNX_DIAGNOSTICS
                guard !holdAppReady else { return }
#endif
                generationController.notifyAppReady(
                    context,
                    completion: completion
                )
            },
            runtimeEvents: { [eventJournal] in
                try eventJournal.snapshot()
            },
            launchConfiguration: HotUpdaterSparklingPageLaunchConfiguration
                .merge(
                    host: launchConfiguration,
                    page: logical.parameters
                )
        )
        let sparkling = SPKContext()
        sparkling.containerLifecycleDelegate = lifecycle
        sparkling.templateProvider = provider
        sparkling.imageFetcher = provider
        sparkling.dynamicComponentFetcher = provider
        var lynxModules: [String: Any] = [
            NSStringFromClass(HotUpdaterLynx.self): module,
        ]
#if HOT_UPDATER_LYNX_DIAGNOSTICS
        lynxModules[NSStringFromClass(HotUpdaterLynxDiagnostics.self)] =
            diagnosticsModuleContext
#endif
        sparkling.lynxModule = lynxModules
        sparkling.rawViewBuilderBlock = { raw in
            guard let builder = raw as? LynxViewBuilder else { return }
            builder.fetcher = provider
            builder.addLynxResourceProvider(
                LYNX_PROVIDER_TYPE_EXTERNAL_JS,
                provider: provider
            )
            builder.addLynxResourceProvider(
                LYNX_PROVIDER_TYPE_FONT,
                provider: provider
            )
        }
        let url = trustedURL(logical)
        guard let container = SPKRouter.create(
            withURL: url,
            context: sparkling,
            frame: navigationController?.view.bounds ?? UIScreen.main.bounds
        ) as? SPKViewController else {
            let failure = ManagedPageFailure(
                message: "Sparkling did not create an SPKViewController"
            )
            if primary {
                _ = try generationController.reportFailure(
                    context,
                    fatal: true,
                    allowConfirmed: true
                )
            } else {
                if try generationController.reportPageFailure(
                    context,
                    failureCode: nil,
                    failureResourcePath: nil
                ), let pageAttemptId {
                    var details = baseDetails(
                        controller: generationController,
                        context: context,
                        generation: generation,
                        pageEntry: logical.entry,
                        pageAttemptId: pageAttemptId
                    ).merging([
                        "sourceContextId": context.id,
                        "orderedPageEntries": stack.map(\.entry),
                        "orderedPageParameters": orderedParameters(stack),
                        "topPageEntry": hotUpdaterJSONValue(stack.last?.entry),
                        "topContextId": context.id,
                        "terminal": "verified-fatal",
                        "reason": "verifiedFatal",
                        "message": failure.message,
                    ]) { _, new in new }
                    details["transitionId"] = hotUpdaterJSONValue(
                        generationController.managedTransitionId
                    )
                    generation.emit("pageAttemptTerminal", details)
                    generation.emit("generationFailed", details)
                }
            }
            throw ManagedPageConstructionError(message: failure.message)
        }
        generation.emit("generationWillEvaluate", baseDetails(
            controller: generationController,
            context: context,
            generation: generation,
            pageEntry: logical.entry
        ).merging([
            "primary": primary,
            "pageClass": NSStringFromClass(type(of: container)),
            "nativePageClass": NSStringFromClass(type(of: container)),
            "containerClass": NSStringFromClass(type(of: container)),
            "sourceContextId": context.id,
            "orderedPageEntries": stack.map(\.entry),
            "orderedPageParameters": orderedParameters(stack),
            "topPageEntry": hotUpdaterJSONValue(stack.last?.entry),
            "essentialResources": artifact.essentialResources(
                for: logical.entry
            ) ?? [],
        ]) { _, new in new })
        return ManagedPage(
            logical: logical,
            primary: primary,
            pageAttemptId: pageAttemptId,
            container: container,
            generation: .init(
                controller: generationController,
                context: context,
                events: generation,
                loader: loader,
                provider: provider,
                lifecycle: lifecycle,
                module: module
            )
        )
    }

    private func activate(_ page: ManagedPage) throws {
        guard let declaredResources = controller.runningArtifact.essentialResources(
            for: page.logical.entry
        ) else {
            throw HotUpdaterSparklingError.reconstructionFailed(
                "The page has no essential resource descriptor"
            )
        }
        let resources = controller.runningArtifact.hasManagedPageMetadata
            ? declaredResources
            : configuration.controller.startupResourcePaths.sorted {
                $0.utf16.lexicographicallyPrecedes($1.utf16)
            }
        for resource in resources {
            try page.generation.loader.resolveEssential(resource)
        }
        page.container.loadViewIfNeeded()
    }

    private func trustedURL(_ logical: LynxManagedLogicalPage) -> String {
        var components = URLComponents()
        components.scheme = "hybrid"
        components.host = "lynxview_page"
        components.queryItems = [
            URLQueryItem(
                name: "bundle",
                value: "hot-updater:///\(logical.entry)"
            ),
            URLQueryItem(name: "hide_status_bar", value: "1"),
            URLQueryItem(name: "hide_nav_bar", value: "1"),
        ] + logical.parameters.map {
            URLQueryItem(name: $0.name, value: $0.value)
        }
        return components.string!
    }

    private func managedPage(for source: PipeContainer) -> ManagedPage? {
        let sourceObject = source as AnyObject
        return pages.first { page in
            guard let pipe = page.container.kitView as? PipeContainer else {
                return false
            }
            return pipe as AnyObject === sourceObject
        }
    }

    private func retireCurrentGeneration(reason: String) {
        let generation = generationEvents
        let retired = retirementDetails(reason: reason)
        generation.beginRetirement(retired)
        navigationController?.setViewControllers([], animated: false)
        pages.reversed().forEach(retire)
        pages = []
        try? controller.close()
        generation.finishRetirement(retired)
    }

    private func retire(_ page: ManagedPage) {
        page.generation.module.invalidate()
        page.generation.controller.destroy(page.generation.context)
    }

    private func recordGenerationFailure() throws -> Bool {
        guard let page = pages.last else { return false }
        if page.primary {
            return try controller.reportFailure(
                page.generation.context,
                fatal: true,
                allowConfirmed: true
            )
        }
        return try controller.reportPageFailure(
            page.generation.context
        )
    }

    private func startGeneration() throws {
        controller = try LynxController(configuration: configuration.controller)
        recoveredTerminalEventsEmitted = false
        generationEvents = SparklingGenerationEvents(
            journal: eventJournal,
            runtimeId: configuration.controller.runtimeId,
            processId: String(ProcessInfo.processInfo.processIdentifier),
            bundleId: controller.runningSelection.bundleId,
            releaseId: controller.runningSelection.releaseId,
            sink: events
        )
    }

    private func reloadError(_ code: String, _ message: String) -> Error {
        LynxPolicyError(code: code, message: message)
    }

    private func baseDetails(
        controller: LynxController,
        context: LynxLaunchContext,
        generation: SparklingGenerationEvents,
        pageEntry: String,
        pageAttemptId: String? = nil
    ) -> [String: Any] {
        [
            "runtimeId": configuration.controller.runtimeId,
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "pageAttemptId": hotUpdaterJSONValue(
                pageAttemptId ?? (try? controller.pendingPageAttemptId(context))
            ),
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "pageEntry": pageEntry,
            "transitionId": hotUpdaterJSONValue(
                controller.managedTransitionId
            ),
        ]
    }

    func details(for page: ManagedPage) -> [String: Any] {
        let nativePageClass = NSStringFromClass(type(of: page.container))
        return baseDetails(
            controller: page.generation.controller,
            context: page.generation.context,
            generation: page.generation.events,
            pageEntry: page.logical.entry,
            pageAttemptId: page.pageAttemptId
        ).merging([
            "pageClass": nativePageClass,
            "nativePageClass": nativePageClass,
            "containerClass": nativePageClass,
            "containerId": page.container.containerID,
            "sourceContextId": page.generation.context.id,
            "parameters": Dictionary(
                uniqueKeysWithValues: page.logical.parameters.map {
                    ($0.name, $0.value)
                }
            ),
            "orderedParameters": page.logical.parameters.map {
                ["name": $0.name, "value": $0.value]
            },
        ]) { _, new in new }
    }

    private func orderedParameters(
        _ logical: [LynxManagedLogicalPage]
    ) -> [[[String: String]]] {
        logical.map { page in
            page.parameters.map { parameter in
                ["name": parameter.name, "value": parameter.value]
            }
        }
    }

    private func currentStackDetails() -> [String: Any] {
        [
            "orderedPageEntries": pages.map(\.logical.entry),
            "orderedPageParameters": orderedParameters(
                pages.map(\.logical)
            ),
            "topPageEntry": hotUpdaterJSONValue(pages.last?.logical.entry),
            "topContextId": hotUpdaterJSONValue(
                pages.last?.generation.context.id
            ),
        ]
    }

    private func retirementDetails(reason: String) -> [String: Any] {
        [
            "runtimeId": configuration.controller.runtimeId,
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "generationId": generationId,
            "contextIds": pages.map { $0.generation.context.id },
            "primaryContextId": hotUpdaterJSONValue(
                pages.first?.generation.context.id
            ),
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "contextId": NSNull(),
            "pageAttemptId": NSNull(),
            "orderedPageEntries": pages.map(\.logical.entry),
            "orderedPageParameters": orderedParameters(
                pages.map(\.logical)
            ),
            "topPageEntry": hotUpdaterJSONValue(pages.last?.logical.entry),
            "reason": reason,
            "transitionId": hotUpdaterJSONValue(
                controller.managedTransitionId
            ),
        ]
    }

    private func emitGenerationStarted(
        reason: String,
        transitionId: String? = nil
    ) {
        if !recoveredTerminalEventsEmitted {
            recoveredTerminalEventsEmitted = true
            controller.recoveredPageAttemptTerminals.forEach { record in
                var details = record
                details["sourceContextId"] = record["contextId"] ?? NSNull()
                details["topContextId"] = record["contextId"] ?? NSNull()
                details["topPageEntry"] = record["pageEntry"] ?? NSNull()
                guard let pageAttemptId = record["pageAttemptId"] as? String
                else { return }
                _ = generationEvents.replayRecoveredPageAttemptTerminal(
                    pageAttemptId: pageAttemptId,
                    details: details
                ) {
                    try controller.markRecoveredPageAttemptTerminalEmitted(
                        pageAttemptId
                    )
                }
            }
        }
        guard let primary = pages.first else { return }
        generationEvents.emit("generationStarted", details(for: primary).merging(
            currentStackDetails()
        ) { _, new in new }.merging([
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "generationId": generationId,
            "contextIds": pages.map { $0.generation.context.id },
            "primaryContextId": hotUpdaterJSONValue(
                pages.first?.generation.context.id
            ),
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "pageClasses": pages.map {
                NSStringFromClass(type(of: $0.container))
            },
            "nativePageClasses": pages.map {
                NSStringFromClass(type(of: $0.container))
            },
            "reason": reason,
            "transitionId": hotUpdaterJSONValue(
                transitionId ?? controller.managedTransitionId
            ),
        ]) { _, new in new })
    }

    private func emitStack(_ name: String, page: ManagedPage) {
        let outcome: String
        switch name {
        case "pageOpened": outcome = "opened"
        case "pageClosed": outcome = "closed"
        case "nativeBack": outcome = "nativeBack"
        default: outcome = name
        }
        var pageDetails = details(for: page)
        if name == "pageClosed" || name == "nativeBack" {
            pageDetails["transitionId"] = NSNull()
        }
        generationEvents.emit(
            name,
            pageDetails.merging(
                currentStackDetails().merging([
                    "outcome": outcome,
                ]) { _, new in new }
            ) { _, new in new }
        )
    }

    private func emitPageAttemptTerminal(
        _ page: ManagedPage,
        pageAttemptId: String,
        terminal: String,
        reason: String,
        transitionId: String? = nil,
        failure: ManagedPageFailure? = nil
    ) {
        var terminalDetails = details(for: page).merging(
            currentStackDetails()
        ) { _, new in new }
        terminalDetails["pageAttemptId"] = pageAttemptId
        terminalDetails["terminal"] = terminal
        terminalDetails["reason"] = reason
        terminalDetails["transitionId"] = hotUpdaterJSONValue(
            reason == "sparklingClose" || reason == "nativeBack"
                ? nil
                : transitionId
                    ?? page.generation.controller.managedTransitionId
        )
        if let code = failure?.code {
            terminalDetails["failureCode"] = code
        }
        if let path = failure?.resourcePath {
            terminalDetails["failureResourcePath"] = path
        }
        if let message = failure?.message {
            terminalDetails["message"] = message
        }
        generationEvents.emit("pageAttemptTerminal", terminalDetails)
    }

    private func failClosed(reason: String, message: String) {
        guard !closed else { return }
        let details = retirementDetails(reason: reason)
        var failure = details.merging([
            "message": message,
        ]) { _, new in new }
        do {
            failure.merge(
                try controller.recordManagedFailClosed(
                    reason: reason,
                    message: message,
                    stack: pages.map(\.logical)
                )
            ) { old, _ in old }
        } catch {
            failure["persistenceError"] = error.localizedDescription
        }
        retireCurrentGeneration(reason: reason)
        closed = true
        if eventJournal.append(
            name: "generationReconstructionFailed",
            details: failure
        ) {
            events?("generationReconstructionFailed", failure)
        }
    }

    public func close() {
        requireMainThread()
        guard !closed else { return }
        retireCurrentGeneration(reason: "close")
        closed = true
        navigationController?.delegate = nil
        navigationController = nil
    }

    private func requireMainThread() {
        precondition(
            Thread.isMainThread,
            "Managed Lynx navigation requires the main thread"
        )
    }

    deinit {
        assert(Thread.isMainThread)
        if !closed {
            pages.reversed().forEach(retire)
            try? controller.close()
        }
    }
}

public final class HotUpdaterSparklingViewController: UINavigationController {
    private weak var managedHost: HotUpdaterSparklingHost?

    fileprivate init(host: HotUpdaterSparklingHost) {
        managedHost = host
        super.init(nibName: nil, bundle: nil)
    }

    public required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    public func close() {
        managedHost?.close()
    }
}

final class ManagedPage {
    let logical: LynxManagedLogicalPage
    let primary: Bool
    let pageAttemptId: String?
    let container: SPKViewController
    let generation: ContainerGeneration

    init(
        logical: LynxManagedLogicalPage,
        primary: Bool,
        pageAttemptId: String?,
        container: SPKViewController,
        generation: ContainerGeneration
    ) {
        self.logical = logical
        self.primary = primary
        self.pageAttemptId = pageAttemptId
        self.container = container
        self.generation = generation
    }
}

final class ContainerGeneration {
    let controller: LynxController
    let context: LynxLaunchContext
    let events: SparklingGenerationEvents
    fileprivate let loader: HotUpdaterSparklingResourceLoader
    fileprivate let provider: SPKLynxResourceProvider
    fileprivate let lifecycle: HotUpdaterSparklingLifecycle
    fileprivate let module: HotUpdaterLynxModuleContext

    fileprivate init(
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

private struct ManagedPageConstructionError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private enum HotUpdaterManagedMethodParameters {
    static func validateOpen(_ values: [AnyHashable: Any]) throws {
        let keys = try stringKeys(values)
        let allowed: Set<String> = [
            "animated", "replace", "scheme", "useSysBrowser",
        ]
        guard keys.isSubset(of: allowed), values["scheme"] is String,
              try optionalBoolean("replace", in: values) != true,
              try optionalBoolean("useSysBrowser", in: values) != true else {
            throw HotUpdaterSparklingNavigationError.invalidOptions(
                "Managed navigation supports push and boolean animation only"
            )
        }
        _ = try optionalBoolean("animated", in: values)
    }

    static func validateClose(_ values: [AnyHashable: Any]) throws {
        let keys = try stringKeys(values)
        guard keys.isSubset(of: ["animated", "containerID"]),
              values["containerID"] == nil
                || (values["containerID"] as? String)?.isEmpty == false else {
            throw HotUpdaterSparklingNavigationError.invalidOptions(
                "Managed close accepts a container ID and boolean animation"
            )
        }
        _ = try optionalBoolean("animated", in: values)
    }

    private static func stringKeys(
        _ values: [AnyHashable: Any]
    ) throws -> Set<String> {
        let keys = values.keys.compactMap { $0 as? String }
        guard keys.count == values.count else {
            throw HotUpdaterSparklingNavigationError.invalidOptions(
                "Managed navigation option keys must be strings"
            )
        }
        return Set(keys)
    }

    private static func optionalBoolean(
        _ key: String,
        in values: [AnyHashable: Any]
    ) throws -> Bool? {
        guard let value = values[key] else { return nil }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw HotUpdaterSparklingNavigationError.invalidOptions(
                "Managed navigation option \(key) must be boolean"
            )
        }
        return number.boolValue
    }
}

private final class HotUpdaterManagedOpenParamModel: SPKMethodModel {
    @objc var scheme: String?
    @objc var replace = false
    @objc var useSysBrowser = false
    @objc var animated = false

    override class func requiredKeyPaths() -> Set<String>? { ["scheme"] }

    override class func jsonKeyPathsByPropertyKey() -> [AnyHashable: Any] {
        [
            "scheme": "scheme",
            "replace": "replace",
            "useSysBrowser": "useSysBrowser",
            "animated": "animated",
        ]
    }

    required init() { super.init() }

    required init?(coder: NSCoder) { super.init(coder: coder) }

    required init(dictionary dictionaryValue: [AnyHashable: Any]!) throws {
        let values = dictionaryValue ?? [:]
        try HotUpdaterManagedMethodParameters.validateOpen(values)
        try super.init(dictionary: values)
    }

    required init(from decoder: Decoder) throws {
        try super.init(from: decoder)
    }
}

private final class HotUpdaterManagedCloseParamModel: SPKMethodModel {
    @objc var containerID: String?
    @objc var animated = false

    override class func requiredKeyPaths() -> Set<String>? { [] }

    override class func jsonKeyPathsByPropertyKey() -> [AnyHashable: Any] {
        ["containerID": "containerID", "animated": "animated"]
    }

    required init() { super.init() }

    required init?(coder: NSCoder) { super.init(coder: coder) }

    required init(dictionary dictionaryValue: [AnyHashable: Any]!) throws {
        let values = dictionaryValue ?? [:]
        try HotUpdaterManagedMethodParameters.validateClose(values)
        try super.init(dictionary: values)
    }

    required init(from decoder: Decoder) throws {
        try super.init(from: decoder)
    }
}

private final class HotUpdaterManagedOpenMethod: PipeMethod {
    private weak var host: HotUpdaterSparklingHost?

    required init() { super.init() }

    init(host: HotUpdaterSparklingHost) {
        self.host = host
        super.init()
    }

    override var methodName: String { "router.open" }
    override class func methodName() -> String { "router.open" }

    override var paramsModelClass: AnyClass {
        HotUpdaterManagedOpenParamModel.self
    }

    override var resultModelClass: AnyClass { EmptyMethodModelClass.self }

    override func call(
        withParamModel paramModel: Any,
        completionHandler: CompletionHandlerProtocol
    ) {
        guard let host, let params = paramModel
            as? HotUpdaterManagedOpenParamModel,
            let route = params.scheme,
            let source = params.context?.pipeContainer else {
            completionHandler.handleCompletion(
                status: .unauthorizedAccess(
                    message: "Missing managed route source"
                ),
                result: nil
            )
            return
        }
        do {
            try host.open(
                rawRoute: route,
                options: try HotUpdaterSparklingOpenOptions(
                    replace: params.replace,
                    useSystemBrowser: params.useSysBrowser,
                    animated: params.animated
                ),
                source: source
            )
            completionHandler.handleCompletion(
                status: .succeeded(),
                result: nil
            )
        } catch {
            completionHandler.handleCompletion(
                status: .invalidParameter(
                    message: error.localizedDescription
                ),
                result: nil
            )
        }
    }
}

private final class HotUpdaterManagedCloseMethod: PipeMethod {
    private weak var host: HotUpdaterSparklingHost?

    required init() { super.init() }

    init(host: HotUpdaterSparklingHost) {
        self.host = host
        super.init()
    }

    override var methodName: String { "router.close" }
    override class func methodName() -> String { "router.close" }

    override var paramsModelClass: AnyClass {
        HotUpdaterManagedCloseParamModel.self
    }

    override var resultModelClass: AnyClass { EmptyMethodModelClass.self }

    override func call(
        withParamModel paramModel: Any,
        completionHandler: CompletionHandlerProtocol
    ) {
        guard let host, let params = paramModel
            as? HotUpdaterManagedCloseParamModel,
            let source = params.context?.pipeContainer else {
            completionHandler.handleCompletion(
                status: .unauthorizedAccess(
                    message: "Missing managed close source"
                ),
                result: nil
            )
            return
        }
        do {
            try host.close(
                source: source,
                requestedContainerId: params.containerID,
                animated: params.animated
            )
            completionHandler.handleCompletion(
                status: .succeeded(),
                result: nil
            )
        } catch {
            completionHandler.handleCompletion(
                status: .unauthorizedAccess(
                    message: error.localizedDescription
                ),
                result: nil
            )
        }
    }
}

private final class HotUpdaterSparklingRouterService: RouterService {
    private weak var host: HotUpdaterSparklingHost?

    init(host: HotUpdaterSparklingHost) {
        self.host = host
    }

    func openScheme(
        withParams params: OpenMethodParamModel,
        completion: @escaping PipeMethod.CompletionBlock
    ) {
        guard let host, let route = params.scheme,
              let source = params.context?.pipeContainer else {
            completion(
                .unauthorizedAccess(message: "Missing managed route source"),
                nil
            )
            return
        }
        do {
            let options = try HotUpdaterSparklingOpenOptions(
                replace: params.replace,
                replaceType: params.replaceType,
                useSystemBrowser: params.useSysBrowser,
                animated: params.animated,
                interceptor: params.interceptor,
                extraPresent: params.extra != nil
            )
            try host.open(rawRoute: route, options: options, source: source)
            completion(.succeeded(), nil)
        } catch {
            completion(
                .invalidParameter(message: error.localizedDescription),
                nil
            )
        }
    }

    func closeContainer(
        withParams params: CloseMethodParamModel,
        completion: @escaping PipeMethod.CompletionBlock
    ) {
        guard let host, let source = params.context?.pipeContainer else {
            completion(
                .unauthorizedAccess(message: "Missing managed close source"),
                nil
            )
            return
        }
        do {
            try host.close(
                source: source,
                requestedContainerId: params.containerID,
                animated: params.animated
            )
            completion(.succeeded(), nil)
        } catch {
            completion(
                .unauthorizedAccess(message: error.localizedDescription),
                nil
            )
        }
    }
}

private final class HotUpdaterSparklingResource: NSObject,
    SPKResourceProtocol {
    let resourceData: Data?
    init(_ data: Data) { resourceData = data }
}

private final class HotUpdaterSparklingResourceLoader: NSObject,
    SPKResourceLoaderProtocol {
    private let controller: LynxController
    private let context: LynxLaunchContext
    private let pageEntry: String
    private let generation: SparklingGenerationEvents
    private let fallback: SPKResourceLoaderProtocol
    private let failed: (ManagedPageFailure) -> Void

    init(
        controller: LynxController,
        context: LynxLaunchContext,
        pageEntry: String,
        generation: SparklingGenerationEvents,
        fallback: SPKResourceLoaderProtocol,
        failed: @escaping (ManagedPageFailure) -> Void
    ) {
        self.controller = controller
        self.context = context
        self.pageEntry = pageEntry
        self.generation = generation
        self.fallback = fallback
        self.failed = failed
    }

    func resolveEssential(_ path: String) throws {
        do {
            _ = try resolve(
                path: path,
                kind: resourceKind(path),
                image: false
            )
        } catch {
            let failure = ManagedPageFailure(
                error: error,
                resourcePath: path
            )
            fail(failure)
            throw failure
        }
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
            let data = try resolve(
                path: path,
                kind: resourceKind(path),
                image: false
            )
            completion(HotUpdaterSparklingResource(data), nil)
        } catch {
            fail(ManagedPageFailure(error: error, resourcePath: path))
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
            let data = try resolve(
                path: path,
                kind: "imageLoaded",
                image: true
            )
            guard let image = UIImage(data: data) else {
                throw HotUpdaterSparklingError.reconstructionFailed(
                    "Managed image could not be decoded"
                )
            }
            completion(image, nil)
        } catch {
            fail(ManagedPageFailure(error: error, resourcePath: path))
            completion(nil, error)
        }
        return nil
    }

    private func resolve(
        path: String,
        kind: String,
        image: Bool
    ) throws -> Data {
        try generation.resourceOperation {
            let data = try controller.resource(
                "hot-updater:///\(path)",
                context: context
            )
            if !image, kind == "fontLoaded" {
                guard let source = CGDataProvider(data: data as CFData),
                      CGFont(source) != nil else {
                    throw HotUpdaterSparklingError.reconstructionFailed(
                        "Managed font could not be decoded"
                    )
                }
            }
            let details: [String: Any] = [
                "processId": String(ProcessInfo.processInfo.processIdentifier),
                "generationId": generation.id,
                "contextId": context.id,
                "attemptId": controller.attemptId,
                "bundleId": controller.runningSelection.bundleId,
                "releaseId": hotUpdaterJSONValue(
                    controller.runningSelection.releaseId
                ),
                "pageEntry": pageEntry,
                "path": path,
                "sha256": SHA256.hash(data: data).map {
                    String(format: "%02x", $0)
                }.joined(),
                "bytes": data.count,
            ]
            guard generation.resourceLoaded(kind, details: details) else {
                throw HotUpdaterSparklingError.reconstructionFailed(
                    "Managed resource belongs to a retired generation"
                )
            }
            try controller.observedResource(path, context: context)
            return data
        }
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

    private func resourceKind(_ path: String) -> String {
        if path.hasSuffix(".ttf") || path.hasSuffix(".otf") {
            return "fontLoaded"
        }
        return "resourceLoaded"
    }

    private func fail(_ failure: ManagedPageFailure) {
        generation.emit("resourceFailed", [
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "pageEntry": pageEntry,
            "message": failure.message,
            "failureCode": hotUpdaterJSONValue(failure.code),
            "failureResourcePath": hotUpdaterJSONValue(
                failure.resourcePath
            ),
        ])
        DispatchQueue.main.async { [failed] in
            failed(failure)
        }
    }
}

private final class HotUpdaterSparklingLifecycle: NSObject,
    SPKContainerLifecycleProtocol {
    private let controller: LynxController
    private let context: LynxLaunchContext
    private let pageEntry: String
    private let generation: SparklingGenerationEvents
    private let failed: (ManagedPageFailure) -> Void
#if HOT_UPDATER_LYNX_DIAGNOSTICS
    private var failAfterFirstContentForDiagnostics = false
#endif

    init(
        controller: LynxController,
        context: LynxLaunchContext,
        pageEntry: String,
        generation: SparklingGenerationEvents,
        failed: @escaping (ManagedPageFailure) -> Void
    ) {
        self.controller = controller
        self.context = context
        self.pageEntry = pageEntry
        self.generation = generation
        self.failed = failed
    }

#if HOT_UPDATER_LYNX_DIAGNOSTICS
    convenience init(
        controller: LynxController,
        context: LynxLaunchContext,
        pageEntry: String,
        generation: SparklingGenerationEvents,
        failAfterFirstContentForDiagnostics: Bool,
        failed: @escaping (ManagedPageFailure) -> Void
    ) {
        self.init(
            controller: controller,
            context: context,
            pageEntry: pageEntry,
            generation: generation,
            failed: failed
        )
        self.failAfterFirstContentForDiagnostics =
            failAfterFirstContentForDiagnostics
    }
#endif

    func containerDidFirstScreen(_ container: SPKContainerProtocol) {
        do {
            guard generation.emit("firstContent", [
                "processId": String(ProcessInfo.processInfo.processIdentifier),
                "generationId": generation.id,
                "contextId": context.id,
                "attemptId": controller.attemptId,
                "bundleId": controller.runningSelection.bundleId,
                "releaseId": hotUpdaterJSONValue(
                    controller.runningSelection.releaseId
                ),
                "pageEntry": pageEntry,
            ]) else { return }
#if HOT_UPDATER_LYNX_DIAGNOSTICS
            if failAfterFirstContentForDiagnostics {
                let failure = ManagedPageFailure(
                    message: "diagnostic pending admission failure"
                )
                generation.emit("runtimeFailed", [
                    "processId": String(ProcessInfo.processInfo.processIdentifier),
                    "generationId": generation.id,
                    "contextId": context.id,
                    "attemptId": controller.attemptId,
                    "bundleId": controller.runningSelection.bundleId,
                    "releaseId": hotUpdaterJSONValue(
                        controller.runningSelection.releaseId
                    ),
                    "pageEntry": pageEntry,
                    "message": failure.message,
                    "failureCode": NSNull(),
                    "failureResourcePath": NSNull(),
                ])
                failed(failure)
                return
            }
#endif
            try controller.observedContent(context)
        } catch {
            generation.emit("staleContentRejected", [
                "generationId": generation.id,
                "contextId": context.id,
                "pageEntry": pageEntry,
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
        guard let lynx = error as? LynxError,
              lynx.isFatal || lynx.isJSError() else {
            generation.emit("runtimeWarning", [
                "generationId": generation.id,
                "contextId": context.id,
                "pageEntry": pageEntry,
                "message": error?.localizedDescription ?? "unknown",
            ])
            return
        }
        fail(error)
    }

    private func fail(_ error: Error?) {
        let failure = ManagedPageFailure(error: error)
        generation.emit("runtimeFailed", [
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "generationId": generation.id,
            "contextId": context.id,
            "attemptId": controller.attemptId,
            "bundleId": controller.runningSelection.bundleId,
            "releaseId": hotUpdaterJSONValue(
                controller.runningSelection.releaseId
            ),
            "pageEntry": pageEntry,
            "message": failure.message,
            "failureCode": hotUpdaterJSONValue(failure.code),
        ])
        DispatchQueue.main.async { [failed] in failed(failure) }
    }
}
