#import "HotUpdater.h" // 이 파일은 그대로 사용 (RN 모듈 인터페이스 정의)

// 생성된 Swift 헤더 파일을 임포트합니다. 여기에는 HotUpdaterModule 정의가 포함됩니다.
#import "HotUpdaterModule-Swift.h"

// 레거시 브릿지 구현
// @implementation HotUpdater는 HotUpdater.h에 선언된 인터페이스를 구현합니다.
@implementation HotUpdater
{
    // FIX: Swift 클래스 인스턴스 타입 변경
    // Swift 클래스의 공유 인스턴스에 대한 참조 유지
    HotUpdaterModule *swiftInstance; // 타입 변경됨
}

// JavaScript에 모듈 이름 노출 ("HotUpdater" 이름 유지)
RCT_EXPORT_MODULE();

// 초기화 시 Swift 공유 인스턴스 가져오기
- (instancetype)init {
    self = [super init];
    if (self) {
        // FIX: Swift 공유 인스턴스 가져오기 변경
        // HotUpdaterModule.swift에 정의된 공유 인스턴스를 가져옴
        swiftInstance = [HotUpdaterModule shared]; // 클래스 이름 변경됨
    }
    return self;
}

// AppDelegate 등에서 사용할 정적 번들 URL 메서드
+ (NSURL *)bundleURL {
  // FIX: Swift 정적 메서드 호출 변경
  // Swift 클래스([HotUpdaterModule class])의 정적 메서드(+bundleURL)를 호출합니다.
  return [HotUpdaterModule bundleURL]; // 클래스 이름 변경됨
}

// --- JavaScript로 메서드 내보내기 ---
// 모든 메서드 호출을 swiftInstance (HotUpdaterModule 타입)로 전달합니다.

RCT_EXPORT_METHOD(setChannel:(NSString *)channel
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  // Swift 인스턴스(HotUpdaterModule)의 setChannel(channel:resolve:reject:) 메서드 호출
  [swiftInstance setChannel:channel resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(reload) {
  // Swift 인스턴스(HotUpdaterModule)의 reload() 메서드 호출
  [swiftInstance reload];
}

RCT_EXPORT_METHOD(getAppVersion:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  // Swift 인스턴스(HotUpdaterModule)의 getAppVersion(resolve:reject:) 메서드 호출
  [swiftInstance getAppVersionWithResolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)bundleData
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  // Swift 인스턴스(HotUpdaterModule)의 updateBundle(_:resolve:reject:) 메서드 호출
  [swiftInstance updateBundle:bundleData resolve:resolve reject:reject];
}

// --- EventEmitter 관련 메서드 ---

// 지원하는 이벤트 목록 반환 (Swift 인스턴스에서 가져옴)
- (NSArray<NSString *> *)supportedEvents {
  // Swift 인스턴스(HotUpdaterModule)의 supportedEvents() 메서드 호출
  return [swiftInstance supportedEvents];
}

// 메인 스레드 설정 필요 여부 반환 (Swift 클래스에서 가져옴)
+ (BOOL)requiresMainQueueSetup {
  // FIX: Swift 정적 메서드 호출 변경
  // Swift 클래스(HotUpdaterModule)의 정적 requiresMainQueueSetup() 메서드 호출
  return [HotUpdaterModule requiresMainQueueSetup]; // 클래스 이름 변경됨
}

// --- 상수 내보내기 ---

// JavaScript로 내보낼 상수 반환 (Swift 인스턴스에서 가져옴)
- (NSDictionary *)constantsToExport {
    // Swift 인스턴스(HotUpdaterModule)의 constantsToExport() 메서드 호출
    return [swiftInstance constantsToExport];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif


@end