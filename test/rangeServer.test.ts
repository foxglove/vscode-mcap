import { McapIndexedReader } from "@mcap/core";
import { largeFixture } from "./fixtures";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { startRangeServer } from "../src/rangeServer";

async function fixture(
  t: import("node:test").TestContext,
  bytes = Buffer.from("0123456789abcdef"),
) {
  const dir = await mkdtemp(join(tmpdir(), "mcap-range-"));
  const path = join(dir, "recording.mcap");
  await writeFile(path, bytes);
  const server = await startRangeServer(path);
  t.after(async () => {
    await server.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { ...server, path, dir, bytes };
}
const headers = { Origin: "https://embed.foxglove.dev" };

test("HEAD, full GET, bounded, suffix, open-ended and clamped ranges", async (t) => {
  const f = await fixture(t);
  const head = await fetch(f.url, { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "16");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("access-control-allow-origin"), headers.Origin);
  assert.equal(await head.text(), "");
  assert.equal(await (await fetch(f.url)).text(), f.bytes.toString());
  for (const [range, text, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/16"],
    ["bytes=-3", "def", "bytes 13-15/16"],
    ["bytes=12-", "cdef", "bytes 12-15/16"],
    ["bytes=14-999999999999999999999", "ef", "bytes 14-15/16"],
    ["bytes=-99999999999999999999", f.bytes.toString(), "bytes 0-15/16"],
  ]) {
    const response = await fetch(f.url, {
      headers: { ...headers, Range: range },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.equal(Number(response.headers.get("content-length")), text.length);
    assert.equal(await response.text(), text);
  }
  const conditional = await fetch(f.url, {
    headers: { Range: "bytes=2-5", "If-Range": head.headers.get("etag")! },
  });
  assert.equal(conditional.status, 206);
  await conditional.arrayBuffer();
  const mismatch = await fetch(f.url, {
    headers: { Range: "bytes=2-5", "If-Range": '"stale"' },
  });
  assert.equal(mismatch.status, 200);
  assert.equal(await mismatch.text(), f.bytes.toString());
});

test("invalid ranges and empty files", async (t) => {
  const f = await fixture(t);
  for (const range of [
    "bytes=16-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=999999999999999999999-",
    "nope",
  ]) {
    const r = await fetch(f.url, { headers: { Range: range } });
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get("content-range"), "bytes */16");
    await r.arrayBuffer();
  }
  const empty = await fixture(t, Buffer.alloc(0));
  assert.equal(await (await fetch(empty.url)).text(), "");
  assert.equal(
    (await fetch(empty.url, { headers: { Range: "bytes=0-0" } })).status,
    416,
  );
});

test("only the capability URL and permitted origin/methods are served", async (t) => {
  const f = await fixture(t);
  for (const target of [
    new URL("/", f.url).href,
    f.url + "?file=/etc/passwd",
    f.url.replace("recording.mcap", "other.mcap"),
  ])
    assert.equal((await fetch(target)).status, 404);
  for (const origin of [
    "https://evil.example",
    "null",
    "https://embed.foxglove.dev.evil.example",
  ])
    assert.equal(
      (await fetch(f.url, { headers: { Origin: origin } })).status,
      403,
    );
  assert.equal((await fetch(f.url, { method: "POST" })).status, 405);
  const preflight = await fetch(f.url, {
    method: "OPTIONS",
    headers: {
      ...headers,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range, if-range",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true",
  );
  assert.equal(
    (
      await fetch(f.url, {
        method: "OPTIONS",
        headers: { ...headers, "Access-Control-Request-Method": "POST" },
      })
    ).status,
    403,
  );
});

test("modified or replaced recordings require reopening; disposal revokes URL", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, "changed");
  assert.equal((await fetch(f.url)).status, 409);
  const other = await fixture(t);
  const replacement = join(other.dir, "replacement");
  await writeFile(replacement, other.bytes);
  await rename(replacement, other.path);
  assert.equal((await fetch(other.url)).status, 409);
  await other.dispose();
  await other.dispose();
  await assert.rejects(fetch(other.url));
});

test("parallel reads remain independent", async (t) => {
  const f = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const r = await fetch(f.url, {
        headers: { Range: `bytes=${i}-${i + 2}` },
      });
      assert.equal(r.status, 206);
      assert.equal(await r.text(), f.bytes.subarray(i, i + 3).toString());
    }),
  );
  assert.equal(await (await fetch(f.url)).text(), f.bytes.toString());
});

test("1 TiB sparse file: large offsets, bounded streaming memory, cancellation and shutdown", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcap-large-range-"));
  const path = join(dir, "large.mcap");
  const length = 1024 ** 4;
  const file = await open(path, "w");
  await file.truncate(length);
  await file.write(Buffer.from("tail"), 0, 4, length - 4);
  await file.close();
  const server = await startRangeServer(path);
  t.after(async () => {
    await server.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const r = await fetch(server.url, {
    headers: { Range: `bytes=${length - 4}-${length - 1}` },
  });
  assert.equal(r.status, 206);
  assert.equal(
    r.headers.get("content-range"),
    `bytes ${length - 4}-${length - 1}/${length}`,
  );
  assert.equal(await r.text(), "tail");
  const before = process.memoryUsage().arrayBuffers;
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      get(server.url, resolve).once("error", reject);
    },
  );
  response.pause();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    process.memoryUsage().arrayBuffers - before < 32 * 1024 * 1024,
    "slow full-file GET must apply backpressure instead of buffering the file",
  );
  response.destroy();
  const afterAbort = await fetch(server.url, {
    headers: { Range: "bytes=-4" },
  });
  assert.equal(
    await afterAbort.text(),
    "tail",
    "aborting one reader must not close another reader's file handle",
  );
  const pending = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => get(server.url, resolve).once("error", reject),
  );
  pending.on("error", () => {});
  await server.dispose();
  pending.destroy();
  await assert.rejects(fetch(server.url));
});

test("indexed MCAP messages beyond 1 TiB are readable through HTTP ranges", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcap-indexed-range-"));
  const path = join(dir, "large.mcap");
  const size = await largeFixture(path);
  const server = await startRangeServer(path);
  t.after(async () => {
    await server.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  let transferred = 0;
  const reader = await McapIndexedReader.Initialize({
    readable: {
      size: async () => BigInt(size),
      read: async (offset, length) => {
        if (length === 0n) return new Uint8Array();
        const response = await fetch(server.url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1n}` },
        });
        assert.equal(response.status, 206);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(BigInt(bytes.length), length);
        transferred += bytes.length;
        return bytes;
      },
    },
  });
  const messages = [];
  for await (const message of reader.readMessages())
    messages.push(JSON.parse(Buffer.from(message.data).toString()));
  assert.deepEqual(messages, [{ value: 42 }]);
  assert.ok(
    transferred < 1024 * 1024,
    "only index and message ranges should be fetched",
  );
});
