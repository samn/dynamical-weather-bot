import { afterEach, describe, expect, it, vi } from "vitest";
import { readStorage, writeStorage } from "./storage.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage", () => {
  it("reads back what it writes", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    writeStorage("key", "value");
    expect(readStorage("key")).toBe("value");
    expect(readStorage("missing")).toBeNull();
  });

  it("degrades to null reads and no-op writes when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(readStorage("key")).toBeNull();
    expect(() => writeStorage("key", "value")).not.toThrow();
  });

  it("degrades when accessing localStorage itself throws", () => {
    // Browsers that block site data throw on the property access
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(readStorage("key")).toBeNull();
      expect(() => writeStorage("key", "value")).not.toThrow();
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
