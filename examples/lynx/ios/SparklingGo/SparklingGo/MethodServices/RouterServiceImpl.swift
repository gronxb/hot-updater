// Copyright 2025 The Sparkling Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import Foundation
import Sparkling
import SparklingMethod
import Sparkling_Router

class RouterServiceImpl: RouterService {
    func closeContainer(withParams params: Sparkling_Router.CloseMethodParamModel, completion: @escaping SparklingMethod.PipeMethod.CompletionBlock) {
        if SPKRouter.close(container: params.context?.pipeContainer) {
            completion(.succeeded(), nil)
        } else {
            completion(.failed(message: "Unable to close the container"), nil)
        }
    }

    func openScheme(withParams params: Sparkling_Router.OpenMethodParamModel, completion: @escaping SparklingMethod.PipeMethod.CompletionBlock) {
        let urlString = params.scheme
        let context = SPKContext()

        DispatchQueue.main.async {
            func openWithRouter(completionHandler: ((Bool) -> Void)? = nil) {
                if let (_, success) = SPKRouter.open(withURL: urlString, context: context), success {
                    completionHandler?(true)
                    completion(.succeeded(), nil)
                } else {
                    completionHandler?(false)
                    completion(.failed(message: "Failed to open URL"), nil)
                }
            }

            if params.useSysBrowser == true {
                let success = SPKRouter.openInSystemBrowser(withURL: urlString)
                if success {
                    completion(.succeeded(), nil)
                } else {
                    completion(.failed(message: "Failed to open URL in system browser"), nil)
                }
            } else {
                if params.replace == true && params.replaceType == "alwaysCloseBeforeOpen" {
                    if SPKRouter.close(container: params.context?.pipeContainer) {
                        print("Unable to close the container")
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        openWithRouter()
                    }
                } else if params.replace == true {
                    openWithRouter { success in
                        if params.replaceType == "alwaysCloseAfterOpen" || (params.replaceType == "onlyCloseAfterOpenSucceed" && success) {
                            if SPKRouter.close(container: params.context?.pipeContainer) {
                                print("Unable to close the container")
                            }
                        }
                    }
                } else {
                    openWithRouter()
                }
            }
        }
    }
}
