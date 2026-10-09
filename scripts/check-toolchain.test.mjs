import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toolchainError } from "./check-toolchain.mjs";

test("explains the required toolchain and setup command for unsupported versions", () => {
  const error = toolchainError({
    nodeVersion: "v22.23.1",
    pnpmVersion: "9.1.1",
  });

  assert.match(error, /Node\.js >=24 <25/);
  assert.match(error, /pnpm >=11 <12/);
  assert.match(error, /Detected Node\.js v22\.23\.1 and pnpm 9\.1\.1/);
  assert.match(
    error,
    /npm exec --yes --package=node@24 --package=pnpm@11\.1\.2 -- pnpm install/,
  );
  assert.match(
    error,
    /npm exec --yes --package=node@24 --package=pnpm@11\.1\.2 -- pnpm dev/,
  );
});

test("accepts Node 24 and pnpm 11", () => {
  assert.equal(
    toolchainError({ nodeVersion: "v24.0.0", pnpmVersion: "11.1.2" }),
    null,
  );
});

test("reports an unavailable pnpm version instead of accepting it", () => {
  assert.match(
    toolchainError({ nodeVersion: "v24.0.0", pnpmVersion: "not detected" }),
    /Detected Node\.js v24\.0\.0 and pnpm not detected/,
  );
});

test("detects pnpm from PATH when the lifecycle user agent is absent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "whiteboard-toolchain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const pnpm = path.join(directory, "pnpm");
  await writeFile(pnpm, "#!/bin/sh\nprintf '11.1.2\\n'\n", { mode: 0o755 });

  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check-toolchain.mjs", import.meta.url))],
    { env: { PATH: directory, npm_config_user_agent: "" } },
  );

  assert.equal(result.status, 0, result.stderr.toString());
});
