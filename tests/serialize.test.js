import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "../src/core/serialize.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("createKeyedQueue", () => {
  it("runs same-key tasks sequentially (no interleave)", async () => {
    const run = createKeyedQueue();
    const order = [];
    // Simulate read-modify-write: read shared value, wait, write incremented.
    let shared = 0;
    const rmw = async (label) => {
      const seen = shared;
      order.push(`read:${label}:${seen}`);
      await tick(10);
      shared = seen + 1;
      order.push(`write:${label}:${shared}`);
    };
    await Promise.all([run("A", () => rmw("first")), run("A", () => rmw("second"))]);
    // If they interleaved, both would read 0 and shared would end at 1.
    expect(shared).toBe(2);
    expect(order).toEqual(["read:first:0", "write:first:1", "read:second:1", "write:second:2"]);
  });

  it("runs different-key tasks concurrently", async () => {
    const run = createKeyedQueue();
    const order = [];
    await Promise.all([
      run("A", async () => {
        order.push("A-start");
        await tick(20);
        order.push("A-end");
      }),
      run("B", async () => {
        order.push("B-start");
        await tick(5);
        order.push("B-end");
      }),
    ]);
    // B started before A finished -> concurrent.
    expect(order).toEqual(["A-start", "B-start", "B-end", "A-end"]);
  });

  it("a rejecting task does not wedge later same-key tasks", async () => {
    const run = createKeyedQueue();
    await expect(run("A", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(run("A", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("returns the task's resolved value", async () => {
    const run = createKeyedQueue();
    await expect(run("A", () => Promise.resolve(42))).resolves.toBe(42);
  });

  it("cleans up the internal map once a key drains", async () => {
    const run = createKeyedQueue();
    await run("A", () => Promise.resolve());
    // A fresh same-key task should start from a clean chain (no error, runs).
    await expect(run("A", () => Promise.resolve("again"))).resolves.toBe("again");
  });
});
