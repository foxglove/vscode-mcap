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
  await writer.start({ profile: "", library: "mcap-viewer-test" });
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
