import { readFile } from "node:fs/promises";
import path from "node:path";

import { writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

export const webSettingsSchema = z.strictObject({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  documentWidth: z.enum(["standard", "wide", "full"]).default("standard"),
  codeFontSize: z.number().int().min(8).max(32).default(14),
  scratchpadEnabled: z.boolean().default(false),
});

export type WebSettings = z.infer<typeof webSettingsSchema>;

export const webSettingsUpdateSchema = webSettingsSchema.partial();

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
