import test from "node:test";
import assert from "node:assert/strict";
import { LayoutStore } from "../src/layoutStore";
import type { Layout } from "../src/layouts";
const layout = (id: string): Layout => ({
  id,
  name: id,
  data: { layout: "Plot!1" },
});
function store() {
  let saved: unknown;
  return new LayoutStore({
    get: <T>(_key: string, fallback: T) => (saved ?? fallback) as T,
    update: async (_key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      saved = value;
    },
  });
}
test("concurrent panel imports and removals preserve unrelated layouts", async () => {
  const state = store();
  let notifications = 0;
  const listener = state.subscribe(() => notifications++);
  await Promise.all([
    state.import([layout("a")]),
    state.import([layout("b")]),
    state.remove("a"),
  ]);
  assert.deepEqual(
    state.list().map((l) => l.id),
    ["b"],
  );
  assert.equal(notifications, 3);
  listener.dispose();
  await state.import([layout("c")]);
  assert.equal(notifications, 3);
});
test("failed storage writes reject and do not block subsequent imports", async () => {
  let saved: unknown;
  let fail = true;
  const state = new LayoutStore({
    get: <T>(_key: string, fallback: T) => (saved ?? fallback) as T,
    update: async (_key, value) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      saved = value;
    },
  });
  await assert.rejects(state.import([layout("a")]), /disk full/);
  await state.import([layout("b")]);
  assert.deepEqual(
    state.list().map((l) => l.id),
    ["b"],
  );
});
