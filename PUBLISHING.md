# Publishing Foxglove MCAP Explorer

Publish the reviewed VSIX to **Visual Studio Marketplace** for VS Code.

## Finish the release identity

The project uses the MIT license in `LICENSE`, matching Foxglove CLI. Third-party licenses in `licenses/` and the generated `THIRD_PARTY_NOTICES.md` cover bundled dependencies separately.

`@foxglove/embed` 0.70.0 declares MIT but omits a license file from its npm package. Its Foxglove-confirmed notice is vendored in `licenses/foxglove-embed.txt`. The notice generator uses this fallback only for that version; confirm the notice again when upgrading if the new package still omits its license file.

Set the publisher account’s display name to **Foxglove** in the Marketplace settings. The manifest’s publisher field is the stable account ID, not its display name. The package author is **Foxglove**.

The publisher is set to `Foxglove`, making the extension identifier `Foxglove.foxglove-mcap-explorer`. Repository and support links point to `https://github.com/foxglove/vscode-mcap`. Confirm that the repository and issue tracker are publicly accessible before publishing.

The extension identifier is `Foxglove.foxglove-mcap-explorer`; choose it before the first public release. If publishing under an existing organization, obtain contributor access to its Marketplace publisher. Changing the publisher later creates a different extension identity.

`npm run package` rejects incomplete metadata. `npm run package:local` can still produce a development VSIX before the identity is decided. No script publishes automatically.

## Validate and package

```sh
npm ci
npm run verify
npm run test:integration
npm run package
```

The package command checks release metadata and bundles runtime JavaScript, decompression WASM, the PNG icon, README, changelog, and license notices. Development tools, fixtures, logs, source maps, and credentials are excluded using an explicit package allowlist.

CI runs integration tests on VS Code 1.96.0 and stable. To test a specific version locally, use `MCAP_TEST_VSCODE_VERSION=1.96.0 npm run test:integration`; this downloads that version rather than using the installed editor. `VSCODE_EXECUTABLE_PATH` can select a VS Code executable explicitly. Unit tests use the `bzip2` CLI to create a compressed fixture; it is a development requirement, not a runtime dependency.

VS Code 1.96 has an observed renderer limitation: dynamic iframe color-scheme changes do not update the embedded viewer's media query. Its integration run checks the SDK's theme setting, file transport, layouts, and scanning; stable additionally checks iframe theme propagation. The README calls out the older-editor theme limitation.

To refresh the README screenshot from the production Foxglove Embed viewer, run `npm run screenshot`. It opens an isolated VS Code profile with a generated telemetry recording and a plot layout, waits up to 15 minutes for Foxglove device sign-in, then saves `assets/screenshot.png`. Sign in with an account that has Embed access. The capture profile is retained under the ignored `.vscode-test/screenshot-profile` directory so retakes can reuse sign-in. The recording contains no customer data. `MCAP_SCREENSHOT_PATH` can select a different output file. To capture the offline file-info view instead, use `MCAP_SCREENSHOT_PATH=assets/file-info.png npm run test:integration`.

Before the first public upload:

- Install the VSIX in a normal VS Code profile.
- Open a representative MCAP, including a large indexed recording and one of your compressed recordings.
- Verify range playback and reload in VS Code; check SSH/container port forwarding separately. The endpoint binds to loopback and is resolved through `vscode.env.asExternalUri`.
- Verify Foxglove sign-in, playback, and switching to a real shared account layout.
- Verify importing a personal JSON layout, opening a second MCAP, and removing the imported layout.
- Check the extension listing's publisher, MCAP icon, support links, and version.
- Confirm that the chosen publisher may use the MCAP artwork and publish this extension under that identity.

Automated integration tests use the real Embed SDK with a controlled iframe to validate the protocol. For an additional live sign-in-page check, use `MCAP_LIVE_EMBED=1 npm run test:integration`. This does not authorize a Foxglove account or prove authenticated playback. `MCAP_TEST_USER_DATA_DIR` can point to a dedicated, already authenticated test profile. Never use your everyday profile for tests that open and close tabs.

## Visual Studio Marketplace

1. Sign in to the [publisher management portal](https://marketplace.visualstudio.com/manage) and create a publisher, or join your organization's existing publisher.
2. Set that publisher's ID in `package.json`, then run the validation and packaging commands above.
3. In the portal, select the publisher, choose **New extension → Visual Studio Code**, and upload `foxglove-mcap-explorer-0.1.0.vsix`.
4. Wait for validation and check the public listing before announcing it.

The portal upload is the simplest first release and does not require putting a publishing token into this repository. For later CLI automation, follow Microsoft's current authentication instructions. Microsoft recommends Entra ID for automated publishing; its documentation states that global Azure DevOps PATs retire on December 1, 2026. [Official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

## Later releases

Update `version` and `CHANGELOG.md`, rerun the checks, build a new VSIX, and upload it to the Visual Studio Marketplace. Do not reuse an already published version. Keep credentials in the publishing tool's supported credential store or CI secrets, outside this repository. CI validates and produces artifacts; it deliberately does not publish.
