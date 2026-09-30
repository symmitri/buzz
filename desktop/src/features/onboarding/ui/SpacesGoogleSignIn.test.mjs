import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
let calls = [],
  connect,
  restore = async () => account;
const account = {
  id: "synthetic-human",
  name: "Synthetic",
  email: "synthetic@symmitri.ai",
  server_setup_pending: true,
};
const community = {
  id: "synthetic-alpha",
  name: "Alpha",
  relay_url: "wss://alpha.example.test",
  pubkey: "a".repeat(64),
};
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.isTauri = true;
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      calls.push(command);
      if (command === "spaces_get_google_account") return restore();
      if (command === "spaces_connect_community") return connect();
      if (command === "plugin:app|version") return "0.1.1";
      return null;
    },
    transformCallback: () => 1,
    unregisterCallback() {},
  };
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  localStorage.clear();
  calls = [];
  restore = async () => account;
});
after(() => dom.window.close());

async function mount() {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { CommunitiesProvider } = await import(
    "@/features/communities/useCommunities"
  );
  const { UpdaterProvider } = await import(
    "@/features/settings/hooks/UpdaterProvider"
  );
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider");
  const { SpacesGoogleSignIn } = await import("./SpacesGoogleSignIn.tsx");
  return render(
    createElement(
      CommunitiesProvider,
      null,
      createElement(
        ThemeProvider,
        { defaultTheme: "buzz" },
        createElement(
          UpdaterProvider,
          null,
          createElement(
            SpacesGoogleSignIn,
            null,
            createElement("p", null, "Vanilla community mounted"),
          ),
        ),
      ),
    ),
  );
}

test("community selection cannot repeat sign-in or cancel its own admitted session", async () => {
  let finish;
  connect = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { act, screen, waitFor } = await import("@testing-library/react");
  await mount();
  await waitFor(() => assert.equal(typeof finish, "function"));
  assert.equal(screen.queryByText("Vanilla community mounted"), null);
  await act(async () => finish(community));
  assert.ok(await screen.findByText("Vanilla community mounted"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  assert.equal(
    calls.filter((c) => c === "spaces_get_google_account").length,
    1,
  );
  assert.equal(calls.filter((c) => c === "spaces_connect_community").length, 1);
  assert.equal(
    calls.filter((c) => c === "spaces_cancel_google_login").length,
    0,
  );
});

test("failed admission leaves a working retry and never mounts cached chat", async () => {
  connect = async () => {
    throw "Synthetic admission unavailable";
  };
  const { fireEvent, screen } = await import("@testing-library/react");
  await mount();
  assert.ok(await screen.findByText("Synthetic admission unavailable"));
  assert.equal(screen.queryByText("Vanilla community mounted"), null);
  connect = async () => community;
  fireEvent.click(screen.getByRole("button", { name: "Connect Alpha" }));
  assert.ok(await screen.findByText("Vanilla community mounted"));
});

test("unmount cancels enrollment and discards a late admitted community", async () => {
  let finish;
  connect = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { act, waitFor } = await import("@testing-library/react");
  const view = await mount();
  await waitFor(() => assert.equal(typeof finish, "function"));
  view.unmount();
  await act(async () => finish(community));
  assert.equal(
    calls.filter((c) => c === "spaces_cancel_google_login").length,
    1,
  );
  assert.ok(
    !Object.keys(localStorage).some((key) =>
      localStorage.getItem(key)?.includes(community.relay_url),
    ),
  );
});

test("failed saved-account read reconnects without another Google login or forgetting identity", async () => {
  restore = async () => {
    throw "Company sign-in: request timed out. Try again.";
  };
  connect = async () => community;
  const { fireEvent, screen } = await import("@testing-library/react");
  await mount();
  assert.ok(
    await screen.findByText(
      "We could not check your saved sign-in. Try reconnecting.",
    ),
  );
  assert.equal(screen.queryByText("Vanilla community mounted"), null);
  restore = async () => account;
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
  assert.ok(await screen.findByText("Vanilla community mounted"));
  assert.equal(
    calls.filter((c) => c === "spaces_start_google_login").length,
    0,
  );
  assert.equal(
    calls.filter((c) => c === "spaces_forget_google_account").length,
    0,
  );
  assert.equal(calls.filter((c) => c === "spaces_connect_community").length, 1);
});
