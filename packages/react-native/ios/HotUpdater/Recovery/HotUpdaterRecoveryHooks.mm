#import "HotUpdaterRecovery.h"
#import <objc/runtime.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTFabricSurface.h>
#import <React/RCTSurfacePresenter.h>
#endif

void HotUpdaterInstallRecoveryHooks(void)
{
#ifdef RCT_NEW_ARCH_ENABLED
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    SEL startSelector = @selector(start);
    SEL completionSelector = @selector(setupAnimationDriverWithSurfaceHandler:);
    Method startMethod = class_getInstanceMethod(RCTFabricSurface.class, startSelector);
    Method completionMethod = class_getInstanceMethod(RCTSurfacePresenter.class, completionSelector);
    if (!startMethod || !completionMethod) {
      return;
    }

    IMP originalCompletion = method_getImplementation(completionMethod);
    method_setImplementation(completionMethod, imp_implementationWithBlock(
        ^(RCTSurfacePresenter *presenter, const facebook::react::SurfaceHandler &handler) {
          ((void (*)(id, SEL, const facebook::react::SurfaceHandler &))originalCompletion)(
              presenter, completionSelector, handler);
          // This is the final operation in both synchronous and asynchronous
          // Fabric starts. A stage callback fires too early to permit reload.
          HotUpdaterFinishSurfaceStart(&handler);
        }));

    IMP originalStart = method_getImplementation(startMethod);
    method_setImplementation(startMethod, imp_implementationWithBlock(^(RCTFabricSurface *surface) {
      if (HotUpdaterIsFailedRuntime()) {
        return;
      }
      const auto &handler = surface.surfaceHandler;
      if (handler.getStatus() != facebook::react::SurfaceHandler::Status::Registered) {
        return;
      }
      if (HotUpdaterBeginSurfaceStart(&handler)) {
        // No coordination lock crosses the original call: older RN versions
        // invoke the completion synchronously on this same thread.
        ((void (*)(id, SEL))originalStart)(surface, startSelector);
      }
    }));
  });
#endif
}
