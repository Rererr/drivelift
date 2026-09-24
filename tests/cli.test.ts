import { describe, expect, it, vi } from "vitest";
import { main, parseShareArg } from "../src/cli.js";

describe("cli", () => {
  it("--share は role:type[:target] を分解し、target の : は保つ", () => {
    expect(parseShareArg("reader:domain:example.com")).toEqual({ role: "reader", type: "domain", target: "example.com" });
    expect(parseShareArg("reader:anyone")).toEqual({ role: "reader", type: "anyone" });
    expect(() => parseShareArg("reader")).toThrow(/role:type/);
  });

  it("使い方の誤りは終了コード 2、--help は 0", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["upload", "--bogus"])).toBe(2);
      expect(await main(["upload", "x", "--convert", "pdf"])).toBe(2);
      expect(await main(["upload", "x", "--share", "bad"])).toBe(2);
      expect(await main(["setup-gcloud", "--project"])).toBe(2);
      expect(await main(["nope"])).toBe(2);
      expect(await main(["upload", "--help"])).toBe(0);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
