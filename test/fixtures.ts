import { McapWriter, type McapWriterOptions } from "@mcap/core";
import { writeFile } from "node:fs/promises";
export async function fixture(
  path: string,
  options: Partial<McapWriterOptions> = {},
  empty = false,
) {
  const parts: Uint8Array[] = [];
  let position = 0n;
  const writer = new McapWriter({
    ...options,
    writable: {
      position: () => position,
      write: async (data) => {
        parts.push(data.slice());
        position += BigInt(data.length);
      },
    },
  });
  await writer.start({ profile: "", library: "foxglove-mcap-explorer-test" });
  if (!empty) {
    const schemaId = await writer.registerSchema({
      name: "Reading",
      encoding: "jsonschema",
      data: Buffer.from(
        '{"type":"object","properties":{"value":{"type":"number"}}}',
      ),
    });
    const channelId = await writer.registerChannel({
      schemaId,
      topic: "/sensor",
      messageEncoding: "json",
      metadata: new Map(),
    });
    for (let i = 0; i < 3; i++)
      await writer.addMessage({
        channelId,
        sequence: i,
        logTime: 1700000000000000001n + BigInt(i) * 1000000000n,
        publishTime: 0n,
        data: Buffer.from(JSON.stringify({ value: i })),
      });
    await writer.addMetadata({
      name: "test",
      metadata: new Map([["robot", "testbot"]]),
    });
    await writer.addAttachment({
      name: "note.txt",
      mediaType: "text/plain",
      logTime: 0n,
      createTime: 0n,
      data: Buffer.from("hello"),
    });
  }
  await writer.end();
  const data = Buffer.concat(parts);
  await writeFile(path, data);
  return data;
}

/** Valid indexed MCAP with a sparse private record before the message chunks. */
export async function largeFixture(path: string) {
  const { open } = await import("node:fs/promises");
  const file = await open(path, "w+");
  let position = 0;
  const write = async (data: Uint8Array) => {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await file.write(
        data,
        offset,
        data.length - offset,
        position,
      );
      offset += bytesWritten;
      position += bytesWritten;
    }
  };
  try {
    const writer = new McapWriter({
      writable: { position: () => BigInt(position), write },
    });
    await writer.start({ profile: "", library: "sparse-mcap-test" });
    const padding = Buffer.alloc(9);
    padding[0] = 0x80; // Application-private record, ignored by standard readers.
    padding.writeBigUInt64LE(1024n ** 4n, 1);
    await write(padding);
    position += 1024 ** 4;
    const schemaId = await writer.registerSchema({
      name: "Reading",
      encoding: "jsonschema",
      data: Buffer.from('{"type":"object"}'),
    });
    const channelId = await writer.registerChannel({
      schemaId,
      topic: "/sensor",
      messageEncoding: "json",
      metadata: new Map(),
    });
    await writer.addMessage({
      channelId,
      sequence: 0,
      logTime: 1700000000000000001n,
      publishTime: 0n,
      data: Buffer.from('{"value":42}'),
    });
    await writer.end();
    // The writer didn't see the private record. Disable the optional data-section
    // checksum; chunk and summary checksums still come from the writer.
    const footer = Buffer.alloc(37);
    await file.read(footer, 0, footer.length, position - footer.length);
    const summaryStart = Number(footer.readBigUInt64LE(9));
    await file.write(Buffer.alloc(4), 0, 4, summaryStart - 4);
    return position;
  } finally {
    await file.close();
  }
}
