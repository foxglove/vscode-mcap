import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import type { ReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const EMBED_ORIGIN = "https://embed.foxglove.dev";
const BUFFER_SIZE = 64 * 1024;
const MAX_REQUESTS = 16;

// Single byte ranges, including suffix/open-ended requests. BigInt prevents overflow
// when a client sends offsets larger than JavaScript's exact integer range.
function rangeBounds(
  range: string,
  size: number,
): [number, number] | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || size === 0) return;
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (!suffix) return;
    return [Number(suffix >= length ? 0n : length - suffix), size - 1];
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) return;
  return [Number(start), Number(end >= length ? length - 1n : end)];
}

export interface RangeServer {
  readonly url: string;
  dispose(): Promise<void>;
}

/** A capability URL serving one pinned file, never a directory or an arbitrary path. */
export async function startRangeServer(path: string): Promise<RangeServer> {
  const file = await open(path, "r");
  try {
    const initial = await file.stat({ bigint: true });
    if (!initial.isFile())
      throw new Error("MCAP source must be a regular file.");
    if (initial.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(
        "MCAP file exceeds the supported filesystem offset range.",
      );
    const size = Number(initial.size);
    const route = `/${randomBytes(32).toString("hex")}/recording.mcap`;
    const etag = `"${initial.ino}-${initial.size}-${initial.mtimeNs}-${initial.ctimeNs}"`;
    const streams = new Set<ReadStream>();
    let closed = false;
    let active = 0;
    let disposal: Promise<void> | undefined;

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Check the exact request target: no query parameters, traversal, or alternate files.
      if (closed || req.url !== route) {
        res.writeHead(404).end();
        return;
      }
      const origin = req.headers.origin;
      if (origin && origin !== EMBED_ORIGIN) {
        res.writeHead(403).end();
        return;
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", EMBED_ORIGIN);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Expose-Headers",
          "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
        );
      }
      if (req.method === "OPTIONS") {
        if (
          !origin ||
          !["GET", "HEAD"].includes(
            req.headers["access-control-request-method"] ?? "",
          )
        ) {
          res.writeHead(403).end();
          return;
        }
        const headers = String(
          req.headers["access-control-request-headers"] ?? "",
        )
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          headers.some(
            (h) =>
              ![
                "range",
                "if-range",
                "if-none-match",
                "if-modified-since",
              ].includes(h),
          )
        ) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Range, If-Range, If-None-Match, If-Modified-Since",
        );
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD, OPTIONS");
        res.writeHead(405).end();
        return;
      }
      if (active >= MAX_REQUESTS) {
        res.setHeader("Retry-After", "1");
        res.writeHead(503).end();
        return;
      }
      active++;
      let stream: ReadStream | undefined;
      let finished = false;
      const release = () => {
        if (finished) return;
        finished = true;
        active--;
        stream?.destroy();
      };
      res.once("close", release);
      res.once("finish", release);
      const requestFile = await open(path, "r");
      let ownedByStream = false;
      try {
        const current = await requestFile.stat({ bigint: true });
        if (closed || res.destroyed) return;
        if (
          current.dev !== initial.dev ||
          current.ino !== initial.ino ||
          current.size !== initial.size ||
          current.mtimeNs !== initial.mtimeNs ||
          current.ctimeNs !== initial.ctimeNs
        ) {
          res
            .writeHead(409, { "Content-Type": "text/plain" })
            .end("Recording changed. Reload the viewer.");
          return;
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("ETag", etag);
        res.setHeader(
          "Last-Modified",
          new Date(Number(initial.mtimeMs)).toUTCString(),
        );
        let start = 0;
        let end = size - 1;
        let code = 200;
        if (
          req.method === "GET" &&
          req.headers.range &&
          (!req.headers["if-range"] ||
            req.headers["if-range"] === etag ||
            req.headers["if-range"] === res.getHeader("Last-Modified"))
        ) {
          const bounds = rangeBounds(req.headers.range, size);
          if (!bounds) {
            res.setHeader("Content-Range", `bytes */${size}`);
            res.writeHead(416).end();
            return;
          }
          [start, end] = bounds;
          code = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        res.setHeader("Content-Length", end - start + 1);
        if (req.method === "HEAD" || size === 0) {
          res.writeHead(code).end();
          return;
        }
        stream = requestFile.createReadStream({
          autoClose: true,
          start,
          end,
          highWaterMark: BUFFER_SIZE,
        });
        ownedByStream = true;
        streams.add(stream);
        stream.once("close", () => streams.delete(stream!));
        stream.once("error", () => res.destroy());
        res.writeHead(code);
        // pipe applies backpressure; memory depends on active requests, not file size.
        stream.pipe(res);
      } finally {
        if (!ownedByStream) await requestFile.close();
      }
    };
    const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
      void handle(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      });
    });
    server.maxConnections = 64;
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.timeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`,
      dispose() {
        if (disposal) return disposal;
        closed = true;
        disposal = (async () => {
          const stopped = new Promise<void>((resolve) =>
            server.close(() => resolve()),
          );
          server.closeAllConnections();
          await Promise.all(
            [...streams].map(
              (stream) =>
                new Promise<void>((resolve) => {
                  stream.once("close", resolve);
                  stream.destroy();
                }),
            ),
          );
          await stopped;
          await file.close();
        })();
        return disposal;
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}
