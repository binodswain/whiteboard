import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { createWebSettings, webSettingsUpdateSchema } from "./web-settings.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("defaults safely and persists validated updates under the state directory", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "whiteboard-web-settings-"));
  const settings = createWebSettings(directory);

  expect(await settings.read()).toEqual({
    theme: "system",
    documentWidth: "standard",
    codeFontSize: 14,
    scratchpadEnabled: false,
  });
  expect(
    await settings.update({ theme: "dark", scratchpadEnabled: true }),
  ).toMatchObject({ theme: "dark", scratchpadEnabled: true });
  expect(
    JSON.parse(
      await readFile(path.join(directory, "web-settings.json"), "utf8"),
    ),
  ).toMatchObject({
    theme: "dark",
    scratchpadEnabled: true,
  });
  await expect(settings.update({ codeFontSize: 100 })).rejects.toThrow(
    "Too big",
  );
});

it("omits defaults from partial updates", () => {
  expect(webSettingsUpdateSchema.parse({ codeFontSize: 16 })).toEqual({
    codeFontSize: 16,
  });
});
