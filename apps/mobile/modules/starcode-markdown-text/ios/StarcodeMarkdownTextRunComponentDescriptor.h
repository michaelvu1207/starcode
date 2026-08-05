#pragma once

#include "StarcodeMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using StarcodeMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<StarcodeMarkdownTextRunShadowNode>;

void StarcodeMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
