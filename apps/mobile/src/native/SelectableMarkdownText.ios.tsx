import {
  SelectableMarkdownText as StarcodeSelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@starcode/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@starcode/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <StarcodeSelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
