import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseShareArg } from "../src/cli.js";
import { saveAccount } from "../src/config.js";
import { defaultDeps } from "../src/core.js";

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

  it("doctor: no_client のとき ~/Downloads の候補を表示する", async () => {
    const downloads = mkdtempSync(join(tmpdir(), "drivelift-dl-"));
    const cand = join(downloads, "client_secret_abc.json");
    writeFileSync(cand, "{}");
    const deps = { ...defaultDeps(), downloadsDir: downloads, hasGcloud: () => false };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["doctor"], deps)).toBe(2);
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(`candidates (newest first):\n  ${cand}`);
    } finally {
      out.mockRestore();
      rmSync(downloads, { recursive: true, force: true });
    }
  });

  it("map: 到達元に shell の特殊文字があれば、案内するコマンドで単一引用符に包む", async () => {
    saveAccount(configDir, "me@example.com", { refresh_token: "ref" }, { clientId: "cid", clientSecret: "csec", source: "file" });
    const deps = { ...defaultDeps(), gitOriginUrl: () => "https://gh.example/org/$(touch x)'q.git" };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["map", "me@example.com"], deps)).toBe(2);
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(`Re-run to map it: drivelift map me@example.com 'gh.example/org/$(touch x)'\\''q'\n`);
    } finally {
      out.mockRestore();
    }
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
      expect(await main(["upload", "package.json", "--share-new-folder", "--share", "reader:anyone"])).toBe(2);
      expect(await main(["setup-gcloud", "--project=Bad_ID"])).toBe(2);
      expect(await main(["upload", "--help"])).toBe(0);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("map は source 省略で候補を表示して 2、書いたら 0。引数の誤りは 2", async () => {
    saveAccount(configDir, "me@example.com", { refresh_token: "ref" }, { clientId: "cid", clientSecret: "csec", source: "file" });
    // 実行中のリポジトリの git に依存しないよう、remote を差し替える
    const deps = { ...defaultDeps(), gitOriginUrl: () => "git@github.com:org/a.git" };
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["map"], deps)).toBe(2);
      expect(await main(["map", "me@example.com", "a", "b"], deps)).toBe(2);
      expect(await main(["map", "other@example.com", "github.com/org/a"], deps)).toBe(2);
      expect(await main(["map", "me@example.com", "org/a"], deps)).toBe(2);
      expect(await main(["map", "me@example.com"], deps)).toBe(2);
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Re-run to map it: drivelift map me@example.com github\.com\/org\/a\n/);
      expect(await main(["map", "me@example.com", "github.com/org/a"], deps)).toBe(0);
      expect(await main(["map", "me@example.com", "github.com/org/a", "--remove"], deps)).toBe(0);
      expect(out.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Unmapped github.com\/org\/a/);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  describe("--share-new-folder", () => {
    let savedEnv: Record<string, string | undefined>;
    beforeEach(() => {
      savedEnv = { id: process.env["DRIVELIFT_CLIENT_ID"], secret: process.env["DRIVELIFT_CLIENT_SECRET"] };
      process.env["DRIVELIFT_CLIENT_ID"] = "cid";
      process.env["DRIVELIFT_CLIENT_SECRET"] = "csec";
      saveAccount(configDir, "me@example.com", { refresh_token: "ref", access_token: "acc", expires_at: Date.now() + 600_000 }, { clientId: "cid", clientSecret: "csec", source: "env" });
      writeFileSync(join(configDir, "r.csv"), "a,b");
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [key, name] of [["id", "DRIVELIFT_CLIENT_ID"], ["secret", "DRIVELIFT_CLIENT_SECRET"]] as const) {
        if (savedEnv[key] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[key];
      }
    });

    function stubDrive(existingFolder: boolean, folderShareOk: boolean): void {
      vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/drive/v3/files?q=")) return new Response(JSON.stringify({ files: existingFolder ? [{ id: "old" }] : [] }));
        if (url.includes("/drive/v3/files?fields=id")) return new Response(JSON.stringify({ id: "fold" }));
        if (url.includes("/upload/drive/v3/files")) return new Response(null, { headers: { Location: "https://upload.test/s" } });
        if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f1", webViewLink: "https://drive.test/f1" }));
        if (url.includes("/files/f1/permissions") || folderShareOk) return new Response(JSON.stringify({ id: "p" }));
        return new Response(JSON.stringify({ error: { message: "Bad Request" } }), { status: 400 });
      });
    }

    async function run(): Promise<{ code: number; stderr: string }> {
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const code = await main(["upload", join(configDir, "r.csv"), "--folder-path", "repo#1", "--share", "reader:domain:example.com", "--share-new-folder"]);
        return { code, stderr: err.mock.calls.map((c) => String(c[0])).join("") };
      } finally {
        err.mockRestore();
        out.mockRestore();
      }
    }

    it("フォルダの共有に失敗したら stderr に出して終了コード 3", async () => {
      stubDrive(false, false);
      const { code, stderr } = await run();
      expect(code).toBe(3);
      expect(stderr).toMatch(/folder share failed: reader:domain:example.com/);
    });

    it("既存フォルダを再利用したら共有しない旨を stderr に出し、終了コードは 0", async () => {
      stubDrive(true, true);
      const { code, stderr } = await run();
      expect(code).toBe(0);
      expect(stderr).toMatch(/folder not shared/);
    });
  });
});
