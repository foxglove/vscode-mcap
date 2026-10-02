import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFile, seconds } from "../src/info";
import { fixture } from "./fixtures";
import { compress } from "lz4js";
import zstd from "@foxglove/wasm-zstd";
import { execFileSync } from "node:child_process";

for (const mode of ["indexed", "scan", "zstd", "lz4", "bz2", "empty"] as const)
  test(`reads ${mode} MCAP`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcap-test-"));
    const path = join(dir, "test.mcap");
    try {
      await zstd.isLoaded;
      await fixture(
        path,
        mode === "lz4"
          ? {
              useStatistics: false,
              compressChunk: (data) => ({
                compression: "lz4",
                compressedData: compress(data),
              }),
            }
          : mode === "bz2"
            ? {
                useStatistics: false,
                compressChunk: (data) => ({
                  compression: "bz2",
                  compressedData: execFileSync("bzip2", ["-c"], {
                    input: data,
                  }),
                }),
              }
            : mode === "scan"
              ? { useStatistics: false }
              : mode === "zstd"
                ? {
                    useStatistics: false,
                    compressChunk: (data) => ({
                      compression: "zstd",
                      compressedData: zstd.compress(data),
                    }),
                  }
                : {},
        mode === "empty",
      );
      const info = await inspectFile(path);
      assert.equal(info.messages, mode === "empty" ? "0" : "3");
      if (mode !== "empty") {
        assert.equal(info.start, "1700000000.000000001");
        assert.equal(info.duration, "2.000000000");
        assert.equal(info.channels[0]?.topic, "/sensor");
        assert.equal(info.channels[0]?.messages, "3");
        assert.equal(info.schemas[0]?.name, "Reading");
        assert.equal(info.attachments, 1);
        assert.equal(info.metadata, 1);
      } else assert.equal(info.start, undefined);
      assert.equal(
        info.method,
        mode === "scan" || mode === "zstd" || mode === "lz4" || mode === "bz2"
          ? "scan"
          : "summary",
      );
      if (mode === "zstd" || mode === "lz4" || mode === "bz2")
        assert.deepEqual(info.compression, [mode]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
test("rejects invalid, truncated and trailing bytes; supports cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcap-test-"));
  const path = join(dir, "bad.mcap");
  try {
    await writeFile(path, "not mcap");
    await assert.rejects(inspectFile(path));
    const data = await fixture(path, { useStatistics: false });
    await writeFile(path, data.subarray(0, data.length - 12));
    await assert.rejects(inspectFile(path));
    await writeFile(path, Buffer.concat([data, Buffer.from("trailing")]));
    await assert.rejects(inspectFile(path));
    await fixture(path);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(inspectFile(path, abort.signal));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("preserves 64-bit nanosecond timestamps", () =>
  assert.equal(seconds(18446744073709551615n), "18446744073.709551615"));
