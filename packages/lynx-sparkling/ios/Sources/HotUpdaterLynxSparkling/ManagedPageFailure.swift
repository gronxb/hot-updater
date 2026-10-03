import Foundation
import Lynx

struct ManagedPageFailure: Error, LocalizedError {
    let message: String
    let code: Int?
    let resourcePath: String?

    init(
        message: String,
        code: Int? = nil,
        resourcePath: String? = nil
    ) {
        self.message = message
        self.code = code
        self.resourcePath = resourcePath
    }

    init(error: Error?, resourcePath: String? = nil) {
        message = error?.localizedDescription ?? "Lynx page load failed"
        code = (error as? LynxError).map { Int($0.errorCode) }
        self.resourcePath = resourcePath
    }

    var errorDescription: String? { message }
}
