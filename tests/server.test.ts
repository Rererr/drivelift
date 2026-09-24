import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../src/core.js";
import { createServer } from "../src/server.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drivelift-server-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(): Deps {
  return {
    configDir: dir,
    fetchImpl: async () => {
      throw new Error("network must not be used");
    },
    now: () => 0,
    env: {},
    openBrowser: async () => false,
    loginTimeoutMs: 1000,
    downloadsDir: join(dir, "Downloads"),
    hasGcloud: () => false,
    execGcloud: async () => ({ code: 1, stdout: "", stderr: "not in tests" }),
  };
}

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drivelift-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), createServer(deps()).connect(serverTransport)]);
  return client;
}

describe("server.ts", () => {
  it("ツールは6個", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["auth_start", "auth_status", "gcloud_setup", "import_client_secret", "status", "upload"]);
    await client.close();
  });

  it("未設定で upload を呼ぶと isError かつ next_steps 付きの JSON が返る", async () => {
    const client = await connectedClient();
    const file = join(dir, "file.xlsx");
    writeFileSync(file, "x");
    const result = await client.callTool({ name: "upload", arguments: { path: file } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const payload = JSON.parse(text) as { error: string; state?: string; next_steps?: string[] };
    expect(payload.state).toBe("no_client");
    expect(payload.next_steps?.length).toBeGreaterThan(3);
    await client.close();
  });

  it("status は isError なしで state を返す", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ state: "no_client", ready: false });
    await client.close();
  });
});
