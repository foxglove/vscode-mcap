import type { Layout } from "./layouts";

interface Storage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Serializes profile-wide edits so multiple MCAP panels cannot lose imports. */
export class LayoutStore {
  private pending: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(private readonly storage: Storage) {}
  list(): Layout[] {
    return this.storage.get<Layout[]>("importedLayouts", []);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  import(layouts: Layout[]) {
    return this.update((current) => {
      const byId = new Map(current.map((layout) => [layout.id, layout]));
      for (const layout of layouts) byId.set(layout.id, layout);
      return [...byId.values()];
    });
  }
  remove(id: string) {
    return this.update((current) =>
      current.filter((layout) => layout.id !== id),
    );
  }
  private update(change: (current: Layout[]) => Layout[]) {
    const operation = this.pending.then(async () => {
      await this.storage.update("importedLayouts", change(this.list()));
      for (const listener of this.listeners) listener();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
