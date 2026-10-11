import Foundation

// Only the native engine boundary is replaceable; controller and storage authority stay here.
protocol LynxMountedRuntime: AnyObject {
    func load(_ callbacks: LynxMountedRuntimeCallbacks) throws
    func invalidate()
    func retire()
}

struct LynxMountedRuntimeCallbacks {
    let readResource: (String, (Data) throws -> Void) throws -> Data
    let didFirstScreen: () -> Void
    let appReady: (@escaping (Result<LynxConfirmationResult, Error>) -> Void) -> Void
    let transition: (String, @escaping (Result<LynxManagedTransitionAcceptance, Error>) -> Void) -> Void
    let failed: (Error) -> Void
    let detached: () -> Void
}

/// Native mount membership and generation lifetime, independent of UIKit layout.
final class LynxMountedHost {
    // Construction is inert. Lifecycle callbacks become available only after registration.
    typealias Factory = (LynxController, LynxLaunchContext, LynxManagedLogicalPage) -> LynxMountedRuntime
    private final class Page {
        let logical: LynxManagedLogicalPage
        let context: LynxLaunchContext
        var runtime: LynxMountedRuntime?
        var admitted: Bool
        var retired = false
        var retirementStarted = false
        var detached = false
        var resources = 0
        init(_ logical: LynxManagedLogicalPage, _ context: LynxLaunchContext) {
            self.logical = logical; self.context = context; admitted = context.primary
        }
    }
    private final class Generation {
        let controller: LynxController
        let primary: LynxLaunchContext
        var pages: [String: Page] = [:]
        // Includes independently removed views until their actual runtime has ended.
        var runtimes: [ObjectIdentifier: Page] = [:]
        let resourceLock = NSLock()
        var retiring = false
        var replacement: [LynxManagedLogicalPage]?
        init(_ controller: LynxController, _ primary: LynxLaunchContext) {
            self.controller = controller; self.primary = primary
        }
    }
    private let owner: LynxRuntimeHost
    private let createRuntime: Factory
    private let onError: (Error) -> Void
    private var mounts: [LynxManagedLogicalPage] = []
    private var generation: Generation?
    private var failedBundles: Set<String> = []
    private var closed = false
    private var replacing = false
    private var retirementRetention: LynxMountedHost?

    init(owner: LynxRuntimeHost, onError: @escaping (Error) -> Void,
         createRuntime: @escaping Factory) throws {
        guard owner.configuration.pageHostMode == .mounted else {
            throw LynxArtifactError.invalid("A plain LynxView host requires mounted page mode")
        }
        self.owner = owner; self.onError = onError; self.createRuntime = createRuntime
    }

    func mountPrimary(id: String, parameters: [LynxManagedPageParameter]) throws {
        requireMainThread()
        guard !closed, mounts.isEmpty, generation == nil else {
            throw LynxArtifactError.invalid("The host already has a primary or is closed")
        }
        mounts = [.init(entry: owner.scope.embeddedArtifact.entry, parameters: parameters, mountId: id)]
        do { try start(mounts, reconstructing: false) }
        catch { failClosed(error); throw error }
    }

    func mount(id: String, entry: String, parameters: [LynxManagedPageParameter]) throws {
        requireMainThread()
        guard !closed, !mounts.isEmpty, let current = generation,
              current.controller.runningArtifact.pageEntries.contains(entry) else {
            throw LynxArtifactError.invalid("Mount the primary before a known secondary")
        }
        let page = LynxManagedLogicalPage(entry: entry, parameters: parameters, mountId: id)
        try lynxValidateLogicalPages((mounts + [page]).map(\.stored), mode: .mounted)
        if !replacing { try current.controller.declareSecondary(page, primary: current.primary) }
        mounts.append(page)
        if !replacing { drain(current) }
    }

    func unmount(_ id: String) throws {
        requireMainThread()
        guard let index = mounts.firstIndex(where: { $0.mountId == id }) else { return }
        if index == 0 { close(); return }
        if !replacing, let current = generation {
            if let page = current.pages[id] {
                try current.controller.unmountSecondary(page.context)
                retire(page, in: current)
                current.pages.removeValue(forKey: id)
            } else {
                try current.controller.unmountUnlaunchedSecondary(id, primary: current.primary)
            }
        }
        mounts.removeAll { $0.mountId == id }
        if !replacing, let current = generation { drain(current) }
    }

    private func start(_ snapshot: [LynxManagedLogicalPage], reconstructing: Bool) throws {
        let controller = try owner.createForegroundForMounts(snapshot, reconstructing: reconstructing)
        let primary = controller.createContext(primary: true)
        do {
            guard !failedBundles.contains(controller.runningSelection.bundleId) else {
                throw LynxArtifactError.invalid("No different complete installation remains after runtime failure")
            }
            _ = try controller.begin(primary)
        } catch { try? controller.close(); throw error }
        let current = Generation(controller, primary)
        generation = current
        // First validate the frozen transition, then apply native changes queued during retirement.
        for page in snapshot.dropFirst() where !mounts.contains(page) {
            try controller.unmountUnlaunchedSecondary(page.mountId!, primary: primary)
        }
        for page in mounts where !snapshot.contains(page) {
            try controller.declareSecondary(page, primary: primary)
        }
        replacing = false
        attach(mounts[0], context: primary, in: current)
        drain(current)
    }

    private func drain(_ current: Generation) {
        guard !closed, !replacing, current === generation, !current.retiring,
              !current.pages.values.contains(where: { !$0.admitted && !$0.retired }),
              let next = mounts.dropFirst().first(where: { current.pages[$0.mountId!] == nil }) else { return }
        do {
            let context = current.controller.createContext(primary: false)
            _ = try current.controller.begin(context, pageEntry: next.entry,
                generationId: current.controller.attemptId,
                stack: current.controller.mountedPages(current.primary), mountId: next.mountId)
            attach(next, context: context, in: current)
        } catch { recover(current, error: error) }
    }

    private func attach(_ logical: LynxManagedLogicalPage, context: LynxLaunchContext, in current: Generation) {
        let page = Page(logical, context)
        current.pages[logical.mountId!] = page
        current.runtimes[ObjectIdentifier(page)] = page
        let callbacks = LynxMountedRuntimeCallbacks(
            readResource: { [weak self, weak current, weak page] url, consume in
                guard let current, let page else { throw LynxArtifactError.invalid("Retired managed page") }
                current.resourceLock.lock()
                guard !current.retiring, !page.retired else {
                    current.resourceLock.unlock()
                    throw LynxArtifactError.invalid("Retired managed page")
                }
                page.resources += 1
                current.resourceLock.unlock()
                defer {
                    current.resourceLock.lock()
                    page.resources -= 1
                    let drained = page.retired && page.resources == 0
                    current.resourceLock.unlock()
                    if drained { self?.onMain { self?.finishPageRetirement(page, in: current) } }
                }
                let data = try current.controller.resource(url, context: context)
                try consume(data)
                let path = LynxManagedFontURL.owns(url)
                    ? try LynxManagedFontURL.relativePath(url)
                    : String((URL(string: url)!.path.removingPercentEncoding!).drop(while: { $0 == "/" }))
                // Controller readiness callbacks are queued below, never delivered under this lock.
                current.resourceLock.lock(); defer { current.resourceLock.unlock() }
                if !page.retired && !current.retiring {
                    try current.controller.observedResource(path, context: context)
                }
                return data
            },
            didFirstScreen: { [weak self, weak current] in
                self?.onMain {
                    guard let self, let current, current === self.generation, !current.retiring, !page.retired else { return }
                    do { try current.controller.observedContent(context) }
                    catch { self.recover(current, error: error, page: page) }
                }
            },
            appReady: { [weak self, weak current] completion in
                DispatchQueue.main.async { [weak self] in
                    guard let self, let current, current === self.generation, !page.retired, !current.retiring else {
                        completion(.failure(LynxArtifactError.invalid("Retired managed page"))); return
                    }
                    current.controller.notifyAppReady(context) { [weak self] result in
                        DispatchQueue.main.async { [weak self] in
                            if case .success = result, !current.retiring, !page.retired {
                                page.admitted = true
                                DispatchQueue.main.async { self?.drain(current) }
                            }
                            completion(result)
                        }
                    }
                }
            },
            transition: { [weak self, weak current] trigger, completion in
                guard let self, let current else { completion(.failure(LynxArtifactError.invalid("Retired managed page"))); return }
                self.onMain { self.reload(current, source: context, trigger: trigger, completion: completion) }
            },
            failed: { [weak self, weak current] error in
                self?.onMain { if let current { self?.recover(current, error: error, page: page) } }
            },
            detached: { [weak self, weak current, weak page] in
                self?.onMain {
                    guard let self, let current, let page,
                          current.runtimes[ObjectIdentifier(page)] != nil, !page.detached else { return }
                    page.detached = true
                    if !page.retired { self.recover(current, error: LynxArtifactError.invalid("Runtime detached before retirement"), page: page) }
                    self.finishPageRetirement(page, in: current)
                }
            }
        )
        let runtime = createRuntime(current.controller, context, logical)
        page.runtime = runtime
        do { try runtime.load(callbacks) } catch { recover(current, error: error, page: page) }
    }

    private func reload(_ current: Generation, source: LynxLaunchContext, trigger: String,
                        completion: @escaping (Result<LynxManagedTransitionAcceptance, Error>) -> Void) {
        requireMainThread()
        do {
            guard !closed, !replacing, current === generation else { throw LynxArtifactError.invalid("Stale managed generation") }
            let snapshot = try current.controller.mountedPages(current.primary)
            let accepted = try current.controller.acceptManagedTransition(source, trigger: trigger, stack: snapshot)
            current.replacement = snapshot
            replacing = true
            completion(.success(accepted))
            DispatchQueue.main.async { self.retire(current) }
        } catch { completion(.failure(error)) }
    }

    private func recover(_ current: Generation, error: Error, page: Page? = nil) {
        guard !closed, !replacing, current === generation, !current.retiring, page?.retired != true else { return }
        do {
            if let page, !page.context.primary,
               try current.controller.reportPageFailure(page.context) {
                // Pending secondary failure records its own admission before retiring the generation.
            } else {
                _ = try current.controller.reportFailure(current.primary, fatal: true, allowConfirmed: true)
            }
            failedBundles.insert(current.controller.runningSelection.bundleId)
            current.replacement = mounts
            replacing = true
            DispatchQueue.main.async { self.retire(current) }
        } catch { failClosed(error) }
    }

    private func retire(_ page: Page, in current: Generation) {
        current.resourceLock.lock()
        let alreadyRetired = page.retired
        page.retired = true
        current.resourceLock.unlock()
        guard !alreadyRetired else { return }
        page.runtime?.invalidate()
        current.controller.destroy(page.context)
        finishPageRetirement(page, in: current)
    }

    private func finishPageRetirement(_ page: Page, in current: Generation) {
        current.resourceLock.lock()
        let drained = page.retired && page.resources == 0
        current.resourceLock.unlock()
        guard drained else { return }
        if !page.retirementStarted {
            page.retirementStarted = true
            page.runtime?.retire()
        }
        if page.detached {
            page.runtime = nil
            current.runtimes.removeValue(forKey: ObjectIdentifier(page))
            finishRetirement(current)
        }
    }

    private func retire(_ current: Generation) {
        guard current === generation, !current.retiring else { return }
        retirementRetention = self
        current.resourceLock.lock(); current.retiring = true; current.resourceLock.unlock()
        if current.pages.isEmpty { current.controller.destroy(current.primary) }
        for page in Array(current.runtimes.values) { retire(page, in: current) }
        finishRetirement(current)
    }

    private func finishRetirement(_ current: Generation) {
        guard current.retiring, current.runtimes.isEmpty, current === generation else { return }
        do {
            try current.controller.close()
            generation = nil
            retirementRetention = nil
            if !closed { try start(current.replacement!, reconstructing: true) }
        } catch { failClosed(error) }
    }

    private func failClosed(_ error: Error) { close(); onError(error) }

    func close() {
        requireMainThread()
        guard !closed else { return }
        closed = true
        mounts.removeAll()
        if let current = generation { retire(current) }
    }

    private func onMain(_ operation: @escaping () -> Void) {
        DispatchQueue.main.async(execute: operation)
    }
    private func requireMainThread() { precondition(Thread.isMainThread, "Mount Lynx containers on the main thread") }
}
