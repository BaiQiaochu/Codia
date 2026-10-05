export interface CodeMirrorCore {
  EditorView: typeof import('@codemirror/view').EditorView;
  EditorState: typeof import('@codemirror/state').EditorState;
  Compartment: typeof import('@codemirror/state').Compartment;
  Transaction: typeof import('@codemirror/state').Transaction;
  defaultKeymap: typeof import('@codemirror/commands').defaultKeymap;
  history: typeof import('@codemirror/commands').history;
  historyKeymap: typeof import('@codemirror/commands').historyKeymap;
  bracketMatching: typeof import('@codemirror/language').bracketMatching;
  syntaxHighlighting: typeof import('@codemirror/language').syntaxHighlighting;
  drawSelection: typeof import('@codemirror/view').drawSelection;
  highlightActiveLine: typeof import('@codemirror/view').highlightActiveLine;
  keymap: typeof import('@codemirror/view').keymap;
  lineNumbers: typeof import('@codemirror/view').lineNumbers;
}

export async function loadCodeMirrorCore(): Promise<CodeMirrorCore> {
  const [
    view,
    state,
    commands,
    language,
  ] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
  ]);

  return {
    EditorView: view.EditorView,
    EditorState: state.EditorState,
    Compartment: state.Compartment,
    Transaction: state.Transaction,
    defaultKeymap: commands.defaultKeymap,
    history: commands.history,
    historyKeymap: commands.historyKeymap,
    bracketMatching: language.bracketMatching,
    syntaxHighlighting: language.syntaxHighlighting,
    drawSelection: view.drawSelection,
    highlightActiveLine: view.highlightActiveLine,
    keymap: view.keymap,
    lineNumbers: view.lineNumbers,
  };
}
