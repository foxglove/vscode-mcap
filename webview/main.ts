import { FoxgloveViewer } from "@foxglove/embed";
import type { FileInfo } from "../src/info";
import type { Layout } from "../src/layouts";
import { formatBytes, formatDuration } from "./format";
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const send = (type: string, extra = {}) =>
  vscode.postMessage({ type, ...extra });
let viewer: FoxgloveViewer | undefined;
let orgSlug: string | undefined;
let channels: FileInfo["channels"] = [];
let activeLayout: Layout | undefined;
let loading = false;
let viewerReady = false;
let visualizing = false;
let generation = 0;
let readyTimer: number | undefined;
let fileRequest: AbortController | undefined;
let saving = false;
let lastSnapshot = "";

function status(text: string, error = false) {
  el("viewerStatus").textContent = text;
  el("viewerStatus").hidden = !text;
  el("viewerStatus").classList.toggle("error", error);
}
function notice(text: string, error = false) {
  el("noticeText").textContent = text;
  el("notice").hidden = !text;
  el("notice").classList.toggle("error", error);
}
function options(open: boolean) {
  el("viewerOptions").hidden = !open;
  el("options").setAttribute("aria-expanded", String(open));
}
function editorColorScheme(): "light" | "dark" {
  return document.body.classList.contains("vscode-light") ||
    document.body.classList.contains("vscode-high-contrast-light")
    ? "light"
    : "dark";
}
function syncTheme() {
  const scheme = editorColorScheme();
  document.documentElement.style.colorScheme = scheme;
  viewer?.setColorScheme(scheme);
}
const themeObserver = new MutationObserver(syncTheme);
themeObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
});
function showPane(visualize: boolean, remember = true) {
  if (!visualize) void saveLayout();
  visualizing = visualize;
  el("infoPane").hidden = visualize;
  el("viewerPane").hidden = !visualize;
  el("refresh").hidden = visualize;
  el("viewerActions").hidden = !visualize;
  el("infoTab").setAttribute("aria-pressed", String(!visualize));
  el("viewerTab").setAttribute("aria-pressed", String(visualize));
  options(false);
  if (remember) send("setTab", { tab: visualize ? "foxglove" : "info" });
  if (visualize && !viewer && !loading) {
    loading = true;
    status("Opening recording…");
    send("loadFile");
  }
}
function row(values: (string | number)[]) {
  const tr = document.createElement("tr");
  for (const value of values) {
    const td = document.createElement("td");
    td.textContent = String(value);
    tr.append(td);
  }
  return tr;
}
function renderChannels() {
  const query = el<HTMLInputElement>("filter").value.toLowerCase();
  const visible = channels.filter((c) =>
    `${c.topic} ${c.schema} ${c.encoding}`.toLowerCase().includes(query),
  );
  el("channels").replaceChildren(
    ...visible.map((c) =>
      row([
        c.id,
        c.topic,
        BigInt(c.messages).toLocaleString(),
        c.encoding,
        c.schema,
      ]),
    ),
  );
  el("channelCount").textContent = query
    ? `${visible.length} / ${channels.length}`
    : String(channels.length);
  el("emptyChannels").hidden = visible.length > 0;
  el("emptyChannels").textContent = channels.length
    ? "No matching channels."
    : "This file has no channels.";
}
function renderInfo(info: FileInfo) {
  el("infoStatus").className = "muted";
  el("infoStatus").textContent =
    info.method === "summary"
      ? "Read from MCAP summary"
      : "Scanned MCAP records";
  const cards = document.createElement("div");
  cards.className = "cards";
  for (const [label, value] of Object.entries({
    "File size": formatBytes(info.size),
    Messages: BigInt(info.messages).toLocaleString(),
    Duration: formatDuration(info.duration),
    Channels: info.channels.length,
  })) {
    const card = document.createElement("div");
    card.className = "card";
    card.textContent = label;
    if (label === "File size")
      card.title = `${BigInt(info.size).toLocaleString()} bytes`;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    card.append(strong);
    cards.append(card);
  }
  const details = document.createElement("dl");
  details.className = "file-details";
  for (const [label, value] of Object.entries({
    Start: info.start ?? "—",
    End: info.end ?? "—",
    Profile: info.profile || "None",
    Library: info.library || "Unknown",
    Compression: info.compression.join(", ") || "None",
    Chunks: info.chunks,
    Attachments: info.attachments,
    Metadata: info.metadata,
  })) {
    const item = document.createElement("div");
    item.className = "detail";
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    if (label === "Start" || label === "End")
      dd.title = "Unix seconds with nanosecond precision";
    item.append(dt, dd);
    details.append(item);
  }
  el("summary").replaceChildren(cards, details);
  channels = info.channels;
  renderChannels();
  el("schemas").replaceChildren(
    ...info.schemas.map((s) =>
      row([s.id, s.name, s.encoding, formatBytes(s.bytes)]),
    ),
  );
  el("schemaCount").textContent = String(info.schemas.length);
  el("topics").hidden = false;
}
async function saveLayout() {
  if (!viewer || !viewerReady || saving) return;
  const currentViewer = viewer;
  const currentGeneration = generation;
  const id = activeLayout?.id ?? "mcap:default";
  saving = true;
  let timeout: number | undefined;
  try {
    const data = await Promise.race([
      currentViewer.getLayout(),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("Layout snapshot timed out")),
          2000,
        );
      }),
    ]);
    if (
      viewer !== currentViewer ||
      currentGeneration !== generation ||
      id !== (activeLayout?.id ?? "mcap:default")
    )
      return;
    const serialized = JSON.stringify(data);
    if (data && serialized !== lastSnapshot) {
      send("saveLayout", { id, data });
      lastSnapshot = serialized;
    }
  } catch {
    /* A disconnected viewer cannot provide a layout snapshot. */
  } finally {
    window.clearTimeout(timeout);
    saving = false;
  }
}
async function loadFile(message: { url: string; name: string; size: number }) {
  const current = ++generation;
  fileRequest?.abort();
  fileRequest = new AbortController();
  viewerReady = false;
  try {
    const response = await fetch(message.url, { signal: fileRequest.signal });
    if (!response.ok)
      throw new Error(`Cannot read local MCAP (${response.status})`);
    const blob = await response.blob();
    if (current !== generation) return;
    if (blob.size !== message.size)
      throw new Error("MCAP file changed while loading. Reload the viewer.");
    viewer?.destroy();
    viewer = new FoxgloveViewer({
      parent: el("viewer"),
      orgSlug,
      initialDataSource: {
        type: "file",
        file: new File([blob], message.name, {
          type: "application/octet-stream",
        }),
      },
      initialLayoutParams: activeLayout
        ? { storageKey: activeLayout.id, opaqueLayout: activeLayout.data }
        : { storageKey: "mcap:default" },
      colorScheme: editorColorScheme(),
    });
    status("Connecting to Foxglove…");
    window.clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      if (current === generation)
        status(
          "Waiting for Foxglove. Check the viewer below; sign-in help is in Viewer options.",
        );
    }, 30000);
    viewer.addEventListener("ready", () => {
      window.clearTimeout(readyTimer);
      if (current === generation) {
        viewerReady = true;
        el("viewerPane").dataset.ready = "true";
        status("");
      }
    });
    viewer.addEventListener("error", (event) => {
      window.clearTimeout(readyTimer);
      if (current === generation)
        status(
          `Foxglove: ${typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail)}`,
          true,
        );
    });
  } catch (e) {
    if (current === generation)
      status(e instanceof Error ? e.message : String(e), true);
  } finally {
    if (current === generation) loading = false;
  }
}
function updateRemoveButton() {
  el<HTMLButtonElement>("remove").disabled =
    !el<HTMLSelectElement>("layouts").value.startsWith("local:");
}
el("infoTab").onclick = () => showPane(false);
el("viewerTab").onclick = () => showPane(true);
el("options").onclick = () => options(Boolean(el("viewerOptions").hidden));
el("closeOptions").onclick = () => {
  options(false);
  el("options").focus();
};
el("dismissNotice").onclick = () => notice("");
el("refresh").onclick = () => send("refresh");
el("signIn").onclick = () => send("signIn");
el("import").onclick = () => send("importLayout");
el("cloud").onclick = () => send("cloudLayouts");
el("remove").onclick = () =>
  send("removeLayout", { id: el<HTMLSelectElement>("layouts").value });
el("retry").onclick = async () => {
  await saveLayout();
  generation++;
  window.clearTimeout(readyTimer);
  fileRequest?.abort();
  viewer?.destroy();
  viewer = undefined;
  viewerReady = false;
  loading = false;
  delete el("viewerPane").dataset.ready;
  showPane(true);
};
el("filter").oninput = renderChannels;
el("layouts").onchange = () => {
  updateRemoveButton();
  lastSnapshot = "";
  const id = el<HTMLSelectElement>("layouts").value;
  send("selectLayout", { id });
  if (!id) {
    activeLayout = undefined;
    viewer?.selectLayout({ storageKey: "mcap:default" });
  }
};
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    options(false);
  }
});
window.addEventListener("message", (event) => {
  // VS Code replaces window.parent; use the host origin to exclude the embedded iframe.
  if (event.origin !== window.origin) return;
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  switch (message.type) {
    case "config":
      el("filename").textContent = message.name;
      el("filename").title = message.name;
      orgSlug = message.orgSlug;
      activeLayout = message.preferences?.layout;
      if (activeLayout)
        el<HTMLSelectElement>("layouts").add(
          new Option(activeLayout.name, activeLayout.id, true, true),
        );
      showPane(message.preferences?.tab === "foxglove", false);
      break;
    case "infoLoading":
      el("infoStatus").textContent = "Reading MCAP information…";
      el("infoStatus").className = "muted";
      break;
    case "info":
      renderInfo(message.info);
      break;
    case "infoError":
      el("infoStatus").textContent =
        `Unable to inspect MCAP: ${message.message}`;
      el("infoStatus").className = "error";
      el("summary").replaceChildren();
      el("topics").hidden = true;
      break;
    case "file":
      void loadFile(message);
      break;
    case "layouts": {
      const select = el<HTMLSelectElement>("layouts");
      const previous = select.value;
      select.replaceChildren(
        new Option("Default layout", ""),
        ...message.layouts.map(
          (l: { name: string; id: string }) => new Option(l.name, l.id),
        ),
      );
      if (message.layouts.some((l: { id: string }) => l.id === previous))
        select.value = previous;
      else if (activeLayout) {
        activeLayout = undefined;
        viewer?.selectLayout({ storageKey: "mcap:default" });
      }
      updateRemoveButton();
      break;
    }
    case "layout":
      if (message.layout.id !== el<HTMLSelectElement>("layouts").value) break;
      activeLayout = message.layout;
      lastSnapshot = "";
      viewer?.selectLayout({
        storageKey: message.layout.id,
        opaqueLayout: message.layout.data,
      });
      break;
    case "notice":
      notice(message.message);
      break;
    case "error":
      notice(message.message, true);
      if (message.operation === "loadFile") {
        status(message.message, true);
        loading = false;
      }
      break;
  }
});
const snapshotTimer = window.setInterval(() => {
  if (visualizing) void saveLayout();
}, 15000);
window.addEventListener("blur", () => {
  void saveLayout();
});
window.addEventListener("pagehide", () => {
  themeObserver.disconnect();
  generation++;
  window.clearInterval(snapshotTimer);
  window.clearTimeout(readyTimer);
  fileRequest?.abort();
  viewer?.destroy();
});
syncTheme();
updateRemoveButton();
send("ready");
