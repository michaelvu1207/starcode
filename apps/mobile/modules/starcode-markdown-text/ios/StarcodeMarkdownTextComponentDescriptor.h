#pragma once

#include "StarcodeMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using StarcodeMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<StarcodeMarkdownTextShadowNode>;

void StarcodeMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
