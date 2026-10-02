import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "@/renderer/stores/ui-store";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

vi.mock("@/renderer/features/right-panel/panels", () => ({ panelShortcuts: () => [] }));
afterEach(cleanup);
function Harness() {
  useGlobalShortcuts();
  return (
    <>
      <div className="xterm">
        <textarea aria-label="terminal" />
      </div>
      <div data-right-panel>
        <button type="button">tab</button>
      </div>
      <textarea aria-label="composer" />
    </>
  );
}

it("leaves terminal control keys and composing events to their owner", () => {
  useUiStore.setState({ searchOpen: false });
  const { getByLabelText } = render(<Harness />);
  fireEvent.keyDown(getByLabelText("terminal"), { key: "k", ctrlKey: true });
  expect(useUiStore.getState().searchOpen).toBe(false);
  fireEvent.keyDown(getByLabelText("composer"), { key: "k", ctrlKey: true, isComposing: true });
  expect(useUiStore.getState().searchOpen).toBe(false);
  fireEvent.keyDown(getByLabelText("composer"), { key: "k", ctrlKey: true });
  expect(useUiStore.getState().searchOpen).toBe(true);
});

it("closes a tab only when focus is in the right panel", () => {
  useUiStore.setState({
    rightPanelOpen: true,
    rightPanelTabs: [{ id: "close-me", view: "files", title: null }],
    activeTabId: "close-me",
  });
  const { getByLabelText, getByText } = render(<Harness />);
  fireEvent.keyDown(getByLabelText("composer"), { key: "w", ctrlKey: true });
  expect(useUiStore.getState().rightPanelTabs).toHaveLength(1);
  fireEvent.keyDown(getByText("tab"), { key: "w", ctrlKey: true });
  expect(useUiStore.getState().rightPanelOpen).toBe(false);
});
