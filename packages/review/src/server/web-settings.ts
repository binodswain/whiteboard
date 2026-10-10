import { readFile } from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

const themeSchema = z.enum(["system", "light", "dark"]);

const documentWidthSchema = z.enum(["standard", "wide", "full"]);

const codeFontSizeSchema = z.number().int().min(8).max(32);

const scratchpadEnabledSchema = z.boolean();

const softwareMapEnabledSchema = z.boolean();

export const webSettingsSchema = z.strictObject({
  theme: themeSchema.default("system"),
  documentWidth: documentWidthSchema.default("standard"),
  codeFontSize: codeFontSizeSchema.default(14),
  scratchpadEnabled: scratchpadEnabledSchema.default(false),
  softwareMapEnabled: softwareMapEnabledSchema.default(false),
});

export type WebSettings = z.infer<typeof webSettingsSchema>;

export const webSettingsUpdateSchema = z.strictObject({
  theme: themeSchema.optional(),
  documentWidth: documentWidthSchema.optional(),
  codeFontSize: codeFontSizeSchema.optional(),
  scratchpadEnabled: scratchpadEnabledSchema.optional(),
  softwareMapEnabled: softwareMapEnabledSchema.optional(),
});

export function createWebSettings(stateDir: string) {
  const file = path.join(stateDir, "web-settings.json");
  let writes = Promise.resolve();

  async function read(): Promise<WebSettings> {
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      const result = webSettingsSchema.safeParse(raw);

      return result.success ? result.data : webSettingsSchema.parse({});
    } catch {
      return webSettingsSchema.parse({});
    }
  }

  async function update(patch: Partial<WebSettings>): Promise<WebSettings> {
    const operation = writes.then(async () => {
      const next = webSettingsSchema.parse({ ...(await read()), ...patch });
      await writePrivateJsonAtomic(file, next);

      return next;
    });

    writes = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  return { read, update };
}
