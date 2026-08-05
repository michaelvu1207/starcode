#pragma once

#include <react/renderer/components/StarcodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/StarcodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/StarcodeMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char StarcodeMarkdownTextRunComponentName[];

using StarcodeMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    StarcodeMarkdownTextRunComponentName,
    StarcodeMarkdownTextRunProps,
    StarcodeMarkdownTextRunEventEmitter,
    StarcodeMarkdownTextRunState>;
}
