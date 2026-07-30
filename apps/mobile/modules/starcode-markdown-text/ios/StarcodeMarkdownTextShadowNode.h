#pragma once

#include <react/renderer/components/StarcodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/StarcodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char StarcodeMarkdownTextComponentName[];

struct StarcodeMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct StarcodeMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float StarcodeMarkdownTextAttachmentSize(const StarcodeMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float StarcodeMarkdownTextAttachmentBaselineOffset(
    const StarcodeMarkdownTextAttachmentRange &) {
  return -2;
}

class StarcodeMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<StarcodeMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<StarcodeMarkdownTextAttachmentRange> attachmentRanges;
};

class StarcodeMarkdownTextShadowNode final : public ConcreteViewShadowNode<
StarcodeMarkdownTextComponentName,
StarcodeMarkdownTextProps,
StarcodeMarkdownTextEventEmitter,
StarcodeMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  StarcodeMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<StarcodeMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<StarcodeMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
