import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// Register Monaco's bundled Python and C/C++ language definitions.
import "monaco-editor/esm/vs/editor/editor.main.js";
import "monaco-editor/min/vs/editor/editor.main.css";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";

globalThis.MonacoEnvironment = {
  getWorker() {
    return new Worker("/editor.worker.js", { type: "module", name: "monaco-editor-worker" });
  },
};

export { monaco };

export function createEditor(container, roomId, language) {
  const extension = language === "c" ? "c" : "py";
  const model = monaco.editor.createModel("", language === "c" ? "cpp" : "python", monaco.Uri.parse(`inmemory://ccd/${roomId}/main.${extension}`));
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  const editor = monaco.editor.create(container, {
    model,
    theme: "vs-dark",
    automaticLayout: true,
    lineNumbers: "on",
    bracketPairColorization: { enabled: true },
    autoClosingBrackets: "always",
    tabSize: 4,
    insertSpaces: true,
    fontSize: 14,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    wordWrap: "on",
    scrollBeyondLastLine: false,
    minimap: { enabled: window.innerWidth >= 760 },
    readOnly: true,
    domReadOnly: true,
    ariaLabel: "Collaborative code editor",
  });
  return { editor, model };
}
