import * as vscode from "vscode";
import { McapWriter } from "@mcap/core";
import { chromium, type Frame } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Capture the production Embed UI with generated telemetry, never a mocked iframe. */
export async function run() {
  const parts: Uint8Array[] = [];
  let position = 0n;
  const writer = new McapWriter({
    writable: {
      position: () => position,
      write: async (bytes) => {
        parts.push(bytes.slice());
        position += BigInt(bytes.length);
      },
    },
  });
  await writer.start({ profile: "", library: "Foxglove MCAP Explorer demo" });
  const schemaId = await writer.registerSchema({
    name: "Telemetry",
    encoding: "jsonschema",
    data: Buffer.from(
      JSON.stringify({
        type: "object",
        properties: { value: { type: "number" } },
      }),
    ),
  });
  const channelId = await writer.registerChannel({
    schemaId,
    topic: "/sensor",
    messageEncoding: "json",
    metadata: new Map(),
  });
  for (let i = 0; i < 600; i++) {
    const time = 1700000000000000000n + BigInt(i) * 100000000n;
    await writer.addMessage({
      channelId,
      sequence: i,
      logTime: time,
      publishTime: time,
      data: Buffer.from(
        JSON.stringify({
          value: 20 + 5 * Math.sin(i / 35) + 1.5 * Math.sin(i / 9),
        }),
      ),
    });
  }
  await writer.end();
  const path = join(process.env.MCAP_TEST_DIR!, "telemetry.mcap");
  await writeFile(path, Buffer.concat(parts));
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${process.env.MCAP_CDP_PORT}`,
  );
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.workspace
      .getConfiguration("workbench")
      .update(
        "colorTheme",
        "Default Light Modern",
        vscode.ConfigurationTarget.Global,
      );
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        page.on("requestfailed", (request) =>
          console.log(
            "SCREENSHOT: Request failed",
            request.url(),
            request.failure(),
          ),
        );
        page.on("console", (message) => {
          if (message.type() === "error")
            console.log("SCREENSHOT: Browser error", message.text());
        });
      }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path));
    let frame: Frame | undefined;
    for (let i = 0; i < 100 && !frame; i++) {
      for (const context of browser.contexts())
        for (const page of context.pages())
          for (const candidate of page.frames())
            if (
              await candidate
                .locator("#viewerTab")
                .count()
                .catch(() => 0)
            )
              frame = candidate;
      if (!frame) await new Promise((r) => setTimeout(r, 200));
    }
    if (!frame) throw new Error("MCAP webview did not open");
    await frame.locator("#channels tr").waitFor();
    // Use the extension's normal SDK configuration message with an opaque demo layout.
    await frame.evaluate(() =>
      window.postMessage(
        {
          type: "config",
          name: "telemetry.mcap",
          preferences: {
            tab: "foxglove",
            layout: {
              id: "demo:telemetry",
              name: "Telemetry",
              data: {
                layout: "Plot!telemetry",
                configById: {
                  "Plot!telemetry": {
                    paths: [
                      {
                        value: "/sensor.value",
                        enabled: true,
                        timestampMethod: "receiveTime",
                      },
                    ],
                    xAxisVal: "timestamp",
                    legendDisplay: "floating",
                  },
                },
              },
            },
          },
        },
        "*",
      ),
    );
    console.log(
      "SCREENSHOT: Production Foxglove viewer open. Waiting up to 15 minutes for sign-in and recording data.",
    );
    let clickedSignIn = false;
    let reloadedAfterSignIn = false;
    let previousText = "";
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      const embed = frame
        .childFrames()
        .find((candidate) =>
          candidate.url().startsWith("https://embed.foxglove.dev"),
        );
      if (embed) {
        const signIn = embed.getByRole("button", {
          name: "Sign in to Foxglove",
          exact: true,
        });
        if (!clickedSignIn && (await signIn.count().catch(() => 0))) {
          await signIn.click();
          clickedSignIn = true;
        }
        const text = await embed
          .locator("body")
          .innerText()
          .catch(() => "");
        if (text !== previousText) {
          console.log("SCREENSHOT: Viewer state:", text.slice(0, 1500));
          previousText = text;
        }
        if (
          clickedSignIn &&
          text.includes("/sensor.value") &&
          !reloadedAfterSignIn
        ) {
          reloadedAfterSignIn = true;
          await frame.locator("#options").click();
          await frame.locator("#retry").click();
          continue;
        }
        if (text.includes("/sensor.value") && /\d{4}-\d{2}-\d{2}/.test(text)) {
          const sidebar = embed.getByRole("button", {
            name: "Hide left sidebar",
            exact: true,
          });
          if (await sidebar.count()) await sidebar.click();
          await frame.locator("#filename").hover();
          // Let the plot finish decoding and painting before capture.
          await new Promise((r) => setTimeout(r, 3000));
          await frame
            .locator("body")
            .screenshot({ path: process.env.MCAP_SCREENSHOT_PATH! });
          console.log("SCREENSHOT: Saved", process.env.MCAP_SCREENSHOT_PATH);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Timed out waiting for Foxglove sign-in and the demo plot");
  } finally {
    await browser.close();
  }
}
