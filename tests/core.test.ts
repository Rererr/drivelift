import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientSecretPath, saveToken } from "../src/config.js";
import { handleAuthStart, handleAuthStatus, handleImportClientSecret, handleStatus, handleUpload, resolveUserPath, type Deps } from "../src/core.js";
import { homedir } from "node:os";
import type { FetchLike } from "../src/drive.js";
import { DriveliftError } from "../src/errors.js";

const NOW = 1_700_000_000_000;
const ENV_CREDS = { DRIVELIFT_CLIENT_ID: "cid", DRIVELIFT_CLIENT_SECRET: "csec" };

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;

function makeDeps(dir: string, env: NodeJS.ProcessEnv, route: Route): Deps & { calls: string[]; opened: string[] } {
  const calls: string[] = [];
  const opened: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const res = route(url, init);
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    return res;
  };
  return {
    configDir: dir,
    fetchImpl,
    now: () => NOW,
    env,
    openBrowser: async (url) => {
      opened.push(url);
      return false;
    },
    loginTimeoutMs: 5_000,
    downloadsDir: join(dir, "Downloads"),
    hasGcloud: () => false,
    execGcloud: async () => ({ code: 1, stdout: "", stderr: "not in tests" }),
    calls,
    opened,
  };
}

const okAbout: Route = (url) => (url.includes("/drive/v3/about") ? new Response(JSON.stringify({ user: { emailAddress: "me@example.com" } })) : undefined);
const disabledAbout: Route = (url) =>
  url.includes("/drive/v3/about")
    ? new Response(JSON.stringify({ error: { message: "Drive API has not been used in project 1 before. Enable it at https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1", errors: [{ reason: "accessNotConfigured" }] } }), { status: 403 })
    : undefined;
const invalidGrant: Route = (url) => (url.includes("/token") ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), { status: 400 }) : undefined);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drivelift-core-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("handleStatus は導入状態を5段階で返す", () => {
  it("no_client: Console の URL と保存先パスを next_steps に含む", async () => {
    const status = await handleStatus(makeDeps(dir, {}, () => undefined));
    expect(status.state).toBe("no_client");
    expect(status.ready).toBe(false);
    expect(status.urls["create_oauth_client"]).toMatch(/^https:\/\/console\.cloud\.google\.com\//);
    expect(status.next_steps.join("\n")).toContain(clientSecretPath(dir));
    expect(status.next_steps.join("\n")).toContain("User type: Internal");
    expect(status.next_steps.join("\n")).toContain("Application type: Desktop app");
    expect(status.console_form?.consent_screen.map((f) => f.field)).toEqual(["App name", "User support email", "User type", "Email addresses", "Agree to the Google API Services: User Data Policy"]);
  });

  it("no_client: ~/Downloads に候補があれば mv コマンドと candidates を返し、gcloud があれば gcloud_setup を案内する", async () => {
    const downloads = join(dir, "Downloads");
    mkdirSync(downloads);
    const cand = join(downloads, "client_secret_abc.json");
    writeFileSync(cand, "{}");
    const deps = { ...makeDeps(dir, {}, () => undefined), hasGcloud: () => true };
    const status = await handleStatus(deps);
    expect(status.candidates).toEqual([cand]);
    const text = status.next_steps.join("\n");
    expect(text).toContain(`mv "${cand}" "${clientSecretPath(dir)}"`);
    expect(text).toContain("gcloud_setup");
  });

  it("no_token: クライアントはあるがログイン前", async () => {
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, () => undefined));
    expect(status).toMatchObject({ state: "no_token", client_source: "env" });
    expect(status.next_steps[0]).toMatch(/auth_start/);
  });

  it("token_invalid: refresh が invalid_grant", async () => {
    saveToken(dir, { refresh_token: "ref" });
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, invalidGrant));
    expect(status.state).toBe("token_invalid");
    expect(status.message).toContain("invalid_grant");
    expect(status.next_steps.join("\n")).toContain("7 days");
  });

  it("api_disabled: about.get が accessNotConfigured", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, disabledAbout));
    expect(status.state).toBe("api_disabled");
    expect(status.urls["enable_drive_api"]).toBe("https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1");
  });

  it("ready: about.get が通ればアカウント付き", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const deps = makeDeps(dir, ENV_CREDS, okAbout);
    const status = await handleStatus(deps);
    expect(status).toMatchObject({ state: "ready", ready: true, account: "me@example.com", client_source: "env" });
    expect(deps.calls.filter((u) => u.includes("/token"))).toHaveLength(0);
  });
});

describe("handleUpload", () => {
  it("未設定なら no_client の Status を伴って失敗する(upload をいきなり呼んでも誘導される)", async () => {
    const file = join(dir, "a.xlsx");
    writeFileSync(file, "x");
    await expect(handleUpload(makeDeps(dir, {}, () => undefined), { path: file })).rejects.toMatchObject({ status: { state: "no_client" } });
  });

  it("ファイルが無い・convert が不正なら Drive を呼ばずに失敗する", async () => {
    const deps = makeDeps(dir, ENV_CREDS, () => undefined);
    await expect(handleUpload(deps, { path: join(dir, "missing.xlsx") })).rejects.toThrow(/File not found/);
    const file = join(dir, "a.xlsx");
    writeFileSync(file, "x");
    await expect(handleUpload(deps, { path: file, convert: "pdf" as never })).rejects.toThrow(/convert must be one of/);
    expect(deps.calls).toHaveLength(0);
  });

  it("成功時は URL と変換先を返し、名前は拡張子を落とす", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000, account: "me@example.com" });
    const file = join(dir, "report.xlsx");
    writeFileSync(file, "x");
    let metadata: Record<string, unknown> | undefined;
    const deps = makeDeps(dir, ENV_CREDS, (url, init) => {
      if (url.includes("/upload/drive/v3/files")) {
        metadata = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(null, { status: 200, headers: { Location: "https://upload.test/s" } });
      }
      if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f1", name: "report", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.google.com/spreadsheets/d/f1/edit" }));
      return undefined;
    });
    const result = await handleUpload(deps, { path: file, folder_id: "F" });
    expect(metadata).toEqual({ name: "report", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["F"] });
    expect(result).toEqual({ id: "f1", name: "report", mimeType: "application/vnd.google-apps.spreadsheet", url: "https://docs.google.com/spreadsheets/d/f1/edit", converted_to: "application/vnd.google-apps.spreadsheet", account: "me@example.com", folder_id: "F", folders_created: [], shared: [] });
  });

  it("folder_id 指定で 404 なら ID と編集権限の確認を案内する", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "a.md");
    writeFileSync(file, "# x");
    let n = 0;
    const deps = makeDeps(dir, ENV_CREDS, () => {
      n += 1;
      return n === 1 ? new Response(JSON.stringify({ error: { message: "File not found: F" } }), { status: 404 }) : undefined;
    });
    await expect(handleUpload(deps, { path: file, folder_id: "F" })).rejects.toThrow(/can edit that folder/);
  });

  it("folder_path でフォルダを用意してから置き、共有は1件ずつ成否を返す(失敗してもアップロードは成功扱い)", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    let metadata: Record<string, unknown> | undefined;
    const deps = makeDeps(dir, ENV_CREDS, (url, init) => {
      if (url.includes("/drive/v3/files?q=")) return new Response(JSON.stringify({ files: [] }));
      if (url.includes("/drive/v3/files?fields=id")) return new Response(JSON.stringify({ id: "fold-1" }));
      if (url.includes("/upload/drive/v3/files")) {
        metadata = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(null, { headers: { Location: "https://upload.test/s" } });
      }
      if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f9" }));
      if (url.includes("/permissions")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return body["type"] === "domain" ? new Response(JSON.stringify({ id: "p" })) : new Response(JSON.stringify({ error: { message: "Bad Request. User message: invalid sharing request" } }), { status: 400 });
      }
      return undefined;
    });
    const r = await handleUpload(deps, { path: file, folder_path: "Reports", share: [{ role: "reader", type: "domain", target: "example.com" }, { role: "writer", type: "user", target: "x@example.com" }] });
    expect(metadata?.["parents"]).toEqual(["fold-1"]);
    expect(r.folder_id).toBe("fold-1");
    expect(r.folders_created).toEqual(["Reports"]);
    expect(r.shared).toEqual([
      { role: "reader", type: "domain", target: "example.com", ok: true },
      expect.objectContaining({ role: "writer", type: "user", target: "x@example.com", ok: false }),
    ]);
  });

  it("空の folder_id / folder_path と 21 件以上の share は何も呼ばずに弾く", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    const deps = makeDeps(dir, ENV_CREDS, () => undefined);
    await expect(handleUpload(deps, { path: file, folder_id: " " })).rejects.toThrow(/folder_id is empty/);
    await expect(handleUpload(deps, { path: file, folder_path: "" })).rejects.toThrow(/folder_path is empty/);
    const many = Array.from({ length: 21 }, (_, i) => ({ role: "reader" as const, type: "user" as const, target: `u${i}@example.com` }));
    await expect(handleUpload(deps, { path: file, share: many })).rejects.toThrow(/at most 20/);
    expect(deps.calls).toHaveLength(0);
  });

  it("共有前のトークン取り直しが失敗しても、アップロード結果は返し共有だけ失敗にする", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    let now = NOW;
    const deps = makeDeps(dir, ENV_CREDS, (url) => {
      if (url.includes("/upload/")) return new Response(null, { headers: { Location: "https://upload.test/s" } });
      if (url === "https://upload.test/s") {
        now = NOW + 3_600_000; // 送信中に access_token が期限切れになる
        return new Response(JSON.stringify({ id: "f1" }));
      }
      if (url.includes("/token")) throw new TypeError("fetch failed");
      return undefined;
    });
    deps.now = () => now;
    const r = await handleUpload(deps, { path: file, share: [{ role: "reader", type: "domain", target: "example.com" }] });
    expect(r.id).toBe("f1");
    expect(r.shared).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/could not refresh/) })]);
  });

  it("パスの途中で失敗しても、それまでに作ったフォルダをエラーに含める", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    let posts = 0;
    const deps = makeDeps(dir, ENV_CREDS, (url, init) => {
      if (url.includes("/drive/v3/files?q=")) return new Response(JSON.stringify({ files: [] }));
      if (init?.method === "POST" && url.includes("/drive/v3/files?fields=id")) {
        posts += 1;
        return posts === 1 ? new Response(JSON.stringify({ id: "A1" })) : new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      return undefined;
    });
    await expect(handleUpload(deps, { path: file, folder_path: "A/B" })).rejects.toThrow(/folders already created before the failure: A\b/);
  });

  it("タイムアウトなど DriveliftError 以外の失敗でも、作ったフォルダを伝える", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    const deps = makeDeps(dir, ENV_CREDS, (url) => {
      if (url.includes("/drive/v3/files?q=")) return new Response(JSON.stringify({ files: [] }));
      if (url.includes("/drive/v3/files?fields=id")) return new Response(JSON.stringify({ id: "A1" }));
      if (url.includes("/upload/")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return undefined;
    });
    await expect(handleUpload(deps, { path: file, folder_path: "A" })).rejects.toThrow(/TimeoutError.*folders already created before the failure: A/);
  });

  it("フォルダを作った後に upload が失敗したら、作ったフォルダをエラーに含める", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    const deps = makeDeps(dir, ENV_CREDS, (url) => {
      if (url.includes("/drive/v3/files?q=")) return new Response(JSON.stringify({ files: [] }));
      if (url.includes("/drive/v3/files?fields=id")) return new Response(JSON.stringify({ id: "fold-1" }));
      if (url.includes("/upload/")) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      return undefined;
    });
    await expect(handleUpload(deps, { path: file, folder_path: "Left/Over" })).rejects.toThrow(/Left\/Over/);
  });

  it("共有指定が不正なら何も作らずに失敗する", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    const deps = makeDeps(dir, ENV_CREDS, () => undefined);
    await expect(handleUpload(deps, { path: file, share: [{ role: "reader", type: "user", target: "not-an-email" }] })).rejects.toThrow(/email/);
    expect(deps.calls).toHaveLength(0);
  });

  it("API 未有効化は api_disabled の Status に変換される", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "a.md");
    writeFileSync(file, "# x");
    const deps = makeDeps(dir, ENV_CREDS, (url) => (url.includes("/upload/") ? new Response(JSON.stringify({ error: { message: "disabled", errors: [{ reason: "accessNotConfigured" }] } }), { status: 403 }) : undefined));
    await expect(handleUpload(deps, { path: file })).rejects.toMatchObject({ status: { state: "api_disabled" } });
  });
});

describe("resolveUserPath", () => {
  it("先頭の ~ を展開し、相対パスは cwd 基準にする", () => {
    expect(resolveUserPath("~/Downloads/x.json")).toBe(join(homedir(), "Downloads", "x.json"));
    expect(resolveUserPath("~")).toBe(homedir());
    expect(resolveUserPath("/abs/x")).toBe("/abs/x");
    expect(resolveUserPath("rel/x")).toBe(join(process.cwd(), "rel", "x"));
  });
});

describe("handleImportClientSecret", () => {
  it("path 指定で検証して取り込む。無ければ候補列挙だけで何もコピーしない", () => {
    const src = join(dir, "client_secret_x.json");
    writeFileSync(src, JSON.stringify({ installed: { client_id: "a", client_secret: "b" } }));
    const cfg = join(dir, "cfg");
    const deps = makeDeps(cfg, {}, () => undefined);
    const imported = handleImportClientSecret(deps, { path: src });
    expect(imported).toMatchObject({ imported: true, saved_to: clientSecretPath(cfg) });
    expect(existsSync(clientSecretPath(cfg))).toBe(true);

    const listed = handleImportClientSecret(makeDeps(join(dir, "cfg2"), {}, () => undefined));
    expect(listed.imported).toBe(false);
    if (!listed.imported) expect(Array.isArray(listed.candidates)).toBe(true);
    expect(existsSync(clientSecretPath(join(dir, "cfg2")))).toBe(false);
  });

  it("通常ファイル以外(ディレクトリ等)は読まずに弾く", () => {
    expect(() => handleImportClientSecret(makeDeps(dir, {}, () => undefined), { path: dir })).toThrow(/Not a regular file/);
  });

  it("Web 種別の JSON は取り込まない", () => {
    const src = join(dir, "web.json");
    writeFileSync(src, JSON.stringify({ web: { client_id: "a", client_secret: "b" } }));
    expect(() => handleImportClientSecret(makeDeps(dir, {}, () => undefined), { path: src })).toThrow(DriveliftError);
  });
});

describe("auth_start / auth_status の2段", () => {
  it("開始で URL を返し、コールバック完了で completed になる", async () => {
    const deps = makeDeps(dir, ENV_CREDS, (url) => {
      if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }));
      return okAbout(url, undefined);
    });
    const started = await handleAuthStart(deps, { wait_seconds: 0 });
    expect(started.state).toBe("pending");
    expect(started.browser_opened).toBe(false);
    expect(deps.opened).toEqual([started.url]);
    await expect(handleAuthStatus(deps)).resolves.toMatchObject({ state: "pending", url: started.url });

    const state = new URL(started.url).searchParams.get("state");
    const port = new URL(new URL(started.url).searchParams.get("redirect_uri") as string).port;
    // wait_seconds 付きの auth_status は、コールバック到着で即座に completed を返す
    const waiting = handleAuthStatus(deps, { wait_seconds: 5 });
    await fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`);
    await expect(waiting).resolves.toMatchObject({ state: "completed", account: "me@example.com" });
  });

  it("auth_start は wait_seconds の間に同意が終われば completed を返す(手動の合図が要らない)", async () => {
    const deps = makeDeps(dir, ENV_CREDS, (url) => {
      if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }));
      return okAbout(url, undefined);
    });
    // openBrowser が呼ばれた時点で(利用者の同意の代わりに)コールバックを叩く
    deps.openBrowser = async (url) => {
      const state = new URL(url).searchParams.get("state");
      const port = new URL(new URL(url).searchParams.get("redirect_uri") as string).port;
      setTimeout(() => void fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`), 30);
      return true;
    };
    const started = await handleAuthStart(deps, { wait_seconds: 5 });
    expect(started).toMatchObject({ state: "completed", account: "me@example.com", browser_opened: true });
  });

  it("open_browser: false ではブラウザを開かない", async () => {
    const deps = makeDeps(dir, ENV_CREDS, () => undefined);
    const started = await handleAuthStart(deps, { open_browser: false, wait_seconds: 0 });
    expect(deps.opened).toEqual([]);
    expect(started.next).toMatch(/open the URL/);
  });
});
