import Foundation
import Lynx

/// Held by Lynx's group listener without retaining its view or runtime.
final class ManagedRuntimeRetirement: NSObject, LynxRuntimeLifecycleListener {
    private let generation: SparklingGenerationEvents
    private let contextId: String

    init(generation: SparklingGenerationEvents, contextId: String) {
        self.generation = generation
        self.contextId = contextId
    }

    func onRuntimeDetach() {
        // A unique group's callback follows module-manager release. Remaining
        // NAPI cleanup still runs on Lynx_JS; this is not its completion fence.
        DispatchQueue.main.async { [generation, contextId] in
            generation.runtimeDetached(contextId)
        }
    }
}
