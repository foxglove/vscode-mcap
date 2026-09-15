import { setImmediate as yieldToHost } from "node:timers/promises";
import { open } from "node:fs/promises";
import {
  McapIndexedReader,
  McapStreamReader,
  type IReadable,
  type Channel,
  type Schema,
} from "@mcap/core";
import { loadDecompressHandlers } from "@mcap/support";

export interface FileInfo {
  size: string;
  profile: string;
  library: string;
  method: "summary" | "scan";
  messages: string;
  start?: string;
  end?: string;
  duration?: string;
  chunks: number;
  attachments: number;
  metadata: number;
  compression: string[];
  channels: {
    id: number;
    topic: string;
    encoding: string;
    schema: string;
    messages: string;
  }[];
  schemas: { id: number; name: string; encoding: string; bytes: number }[];
}
export function seconds(ns: bigint): string {
  return `${ns / 1000000000n}.${(ns % 1000000000n).toString().padStart(9, "0")}`;
}
export async function inspectFile(
  path: string,
  signal?: AbortSignal,
): Promise<FileInfo> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("The selected path is not a regular file");
    const readable: IReadable = {
      size: async () => BigInt(stat.size),
      read: async (offset, size) => {
        signal?.throwIfAborted();
        if (
          offset < 0n ||
          size < 0n ||
          size > BigInt(Number.MAX_SAFE_INTEGER) ||
          offset + size > BigInt(stat.size)
        )
          throw new Error("Invalid MCAP read range");
        const data = Buffer.alloc(Number(size));
        let filled = 0;
        while (filled < data.length) {
          const { bytesRead } = await handle.read(
            data,
            filled,
            data.length - filled,
            Number(offset) + filled,
          );
          if (!bytesRead)
            throw new Error("MCAP file changed or ended unexpectedly");
          filled += bytesRead;
        }
        return data;
      },
    };
    let channels = new Map<number, Channel>(),
      schemas = new Map<number, Schema>();
    let counts = new Map<number, bigint>(),
      messages = 0n,
      start: bigint | undefined,
      end: bigint | undefined;
    let profile = "",
      library = "",
      chunks = 0,
      attachments = 0,
      metadata = 0;
    const compression = new Set<string>();
    let method: FileInfo["method"] = "scan";
    let indexed: McapIndexedReader | undefined;
    try {
      indexed = await McapIndexedReader.Initialize({ readable });
    } catch {
      signal?.throwIfAborted();
    }
    if (
      indexed?.statistics &&
      indexed.channelsById.size === indexed.statistics.channelCount &&
      indexed.schemasById.size === indexed.statistics.schemaCount
    ) {
      method = "summary";
      const s = indexed.statistics;
      channels = new Map(indexed.channelsById);
      schemas = new Map(indexed.schemasById);
      counts = new Map(s.channelMessageCounts);
      messages = s.messageCount;
      if (messages > 0n) {
        start = s.messageStartTime;
        end = s.messageEndTime;
      }
      ({ profile, library } = indexed.header);
      chunks = s.chunkCount;
      attachments = s.attachmentCount;
      metadata = s.metadataCount;
      for (const c of indexed.chunkIndexes)
        compression.add(c.compression || "none");
    } else {
      const reader = new McapStreamReader({
        includeChunks: true,
        decompressHandlers: await loadDecompressHandlers(),
      });
      for (let offset = 0; offset < stat.size; offset += 1024 * 1024) {
        signal?.throwIfAborted();
        reader.append(
          await readable.read(
            BigInt(offset),
            BigInt(Math.min(1024 * 1024, stat.size - offset)),
          ),
        );
        let recordsRead = 0;
        for (let record; (record = reader.nextRecord());) {
          if (++recordsRead % 4096 === 0) {
            await yieldToHost();
            signal?.throwIfAborted();
          }
          switch (record.type) {
            case "Header":
              ({ profile, library } = record);
              break;
            case "Channel":
              channels.set(record.id, record);
              break;
            case "Schema":
              schemas.set(record.id, record);
              break;
            case "Message":
              messages++;
              counts.set(
                record.channelId,
                (counts.get(record.channelId) ?? 0n) + 1n,
              );
              start =
                start === undefined || record.logTime < start
                  ? record.logTime
                  : start;
              end =
                end === undefined || record.logTime > end
                  ? record.logTime
                  : end;
              break;
            case "Chunk":
              chunks++;
              compression.add(record.compression || "none");
              break;
            case "Attachment":
              attachments++;
              break;
            case "Metadata":
              metadata++;
              break;
          }
        }
      }
      if (!reader.done() || reader.bytesRemaining() !== 0)
        throw new Error(
          "Incomplete or invalid MCAP file (missing footer or trailing data)",
        );
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error(
        "MCAP file changed while reading. Refresh info to retry.",
      );
    return {
      size: String(stat.size),
      profile,
      library,
      method,
      messages: String(messages),
      start: start === undefined ? undefined : seconds(start),
      end: end === undefined ? undefined : seconds(end),
      duration:
        start === undefined || end === undefined
          ? undefined
          : seconds(end - start),
      chunks,
      attachments,
      metadata,
      compression: [...compression],
      channels: [...channels.values()]
        .map((c) => ({
          id: c.id,
          topic: c.topic,
          encoding: c.messageEncoding,
          schema: schemas.get(c.schemaId)?.name ?? "(none)",
          messages: String(counts.get(c.id) ?? 0n),
        }))
        .sort((a, b) => a.topic.localeCompare(b.topic)),
      schemas: [...schemas.values()].map((s) => ({
        id: s.id,
        name: s.name,
        encoding: s.encoding,
        bytes: s.data.length,
      })),
    };
  } finally {
    await handle.close();
  }
}
