import { readFile, access } from "node:fs/promises";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const errors = [];
if (!manifest.license)
  errors.push(
    "Add the project license and set package.json license before publishing.",
  );
if (!manifest.publisher || manifest.publisher === "local-mcap")
  errors.push(
    "Set package.json publisher to the Visual Studio Marketplace publisher you own or can contribute to.",
  );
const repository =
  typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository?.url;
if (!repository || !/^https:\/\//.test(repository))
  errors.push(
    "Set package.json repository.url to the public HTTPS repository URL.",
  );
if (!manifest.homepage || !manifest.bugs?.url)
  errors.push("Set package.json homepage and bugs.url for users and support.");
if (manifest.icon !== "assets/icon.png")
  errors.push("The manifest must reference assets/icon.png.");
for (const file of [
  "assets/icon.png",
  "assets/screenshot.png",
  "LICENSE",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  try {
    await access(file);
  } catch {
    errors.push(`Missing release asset: ${file}`);
  }
}
if (errors.length) {
  console.error(
    `Release metadata is incomplete:\n${errors.map((e) => `- ${e}`).join("\n")}`,
  );
  process.exitCode = 1;
} else
  console.log(
    "Release metadata checks passed. Complete the authenticated playback and Marketplace publisher checklist in PUBLISHING.md before uploading.",
  );
