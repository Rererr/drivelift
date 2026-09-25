import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseShareArg } from "../src/cli.js";

describe("cli", () => {
  // main() は既定の設定ディレクトリを使う。入力チェックが退行したときにテストが本物のトークンで Drive へ送らないよう、空のディレクトリに向ける
  let configDir: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["DRIVELIFT_CONFIG_DIR"];
    configDir = mkdtempSync(join(tmpdir(), "drivelift-cli-"));
    process.env["DRIVELIFT_CONFIG_DIR"] = configDir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["DRIVELIFT_CONFIG_DIR"];
    else process.env["DRIVELIFT_CONFIG_DIR"] = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

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
      // core 側で弾く指定の誤りも使い方の誤りとして 2
      expect(await main(["upload", "package.json", "--share", "admin:user:a@b.c"])).toBe(2);
      expect(await main(["upload", "package.json", "--folder", ""])).toBe(2);
      expect(await main(["upload", "package.json", "--replace", ""])).toBe(2);
      expect(await main(["setup-gcloud", "--project=Bad_ID"])).toBe(2);
      expect(await main(["upload", "--help"])).toBe(0);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
