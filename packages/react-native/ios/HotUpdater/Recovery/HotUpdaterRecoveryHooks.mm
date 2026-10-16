#import "HotUpdaterRecovery.h"
#import <objc/runtime.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTFabricSurface.h>
#import <React/RCTSurfacePresenter.h>
#else
#import <React/RCTRootView.h>
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
        // A view of this surface's runtime is about to show: crash recovery
        // starts the launch of the instance the runtime belongs to.
        [[NSNotificationCenter defaultCenter] postNotificationName:@"HotUpdaterSurfaceWillStart" object:surface];
        // No coordination lock crosses the original call: older RN versions
        // invoke the completion synchronously on this same thread.
        ((void (*)(id, SEL))originalStart)(surface, startSelector);
      }
    }));
  });
#else
  // Old architecture: a root view in a window shows its bridge's runtime,
  // which starts the launch of the instance the bridge runs (attributed by
  // its bundle URL). Repeats are harmless: a launch starts once.
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    Class rootViewClass = RCTRootView.class;
#pragma clang diagnostic pop
    SEL selector = @selector(didMoveToWindow);
    Class superclass = class_getSuperclass(rootViewClass);
    Method inherited = class_getInstanceMethod(rootViewClass, selector);
    if (!inherited || !superclass) {
      return;
    }
    // RCTRootView doesn't override didMoveToWindow today: add an override
    // that calls UIView's, never exchanging UIView's own implementation.
    IMP current = class_getMethodImplementation(rootViewClass, selector);
    IMP own = current != class_getMethodImplementation(superclass, selector) ? current : NULL;
    IMP replacement = imp_implementationWithBlock(^(UIView *view) {
      IMP next = own ?: class_getMethodImplementation(superclass, selector);
      ((void (*)(id, SEL))next)(view, selector);
      if (view.window) {
        [[NSNotificationCenter defaultCenter] postNotificationName:@"HotUpdaterSurfaceWillStart" object:view];
      }
    });
    if (own) {
      method_setImplementation(inherited, replacement);
    } else {
      class_addMethod(rootViewClass, selector, replacement, method_getTypeEncoding(inherited));
    }
  });
#endif
}
