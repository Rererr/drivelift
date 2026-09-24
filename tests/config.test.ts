import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientSecretPath, loadClientCredentials, loadToken, parseClientSecret, resolveConfigDir, saveClientSecret, saveToken, tokenPath } from "../src/config.js";
import { DriveliftError } from "../src/errors.js";

const VALID = JSON.stringify({ installed: { client_id: "id-1", client_secret: "sec-1", redirect_uris: ["http://localhost"] } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drivelift-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseClientSecret", () => {
  it("Desktop 種別(installed)の JSON から id/secret を取り出す", () => {
    expect(parseClientSecret(VALID)).toEqual({ clientId: "id-1", clientSecret: "sec-1" });
  });

  it("Web 種別は Desktop で作り直すよう案内して弾く", () => {
    expect(() => parseClientSecret(JSON.stringify({ web: { client_id: "a", client_secret: "b" } }))).toThrow(/Desktop app/);
  });

  it("client_id 欠落・JSON 不正はそれぞれ理由付きで失敗する", () => {
    expect(() => parseClientSecret(JSON.stringify({ installed: { client_secret: "b" } }))).toThrow(/client_id/);
    expect(() => parseClientSecret("{not json")).toThrow(/valid JSON/);
    expect(() => parseClientSecret("[]")).toThrow(DriveliftError);
  });
});

describe("loadClientCredentials", () => {
  it("環境変数があればファイルより優先する", () => {
    writeFileSync(clientSecretPath(dir), VALID);
    const creds = loadClientCredentials(dir, { DRIVELIFT_CLIENT_ID: "env-id", DRIVELIFT_CLIENT_SECRET: "env-sec" });
    expect(creds).toEqual({ clientId: "env-id", clientSecret: "env-sec", source: "env" });
  });

  it("環境変数が片方だけなら黙ってフォールバックせず失敗する", () => {
    expect(() => loadClientCredentials(dir, { DRIVELIFT_CLIENT_ID: "only-id" })).toThrow(/both/);
  });

  it("ファイルからは source: file で返し、何もなければ null", () => {
    expect(loadClientCredentials(dir, {})).toBeNull();
    writeFileSync(clientSecretPath(dir), VALID);
    expect(loadClientCredentials(dir, {})).toEqual({ clientId: "id-1", clientSecret: "sec-1", source: "file" });
  });
});

describe("saveClientSecret / token", () => {
  it("検証してから 0600 で保存する", () => {
    const sub = join(dir, "nested");
    const { path: saved, tokenCleared } = saveClientSecret(sub, VALID);
    expect(saved).toBe(clientSecretPath(sub));
    expect(tokenCleared).toBe(false);
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(() => saveClientSecret(sub, "{}")).toThrow(DriveliftError);
  });

  it("client_id が変わる取り込みでは token.json を消し、同じ client_id なら残す", () => {
    saveClientSecret(dir, VALID);
    saveToken(dir, { refresh_token: "r" });
    expect(saveClientSecret(dir, VALID).tokenCleared).toBe(false);
    expect(loadToken(dir)).not.toBeNull();
    const other = JSON.stringify({ installed: { client_id: "id-2", client_secret: "sec-2" } });
    expect(saveClientSecret(dir, other).tokenCleared).toBe(true);
    expect(loadToken(dir)).toBeNull();
  });

  it("既存の 0644 ファイルへ保存し直しても 0600 に戻す", () => {
    writeFileSync(tokenPath(dir), "{}", { mode: 0o644 });
    saveToken(dir, { refresh_token: "r" });
    expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("token は往復し、壊れていれば削除を案内する", () => {
    expect(loadToken(dir)).toBeNull();
    saveToken(dir, { refresh_token: "r", access_token: "a", expires_at: 123, account: "me@example.com" });
    expect(loadToken(dir)).toEqual({ refresh_token: "r", access_token: "a", expires_at: 123, account: "me@example.com" });
    expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
    writeFileSync(tokenPath(dir), "{}");
    expect(() => loadToken(dir)).toThrow(/refresh_token/);
    expect(readFileSync(tokenPath(dir), "utf-8")).toBe("{}");
  });
});

describe("resolveConfigDir", () => {
  it("DRIVELIFT_CONFIG_DIR を優先し、無ければ ~/.config/drivelift", () => {
    expect(resolveConfigDir({ DRIVELIFT_CONFIG_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(resolveConfigDir({})).toMatch(/\.config\/drivelift$/);
  });
});
