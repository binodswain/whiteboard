import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function toolchainError({ nodeVersion, pnpmVersion }) {
  if (
    /^v?24\.\d+\.\d+$/.test(nodeVersion) &&
    /^11\.\d+\.\d+$/.test(pnpmVersion)
  )
    return null;

  return [
    "Whiteboard requires Node.js >=24 <25 and pnpm >=11 <12.",
    `Detected Node.js ${nodeVersion} and pnpm ${pnpmVersion}.`,
    "Use the supported toolchain to install or start the project:",
    "  npm exec --yes --package=node@24 --package=pnpm@11.1.2 -- pnpm install",
    "  npm exec --yes --package=node@24 --package=pnpm@11.1.2 -- pnpm dev",
  ].join("\n");
}

function detectedPnpmVersion(userAgent) {
  const fromUserAgent = userAgent?.match(/(?:^|\s)pnpm\/([^\s]+)/)?.[1];

  if (fromUserAgent) return fromUserAgent;

  try {
    return execFileSync("pnpm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "not detected";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const error = toolchainError({
    nodeVersion: process.version,
    pnpmVersion: detectedPnpmVersion(process.env.npm_config_user_agent),
  });

  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
