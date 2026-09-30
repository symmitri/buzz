import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  document.body.replaceChildren();
});
after(() => dom.window.close());

async function mount() {
  const { renderHook } = await import("@testing-library/react");
  const { useComposerAutofocus } = await import("./useComposerAutofocus.ts");
  let calls = 0;
  const ui = renderHook(
    ({ focus, draft, disabled }) =>
      useComposerAutofocus(focus, draft, disabled),
    {
      initialProps: {
        focus: () => calls++,
        draft: "thread-one",
        disabled: false,
      },
    },
  );
  return {
    calls: () => calls,
    ready: (draft = "thread-one", disabled = false) =>
      ui.rerender({ focus: () => calls++, draft, disabled }),
  };
}

test("editor readiness preserves native account, consent and review heading focus", async () => {
  const ui = await mount();
  assert.equal(ui.calls(), 1);
  const section = document.createElement("section");
  section.setAttribute("data-preserve-composer-focus", "");
  section.innerHTML =
    '<button>Review access</button><button>Allow access</button><h3 tabindex="-1">Review personal access</h3>';
  document.body.append(section);
  for (const control of section.children) {
    control.focus();
    ui.ready();
    assert.equal(ui.calls(), 1);
    assert.equal(document.activeElement, control);
  }
});

test("normal channel navigation still focuses the composer while disabled editors and text entries retain their defaults", async () => {
  const ui = await mount();
  const navigation = document.createElement("button");
  navigation.textContent = "Another channel";
  document.body.append(navigation);
  navigation.focus();
  ui.ready("thread-two");
  assert.equal(ui.calls(), 2);
  ui.ready("thread-three", true);
  assert.equal(ui.calls(), 2);
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  ui.ready("thread-four");
  assert.equal(ui.calls(), 2);
  assert.equal(document.activeElement, input);
});

test("deferred composer focus cannot steal a native decision's Enter key after scheduling", async () => {
  const { scheduleComposerFocus } = await import("./useComposerAutofocus.ts");
  const queued = [];
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => queued.push(callback);
  try {
    const composer = document.createElement("textarea");
    composer.value = "Preserve my unsent thread draft";
    const section = document.createElement("section");
    section.setAttribute("data-preserve-composer-focus", "");
    section.innerHTML =
      "<button>Review draft</button><button>Share selected contribution</button>";
    document.body.append(composer, section);
    for (const control of section.children) {
      composer.focus();
      scheduleComposerFocus(() => composer.focus());
      control.focus();
      queued.shift()();
      assert.equal(document.activeElement, control);
      assert.equal(composer.value, "Preserve my unsent thread draft");
    }
    // Ordinary navigation still grants deferred focus to the same composer.
    document.activeElement.blur();
    scheduleComposerFocus(() => composer.focus());
    queued.shift()();
    assert.equal(document.activeElement, composer);
  } finally {
    globalThis.requestAnimationFrame = previous;
  }
});

test("real TipTap focus end preserves pending bold formatting and trailing atomic NodeSelection", async () => {
  const { Editor } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { NodeSelection } = await import("@tiptap/pm/state");
  const { focusComposerEndNow } = await import("./useComposerAutofocus.ts");
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ trailingNode: false })],
    content: "<p>Draft</p>",
    // JSDOM has no text geometry; selection/formatting still use the real editor.
    editorProps: { handleScrollToSelection: () => true },
  });
  try {
    editor.commands.setTextSelection(6);
    editor.commands.toggleBold();
    assert.equal(editor.state.storedMarks?.[0]?.type.name, "bold");
    focusComposerEndNow(editor);
    assert.equal(editor.state.storedMarks?.[0]?.type.name, "bold");
    editor.commands.insertContent(" next");
    assert.match(editor.getHTML(), /<strong> next<\/strong>/);
    editor.commands.setContent("<p>Draft</p><hr>");
    editor.commands.setTextSelection(1);
    focusComposerEndNow(editor);
    assert.ok(editor.state.selection instanceof NodeSelection);
    assert.equal(editor.state.selection.node.type.name, "horizontalRule");
    assert.equal(editor.state.selection.to, editor.state.doc.content.size);
  } finally {
    editor.destroy();
    globalThis.getComputedStyle = previous;
  }
});

test("real TipTap preserve focus keeps selection, stays a no-op while focused, and ignores destroyed views", async () => {
  const { Editor } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { focusComposerPreserve } = await import("./useComposerAutofocus.ts");
  const queued = [];
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => queued.push(callback);
  const element = document.createElement("div");
  const other = document.createElement("textarea");
  other.value = "My unrelated draft";
  document.body.append(element, other);
  const editor = new Editor({
    element,
    extensions: [StarterKit],
    content: "<p>Draft</p>",
    editorProps: { handleScrollToSelection: () => true },
  });
  try {
    editor.commands.setTextSelection(3);
    editor.view.focus();
    assert.ok(editor.view.hasFocus());
    focusComposerPreserve(editor);
    assert.equal(queued.length, 0);
    other.focus();
    assert.equal(document.activeElement, other);
    assert.equal(other.value, "My unrelated draft");
    // Re-enable/restoration uses the same actual production helper and keeps
    // the caret; a later native review focus wins before the queued frame.
    editor.setEditable(false, false);
    editor.setEditable(true, false);
    focusComposerPreserve(editor);
    queued.shift()();
    assert.ok(editor.view.hasFocus());
    assert.equal(editor.state.selection.from, 3);
    other.focus();
    focusComposerPreserve(editor);
    const review = document.createElement("button");
    review.setAttribute("data-preserve-composer-focus", "");
    document.body.append(review);
    review.focus();
    queued.shift()();
    assert.equal(document.activeElement, review);
    assert.equal(editor.state.selection.from, 3);
    other.focus();
    focusComposerPreserve(editor);
    editor.destroy();
    assert.doesNotThrow(() => queued.shift()());
    assert.doesNotThrow(() => focusComposerPreserve(editor));
    assert.equal(queued.length, 0);
    assert.equal(document.activeElement, other);
  } finally {
    editor.destroy();
    globalThis.requestAnimationFrame = previousFrame;
  }
});
