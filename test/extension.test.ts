import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

test("removing an imported layout clears every panel and rejects stale snapshots", async () => {
  const layout = { id: "local:plot", name: "Plot", data: { layout: "Plot!1" } };
  const saved = new Map<string, unknown>([
    ["importedLayouts", [layout]],
    ["viewerPreferences", { tab: "info", layout }],
  ]);
  let provider: any;
  const disposable = { dispose() {} };
  const vscode = {
    commands: { registerCommand: () => disposable },
    window: {
      registerCustomEditorProvider: (_name: string, value: unknown) => {
        provider = value;
        return disposable;
      },
    },
    Uri: { joinPath: (...parts: string[]) => parts.join("/") },
  };
  const result = await build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    loader: { ".wasm": "file", ".html": "text", ".css": "text" },
    outfile: "dist/test-extension.js",
    write: false,
  });
  const module = { exports: {} as { activate: (context: unknown) => void } };
  const require = createRequire(import.meta.url);
  new Function(
    "require",
    "module",
    "exports",
    "__dirname",
    result.outputFiles.find((f) => f.path.endsWith(".js"))!.text,
  )(
    (name: string) => (name === "vscode" ? vscode : require(name)),
    module,
    module.exports,
    process.cwd(),
  );
  module.exports.activate({
    subscriptions: [],
    extensionUri: "extension",
    globalState: {
      get: (key: string, fallback: unknown) => saved.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
    },
  });
  const panel = async () => {
    let receive: (message: unknown) => Promise<void> = async () => {};
    const messages: any[] = [];
    await provider.resolveCustomEditor(
      { uri: { fsPath: "test.mcap" } },
      {
        active: true,
        onDidDispose: () => disposable,
        webview: {
          cspSource: "test",
          asWebviewUri: (uri: string) => uri,
          postMessage: async (message: unknown) => {
            messages.push(message);
            return true;
          },
          onDidReceiveMessage: (handler: typeof receive) => {
            receive = handler;
            return disposable;
          },
        },
      },
    );
    return { messages, receive: (message: unknown) => receive(message) };
  };
  const first = await panel();
  const second = await panel();
  await first.receive({ type: "removeLayout", id: layout.id });
  for (const editor of [first, second])
    assert.deepEqual(editor.messages.at(-1), { type: "layouts", layouts: [] });
  await second.receive({
    type: "saveLayout",
    id: layout.id,
    data: layout.data,
  });
  assert.deepEqual(saved.get("importedLayouts"), []);
  assert.deepEqual(saved.get("viewerPreferences"), {
    tab: "info",
    layout: undefined,
  });
});
