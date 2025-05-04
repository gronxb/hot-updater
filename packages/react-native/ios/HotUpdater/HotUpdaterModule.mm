#import "HotUpdaterModule.h"

#if __has_include("HotUpdater/HotUpdater-Swift.h")
#import "HotUpdater/HotUpdater-Swift.h"
#else
#import "HotUpdater-Swift.h"
#endif

@implementation HotUpdaterModule

RCT_EXPORT_MODULE(HotUpdater);

RCT_EXPORT_METHOD(setChannel:(NSString *)channel
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  [HotUpdaterModuleImpl setChannel:channel resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(reload) {
  [HotUpdaterModuleImpl reload];
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  [HotUpdaterModuleImpl getAppVersionWithResolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)bundleData
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  [HotUpdaterModuleImpl updateBundle:bundleData resolve:resolve reject:reject];
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"onProgress"];
}

+ (BOOL)requiresMainQueueSetup {
  return YES;
}


- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}

@end