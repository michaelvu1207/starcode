package expo.modules.starcodecomposereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class StarcodeComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarcodeComposerEditor")

    View(StarcodeComposerEditorView::class) {
      Prop("controlledDocumentJson") { view: StarcodeComposerEditorView, documentJson: String ->
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { view: StarcodeComposerEditorView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { view: StarcodeComposerEditorView, placeholder: String ->
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { view: StarcodeComposerEditorView, fontFamily: String ->
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { view: StarcodeComposerEditorView, fontSize: Double ->
        view.setFontSize(fontSize.toFloat())
      }
      Prop("lineHeight") { view: StarcodeComposerEditorView, lineHeight: Double ->
        view.setLineHeight(lineHeight.toFloat())
      }
      Prop("contentInsetVertical") { view: StarcodeComposerEditorView, contentInsetVertical: Double ->
        view.setContentInsetVertical(contentInsetVertical.toInt())
      }

      Prop("singleLineCentered") { view: StarcodeComposerEditorView, singleLineCentered: Boolean ->
        view.setSingleLineCentered(singleLineCentered)
      }
      Prop("editable") { view: StarcodeComposerEditorView, editable: Boolean ->
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { view: StarcodeComposerEditorView, scrollEnabled: Boolean ->
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { view: StarcodeComposerEditorView, autoFocus: Boolean ->
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { view: StarcodeComposerEditorView, autoCorrect: Boolean ->
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { view: StarcodeComposerEditorView, spellCheck: Boolean ->
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
      )

      AsyncFunction("focus") { view: StarcodeComposerEditorView ->
        view.focusEditor()
      }
      AsyncFunction("blur") { view: StarcodeComposerEditorView ->
        view.blurEditor()
      }
      AsyncFunction("setSelection") { view: StarcodeComposerEditorView, start: Int, end: Int ->
        view.setSelection(start, end)
      }
    }
  }
}
