import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDriveFailure, DriveRequestError, uploadToDrive, type FetchLike } from "../src/drive.js";

describe("classifyDriveFailure", () => {
  it("403 accessNotConfigured は api_disabled として有効化 URL を拾う", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Google Drive API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123 then retry.",
        errors: [{ reason: "accessNotConfigured" }],
      },
    });
    expect(classifyDriveFailure(403, body)).toEqual({ kind: "api_disabled", enableUrl: "https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123" });
  });

  it("details.metadata.activationUrl があればそれを優先する", () => {
    const body = JSON.stringify({ error: { code: 403, message: "disabled", details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://example.test/enable" } }] } });
    expect(classifyDriveFailure(403, body)).toEqual({ kind: "api_disabled", enableUrl: "https://example.test/enable" });
  });

  it("401 / 404 / その他 / 非JSON を区別する", () => {
    expect(classifyDriveFailure(401, JSON.stringify({ error: { message: "Invalid Credentials" } }))).toEqual({ kind: "unauthorized", message: "Invalid Credentials" });
    expect(classifyDriveFailure(404, JSON.stringify({ error: { message: "File not found: abc" } }))).toEqual({ kind: "not_found", message: "File not found: abc" });
    expect(classifyDriveFailure(500, "<html>oops</html>")).toEqual({ kind: "other", status: 500, message: "<html>oops</html>" });
    expect(classifyDriveFailure(403, JSON.stringify({ error: { message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } }))).toMatchObject({ kind: "other", status: 403 });
  });
});

describe("uploadToDrive", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drivelift-drive-"));
    file = join(dir, "r.xlsx");
    writeFileSync(file, Buffer.from("PK\u0003\u0004fake-xlsx"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resumable の2段(メタデータ POST → セッションへ PUT)で送り、変換先とフォルダを載せる", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (calls.length === 1) return new Response(null, { status: 200, headers: { Location: "https://upload.test/session/1" } });
      return new Response(JSON.stringify({ id: "f1", name: "r", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.google.com/spreadsheets/d/f1/edit" }), { status: 200 });
    };

    const result = await uploadToDrive({ accessToken: "tok", filePath: file, name: "r", sourceMime: "application/x-xlsx", targetMime: "application/vnd.google-apps.spreadsheet", folderId: "folder9", fetchImpl });

    expect(result).toEqual({ id: "f1", name: "r", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.google.com/spreadsheets/d/f1/edit" });
    const [init, put] = calls;
    expect(init?.url).toContain("uploadType=resumable");
    expect(init?.url).toContain("supportsAllDrives=true");
    const headers = init?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["X-Upload-Content-Type"]).toBe("application/x-xlsx");
    expect(headers["X-Upload-Content-Length"]).toBe(String(Buffer.from("PK\u0003\u0004fake-xlsx").byteLength));
    expect(JSON.parse(String(init?.init.body))).toEqual({ name: "r", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["folder9"] });
    expect(put?.url).toBe("https://upload.test/session/1");
    expect(put?.init.method).toBe("PUT");
    expect((put?.init.body as Uint8Array).byteLength).toBe(Buffer.from("PK\u0003\u0004fake-xlsx").byteLength);
  });

  it("変換なし・フォルダなしでは mimeType / parents を送らない", async () => {
    let metadata: unknown;
    const fetchImpl: FetchLike = async (_input, init) => {
      if (metadata === undefined) {
        metadata = JSON.parse(String(init?.body));
        return new Response(null, { status: 200, headers: { Location: "https://upload.test/s" } });
      }
      return new Response(JSON.stringify({ id: "f2" }), { status: 200 });
    };
    const result = await uploadToDrive({ accessToken: "t", filePath: file, name: "r.xlsx", sourceMime: "a/b", targetMime: null, fetchImpl });
    expect(metadata).toEqual({ name: "r.xlsx" });
    expect(result.webViewLink).toBe("https://drive.google.com/open?id=f2");
    expect(result.mimeType).toBe("a/b");
  });

  it("Location が無い・PUT が失敗した場合もそれぞれ失敗する", async () => {
    const noLocation: FetchLike = async () => new Response(null, { status: 200 });
    await expect(uploadToDrive({ accessToken: "t", filePath: file, name: "r", sourceMime: "a/b", targetMime: null, fetchImpl: noLocation })).rejects.toThrow(/session URL/);

    let n = 0;
    const putFails: FetchLike = async () => {
      n += 1;
      if (n === 1) return new Response(null, { status: 200, headers: { Location: "https://upload.test/s" } });
      return new Response(JSON.stringify({ error: { message: "File not found: folderX" } }), { status: 404 });
    };
    await expect(uploadToDrive({ accessToken: "t", filePath: file, name: "r", sourceMime: "a/b", targetMime: null, fetchImpl: putFails })).rejects.toMatchObject({ failure: { kind: "not_found" } });
  });

  it("初回 POST の失敗は分類付きの DriveRequestError になる", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error: { message: "API disabled", errors: [{ reason: "accessNotConfigured" }] } }), { status: 403 });
    await expect(uploadToDrive({ accessToken: "t", filePath: file, name: "r", sourceMime: "a/b", targetMime: null, fetchImpl })).rejects.toMatchObject({ failure: { kind: "api_disabled" } });
    await expect(uploadToDrive({ accessToken: "t", filePath: file, name: "r", sourceMime: "a/b", targetMime: null, fetchImpl })).rejects.toBeInstanceOf(DriveRequestError);
  });
});
