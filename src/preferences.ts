import type { Layout } from "./layouts";
export interface ViewerPreferences {
  tab: "info" | "foxglove";
  layout?: Layout;
}
interface Storage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}
export class Preferences {
  private value: ViewerPreferences;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly storage: Storage) {
    const saved = storage.get<ViewerPreferences>("viewerPreferences", {
      tab: "info",
    });
    this.value = {
      tab: saved.tab,
      ...(saved.layout ? { layout: saved.layout } : {}),
    };
  }
  get(): ViewerPreferences {
    return this.value;
  }
  update(change: Partial<ViewerPreferences>) {
    this.value = { ...this.value, ...change };
    const value = this.value;
    const operation = this.pending.then(() =>
      this.storage.update("viewerPreferences", value),
    );
    this.pending = operation.catch(() => {});
    return operation;
  }
}
