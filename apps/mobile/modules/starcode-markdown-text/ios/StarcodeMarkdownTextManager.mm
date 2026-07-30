#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface StarcodeMarkdownTextManager : RCTViewManager
@end

@implementation StarcodeMarkdownTextManager

RCT_EXPORT_MODULE(StarcodeMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface StarcodeMarkdownTextRunManager : RCTViewManager
@end

@implementation StarcodeMarkdownTextRunManager

RCT_EXPORT_MODULE(StarcodeMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
