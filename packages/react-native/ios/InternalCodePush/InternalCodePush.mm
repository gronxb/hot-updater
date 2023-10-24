#import "InternalCodePush.h"

@implementation InternalCodePush

RCT_EXPORT_MODULE();

static NSURL *_bundleURL = nil;

+ (void)setBundleURL:(NSURL *)url {
    _bundleURL = url;
}

+ (NSURL *)bundleURL {
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