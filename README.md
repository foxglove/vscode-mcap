# MCAP Viewer

Inspect MCAP files and visualize with Foxglove in VS Code or Cursor.

## Get started

1. Install **MCAP Viewer** from the extension marketplace.
2. Open an `.mcap` file to see file size, duration, message counts, channels, and schemas. No CLI or account is needed for file information.
3. Select **Foxglove** to visualize the recording. Sign in if prompted. Visualization requires internet access and [Foxglove Embed access](https://docs.foxglove.dev/docs/embed).

If the file opens in another editor, choose **Reopen Editor With… → MCAP Viewer**.

Your last tab and layout are remembered, and the viewer follows your editor theme.

## Layouts and sign-in

Under **Viewer options**:

- **Load shared layouts…** loads organization layouts using a Foxglove API key with layout read access.
- **Import JSON…** loads an exported layout, including personal layouts.
- **Sign-in help → Open sign-in page** lets you enter the viewer’s activation code if its sign-in popup is blocked.

Layout edits are saved locally, not back to your Foxglove account. API keys are stored securely by the editor; use **MCAP: Clear Foxglove API Key** in the Command Palette to remove one.

The viewer defaults to a 512 MB file limit, configurable with `mcap.maxViewerFileSizeMB`. Larger files can still be inspected in **File info**.
