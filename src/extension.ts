import * as vscode from "vscode";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { html } from "./html";
import { startRangeServer, type RangeServer } from "./rangeServer";
import { LayoutStore } from "./layoutStore";
import { Preferences } from "./preferences";
import { inspectFile } from "./info";
import { layoutData, listLayouts, type Layout } from "./layouts";

export function activate(context: vscode.ExtensionContext) {
  const servers = new Set<RangeServer>();
  let stopping = false;
  context.subscriptions.push({
    dispose() {
      stopping = true;
      for (const server of servers) void server.dispose();
    },
  });
  const preferences = new Preferences(context.globalState);
  const layoutStore = new LayoutStore(context.globalState);
  const setKey = async () => {
    const key = await vscode.window.showInputBox({
      title: "Foxglove API key",
      prompt:
        "Used to read shared organization layouts. Stored in the editor secret storage.",
      password: true,
      ignoreFocusOut: true,
    });
    if (key?.trim()) await context.secrets.store("foxglove.apiKey", key.trim());
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("mcap.setApiKey", setKey),
    vscode.commands.registerCommand("mcap.clearApiKey", () =>
      context.secrets.delete("foxglove.apiKey"),
    ),
    vscode.window.registerCustomEditorProvider(
      "mcap.explorer",
      {
        async openCustomDocument(uri: vscode.Uri) {
          if (uri.scheme !== "file")
            throw new Error(
              "Foxglove MCAP Explorer requires a file on the extension host filesystem. In SSH/containers, install this extension remotely.",
            );
          return { uri, dispose() {} };
        },
        async resolveCustomEditor(
          document: vscode.CustomDocument,
          panel: vscode.WebviewPanel,
        ) {
          const webview = panel.webview;
          const media = vscode.Uri.joinPath(context.extensionUri, "dist");
          webview.options = {
            enableScripts: true,
            localResourceRoots: [media],
          };
          let scan: AbortController | undefined;
          let fileServer: RangeServer | undefined;
          let fileGeneration = 0;
          let disposed = false;
          const disposables: vscode.Disposable[] = [];
          let infoGeneration = 0;
          const post = (message: unknown) => {
            return disposed
              ? Promise.resolve(false)
              : webview.postMessage(message);
          };
          const report = (e: unknown, operation: string) =>
            post({
              type: "error",
              operation,
              message: e instanceof Error ? e.message : String(e),
            });

          let cloud: Layout[] = [];
          let selectedLayout = preferences.get().layout;
          const availableLayouts = () => [
            ...new Map(
              [
                ...layoutStore.list(),
                ...cloud,
                ...(selectedLayout ? [selectedLayout] : []),
              ].map((l) => [l.id, l]),
            ).values(),
          ];
          const sendLayouts = () =>
            post({
              type: "layouts",
              layouts: availableLayouts().map(({ id, name }) => ({
                id,
                name,
              })),
            });
          disposables.push(
            layoutStore.subscribe(() => {
              if (
                selectedLayout?.id.startsWith("local:") &&
                !layoutStore.list().some((l) => l.id === selectedLayout?.id)
              )
                selectedLayout = undefined;
              if (!disposed) void sendLayouts();
            }),
          );
          const readInfo = async () => {
            scan?.abort();
            const abort = new AbortController();
            scan = abort;
            const generation = ++infoGeneration;
            await post({ type: "infoLoading" });
            try {
              const info = await inspectFile(document.uri.fsPath, abort.signal);
              if (generation === infoGeneration && !abort.signal.aborted)
                await post({ type: "info", info });
            } catch (e) {
              if (generation === infoGeneration && !abort.signal.aborted)
                await post({
                  type: "infoError",
                  message: e instanceof Error ? e.message : String(e),
                });
            }
          };
          disposables.push(
            webview.onDidReceiveMessage(async (message) => {
              if (!message || typeof message.type !== "string") return;
              try {
                switch (message.type) {
                  case "setTab":
                    if (message.tab === "info" || message.tab === "foxglove")
                      await preferences.update({ tab: message.tab });
                    break;
                  case "saveLayout": {
                    const id = selectedLayout?.id ?? "mcap:default";
                    if (
                      !panel.active ||
                      message.id !== id ||
                      (preferences.get().layout?.id ?? "mcap:default") !== id
                    )
                      break;
                    const data = layoutData(message.data);
                    if (JSON.stringify(data).length > 10 * 1024 * 1024) break;
                    const next = {
                      id,
                      name: selectedLayout?.name ?? "My layout",
                      data,
                    };
                    if (
                      JSON.stringify(preferences.get().layout?.data) !==
                      JSON.stringify(data)
                    ) {
                      selectedLayout = next;
                      await preferences.update({ layout: next });
                    }
                    break;
                  }
                  case "signIn":
                    await vscode.env.openExternal(
                      vscode.Uri.parse("https://app.foxglove.dev/activate"),
                    );
                    break;
                  case "ready":
                    await post({
                      type: "config",
                      name: basename(document.uri.fsPath),
                      preferences: preferences.get(),
                      orgSlug:
                        vscode.workspace
                          .getConfiguration("mcap", document.uri)
                          .get<string>("orgSlug") || undefined,
                    });
                    await sendLayouts();
                    void readInfo();
                    break;
                  case "refresh":
                    await readInfo();
                    break;
                  case "loadFile": {
                    const generation = ++fileGeneration;
                    if (fileServer) {
                      const old = fileServer;
                      fileServer = undefined;
                      servers.delete(old);
                      await old.dispose();
                    }
                    const server = await startRangeServer(document.uri.fsPath);
                    servers.add(server);
                    try {
                      // Resolves/forwards the extension-host loopback port for SSH and containers.
                      const uri = await vscode.env.asExternalUri(
                        vscode.Uri.parse(server.url),
                      );
                      if (
                        disposed ||
                        stopping ||
                        generation !== fileGeneration
                      ) {
                        servers.delete(server);
                        await server.dispose();
                        break;
                      }
                      fileServer = server;
                      await post({ type: "file", url: uri.toString() });
                    } catch (error) {
                      servers.delete(server);
                      await server.dispose();
                      throw error;
                    }
                    break;
                  }
                  case "importLayout": {
                    const uris = await vscode.window.showOpenDialog({
                      filters: { "Foxglove layout": ["json"] },
                      canSelectMany: true,
                      title: "Import exported Foxglove layouts",
                    });
                    const additions: Layout[] = [];
                    for (const uri of uris ?? []) {
                      if (
                        (await vscode.workspace.fs.stat(uri)).size >
                        10 * 1024 * 1024
                      )
                        throw new Error("Layout exceeds 10 MB");
                      const data = layoutData(
                        JSON.parse(
                          Buffer.from(
                            await vscode.workspace.fs.readFile(uri),
                          ).toString("utf8"),
                        ),
                      );
                      const id = `local:${createHash("sha256").update(uri.toString()).digest("hex")}`;
                      additions.push({
                        id,
                        name: basename(uri.path, ".json"),
                        data,
                      });
                    }
                    if (additions.length) await layoutStore.import(additions);
                    break;
                  }
                  case "cloudLayouts": {
                    let key = await context.secrets.get("foxglove.apiKey");
                    if (!key) {
                      await setKey();
                      key = await context.secrets.get("foxglove.apiKey");
                    }
                    if (!key) break;
                    cloud = await listLayouts(key);
                    await sendLayouts();
                    await post({
                      type: "notice",
                      message: cloud.length
                        ? `Loaded ${cloud.length} shared layouts. Personal layouts can be imported as JSON.`
                        : "No shared layouts found. Personal layouts can be imported as JSON.",
                    });
                    break;
                  }
                  case "selectLayout": {
                    if (message.id === "") {
                      selectedLayout = undefined;
                      await preferences.update({ layout: undefined });
                      break;
                    }
                    const layout = availableLayouts().find(
                      (l) => l.id === message.id,
                    );
                    if (!layout)
                      throw new Error(
                        "Layout not found. Refresh shared layouts or import the JSON again.",
                      );
                    selectedLayout = layout;
                    await preferences.update({ layout });
                    await post({ type: "layout", layout });
                    break;
                  }
                  case "removeLayout":
                    if (
                      typeof message.id === "string" &&
                      message.id.startsWith("local:")
                    ) {
                      await layoutStore.remove(message.id);
                      if (preferences.get().layout?.id === message.id)
                        await preferences.update({ layout: undefined });
                    }
                    break;
                }
              } catch (e) {
                if (!disposed) await report(e, message.type);
              }
            }),
          );
          panel.onDidDispose(() => {
            disposed = true;
            fileGeneration++;
            if (fileServer) {
              servers.delete(fileServer);
              void fileServer.dispose();
            }
            scan?.abort();
            for (const d of disposables) d.dispose();
          });
          webview.html = html(webview, media);
        },
      },
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    ),
  );
}
