import * as vscode from "vscode";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium, type Frame } from "playwright";
import { fixture } from "./fixtures";

async function until<T>(
  fn: () => Promise<T | undefined>,
  label: string,
  timeout = 20000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
export async function run() {
  const path = join(process.env.MCAP_TEST_DIR!, "sample.mcap");
  const data = await fixture(path);
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${process.env.MCAP_CDP_PORT}`,
  );
  try {
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        page.on("console", (msg) => {
          if (msg.type() === "error") console.log("WEB ERROR:", msg.text());
        });
        page.on("response", (r) => {
          if (r.status() >= 400)
            console.log("HTTP ERROR:", r.status(), r.url());
        });
        page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
        page.on("requestfailed", (r) =>
          console.log("FAILED:", r.url(), r.failure()),
        );
      }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path));
    await until(
      async () =>
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputCustom || undefined,
      "automatic MCAP custom editor",
    );
    assert.equal(
      (
        vscode.window.tabGroups.activeTabGroup.activeTab!
          .input as vscode.TabInputCustom
      ).viewType,
      "mcap.viewer",
    );
    const frame = await until<Frame>(async () => {
      for (const context of browser.contexts())
        for (const page of context.pages())
          for (const f of page.frames())
            if (
              await f
                .locator("#infoTab")
                .count()
                .catch(() => 0)
            )
              return f;
    }, "webview frame");
    await frame
      .locator("#channels tr")
      .waitFor()
      .catch(async (e) => {
        console.log(
          "Webview:",
          await frame.locator("body").innerText(),
          await frame
            .locator("script")
            .evaluateAll((elements) =>
              elements.map((e) => e.getAttribute("src")),
            ),
        );
        throw e;
      });
    assert.match(await frame.locator("#channels").innerText(), /\/sensor/);
    assert.match(
      await frame.locator("#summary").innerText(),
      /1700000000\.000000001/,
    );
    assert.match(await frame.locator(".cards").innerText(), /2 s/);
    assert.doesNotMatch(
      await frame.locator(".cards").innerText(),
      /2\.000000000/,
    );
    assert.match(await frame.locator(".cards").innerText(), /KiB| B/);
    assert.equal(
      await frame.locator("#viewer iframe").count(),
      0,
      "offline info does not load embed",
    );
    await frame.locator("#filter").fill("missing");
    assert.equal(await frame.locator("#channels tr").count(), 0);
    await frame.locator("#filter").fill("sensor");
    assert.equal(await frame.locator("#channels tr").count(), 1);
    if (
      vscode.env.appName.includes("Cursor") &&
      (await frame.page().locator("body").innerText()).includes(
        "The best way to code with AI",
      )
    ) {
      await mkdir("test-results", { recursive: true });
      await frame
        .page()
        .screenshot({ path: "test-results/cursor-onboarding.png" });
      throw new Error(
        "Cursor automatic MCAP association and info rendering passed, but Cursor's first-run login screen blocks interaction. Complete Cursor login in a dedicated test profile to continue.",
      );
    }
    await frame.locator("#refresh").click();
    await frame.locator("#channels tr").waitFor();
    // Let iframe color-scheme inheritance drive media queries; Playwright defaults to light.
    await frame.page().emulateMedia({ colorScheme: null });
    const context = frame.page().context();
    await context.route("https://embed.foxglove.dev/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Embed transport fixture</title><style>
      :root { color-scheme: light dark; }
      body { background: white; }
      @media (prefers-color-scheme: dark) { body { background: black; } }
      </style><body>Embed transport fixture<script>
      window.themeQuery = matchMedia('(prefers-color-scheme: light)');
      window.themeQuery.addEventListener('change', () => {});
      window.received=[];
      window.currentLayout={layout:'Plot!remembered',configById:{'Plot!remembered':{paths:[]}}};
      window.addEventListener('message',async e=>{
        window.received.push(e.data);
        if(e.data.type==='get-layout') parent.postMessage({type:'foxglove-layout-data',payload:window.currentLayout},'*');
        if(e.data.type==='handshake-ack'){
          window.currentLayout=e.data.payload.initialLayoutParams.opaqueLayout || window.currentLayout;
          const file=e.data.payload.initialDataSource.file;
          window.fileBytes=Array.from(new Uint8Array(await file.arrayBuffer()));
          window.fileName=file.name;
          parent.postMessage({type:'foxglove-handshake-complete'},'*');
        }
      });
      parent.postMessage({type:'foxglove-handshake-request'},'*');
      </script>`,
      }),
    );
    await frame.locator("#viewerTab").click();
    await until(
      async () =>
        (await frame.locator("#viewerPane").getAttribute("data-ready")) ===
          "true" || undefined,
      "embed handshake",
    );
    const embed = await until<Frame>(
      async () =>
        frame
          .childFrames()
          .find((f) => f.url().startsWith("https://embed.foxglove.dev")),
      "embed frame",
    );
    assert.deepEqual(
      await embed.evaluate("window.fileBytes"),
      Array.from(data),
      "exact MCAP bytes reached Foxglove SDK iframe",
    );
    assert.equal(await embed.evaluate("window.fileName"), "sample.mcap");
    assert.equal(await frame.locator("#viewerOptions").isVisible(), false);
    assert.equal(await frame.locator("#viewerStatus").isVisible(), false);
    assert.equal(await frame.locator("#focus, #exitFocus").count(), 0);
    const originalTheme = vscode.workspace
      .getConfiguration("workbench")
      .get<string>("colorTheme");
    const originalIframe = await frame
      .locator("#viewer iframe")
      .elementHandle();
    try {
      for (const [theme, scheme] of [
        ["Default Light Modern", "light"],
        ["Default Dark Modern", "dark"],
        ["Default High Contrast Light", "light"],
        ["Default High Contrast", "dark"],
      ]) {
        await vscode.workspace
          .getConfiguration("workbench")
          .update("colorTheme", theme, vscode.ConfigurationTarget.Global);
        await until(
          async () =>
            (await frame
              .locator("#viewer iframe")
              .evaluate(
                (node) => (node as HTMLIFrameElement).style.colorScheme,
              )) === scheme || undefined,
          `embed follows ${theme}`,
        );
        await until(
          async () =>
            (await embed.evaluate(
              "matchMedia('(prefers-color-scheme: light)').matches",
            )) ===
              (scheme === "light") || undefined,
          `iframe media query follows ${theme}`,
        ).catch(async (error) => {
          console.log(
            "THEME DIAGNOSTICS",
            await frame.locator("#viewer iframe").evaluate((node) => ({
              style: node.getAttribute("style"),
              computed: getComputedStyle(node).colorScheme,
              root: getComputedStyle(document.documentElement).colorScheme,
              classes: document.body.className,
            })),
            await embed.evaluate(
              "({light:matchMedia('(prefers-color-scheme: light)').matches, background:getComputedStyle(document.body).backgroundColor})",
            ),
          );
          throw error;
        });
        assert.equal(
          await originalIframe!.evaluate(
            (node) => node === document.querySelector("#viewer iframe"),
          ),
          true,
          "theme changes preserve viewer instance",
        );
      }
    } finally {
      await vscode.workspace
        .getConfiguration("workbench")
        .update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
    }
    console.log(
      "PASS live editor theme changes, including high contrast, without recreating viewer",
    );
    await frame.locator("#options").click();
    assert.equal(await frame.locator("#viewerOptions").isVisible(), true);
    await frame.locator("#closeOptions").click();
    // Host message exercises the real SDK layout selection; UI import uses a native file dialog.
    await frame.evaluate(() =>
      window.postMessage(
        {
          type: "layouts",
          layouts: [{ id: "test-layout", name: "Test plot" }],
        },
        "*",
      ),
    );
    await frame
      .locator('#layouts option[value="test-layout"]')
      .waitFor({ state: "attached" });
    await frame.locator("#layouts").evaluate((element) => {
      (element as HTMLSelectElement).value = "test-layout";
    });
    await frame.evaluate(() =>
      window.postMessage(
        {
          type: "layout",
          layout: {
            id: "test-layout",
            name: "Test plot",
            data: {
              layout: "Plot!test",
              configById: { "Plot!test": { paths: [] } },
            },
          },
        },
        "*",
      ),
    );
    await until(
      async () =>
        embed.evaluate(
          "window.received.some(m=>m.type==='select-layout' && m.payload.storageKey==='test-layout')",
        ),
      "SDK layout selection",
    ).catch(async (error) => {
      console.log(
        "Selection debug",
        await frame.locator("#layouts").inputValue(),
        await embed.evaluate("window.received"),
      );
      throw error;
    });
    await frame.locator("#infoTab").click();
    assert.equal(await frame.locator("#infoPane").isVisible(), true);
    await frame.locator("#viewerTab").click();
    assert.equal(await frame.locator("#viewer iframe").count(), 1);
    await mkdir("test-results", { recursive: true });
    await frame.page().screenshot({
      path: join(
        "test-results",
        `${vscode.env.appName.replaceAll(" ", "-")}-viewer.png`,
      ),
    });
    await embed.evaluate(() =>
      parent.postMessage({ type: "config", name: "untrusted iframe" }, "*"),
    );
    assert.equal(await frame.locator("#filename").innerText(), "sample.mcap");
    await frame.locator("#infoTab").click();
    await frame.page().screenshot({
      path: join(
        "test-results",
        `${vscode.env.appName.replaceAll(" ", "-")}-info.png`,
      ),
    });
    await frame.locator("#viewerTab").click();
    if (process.env.MCAP_LIVE_EMBED === "1") {
      await context.unroute("https://embed.foxglove.dev/**");
      // Check the production embed page, independently from transport fixture assertions.
      await frame.locator("#options").click();
      await frame.locator("#retry").click();
      const live = await until<Frame>(
        async () =>
          frame
            .childFrames()
            .find((f) => f.url().startsWith("https://embed.foxglove.dev")),
        "live embed frame",
      );
      const liveText = await until(
        async () => {
          const text = await live
            .locator("body")
            .innerText()
            .catch(() => "");
          return text.length > 30 ? text : undefined;
        },
        "live embed content",
        45000,
      );
      await writeFile(
        join(
          "test-results",
          `${vscode.env.appName.replaceAll(" ", "-")}-live-embed.txt`,
        ),
        liveText,
      );
      await frame.page().screenshot({
        path: join(
          "test-results",
          `${vscode.env.appName.replaceAll(" ", "-")}-live.png`,
        ),
      });
      console.log(
        `PASS ${vscode.env.appName}: automatic editor, summary, filtering, refresh, byte-exact SDK file transfer, layout selection, tab lifecycle, live embed loaded.`,
      );
      console.log(`Live embed state: ${liveText.slice(0, 500)}`);
      const signIn = live.getByRole("button", {
        name: "Sign in to Foxglove",
        exact: true,
      });
      if (await signIn.count()) {
        await signIn.click();
        await until(
          async () =>
            (await live.locator("body").innerText()).includes(
              "enter the code below",
            ) || undefined,
          "Foxglove device activation prompt",
        );
        console.log(
          "PASS Foxglove device activation prompt (account authorization not performed)",
        );
      }
    } else {
      console.log(
        "PASS offline SDK transport and editor integration (live Foxglove check is opt-in)",
      );
    }
    if (process.env.MCAP_LIVE_EMBED !== "1") {
      // Reset to the default layout so the genuine host can persist a viewer snapshot.
      await frame.locator("#options").click();
      await frame.locator("#layouts").selectOption("");
      await frame.locator("#closeOptions").click();
      await frame.locator("#infoTab").click();
      await until(
        async () =>
          embed.evaluate("window.received.some(m=>m.type==='get-layout')"),
        "layout snapshot",
      );
      await frame.locator("#viewerTab").click();
      const nextPath = join(process.env.MCAP_TEST_DIR!, "second.mcap");
      await fixture(nextPath);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(nextPath),
      );
      const restored = await until<Frame>(async () => {
        for (const page of context.pages())
          for (const candidate of page.frames())
            if (
              (await candidate
                .locator("#filename")
                .textContent({ timeout: 500 })
                .catch(() => "")) === "second.mcap"
            )
              return candidate;
      }, "reopened MCAP");
      await until(
        async () =>
          (await restored.locator("#viewerPane").getAttribute("data-ready")) ===
            "true" || undefined,
        "restored viewer tab",
      );
      const restoredEmbed = restored
        .childFrames()
        .find((f) => f.url().startsWith("https://embed.foxglove.dev"))!;
      assert.equal(
        await restoredEmbed.evaluate("window.currentLayout.layout"),
        "Plot!remembered",
        "viewer layout restored from saved preferences",
      );
      await restored.locator("#infoTab").click();
      console.log("PASS tab and layout restoration across files");
    }
    // Verify the deployed WASM assets by scanning a file without statistics inside the extension bundle.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fixture(path, { useStatistics: false });
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path));
    const scan = await until<Frame>(async () => {
      for (const page of context.pages())
        for (const f of page.frames())
          if (
            await f
              .locator("#infoStatus")
              .count()
              .catch(() => 0)
          )
            return f;
    }, "scan webview");
    await until(
      async () =>
        (await scan.locator("#infoStatus").innerText()).includes(
          "Scanned MCAP",
        ) || undefined,
      "bundled WASM scan",
    );
    console.log(
      "PASS packaged decompression initialization and streaming scan",
    );
  } finally {
    await browser.close();
  }
}
