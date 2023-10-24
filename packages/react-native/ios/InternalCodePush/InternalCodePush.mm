#import "InternalCodePush.h"

@implementation InternalCodePush

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;

+ (void)setBundleURL:(NSURL *)url {
    _bundleURL = url;
}

+ (NSURL *)bundleURL {
    if (!_bundleURL) {
        #if DEBUG
            // Support React Native 0.72.6
            return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
        #else
            return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
        #endif
    }
    return _bundleURL;
}

RCT_EXPORT_METHOD(getBundleURL:(RCTResponseSenderBlock)callback) {
    NSString *urlString = [InternalCodePush.bundleURL absoluteString];
    callback(@[urlString]);
}

RCT_EXPORT_METHOD(setBundleURL:(NSString *)urlString) {
    [InternalCodePush setBundleURL:[NSURL URLWithString:urlString]];
}

@end