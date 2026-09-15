import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import template from "../webview/index.html";
import styles from "../webview/style.css";

export function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomUUID().replaceAll("-", "");
  const script = webview
    .asWebviewUri(vscode.Uri.joinPath(media, "webview.js"))
    .toString();
  return template
    .replaceAll("{{nonce}}", nonce)
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{script}}", script)
    .replace("{{styles}}", styles);
}
