import * as React from "react";
import type { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";

/** TipTap focus("end") selection semantics, with synchronous DOM focus. */
export function focusComposerEndNow(editor: Editor) {
  const selection = Selection.atEnd(editor.state.doc);
  // Setting an identical selection clears stored formatting. Selection.atEnd
  // also retains NodeSelection for a trailing atomic block such as a rule.
  if (!editor.state.selection.eq(selection)) {
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  }
  editor.view.focus();
  editor.commands.scrollIntoView();
}

/**
 * Check focus ownership in the frame that changes DOM focus. TipTap's focus
 * command queues another frame internally, after an effect's guard has run.
 * The callback must focus synchronously so a newly focused native decision
 * cannot lose its Enter key to the composer between those two operations.
 */
export function scheduleComposerFocus(focusNow: () => void) {
  return requestAnimationFrame(() => {
    if (document.activeElement?.closest("[data-preserve-composer-focus]"))
      return;
    focusNow();
  });
}

export function focusComposerPreserve(editor: Editor | null) {
  // TipTap focus() is an immediate no-op when already focused. Do not queue a
  // later focus that could steal it back from an ordinary input the user chose.
  if (!editor || editor.isDestroyed || editor.view.hasFocus()) return;
  scheduleComposerFocus(() => {
    if (editor.isDestroyed || editor.view.hasFocus()) return;
    editor.view.focus();
    editor.commands.scrollIntoView();
  });
}

/**
 * Focus the composer editor on mount and whenever the active draft key
 * changes (channel switch, thread open).
 *
 * Matches the behaviour of Slack/Discord/Signal: the composer is ready to
 * accept typing without an explicit click. The `focus` callback is expected
 * to no-op until the underlying editor is mounted, and to change identity
 * once that happens — so listing it as a dep recovers from the
 * editor-not-ready-yet case on first render.
 *
 * The effect trigger deliberately excludes `disabled`: callers pass a
 * disabled flag that includes transient state like `isSending`, which would
 * otherwise re-fire autofocus after every send. When the main channel and
 * an open thread panel both have composers mounted, that race let the main
 * composer steal focus from the thread composer post-send. We only autofocus
 * on mount and on real navigation events (draft-key change).
 *
 * Guards:
 *  - Skip if the composer is currently disabled (archived channel, no
 *    channel, or in-flight send at the moment of mount).
 *  - Skip if focus already lives in another text-entry surface (open
 *    dialog input, search box, etc.) so we don't yank focus from the user.
 */
export function useComposerAutofocus(
  focus: () => void,
  draftKey: string | null | undefined,
  disabled: boolean,
) {
  // We read `disabled` at execution time but intentionally don't depend on
  // it — see the comment above.
  const disabledRef = React.useRef(disabled);
  disabledRef.current = disabled;

  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey is the trigger; disabled is read via ref
  React.useEffect(() => {
    if (disabledRef.current) return;
    if (typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) {
      // Native work decisions own keyboard focus while the editor finishes
      // mounting. Do not turn a decision's Enter key into a chat send.
      if (active.closest("[data-preserve-composer-focus]")) return;
      const tag = active.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        active.isContentEditable
      ) {
        return;
      }
    }
    focus();
  }, [draftKey, focus]);
}
