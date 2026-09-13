// Copyright 2025 The Sparkling Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import Foundation
import SparklingMethod
import Sparkling_Router
#if canImport(Sparkling_Storage)
import Sparkling_Storage
#endif

enum SPKServiceRegister {
    static func registerAll() {
        // IMPORTANT: You must either use the provided DefaultDIContainerProvider.inject()
        // or manually inject your own implementation of DIContainer before using SPK services.
        DefaultDIContainerProvider.inject()

        DIProviderRegistry.provider.pipeShared().register(RouterService.self) {
            RouterServiceImpl()
        }
        #if canImport(Sparkling_Storage)
        DIProviderRegistry.provider.pipeShared().register(StorageService.self) {
            StorageServiceImpl()
        }
        #endif
        /// Methods that conform to `SPKAutoRegisteringMethod` will be automatically
        /// registered into the global method table by calling this function.
        MethodRegistry.autoRegisterGlobalMethods()

        /// Alternatively, you can manually register individual methods as shown below.
        // MethodRegistry.global.register(methodType: SPK_SPKRouter.OpenMethod.self)
        // MethodRegistry.global.register(methodType: XXX.self)
    }
}
