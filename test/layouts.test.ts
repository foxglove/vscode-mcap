import test from "node:test";
import assert from "node:assert/strict";
import { layoutData, listLayouts } from "../src/layouts";
test("shared layouts use API key auth and retain opaque data", async () => {
  const data = {
    layout: "Plot!one",
    configById: { "Plot!one": { paths: [] } },
    futureField: 42,
  };
  const result = await listLayouts("test-secret", async (url, init) => {
    assert.equal(url, "https://api.foxglove.dev/v1/layouts?includeData=true");
    assert.deepEqual(init?.headers, { Authorization: "Bearer test-secret" });
    assert.equal(init?.redirect, "error");
    return new Response(
      JSON.stringify([
        { id: "one", name: "Sensors", folderName: "Robot", data },
      ]),
    );
  });
  assert.deepEqual(result, [{ id: "cloud:one", name: "Robot/Sensors", data }]);
});
test("handles API denial and malformed responses without leaking key", async () => {
  await assert.rejects(
    listLayouts("secret", async () => new Response("", { status: 403 })),
    /403/,
  );
  await assert.rejects(
    listLayouts("secret", async () => new Response("{}")),
    /Invalid layout list/,
  );
  await assert.rejects(
    listLayouts(
      "secret",
      async () => new Response('[{"id":"one","name":"bad","data":null}]'),
    ),
    /JSON object/,
  );
  for (const value of [null, [], 1, "layout"])
    assert.throws(() => layoutData(value));
});

test("rejects malformed layout list entries with a useful error", async () => {
  for (const item of [
    null,
    3,
    { id: "x", name: "x", folderName: 42, data: {} },
  ]) {
    await assert.rejects(
      listLayouts("secret", async () => new Response(JSON.stringify([item]))),
      /Invalid layout returned/,
    );
  }
});
