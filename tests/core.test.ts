import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountDir, clientSecretPath, loadToken, parseClientSecret, saveAccount, saveSources, type StoredToken } from "../src/config.js";
import { handleAuthStart, handleAuthStatus, handleImportClientSecret, handleMapSource, handleStatus, handleUpload, resolveUserPath, type Deps } from "../src/core.js";
import { homedir, tmpdir as osTmpdir } from "node:os";
import type { FetchLike } from "../src/drive.js";
import { AccountUnresolvedError, DriveliftError } from "../src/errors.js";

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
    cwd: dir,
    gitOriginUrl: () => null,
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

/** env のクライアントでログイン済みの枠を作る。 */
function signIn(configDir: string, token: StoredToken, email = "me@example.com"): void {
  saveAccount(configDir, email, token, { clientId: "cid", clientSecret: "csec", source: "env" });
}

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(osTmpdir(), "drivelift-core-")));
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
    signIn(dir, { refresh_token: "ref" });
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, invalidGrant));
    expect(status.state).toBe("token_invalid");
    expect(status.message).toContain("invalid_grant");
    expect(status.next_steps.join("\n")).toContain("7 days");
  });

  it("api_disabled: about.get が accessNotConfigured", async () => {
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, disabledAbout));
    expect(status.state).toBe("api_disabled");
    expect(status.urls["enable_drive_api"]).toBe("https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1");
  });

  it("ready: about.get が通ればアカウント付き", async () => {
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000, account: "me@example.com" });
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
    expect(result).toEqual({ id: "f1", name: "report", mimeType: "application/vnd.google-apps.spreadsheet", url: "https://docs.google.com/spreadsheets/d/f1/edit", converted_to: "application/vnd.google-apps.spreadsheet", account: "me@example.com", source: null, folder_id: "F", folders_created: [], shared: [], folder_shared: [], replaced: false });
  });

  it("folder_id 指定で 404 なら ID と編集権限の確認を案内する", async () => {
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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

  describe("share_new_folder", () => {
    const spec = [{ role: "reader" as const, type: "domain" as const, target: "example.com" }];
    /** existing: 検索で既存として返すフォルダ名。途中と末端で既存・新規を分けるため名前で指定する */
    function folderDeps(existing: string[], folderPermission: (fileId: string) => Response = () => new Response(JSON.stringify({ id: "p" }))) {
      const permitted: string[] = [];
      let created = 0;
      const deps = makeDeps(dir, ENV_CREDS, (url) => {
        if (url.includes("/drive/v3/files?q=")) {
          const q = new URL(url).searchParams.get("q") ?? "";
          const hit = existing.find((name) => q.includes(`name='${name}'`));
          return new Response(JSON.stringify({ files: hit ? [{ id: `old-${hit}`, createdTime: "2026-01-01T00:00:00Z" }] : [] }));
        }
        if (url.includes("/drive/v3/files?fields=id")) return new Response(JSON.stringify({ id: `new-${created++}` }));
        if (url.includes("/upload/drive/v3/files")) return new Response(null, { headers: { Location: "https://upload.test/s" } });
        if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f1" }));
        const m = /\/files\/([^/]+)\/permissions/.exec(url);
        if (m?.[1]) {
          permitted.push(m[1]);
          return m[1] === "f1" ? new Response(JSON.stringify({ id: "p" })) : folderPermission(m[1]);
        }
        return undefined;
      });
      return { deps, permitted };
    }

    beforeEach(() => {
      signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
      writeFileSync(join(dir, "r.csv"), "a,b");
    });

    it("末端フォルダを今回作ったら、ファイルと同じ共有を末端フォルダにだけ付ける(途中の新規フォルダには付けない)", async () => {
      const { deps, permitted } = folderDeps([]);
      const r = await handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo/#1", share: spec, share_new_folder: true });
      expect(r.folders_created).toEqual(["repo", "#1"]);
      expect(r.folder_id).toBe("new-1");
      expect(permitted).toEqual(["f1", "new-1"]);
      expect(r.folder_shared).toEqual([{ role: "reader", type: "domain", target: "example.com", ok: true }]);
    });

    it("途中が既存でも、末端を今回作ったら末端に付ける", async () => {
      const { deps, permitted } = folderDeps(["repo"]);
      const r = await handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo/#1", share: spec, share_new_folder: true });
      expect(r.folder_id).toBe("new-0");
      expect(permitted).toEqual(["f1", "new-0"]);
    });

    it("途中を作っても、末端が既存(別プロセスが先に作った等)なら付けない", async () => {
      const { deps, permitted } = folderDeps(["#1"]);
      const r = await handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo/#1", share: spec, share_new_folder: true });
      expect(r.folders_created).toEqual(["repo"]);
      expect(permitted).toEqual(["f1"]);
      expect(r.folder_shared).toEqual([]);
    });

    it("再利用したフォルダには付けない", async () => {
      const { deps, permitted } = folderDeps(["repo#1"]);
      const r = await handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo#1", share: spec, share_new_folder: true });
      expect(r.folders_created).toEqual([]);
      expect(permitted).toEqual(["f1"]);
      expect(r.folder_shared).toEqual([]);
    });

    it("指定しなければ、新規フォルダでも付けない", async () => {
      const { deps, permitted } = folderDeps([]);
      const r = await handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo#1", share: spec });
      expect(permitted).toEqual(["f1"]);
      expect(r.folder_shared).toEqual([]);
    });

    it("フォルダの共有に失敗しても、アップロードとファイルの共有は成功として返す", async () => {
      const { deps } = folderDeps([], () => new Response(JSON.stringify({ error: { message: "Bad Request" } }), { status: 400 }));
      const r = await handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo#1", share: spec, share_new_folder: true });
      expect(r.id).toBe("f1");
      expect(r.shared).toEqual([expect.objectContaining({ ok: true })]);
      expect(r.folder_shared).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/Bad Request/) })]);
    });

    it("share か folder_path が無ければ何も呼ばずに弾く", async () => {
      const { deps } = folderDeps([]);
      await expect(handleUpload(deps, { path: join(dir, "r.csv"), share: spec, share_new_folder: true })).rejects.toThrow(/needs folder_path/);
      await expect(handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo#1", share_new_folder: true })).rejects.toThrow(/needs share/);
      await expect(handleUpload(deps, { path: join(dir, "r.csv"), folder_path: "repo#1", share: [], share_new_folder: true })).rejects.toThrow(/needs share/);
      expect(deps.calls).toHaveLength(0);
    });
  });

  describe("replace_id", () => {
    const SHEET = "application/vnd.google-apps.spreadsheet";
    function replaceDeps(meta: Record<string, unknown> | null) {
      const methods: string[] = [];
      const deps = makeDeps(dir, ENV_CREDS, (url, init) => {
        if (url.startsWith("https://www.googleapis.com/drive/v3/files/f1?")) {
          return meta ? new Response(JSON.stringify(meta)) : new Response(JSON.stringify({ error: { message: "File not found: f1." } }), { status: 404 });
        }
        if (url.includes("/upload/drive/v3/files")) {
          methods.push(`${init?.method} ${url.split("?")[0]}`);
          return new Response(null, { headers: { Location: "https://upload.test/s" } });
        }
        if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f1", name: "report", mimeType: SHEET, webViewLink: "https://docs.google.com/spreadsheets/d/f1/edit" }));
        return undefined;
      });
      return { deps, methods };
    }
    let file: string;
    beforeEach(() => {
      signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
      file = join(dir, "report.xlsx");
      writeFileSync(file, "x");
    });

    it("同名・同種・ゴミ箱外のファイルなら新規作成せず PATCH で中身を差し替え、同じ ID を返す", async () => {
      const { deps, methods } = replaceDeps({ id: "f1", name: "report", mimeType: SHEET, trashed: false });
      const r = await handleUpload(deps, { path: file, replace_id: "f1" });
      expect(methods).toEqual(["PATCH https://www.googleapis.com/upload/drive/v3/files/f1"]);
      expect(r).toMatchObject({ id: "f1", url: "https://docs.google.com/spreadsheets/d/f1/edit", replaced: true });
    });

    it.each([
      ["ゴミ箱にある", { id: "f1", name: "report", mimeType: SHEET, trashed: true }, /in the trash/],
      ["名前が違う(md をコピーした別レポート)", { id: "f1", name: "other-report", mimeType: SHEET, trashed: false }, /named "other-report"/],
      ["種類が違う", { id: "f1", name: "report", mimeType: "application/vnd.google-apps.document", trashed: false }, /same kind/],
      ["見えない(drivelift が作っていない・削除済み)", null, /can only replace files it created/],
    ])("%s ファイルは送信せずに拒否する", async (_label, meta, message) => {
      const { deps, methods } = replaceDeps(meta);
      await expect(handleUpload(deps, { path: file, replace_id: "f1" })).rejects.toThrow(message);
      expect(methods).toEqual([]);
    });

    it("名前は Unicode 正規化(NFC/NFD)の違いを同じ名前として扱う", async () => {
      const nfd = "レポート".normalize("NFD");
      writeFileSync(join(dir, `${"レポート".normalize("NFC")}.xlsx`), "x");
      const { deps, methods } = replaceDeps({ id: "f1", name: nfd, mimeType: SHEET, trashed: false });
      await handleUpload(deps, { path: join(dir, `${"レポート".normalize("NFC")}.xlsx`), replace_id: "f1" });
      expect(methods).toHaveLength(1);
    });

    it("変換しないファイルは、元の mimeType と一致すれば差し替える", async () => {
      const png = join(dir, "shot.png");
      writeFileSync(png, "x");
      const { deps, methods } = replaceDeps({ id: "f1", name: "shot.png", mimeType: "image/png", trashed: false });
      await handleUpload(deps, { path: png, replace_id: "f1" });
      expect(methods).toHaveLength(1);
      const other = replaceDeps({ id: "f1", name: "shot.png", mimeType: "image/jpeg", trashed: false });
      await expect(handleUpload(other.deps, { path: png, replace_id: "f1" })).rejects.toThrow(/same kind/);
    });

    it("確認の後で消されて差し替えが 404 になったら、フォルダではなく差し替え先が消えたと案内する", async () => {
      const deps = makeDeps(dir, ENV_CREDS, (url) => {
        if (url.startsWith("https://www.googleapis.com/drive/v3/files/f1?")) return new Response(JSON.stringify({ id: "f1", name: "report", mimeType: SHEET, trashed: false }));
        if (url.includes("/upload/drive/v3/files")) return new Response(JSON.stringify({ error: { message: "File not found: f1." } }), { status: 404 });
        return undefined;
      });
      await expect(handleUpload(deps, { path: file, replace_id: "f1" })).rejects.toThrow(/removed after drivelift checked it/);
    });

    it("置き先の指定との組み合わせと空の ID は Drive を呼ばずに弾く", async () => {
      const { deps } = replaceDeps(null);
      await expect(handleUpload(deps, { path: file, replace_id: "f1", folder_id: "F" })).rejects.toThrow(/cannot be combined/);
      await expect(handleUpload(deps, { path: file, replace_id: "f1", folder_path: "A" })).rejects.toThrow(/cannot be combined/);
      await expect(handleUpload(deps, { path: file, replace_id: " " })).rejects.toThrow(/replace_id is empty/);
      expect(deps.calls).toHaveLength(0);
    });
  });

  it("空の folder_id / folder_path と 21 件以上の share は何も呼ばずに弾く", async () => {
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
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
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "r.csv");
    writeFileSync(file, "a,b");
    const deps = makeDeps(dir, ENV_CREDS, () => undefined);
    await expect(handleUpload(deps, { path: file, share: [{ role: "reader", type: "user", target: "not-an-email" }] })).rejects.toThrow(/email/);
    expect(deps.calls).toHaveLength(0);
  });

  it("API 未有効化は api_disabled の Status に変換される", async () => {
    signIn(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000 });
    const file = join(dir, "a.md");
    writeFileSync(file, "# x");
    const deps = makeDeps(dir, ENV_CREDS, (url) => (url.includes("/upload/") ? new Response(JSON.stringify({ error: { message: "disabled", errors: [{ reason: "accessNotConfigured" }] } }), { status: 403 }) : undefined));
    await expect(handleUpload(deps, { path: file })).rejects.toMatchObject({ status: { state: "api_disabled" } });
  });
});

describe("resolveUserPath", () => {
  it("先頭の ~ を展開し、相対パスは cwd 基準にする", () => {
    expect(resolveUserPath("~/Downloads/x.json", "/cwd")).toBe(join(homedir(), "Downloads", "x.json"));
    expect(resolveUserPath("~", "/cwd")).toBe(homedir());
    expect(resolveUserPath("/abs/x", "/cwd")).toBe("/abs/x");
    expect(resolveUserPath("rel/x", "/cwd")).toBe(join("/cwd", "rel", "x"));
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

describe("複数アカウント", () => {
  const A = "a@example.com";
  const B = "b@example.com";
  const fresh = { access_token: "acc", expires_at: NOW + 600_000 };
  let repo: string;
  let file: string;

  /** a は git@github.com:org/a.git の作業ツリー。トークンは枠ごとに acc-<email> */
  beforeEach(() => {
    repo = join(dir, "work", "a");
    mkdirSync(join(repo, ".git"), { recursive: true });
    file = join(repo, "r.csv");
    writeFileSync(file, "a,b");
    signIn(dir, { refresh_token: "ref-a", ...fresh, access_token: `acc-${A}` }, A);
    signIn(dir, { refresh_token: "ref-b", ...fresh, access_token: `acc-${B}` }, B);
  });

  function uploadDeps(env: NodeJS.ProcessEnv = ENV_CREDS) {
    const bearers: string[] = [];
    const deps = makeDeps(dir, env, (url, init) => {
      if (url.includes("/upload/drive/v3/files")) {
        bearers.push(String((init?.headers as Record<string, string>)["Authorization"]));
        return new Response(null, { headers: { Location: "https://upload.test/s" } });
      }
      if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f1", webViewLink: "https://drive.test/f1" }));
      return undefined;
    });
    deps.gitOriginUrl = (root) => (root === repo ? "git@github.com:org/a.git" : null);
    return { deps, bearers };
  }

  it("枠が2つで到達元が対応づいていなければ、何も送らずに枠の一覧と到達元を返して拒否する", async () => {
    const { deps } = uploadDeps();
    const error = await handleUpload(deps, { path: file }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountUnresolvedError);
    expect((error as AccountUnresolvedError).toPayload()).toMatchObject({ state: "account_unresolved", candidates: [A, B], source: "github.com/org/a", next_steps: expect.arrayContaining([expect.stringMatching(/map_source/)]) });
    expect(deps.calls).toEqual([]);
  });

  it("同じ到達元が2つの枠に対応づいていたら(手で書いた sources.json)、曖昧として拒否する", async () => {
    saveSources(accountDir(dir, A), ["github.com/org/a"]);
    saveSources(accountDir(dir, B), ["github.com/org/a"]);
    const { deps } = uploadDeps();
    await expect(handleUpload(deps, { path: file })).rejects.toThrow(/more than one account/);
    expect(deps.calls).toEqual([]);
  });

  it("map_source で対応づけた到達元からは、その枠のトークンで送り、解決に使った鍵を返す", async () => {
    await handleMapSource(uploadDeps().deps, { account: B, source: "github.com/org/a" });
    const { deps, bearers } = uploadDeps();
    const r = await handleUpload(deps, { path: file });
    expect(bearers).toEqual([`Bearer acc-${B}`]);
    expect(r).toMatchObject({ account: B, source: "github.com/org/a" });
    expect(r.suggest_map).toBeUndefined();
  });

  it("account 引数で送ると、到達元が未登録なら suggest_map を返すが対応づけは書かない", async () => {
    const { deps, bearers } = uploadDeps();
    const r = await handleUpload(deps, { path: file, account: A });
    expect(bearers).toEqual([`Bearer acc-${A}`]);
    expect(r).toMatchObject({ account: A, source: null, suggest_map: { source: "github.com/org/a", account: A } });
    expect(existsSync(join(dir, "accounts", A, "sources.json"))).toBe(false);
  });

  it("account 引数が到達元の対応づけと食い違っても送るが、mapped_to に対応づいている枠を載せる", async () => {
    await handleMapSource(uploadDeps().deps, { account: B, source: "github.com/org/a" });
    const { deps, bearers } = uploadDeps();
    const r = await handleUpload(deps, { path: file, account: A });
    expect(bearers).toEqual([`Bearer acc-${A}`]);
    expect(r).toMatchObject({ account: A, mapped_to: B });
    expect(r).not.toHaveProperty("suggest_map");
    const same = await handleUpload(uploadDeps().deps, { path: file, account: B });
    expect(same).not.toHaveProperty("mapped_to");
    expect(same).not.toHaveProperty("suggest_map");
  });

  it("suggest_map は git remote の鍵のときだけ。パスの到達元(git でない・origin なし)では出さない", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "r.csv"), "a,b");
    const r = await handleUpload(uploadDeps().deps, { path: join(plain, "r.csv"), account: A });
    expect(r.account).toBe(A);
    expect(r).not.toHaveProperty("suggest_map");
    const { deps } = uploadDeps();
    deps.gitOriginUrl = () => null;
    expect(await handleUpload(deps, { path: file, account: A })).not.toHaveProperty("suggest_map");
  });

  it("account 引数で送るなら git が読めなくても送り、suggest_map も mapped_to も出さない", async () => {
    const { deps, bearers } = uploadDeps();
    deps.gitOriginUrl = () => {
      throw new Error("detected dubious ownership");
    };
    const r = await handleUpload(deps, { path: file, account: A });
    expect(bearers).toEqual([`Bearer acc-${A}`]);
    expect(r).not.toHaveProperty("suggest_map");
    expect(r).not.toHaveProperty("mapped_to");
  });

  it("git が読めなければ、パスの対応づけに落とさず git の失敗を理由に拒否する", async () => {
    saveSources(accountDir(dir, A), [join(dir, "work")]);
    const { deps } = uploadDeps();
    deps.gitOriginUrl = () => {
      throw new Error("detected dubious ownership in repository");
    };
    const error = await handleUpload(deps, { path: file }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountUnresolvedError);
    expect((error as AccountUnresolvedError).toPayload()).toMatchObject({ state: "account_unresolved", message: expect.stringMatching(/dubious ownership/), source: null });
    expect(deps.calls).toEqual([]);
  });

  it("パスの対応づけが重なれば最長一致で送る", async () => {
    const plain = join(dir, "plain", "clientB");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "r.csv"), "a,b");
    const { deps, bearers } = uploadDeps();
    await handleMapSource(deps, { account: A, source: join(dir, "plain") });
    await handleMapSource(deps, { account: B, source: plain });
    expect(await handleUpload(deps, { path: join(plain, "r.csv") })).toMatchObject({ account: B, source: plain });
    expect(bearers).toEqual([`Bearer acc-${B}`]);
  });

  it("DRIVELIFT_ACCOUNT で枠を選べる(suggest_map は出さない)。ログインしていないアカウントなら送らずに拒否する", async () => {
    const { deps, bearers } = uploadDeps({ ...ENV_CREDS, DRIVELIFT_ACCOUNT: B });
    const r = await handleUpload(deps, { path: file });
    expect(r).toMatchObject({ account: B, source: null });
    expect(r).not.toHaveProperty("suggest_map");
    expect(bearers).toEqual([`Bearer acc-${B}`]);
    const unknown = uploadDeps({ ...ENV_CREDS, DRIVELIFT_ACCOUNT: "c@example.com" });
    await expect(handleUpload(unknown.deps, { path: file })).rejects.toBeInstanceOf(AccountUnresolvedError);
    await expect(handleUpload(unknown.deps, { path: file, account: "c@example.com" })).rejects.toThrow(/c@example.com is not signed in/);
    expect(unknown.deps.calls).toEqual([]);
  });

  it("枠が1つなら、対応づけが無くても黙ってその枠で送る(0.4.0 と同じ振る舞い)", async () => {
    rmSync(join(dir, "accounts", B), { recursive: true });
    const { deps } = uploadDeps();
    const r = await handleUpload(deps, { path: file });
    expect(r).toMatchObject({ account: A, source: null });
    expect(r).not.toHaveProperty("suggest_map");
  });

  it("status は枠ごとの状態と cwd から解決される枠を返し、トップレベルの state は解決した枠の状態", async () => {
    const route: Route = (url, init) => {
      if (!url.includes("/drive/v3/about")) return undefined;
      const auth = String((init?.headers as Record<string, string>)["Authorization"]);
      return auth === `Bearer acc-${B}` ? disabledAbout(url, init) : okAbout(url, init);
    };
    const deps = makeDeps(dir, ENV_CREDS, route);
    deps.gitOriginUrl = () => "git@github.com:org/a.git";
    deps.cwd = repo;

    const unresolved = await handleStatus(deps);
    expect(unresolved).toMatchObject({ state: "account_unresolved", ready: false, resolved: { account: null, source: "github.com/org/a" } });
    expect(unresolved.accounts).toEqual([
      { email: A, state: "ready", sources: [], client_source: "env" },
      { email: B, state: "api_disabled", sources: [], client_source: "env" },
    ]);

    await handleMapSource(deps, { account: B, source: "github.com/org/a" });
    expect(await handleStatus(deps)).toMatchObject({ state: "api_disabled", resolved: { account: B, by: "source", source: "github.com/org/a" } });

    // git が読めなくても status 自体は落とさず、理由を resolved.reason に入れる
    deps.gitOriginUrl = () => {
      throw new Error("detected dubious ownership");
    };
    const gitFailed = await handleStatus(deps);
    expect(gitFailed).toMatchObject({ state: "account_unresolved", resolved: { account: null, source: null, reason: expect.stringMatching(/dubious ownership/) } });
    expect(gitFailed.accounts).toHaveLength(2);
  });

  describe("map_source", () => {
    it("source 省略時は path(省略時は cwd)の鍵を候補として返すだけで書かない", async () => {
      const { deps } = uploadDeps();
      const r = await handleMapSource(deps, { account: A, path: file });
      expect(r).toMatchObject({ state: "candidate", account: A, source: "github.com/org/a", sources: [] });
      deps.cwd = join(dir, "work");
      expect(await handleMapSource(deps, { account: A })).toMatchObject({ state: "candidate", source: join(dir, "work") });
      expect(existsSync(join(dir, "accounts", A, "sources.json"))).toBe(false);
    });

    it("追加・重複追加・削除。URL で渡しても鍵の形で保存する", async () => {
      const { deps } = uploadDeps();
      expect(await handleMapSource(deps, { account: A, source: "https://github.com/org/a.git" })).toMatchObject({ state: "added", source: "github.com/org/a", sources: ["github.com/org/a"] });
      expect(await handleMapSource(deps, { account: A, source: "github.com/org/a" })).toMatchObject({ state: "unchanged", sources: ["github.com/org/a"] });
      const x = join(dir, "x");
      mkdirSync(x);
      expect(await handleMapSource(deps, { account: A, source: `${x}/` })).toMatchObject({ state: "added", sources: ["github.com/org/a", x] });
      expect(await handleMapSource(deps, { account: A, source: "github.com/org/a", remove: true })).toMatchObject({ state: "removed", sources: [x] });
      expect(await handleMapSource(deps, { account: A, source: "github.com/org/a", remove: true })).toMatchObject({ state: "unchanged", sources: [x] });
    });

    it("別の枠に対応づいている到達元は追加せず、先に remove を求める(1回で付け替えさせない)", async () => {
      const { deps } = uploadDeps();
      await handleMapSource(deps, { account: A, source: "github.com/org/a" });
      await expect(handleMapSource(deps, { account: B, source: "https://github.com/org/a.git" })).rejects.toThrow(/already mapped to a@example.com.*remove/);
      const x = join(dir, "x");
      mkdirSync(x);
      await handleMapSource(deps, { account: A, source: `${x}/` });
      await expect(handleMapSource(deps, { account: B, source: x })).rejects.toThrow(/already mapped to a@example.com/);
      expect(existsSync(join(dir, "accounts", B, "sources.json"))).toBe(false);
      await handleMapSource(deps, { account: A, source: "github.com/org/a", remove: true });
      expect(await handleMapSource(deps, { account: B, source: "github.com/org/a" })).toMatchObject({ state: "added" });
    });

    it("短い・長い既存の対応づけと重なるパスを追加したら、最長一致になることを知らせる", async () => {
      const { deps } = uploadDeps();
      const work = join(dir, "work");
      mkdirSync(join(work, "clientB"), { recursive: true });
      mkdirSync(join(dir, "elsewhere"));
      await handleMapSource(deps, { account: A, source: work });
      expect((await handleMapSource(deps, { account: B, source: join(work, "clientB") })).message).toMatch(new RegExp(`overlaps ${work} \\(a@example.com\\).*longest`));
      expect((await handleMapSource(deps, { account: B, source: join(dir, "elsewhere") })).message).not.toMatch(/overlaps/);
    });

    it("ルート・ホーム・一時ディレクトリとその祖先は対応づけない(外すのはできる)", async () => {
      const { deps } = uploadDeps();
      const systemTemp = ["/tmp", "/var/tmp", ...(process.platform === "darwin" ? ["/private/tmp", "/private/var/tmp"] : [])];
      for (const source of ["/", homedir(), osTmpdir(), dirname(homedir()), ...systemTemp, `${homedir()}/.`, `${homedir()}/x/..`]) {
        await expect(handleMapSource(deps, { account: A, source })).rejects.toThrow(/too broad/);
      }
      expect(existsSync(join(dir, "accounts", A, "sources.json"))).toBe(false);
      saveSources(accountDir(dir, A), ["/"]);
      expect(await handleMapSource(deps, { account: A, source: "/", remove: true })).toMatchObject({ state: "removed", sources: [] });
    });

    it("ホームを指すシンボリックリンクも、実体で判定して対応づけない", async () => {
      const { deps } = uploadDeps();
      const link = join(dir, "home-link");
      symlinkSync(homedir(), link);
      await expect(handleMapSource(deps, { account: A, source: link })).rejects.toThrow(/too broad/);
    });

    it("存在しないパスは対応づけない(実体にそろえられず照合に使えない)が、外すことはできる", async () => {
      const { deps } = uploadDeps();
      const gone = join(dir, "gone");
      await expect(handleMapSource(deps, { account: A, source: gone })).rejects.toThrow(/does not exist/);
      expect(existsSync(join(dir, "accounts", A, "sources.json"))).toBe(false);
      saveSources(accountDir(dir, A), [gone]);
      expect(await handleMapSource(deps, { account: A, source: `${gone}/`, remove: true })).toMatchObject({ state: "removed", sources: [] });
    });

    it("remote を明示しても、cwd の git の鍵と同じで作業ツリーが広すぎれば対応づけない(違う remote は判定できないので受ける)", async () => {
      const home = join(dir, "home");
      mkdirSync(join(home, ".git"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      try {
        const { deps } = uploadDeps();
        deps.gitOriginUrl = (root) => (root === home ? "git@github.com:me/dotfiles.git" : null);
        deps.cwd = home;
        await expect(handleMapSource(deps, { account: A, source: "https://github.com/me/dotfiles.git" })).rejects.toThrow(/too broad.*working tree/);
        expect(existsSync(join(dir, "accounts", A, "sources.json"))).toBe(false);
        expect(await handleMapSource(deps, { account: A, source: "github.com/org/a" })).toMatchObject({ state: "added" });
        deps.cwd = repo;
        expect(await handleMapSource(deps, { account: A, source: "github.com/org/a", remove: true })).toMatchObject({ state: "removed" });
        expect(await handleMapSource(deps, { account: A, source: "github.com/org/a" })).toMatchObject({ state: "added" });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("候補が広すぎる場所なら、対応づけられないと案内する", async () => {
      const { deps } = uploadDeps();
      deps.cwd = homedir();
      const r = await handleMapSource(deps, { account: A });
      expect(r).toMatchObject({ state: "candidate", source: homedir() });
      expect(r.next).toMatch(/cannot be mapped/);
    });

    it("ホームを丸ごと git で管理していれば、その remote は suggest_map にも候補にも出さない", async () => {
      const home = join(dir, "home");
      mkdirSync(join(home, ".git"), { recursive: true });
      mkdirSync(join(home, "Downloads"));
      const invoice = join(home, "Downloads", "inv.csv");
      writeFileSync(invoice, "x");
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      try {
        const { deps } = uploadDeps();
        deps.gitOriginUrl = (root) => (root === home ? "git@github.com:me/dotfiles.git" : null);
        const r = await handleUpload(deps, { path: invoice, account: A });
        expect(r).toMatchObject({ account: A });
        expect(r).not.toHaveProperty("suggest_map");
        const candidate = await handleMapSource(deps, { account: A, path: invoice });
        expect(candidate).toMatchObject({ state: "candidate", source: "github.com/me/dotfiles" });
        expect(candidate.next).toMatch(/cannot be mapped.*working tree/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("path の相対指定は cwd 基準で解決する", async () => {
      const { deps } = uploadDeps();
      deps.cwd = repo;
      expect(await handleMapSource(deps, { account: A, path: "r.csv" })).toMatchObject({ state: "candidate", source: "github.com/org/a" });
    });

    it("ログインしていないアカウントと、鍵にならない source は書かずに弾く", async () => {
      const { deps } = uploadDeps();
      await expect(handleMapSource(deps, { account: "c@example.com", source: "github.com/org/a" })).rejects.toThrow(/c@example.com is not signed in.*a@example.com, b@example.com/);
      await expect(handleMapSource(deps, { account: A, source: "./rel" })).rejects.toThrow(/absolute path/);
      await expect(handleMapSource(deps, { account: A, source: "org/a" })).rejects.toThrow(/github\.com\/owner\/repo/);
      expect(existsSync(join(dir, "accounts", A, "sources.json"))).toBe(false);
    });
  });
});

describe("0.4.0 の token.json からの移行(写し)", () => {
  const legacy = () => join(dir, "token.json");
  const SECRET = JSON.stringify({ installed: { client_id: "file-id", client_secret: "file-sec" } });
  const refreshOk: Route = (url, init) => (url.includes("/token") ? new Response(JSON.stringify({ access_token: "new", expires_in: 3600 })) : okAbout(url, init));

  it("account があれば、1回 refresh して通ることを確かめてからその枠へ写し、元の token.json は書き換えずに残す", async () => {
    writeFileSync(clientSecretPath(dir), SECRET);
    const original = JSON.stringify({ refresh_token: "ref", access_token: "acc", expires_at: NOW + 600_000, account: "me@example.com" });
    writeFileSync(legacy(), original);
    const deps = makeDeps(dir, {}, refreshOk);
    const status = await handleStatus(deps);
    expect(status).toMatchObject({ state: "ready", account: "me@example.com", client_source: "file", resolved: { account: "me@example.com", by: "only_account" } });
    expect(readFileSync(legacy(), "utf-8")).toBe(original);
    expect(loadToken(join(dir, "accounts", "me@example.com"))).toMatchObject({ refresh_token: "ref", access_token: "new", account: "me@example.com", client_source: "file" });
    expect(parseClientSecret(readFileSync(clientSecretPath(join(dir, "accounts", "me@example.com")), "utf-8"))).toEqual({ clientId: "file-id", clientSecret: "file-sec" });
    expect(deps.calls.filter((u) => u.includes("/token"))).toHaveLength(1);
    expect(deps.calls.filter((u) => u.includes("/about"))).toHaveLength(1);
    // 写した後は旧ファイルを読まない。消してよいことを案内する
    expect(status.message).toMatch(/rm ".*token\.json"/);
  });

  it("写した後の呼び出しでは、旧ファイルのために refresh しない(account の無いトークンも)", async () => {
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref" }));
    const deps = makeDeps(dir, ENV_CREDS, refreshOk);
    await handleStatus(deps);
    expect(deps.calls.filter((u) => u.includes("/token"))).toHaveLength(1);
    const again = makeDeps(dir, ENV_CREDS, refreshOk);
    await handleStatus(again);
    expect(again.calls.filter((u) => u.includes("/token"))).toHaveLength(0);
  });

  it("account が無ければ refresh して about.get でメールを埋めてから写す", async () => {
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref" }));
    const deps = makeDeps(dir, ENV_CREDS, refreshOk);
    const status = await handleStatus(deps);
    expect(status).toMatchObject({ state: "ready", account: "me@example.com", client_source: "env" });
    expect(existsSync(legacy())).toBe(true);
    expect(loadToken(join(dir, "accounts", "me@example.com"))).toMatchObject({ refresh_token: "ref", access_token: "new", client_source: "env" });
  });

  it("同じアカウントの枠が既にあれば写さず、その枠を古いトークンで上書きしない", async () => {
    signIn(dir, { refresh_token: "ref-new", access_token: "acc", expires_at: NOW + 600_000 });
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref-old", account: "me@example.com" }));
    const deps = makeDeps(dir, ENV_CREDS, okAbout);
    expect(await handleStatus(deps)).toMatchObject({ state: "ready" });
    expect(loadToken(join(dir, "accounts", "me@example.com"))).toMatchObject({ refresh_token: "ref-new" });
    expect(deps.calls.filter((u) => u.includes("/token"))).toHaveLength(0);
  });

  it("クライアントが無ければ写さずに待ち、no_client を案内する(ネットワークも使わない)", async () => {
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref", account: "me@example.com" }));
    const deps = makeDeps(dir, {}, () => undefined);
    expect(await handleStatus(deps)).toMatchObject({ state: "no_client", accounts: [] });
    expect(existsSync(join(dir, "accounts"))).toBe(false);
    expect(deps.calls).toEqual([]);

    // 写しを持つ別の枠があっても、トップレベルのクライアントが無い間は写そうとせず、失敗も削除の案内も出さない
    saveAccount(dir, "other@example.com", { refresh_token: "r", access_token: "acc", expires_at: NOW + 600_000 }, { clientId: "cid", clientSecret: "csec", source: "file" });
    const withSlot = await handleStatus(makeDeps(dir, {}, okAbout));
    expect(withSlot).toMatchObject({ state: "ready", account: "other@example.com" });
    expect(withSlot.message).toBe("Ready. Signed in as other@example.com.");
    expect(existsSync(accountDir(dir, "me@example.com"))).toBe(false);
  });

  it("壊れていれば写さず、token.json を残し、理由付きで no_token と同じ案内をする", async () => {
    writeFileSync(legacy(), "{broken");
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, () => undefined));
    expect(status).toMatchObject({ state: "no_token", accounts: [] });
    expect(status.message).toMatch(/could not be copied.*corrupted/);
    expect(status.next_steps[0]).toMatch(/auth_start/);
    expect(existsSync(legacy())).toBe(true);
  });

  it("今のクライアントで refresh が通らなければ写さず、その理由の状態(invalid_grant・invalid_client)で返す", async () => {
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref", account: "me@example.com" }));
    const file = join(dir, "a.csv");
    writeFileSync(file, "x");
    const rejected = await handleUpload(makeDeps(dir, ENV_CREDS, invalidGrant), { path: file }).catch((e: unknown) => e);
    expect(rejected).toMatchObject({ message: expect.stringMatching(/of me@example\.com .*could not be copied.*invalid_grant/), status: { state: "token_invalid", message: expect.stringMatching(/could not be copied.*invalid_grant/) } });
    expect((rejected as DriveliftError).status?.next_steps[0]).toMatch(/auth_start with login_hint: me@example\.com/);
    // map_source も not signed in でなく同じ理由で弾く
    await expect(handleMapSource(makeDeps(dir, ENV_CREDS, invalidGrant), { account: "me@example.com", source: "github.com/o/r" })).rejects.toMatchObject({ status: { state: "token_invalid", message: expect.stringMatching(/invalid_grant/) } });
    // 別の内容のトークン(印と一致しない)は改めて refresh する
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref-2", account: "me@example.com" }));
    const invalidClient: Route = (url) => (url.includes("/token") ? new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }) : undefined);
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, invalidClient));
    expect(status).toMatchObject({ state: "token_invalid", accounts: [] });
    expect(status.next_steps.join("\n")).toMatch(/import_client_secret/);
    expect(existsSync(join(dir, "accounts"))).toBe(false);
    expect(existsSync(legacy())).toBe(true);
  });

  it("通信に失敗したら写さず、no_token とは報告しない(状態が分からないので通信の失敗として返す)", async () => {
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref", account: "me@example.com" }));
    const offline = makeDeps(dir, ENV_CREDS, () => {
      throw new TypeError("fetch failed");
    });
    const error = await handleStatus(offline).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveliftError);
    expect((error as DriveliftError).message).toMatch(/could not be copied.*fetch failed.*network/);
    expect((error as DriveliftError).status).toBeUndefined();
    expect(existsSync(join(dir, "accounts"))).toBe(false);

    // 枠がほかにあれば status は落とさず、message に理由を載せる
    signIn(dir, { refresh_token: "r", access_token: "acc", expires_at: NOW + 600_000 }, "other@example.com");
    const deps = makeDeps(dir, ENV_CREDS, (url, init) => {
      if (url.includes("/token")) throw new TypeError("fetch failed");
      return okAbout(url, init);
    });
    const status = await handleStatus(deps);
    expect(status).toMatchObject({ state: "ready", account: "other@example.com" });
    expect(status.message).toMatch(/could not be copied.*fetch failed/);
  });

  it("通信の失敗では印を残さず、map_source も通信の失敗として返し、次の呼び出しで再試行する", async () => {
    writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref", account: "me@example.com" }));
    const offline = makeDeps(dir, ENV_CREDS, () => {
      throw new TypeError("fetch failed");
    });
    await expect(handleMapSource(offline, { account: "me@example.com", source: "github.com/o/r" })).rejects.toThrow(/could not be copied.*fetch failed.*network/);
    expect(existsSync(join(dir, "legacy-migration.json"))).toBe(false);
    const online = makeDeps(dir, ENV_CREDS, refreshOk);
    expect(await handleStatus(online)).toMatchObject({ state: "ready", account: "me@example.com" });
    expect(online.calls.filter((u) => u.includes("/token"))).toHaveLength(1);
  });

  describe("写し済み・写せなかった印があれば、同じ内容の token.json では refresh しない", () => {
    const tokenCalls = (deps: { calls: string[] }) => deps.calls.filter((u) => u.includes("/token")).length;

    it("同じアカウントで先にログインし直していた(refresh_token が違う)", async () => {
      signIn(dir, { refresh_token: "ref-new", access_token: "acc", expires_at: NOW + 600_000 });
      writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref-old" }));
      const first = makeDeps(dir, ENV_CREDS, refreshOk);
      await handleStatus(first);
      expect(tokenCalls(first)).toBe(1);
      for (let i = 0; i < 2; i++) {
        const again = makeDeps(dir, ENV_CREDS, refreshOk);
        expect((await handleStatus(again)).message).toMatch(/rm ".*token\.json"/);
        expect(tokenCalls(again)).toBe(0);
      }
      expect(loadToken(join(dir, "accounts", "me@example.com"))).toMatchObject({ refresh_token: "ref-new" });
    });

    it("refresh で refresh_token がローテーションされた", async () => {
      writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref" }));
      const rotating: Route = (url, init) => (url.includes("/token") ? new Response(JSON.stringify({ access_token: "new", refresh_token: "rotated", expires_in: 3600 })) : okAbout(url, init));
      await handleStatus(makeDeps(dir, ENV_CREDS, rotating));
      expect(loadToken(join(dir, "accounts", "me@example.com"))).toMatchObject({ refresh_token: "rotated" });
      for (let i = 0; i < 2; i++) {
        const again = makeDeps(dir, ENV_CREDS, rotating);
        await handleStatus(again);
        expect(tokenCalls(again)).toBe(0);
      }
    });

    it("失効していて、ほかの枠がある", async () => {
      signIn(dir, { refresh_token: "r", access_token: "acc", expires_at: NOW + 600_000 }, "other@example.com");
      writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref" }));
      const revoked: Route = (url, init) => invalidGrant(url, init) ?? okAbout(url, init);
      const first = makeDeps(dir, ENV_CREDS, revoked);
      expect((await handleStatus(first)).message).toMatch(/could not be copied.*invalid_grant.*rm ".*token\.json"/);
      expect(tokenCalls(first)).toBe(1);
      for (let i = 0; i < 2; i++) {
        const again = makeDeps(dir, ENV_CREDS, revoked);
        const status = await handleStatus(again);
        expect(status).toMatchObject({ state: "ready", account: "other@example.com" });
        expect(status.message).toMatch(/could not be copied.*invalid_grant.*rm ".*token\.json"/);
        expect(tokenCalls(again)).toBe(0);
      }
    });

    it("token.json の内容が変われば(0.4.0 でログインし直した等)写し直す", async () => {
      writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref" }));
      await handleStatus(makeDeps(dir, ENV_CREDS, refreshOk));
      writeFileSync(legacy(), JSON.stringify({ refresh_token: "ref-relogin" }));
      const changed = makeDeps(dir, ENV_CREDS, refreshOk);
      await handleStatus(changed);
      expect(tokenCalls(changed)).toBe(1);
    });
  });

  it("ログインし直しても token.json は消さない(0.4.0 が使い続けられる)", async () => {
    writeFileSync(legacy(), "{broken");
    const deps = makeDeps(dir, ENV_CREDS, (url, init) => (url.includes("/token") ? new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref", expires_in: 3600 })) : okAbout(url, init)));
    deps.openBrowser = async (url) => {
      const state = new URL(url).searchParams.get("state");
      const port = new URL(new URL(url).searchParams.get("redirect_uri") as string).port;
      setTimeout(() => void fetch(`http://127.0.0.1:${port}/callback?code=C&state=${state}`), 10);
      return true;
    };
    expect(await handleAuthStart(deps, { wait_seconds: 5 })).toMatchObject({ state: "completed", account: "me@example.com" });
    expect(readFileSync(legacy(), "utf-8")).toBe("{broken");
  });
});

describe("枠ごとのクライアントとトークンの置き場所", () => {
  it("file でログインした枠は、env に別のクライアントがあっても写しのクライアントで refresh する", async () => {
    saveAccount(dir, "me@example.com", { refresh_token: "ref", access_token: "old", expires_at: NOW - 1 }, { clientId: "copy-id", clientSecret: "copy-sec", source: "file" });
    const bodies: string[] = [];
    const deps = makeDeps(dir, { DRIVELIFT_CLIENT_ID: "env-id", DRIVELIFT_CLIENT_SECRET: "env-sec" }, (url, init) => {
      if (url.includes("/token")) {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }));
      }
      return okAbout(url, init);
    });
    expect(await handleStatus(deps)).toMatchObject({ state: "ready", client_source: "file" });
    expect(bodies.map((b) => new URLSearchParams(b).get("client_id"))).toEqual(["copy-id"]);
  });

  it("期限切れの枠で upload / status を通すと、その枠の token.json が更新され、トップレベルに token.json はできない", async () => {
    signIn(dir, { refresh_token: "ref", access_token: "old", expires_at: NOW - 1 });
    const file = join(dir, "a.csv");
    writeFileSync(file, "x");
    let n = 0;
    const deps = makeDeps(dir, ENV_CREDS, (url, init) => {
      if (url.includes("/token")) return new Response(JSON.stringify({ access_token: `new-${++n}`, expires_in: 1 }));
      if (url.includes("/upload/drive/v3/files")) return new Response(null, { headers: { Location: "https://upload.test/s" } });
      if (url === "https://upload.test/s") return new Response(JSON.stringify({ id: "f1" }));
      return okAbout(url, init);
    });
    await handleUpload(deps, { path: file });
    expect(loadToken(accountDir(dir, "me@example.com"))).toMatchObject({ access_token: "new-1", account: "me@example.com", client_source: "env" });
    expect(existsSync(join(dir, "token.json"))).toBe(false);
    await handleStatus(deps);
    expect(loadToken(accountDir(dir, "me@example.com"))).toMatchObject({ access_token: "new-2" });
    expect(existsSync(join(dir, "token.json"))).toBe(false);
  });

  it("token_invalid の案内は、その枠のメールを login_hint に入れる", async () => {
    signIn(dir, { refresh_token: "ref" });
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, invalidGrant));
    expect(status.state).toBe("token_invalid");
    expect(status.next_steps.join("\n")).toContain("login_hint: me@example.com");
  });
});

describe("再ログイン", () => {
  it("login_hint を認可 URL に載せ、同じメールの再ログインは自分の枠だけを差し替える", async () => {
    signIn(dir, { refresh_token: "ref-a-old" }, "a@example.com");
    signIn(dir, { refresh_token: "ref-b" }, "b@example.com");
    await handleMapSource(makeDeps(dir, ENV_CREDS, () => undefined), { account: "b@example.com", source: "github.com/org/b" });
    const before = readdirSync(join(dir, "accounts", "b@example.com")).map((name) => readFileSync(join(dir, "accounts", "b@example.com", name), "utf-8"));

    const deps = makeDeps(dir, ENV_CREDS, (url) => {
      if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "acc-new", refresh_token: "ref-a-new", expires_in: 3600 }));
      if (url.includes("/drive/v3/about")) return new Response(JSON.stringify({ user: { emailAddress: "a@example.com" } }));
      return undefined;
    });
    const started = await handleAuthStart(deps, { wait_seconds: 0, login_hint: "a@example.com" });
    const authUrl = new URL(started.url);
    expect(authUrl.searchParams.get("login_hint")).toBe("a@example.com");
    expect(authUrl.searchParams.get("prompt")).toBe("select_account consent");
    const port = new URL(authUrl.searchParams.get("redirect_uri") as string).port;
    await fetch(`http://127.0.0.1:${port}/callback?code=C&state=${authUrl.searchParams.get("state")}`);
    await expect(handleAuthStatus(deps, { wait_seconds: 5 })).resolves.toMatchObject({ state: "completed", account: "a@example.com" });

    expect(loadToken(join(dir, "accounts", "a@example.com"))).toMatchObject({ refresh_token: "ref-a-new" });
    const after = readdirSync(join(dir, "accounts", "b@example.com")).map((name) => readFileSync(join(dir, "accounts", "b@example.com", name), "utf-8"));
    expect(after).toEqual(before);
  });

  it("空の login_hint はログインを始めずに弾く", async () => {
    await expect(handleAuthStart(makeDeps(dir, ENV_CREDS, () => undefined), { login_hint: " " })).rejects.toThrow(/login_hint is empty/);
  });
});

describe("枠ごとの状態", () => {
  it("壊れた枠は token_invalid で、ほかの枠の状態は出せる。env でログインした枠を環境変数なしで使うと no_client", async () => {
    signIn(dir, { refresh_token: "r", access_token: "acc", expires_at: NOW + 600_000 }, "a@example.com");
    mkdirSync(join(dir, "accounts", "b@example.com"));
    writeFileSync(join(dir, "accounts", "b@example.com", "token.json"), "{broken");
    const status = await handleStatus(makeDeps(dir, ENV_CREDS, okAbout));
    expect(status.accounts?.map((a) => [a.email, a.state])).toEqual([["a@example.com", "ready"], ["b@example.com", "token_invalid"]]);

    const noEnv = await handleStatus({ ...makeDeps(dir, {}, okAbout), env: { DRIVELIFT_ACCOUNT: "a@example.com" } });
    expect(noEnv).toMatchObject({ state: "no_client", client_source: "env", resolved: { account: "a@example.com", by: "env" } });
    expect(noEnv.message).toMatch(/DRIVELIFT_CLIENT_ID/);
  });
});
