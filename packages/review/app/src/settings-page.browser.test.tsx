import type { ReviewCanvasSettingsContent } from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { SettingsPage } from "./settings-page";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function unavailable(): never {
  throw new Error("not used in this test");
}

function settingsFixture(
  overrides: Partial<ReviewCanvasSettingsContent> = {},
): ReviewCanvasSettingsContent {
  return {
    web: true,
    telemetryEnabled: false,
    setTelemetryEnabled: unavailable,
    theme: "system",
    setTheme: async (choice) => choice,
    keymap: "none",
    setKeymap: unavailable,
    ctrlTab: "recent",
    setCtrlTab: unavailable,
    documentWidth: "standard",
    setDocumentWidth: async (choice) => choice,
    codeFontSize: 14,
    setCodeFontSize: async (size) => size,
    readyNotification: "off",
    setReadyNotification: unavailable,
    softwareMapEnabled: false,
    setSoftwareMapEnabled: async (enabled) => enabled,
    structuralDiffEnabled: false,
    setStructuralDiffEnabled: unavailable,
    scratchpadEnabled: false,
    setScratchpadEnabled: async (enabled) => enabled,
    diffrConfig: {
      read: unavailable,
      set: unavailable,
      saveSummarizer: unavailable,
      testSummarizer: unavailable,
    },
    reloadWindow: async () => {},
    manageExtensions: () => {},
    importVsCodeSettings: () => {},
    ...overrides,
  };
}

async function render(settings: ReviewCanvasSettingsContent) {
  const container = document.createElement("div");

  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<SettingsPage settings={settings} web />));

  return container;
}

describe("SettingsPage", () => {
  it("moves through a choice group with the arrow keys and one tab stop", async () => {
    let saved = "";

    const container = await render(
      settingsFixture({
        setTheme: async (choice) => {
          saved = choice;

          return choice;
        },
      }),
    );

    const group = container.querySelector(
      '[role="radiogroup"][aria-label="Theme"]',
    )!;

    const radios = [
      ...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ];

    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);

    radios[2]!.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(saved).toBe("dark");
    expect(document.activeElement).toBe(radios[1]);

    await userEvent.keyboard("{Home}");
    expect(saved).toBe("light");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("explains a failed save beside its row and keeps other rows usable", async () => {
    const container = await render(
      settingsFixture({
        setDocumentWidth: async () => {
          throw new Error("Server said no");
        },
      }),
    );

    const wide = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ].find((radio) => radio.textContent === "Wide")!;

    await act(async () => wide.click());

    const alert = container.querySelector('[role="alert"]')!;

    expect(alert.textContent).toContain("Document width");
    expect(alert.textContent).toContain("Server said no");
    expect(
      container.querySelector('[role="radio"][aria-checked="true"]')
        ?.textContent,
    ).toBeTruthy();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Software Map"]',
      )?.disabled,
    ).toBe(false);
  });

  it("toggles a setting from its visible label", async () => {
    let enabled = false;

    const container = await render(
      settingsFixture({
        setSoftwareMapEnabled: async (next) => {
          enabled = next;

          return next;
        },
      }),
    );

    const label = [...container.querySelectorAll<HTMLElement>("label")].find(
      (element) => element.textContent === "Software Map",
    )!;

    await act(async () => label.click());
    expect(enabled).toBe(true);
  });
});
