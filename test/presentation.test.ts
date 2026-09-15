import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatDuration } from "../webview/format";
import { Preferences, type ViewerPreferences } from "../src/preferences";

test("human-readable sizes cover empty files, byte counts, and large recordings", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(String(5 * 1024 ** 3)), "5 GiB");
});
test("duration formatting trims only fractional zeroes without losing precision", () => {
  for (const [input, expected] of [
    ["2.000000000", "2 s"],
    ["2.500000000", "2.5 s"],
    ["0.000000001", "0.000000001 s"],
    ["120", "120 s"],
    ["0.000000000", "0 s"],
    ["18446744073.709551615", "18446744073.709551615 s"],
  ])
    assert.equal(formatDuration(input), expected);
  assert.equal(formatDuration(undefined), "—");
});
test("tab and layout preferences survive reopening and concurrent updates", async () => {
  let stored: unknown;
  const storage = {
    get: <T>(_key: string, fallback: T) => (stored ?? fallback) as T,
    update: async (_key: string, value: unknown) => {
      stored = value;
    },
  };
  const preferences = new Preferences(storage);
  assert.deepEqual(preferences.get(), { tab: "info" });
  const layout = {
    id: "cloud:sensors",
    name: "Sensors",
    data: { layout: "Plot!1" },
  };
  await Promise.all([
    preferences.update({ tab: "foxglove" }),
    preferences.update({ layout }),
  ]);
  assert.deepEqual(new Preferences(storage).get(), {
    tab: "foxglove",
    layout,
  });
  await preferences.update({ tab: "info" });
  assert.equal((stored as ViewerPreferences).layout?.id, layout.id);
  await preferences.update({ layout: undefined });
  assert.equal(new Preferences(storage).get().layout, undefined);
});
