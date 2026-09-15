import { build } from "esbuild";
import { runTests } from "@vscode/test-electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const temp = await mkdtemp(`${tmpdir()}/mcap-integration-`);
try {
  await build({
    entryPoints: ["test/integration.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode", "playwright"],
    outfile: "dist/integration.js",
  });
  await runTests({
    vscodeExecutablePath:
      process.env.VSCODE_EXECUTABLE_PATH ||
      (process.platform === "darwin" &&
      existsSync("/Applications/Visual Studio Code.app/Contents/MacOS/Electron")
        ? "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"
        : undefined),
    extensionDevelopmentPath: resolve("."),
    extensionTestsPath: resolve("dist/integration.js"),
    extensionTestsEnv: {
      MCAP_TEST_DIR: temp,
      MCAP_CDP_PORT: String(port),
      MCAP_LIVE_EMBED: process.env.MCAP_LIVE_EMBED,
    },
    launchArgs: [
      temp,
      "--user-data-dir",
      process.env.MCAP_TEST_USER_DATA_DIR || `${temp}/user`,
      "--extensions-dir",
      `${temp}/extensions`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--remote-debugging-port=${port}`,
    ],
  });
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
} catch (error) {
  console.error("Test logs:", temp);
  throw error;
}
