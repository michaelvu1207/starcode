#import "StarcodeMarkdownTextRun.h"
#import "StarcodeMarkdownText.h"
#import "StarcodeMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/StarcodeMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/StarcodeMarkdownTextSpec/Props.h>
#import <react/renderer/components/StarcodeMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface StarcodeMarkdownTextRun () <RCTStarcodeMarkdownTextRunViewProtocol>

@end

@implementation StarcodeMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<StarcodeMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const StarcodeMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<StarcodeMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<StarcodeMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::StarcodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::StarcodeMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::StarcodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::StarcodeMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> StarcodeMarkdownTextRunCls(void)
{
    return StarcodeMarkdownTextRun.class;
}

@end
