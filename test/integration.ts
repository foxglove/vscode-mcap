import * as vscode from "vscode";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium, type Frame } from "playwright";
import { fixture, largeFixture } from "./fixtures";
import { execFileSync } from "node:child_process";

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
      "mcap.explorer",
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
    if (process.env.MCAP_SCREENSHOT_PATH)
      await frame.locator("body").screenshot({
        path: process.env.MCAP_SCREENSHOT_PATH,
      });
    await frame.locator("#filter").fill("missing");
    assert.equal(await frame.locator("#channels tr").count(), 0);
    await frame.locator("#filter").fill("sensor");
    assert.equal(await frame.locator("#channels tr").count(), 1);
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
          try {
            const source=e.data.payload.initialDataSource;
            if(source.type !== 'remote-file' || source.file) throw new Error('Expected URL-only data source');
            window.fileUrl=source.urls[0];
            // Match Foxglove's reader: discover size with GET, abort immediately,
            // then open independent byte-range requests.
            const controller=new AbortController();
            const probe=await fetch(window.fileUrl,{signal:controller.signal,cache:'no-store'});
            controller.abort();
            if(!probe.ok || probe.headers.get('accept-ranges') !== 'bytes') throw new Error('Missing range support');
            const size=Number(probe.headers.get('content-length'));
            window.fileSize=size;
            const first=await fetch(window.fileUrl,{headers:{Range:'bytes=0-7'}});
            const last=await fetch(window.fileUrl,{headers:{Range:'bytes=-8'}});
            if(first.status !== 206 || last.status !== 206) throw new Error('Expected partial responses');
            window.firstBytes=Array.from(new Uint8Array(await first.arrayBuffer()));
            window.lastBytes=Array.from(new Uint8Array(await last.arrayBuffer()));
            window.contentRange=last.headers.get('content-range');
          } catch(error) { window.transportError=String(error); throw error; }
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
      await embed.evaluate("window.firstBytes"),
      Array.from(data.subarray(0, 8)),
      "MCAP header reached iframe through HTTP range read",
    );
    assert.deepEqual(
      await embed.evaluate("window.lastBytes"),
      Array.from(data.subarray(-8)),
      "MCAP footer reached iframe through suffix range read",
    );
    assert.equal(await embed.evaluate("window.fileSize"), data.length);
    assert.equal(
      await embed.evaluate("window.contentRange"),
      `bytes ${data.length - 8}-${data.length - 1}/${data.length}`,
    );
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
        // VS Code 1.96's renderer does not propagate dynamic color-scheme
        // changes into the cross-origin iframe. Still check the SDK style above.
        if (!vscode.version.startsWith("1.96."))
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
      vscode.version.startsWith("1.96.")
        ? "PASS SDK theme setting (VS Code 1.96 iframe media inheritance is limited)"
        : "PASS live editor theme changes, including high contrast, without recreating viewer",
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
        `PASS ${vscode.env.appName}: automatic editor, summary, filtering, refresh, byte-exact SDK HTTP range reads, layout selection, tab lifecycle, live embed loaded.`,
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
      const closedUrl = await embed.evaluate<string>("window.fileUrl");
      const nextPath = join(process.env.MCAP_TEST_DIR!, "second.mcap");
      const largeSize = await largeFixture(nextPath);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(nextPath),
      );
      await until(
        async () =>
          fetch(closedUrl).then(
            () => undefined,
            () => true,
          ),
        "closed editor revokes range endpoint",
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
      assert.equal(await restoredEmbed.evaluate("window.fileSize"), largeSize);
      assert.ok(
        largeSize > 1024 ** 4,
        "browser opens a terabyte MCAP without copying it",
      );
      await restored.locator("#infoTab").click();
      await until(
        async () =>
          (await restored.locator(".cards").innerText()).includes("TiB") ||
          undefined,
        "large MCAP indexed summary",
      );
      console.log(
        "PASS terabyte MCAP range access from browser and indexed file info",
      );
      await restored.locator("#viewerTab").click();
      const oldUrl = await restoredEmbed.evaluate<string>("window.fileUrl");
      await restored.locator("#options").click();
      await restored.locator("#retry").click();
      await until(async () => {
        const child = restored
          .childFrames()
          .find((f) => f.url().startsWith("https://embed.foxglove.dev"));
        if (!child || child.isDetached()) return;
        // Reload destroys the old iframe asynchronously. It can detach between
        // childFrames() and evaluate(), so retry only that expected transition.
        const newUrl = await child
          .evaluate<string | undefined>("window.lastBytes && window.fileUrl")
          .catch((error: unknown) => {
            if (child.isDetached()) return undefined;
            throw error;
          });
        return newUrl && newUrl !== oldUrl ? true : undefined;
      }, "reload restores range playback");
      await until(
        async () =>
          fetch(oldUrl).then(
            () => undefined,
            () => true,
          ),
        "reload revokes previous endpoint",
      );
      await restored.locator("#infoTab").click();
      console.log("PASS tab and layout restoration across files");
    }
    // Verify the deployed bzip2 WASM by decoding a compressed file without statistics.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fixture(path, {
      useStatistics: false,
      compressChunk: (data) => ({
        compression: "bz2",
        compressedData: execFileSync("bzip2", ["-c"], { input: data }),
      }),
    });
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
    assert.match(await scan.locator("#channels").innerText(), /\/sensor/);
    assert.match(await scan.locator("#summary").innerText(), /bz2/);
    console.log("PASS packaged bzip2 decompression and streaming scan");
  } finally {
    await browser.close();
  }
}
