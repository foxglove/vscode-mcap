# Publishing MCAP Viewer

Publish the same reviewed VSIX to **Visual Studio Marketplace** for VS Code and **Open VSX** for Cursor. Cursor mirrors Open VSX, so discovery can lag behind publication. There is no separate Cursor upload step in this workflow. [Cursor guidance](https://forum.cursor.com/t/my-extension-not-searchable-in-cursor-marketplace-published-verified-on-open-vsx/165455)

## Finish the release identity

The project uses the MIT license in `LICENSE`, matching Foxglove CLI. Third-party licenses in `licenses/` and the generated `THIRD_PARTY_NOTICES.md` cover bundled dependencies separately.

Set the publisher account’s display name to **Foxglove** in the registry settings. The manifest’s publisher field is the stable account ID, not its display name. The package author is **Foxglove**.

The publisher is set to `foxglove`, making the extension identifier `foxglove.mcap-viewer`. Repository and support links point to `https://github.com/foxglove/vscode-mcap`. Confirm that the repository and issue tracker are publicly accessible before publishing.

Use the same publisher ID on both registries. The extension identifier is `foxglove.mcap-viewer`; choose it before the first public release. If publishing under an existing organization, obtain contributor access to its publisher and Open VSX namespace. Changing the publisher later creates a different extension identity.

`npm run package` rejects incomplete metadata. `npm run package:local` can still produce a development VSIX before the identity is decided. No script publishes automatically.

## Validate and package

```sh
npm ci
npm run verify
npm run test:integration
npm run package
```

The package command checks release metadata and bundles runtime JavaScript, decompression WASM, the PNG icon, README, changelog, and license notices. Development tools, fixtures, logs, source maps, and credentials are excluded using an explicit package allowlist.

CI runs integration tests on VS Code 1.96.0 and stable. To test a specific version locally, use `MCAP_TEST_VSCODE_VERSION=1.96.0 npm run test:integration`; this downloads that version rather than using the installed editor. `VSCODE_EXECUTABLE_PATH` can select a VS Code or Cursor executable explicitly. Unit tests use the `bzip2` CLI to create a compressed fixture; it is a development requirement, not a runtime dependency.

VS Code 1.96 has an observed renderer limitation: dynamic iframe color-scheme changes do not update the embedded viewer's media query. Its integration run checks the SDK's theme setting, file transport, layouts, and scanning; stable additionally checks iframe theme propagation. The README calls out the older-editor theme limitation.

To refresh the README screenshot from the production Foxglove Embed viewer, run `npm run screenshot`. It opens an isolated VS Code profile with a generated telemetry recording and a plot layout, waits up to 15 minutes for Foxglove device sign-in, then saves `assets/screenshot.png`. Sign in with an account that has Embed access. The capture profile is retained under the ignored `.vscode-test/screenshot-profile` directory so retakes can reuse sign-in. The recording contains no customer data. `MCAP_SCREENSHOT_PATH` can select a different output file. To capture the offline file-info view instead, use `MCAP_SCREENSHOT_PATH=assets/file-info.png npm run test:integration`.

Before the first public upload:

- Install the VSIX in a normal VS Code profile and an authenticated Cursor profile.
- Open a representative MCAP, including a large indexed recording and one of your compressed recordings.
- Verify range playback and reload in VS Code and Cursor; check SSH/container port forwarding separately. The endpoint binds to loopback and is resolved through `vscode.env.asExternalUri`.
- Verify Foxglove sign-in, playback, and switching to a real shared account layout.
- Verify importing a personal JSON layout, opening a second MCAP, and removing the imported layout.
- Check the extension listing's publisher, MCAP icon, support links, and version.
- Confirm that the chosen publisher may use the MCAP artwork and publish this extension under that identity.

Automated integration tests use the real Embed SDK with a controlled iframe to validate the protocol. For an additional live sign-in-page check, use `MCAP_LIVE_EMBED=1 npm run test:integration`. This does not authorize a Foxglove account or prove authenticated playback. Cursor's fresh test profile currently requires Cursor login before full interaction tests can run; `MCAP_TEST_USER_DATA_DIR` can point to a dedicated, already authenticated test profile. Never use your everyday profile for tests that open and close tabs.

## Visual Studio Marketplace

1. Sign in to the [publisher management portal](https://marketplace.visualstudio.com/manage) and create a publisher, or join your organization's existing publisher.
2. Set that publisher's ID in `package.json`, then run the validation and packaging commands above.
3. In the portal, select the publisher, choose **New extension → Visual Studio Code**, and upload `mcap-viewer-0.1.0.vsix`.
4. Wait for validation and check the public listing before announcing it.

The portal upload is the simplest first release and does not require putting a publishing token into this repository. For later CLI automation, follow Microsoft's current authentication instructions. Microsoft recommends Entra ID for automated publishing; its documentation states that global Azure DevOps PATs retire on December 1, 2026. [Official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

## Open VSX / Cursor

1. Sign in to [Open VSX](https://open-vsx.org/) with GitHub, complete the required Eclipse account/publisher agreement steps, and create an access token in your account settings.
2. Authenticate the CLI and create the namespace matching `package.json`:

   ```sh
   npx ovsx login foxglove
   npx ovsx create-namespace foxglove
   ```

   Enter the Open VSX token at the prompt. Skip namespace creation if it already exists and you are a contributor. The CLI normally uses the OS credential manager; see its documentation for fallback behavior.

3. Publish the reviewed package:

   ```sh
   npx ovsx publish mcap-viewer-0.1.0.vsix
   ```

4. Follow the namespace ownership process if the namespace is not yet verified. Namespace creation grants contributor access; verified ownership is a separate step.
5. Check the Open VSX listing, then search Cursor by `foxglove.mcap-viewer` after its registry has synced. If it remains absent, check Cursor's VS Code engine compatibility and contact Cursor support. A VSIX install remains available meanwhile.

Sources: [Open VSX publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions), [CLI authentication](https://github.com/eclipse-openvsx/openvsx/blob/main/cli/README.md), [namespace ownership](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

## Later releases

Update `version` and `CHANGELOG.md`, rerun the checks, build a new VSIX, and upload that same version to both registries. Do not reuse an already published version. Keep credentials in the registries' supported credential stores or CI secrets, outside this repository. CI validates and produces artifacts; it deliberately does not publish.
