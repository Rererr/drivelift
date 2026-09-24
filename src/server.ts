#!/usr/bin/env node
/**
 * server.ts — drivelift MCP stdio サーバー。
 *
 * ツール(5個):
 *   - status: 導入状態と次の一手(未設定なら Console の URL 群、未ログインなら auth_start、等)
 *   - auth_start / auth_status: ブラウザでの Google ログインを開始/確認(2段。1ツールで待たない)
 *   - import_client_secret: ダウンロード済みの client_secret JSON を設定ディレクトリへ取り込む(パス指定のみ。中身は会話に通さない)
 *   - gcloud_setup: gcloud があれば手順 1-2(プロジェクト・Drive API)を代理実行。confirm なしは計画のみ
 *   - upload: ローカルファイルを Drive へ置き、拡張子に応じて Docs/Sheets/Slides へ変換。URL を返す
 *
 * ハンドラの応答は JSON テキスト。失敗時も status(next_steps / urls)を同じ形で載せる(SDK の入力検証エラーだけは SDK がプレーンテキストで返す)。
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { cancelPendingLogin, DEFAULT_AUTH_WAIT_SECONDS, defaultDeps, handleAuthStart, handleAuthStatus, handleGcloudSetup, handleImportClientSecret, handleStatus, handleUpload, MAX_AUTH_WAIT_SECONDS, type Deps } from "./core.js";
import { DriveliftError } from "./errors.js";
import { SHARE_ROLES, SHARE_TYPES, type ShareRole, type ShareType } from "./drive.js";
import { CONVERT_MODES } from "./mime.js";
import { resolvePackageVersion } from "./version.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  if (error instanceof DriveliftError) {
    return { content: [{ type: "text", text: JSON.stringify(error.toPayload(), null, 2) }], isError: true };
  }
  console.error(error);
  const cause = error instanceof Error && error.cause instanceof Error ? ` (cause: ${error.cause.message})` : "";
  return { content: [{ type: "text", text: JSON.stringify({ error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}${cause}` }, null, 2) }], isError: true };
}

async function run(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

export function createServer(deps: Deps = defaultDeps()): McpServer {
  const server = new McpServer({ name: "drivelift", version: resolvePackageVersion() });

  server.registerTool(
    "status",
    {
      title: "Check drivelift setup status",
      description:
        "Report whether drivelift can upload to Google Drive right now. Returns state (no_client / no_token / token_invalid / api_disabled / ready), " +
        "a message, next_steps, and urls. When not ready, relay next_steps to the user verbatim — they contain the exact Google Cloud Console links, " +
        "a gcloud_setup hint when gcloud is installed, and a ready-made mv command when a downloaded client JSON is found in ~/Downloads. " +
        "console_form lists sample values for every Console field in steps 3-4; show it to the user as a table so they can fill the forms without guessing. " +
        "drivelift uses a bring-your-own OAuth client (Desktop app type) and the drive.file scope only.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => handleStatus(deps)),
  );

  server.registerTool(
    "auth_start",
    {
      title: "Start Google sign-in",
      description:
        "Begin the OAuth sign-in. Opens the Google consent page in the user's browser (loopback redirect on 127.0.0.1) and waits up to wait_seconds " +
        "(default 90) for the user to finish; if they do, the result is state: completed and no further call is needed. Otherwise state: pending — " +
        "call auth_status (with wait_seconds) to keep waiting. Requires an OAuth client (see status).",
      inputSchema: z.object({
        open_browser: z.boolean().optional().describe("Default true. Set false to only return the URL."),
        wait_seconds: z.number().int().min(0).max(MAX_AUTH_WAIT_SECONDS).optional().describe(`Seconds to wait for the sign-in to finish before returning (default ${DEFAULT_AUTH_WAIT_SECONDS}, 0 = return immediately).`),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ open_browser, wait_seconds }) =>
      run(() => handleAuthStart(deps, { ...(open_browser === undefined ? {} : { open_browser }), ...(wait_seconds === undefined ? {} : { wait_seconds }) })),
  );

  server.registerTool(
    "auth_status",
    {
      title: "Check sign-in progress",
      description: "Report the state of the sign-in started by auth_start: idle / pending / completed / failed. With wait_seconds it blocks until the sign-in settles or the time runs out.",
      inputSchema: z.object({
        wait_seconds: z.number().int().min(0).max(MAX_AUTH_WAIT_SECONDS).optional().describe("Seconds to wait for the sign-in to settle (default 0)."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ wait_seconds }) => run(() => handleAuthStatus(deps, wait_seconds === undefined ? {} : { wait_seconds })),
  );

  server.registerTool(
    "import_client_secret",
    {
      title: "Import OAuth client JSON",
      description:
        "Copy a downloaded OAuth client JSON (Desktop app type) into drivelift's config directory. Pass the file path; the secret itself never enters the conversation. " +
        "Without a path, it only lists client_secret*.json candidates in ~/Downloads (newest first) and copies nothing — confirm with the user, then call again with the chosen path.",
      inputSchema: z.object({
        path: z.string().optional().describe("Path to the downloaded client_secret_*.json"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ path }) => run(() => handleImportClientSecret(deps, path === undefined ? {} : { path })),
  );

  server.registerTool(
    "gcloud_setup",
    {
      title: "Run setup steps 1-2 with gcloud",
      description:
        "For users who have the gcloud CLI: prepare a Google Cloud project and enable the Drive API on the user's behalf. " +
        "Without confirm it only reports what it would run (planned_commands) — show that to the user and ask for approval. " +
        "With confirm: true it runs those commands (and `gcloud auth login`, opening a browser, if gcloud has no active account). " +
        "Steps 3-4 (consent screen, Desktop-app OAuth client) cannot be automated and are returned as next_steps with project-scoped Console links, plus console_form with sample values for every field (show it to the user as a table).",
      inputSchema: z.object({
        project_id: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).optional().describe("Project ID to use or create. Default: gcloud's current project, else a generated drivelift-xxxxxxxx."),
        confirm: z.boolean().optional().describe("Default false (plan only). true = execute the planned commands."),
        login_if_needed: z.boolean().optional().describe("Default true. With confirm, run `gcloud auth login` when no gcloud account is active."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ project_id, confirm, login_if_needed }) =>
      run(() =>
        handleGcloudSetup(deps, {
          ...(project_id === undefined ? {} : { project_id }),
          ...(confirm === undefined ? {} : { confirm }),
          ...(login_if_needed === undefined ? {} : { login_if_needed }),
        }),
      ),
  );

  server.registerTool(
    "upload",
    {
      title: "Upload a local file to Google Drive",
      description:
        "Upload a local file to Google Drive and return its URL. By default (convert: auto) spreadsheets (xlsx/csv/tsv/ods) become Google Sheets, " +
        "documents (docx/md/txt/html/rtf/odt) become Google Docs, and slides (pptx/odp) become Google Slides via Drive's own import, which carries over most formatting. " +
        "Other files are stored as-is. Destination: My Drive root by default; folder_path (e.g. \"Reports/2026-09\") finds or creates folders that drivelift made, optionally under folder_id. " +
        "share grants access to the new file (user/group by email, domain, or anyone-with-link) — set it only when the user asked for it, and never use type anyone unless the user explicitly asked to make the file public. " +
        "Per-share results come back in shared; a failed share does not undo the upload. If drivelift is not set up, the error carries next_steps to relay to the user.",
      inputSchema: z.object({
        path: z.string().describe("Local file path (absolute, or relative to the server's working directory)"),
        name: z.string().optional().describe("Name in Drive. Default: the file name (extension dropped when converting)"),
        folder_id: z.string().optional().describe("Destination folder ID (the part after /folders/ in the folder URL). Caution: with the drive.file scope, folders that drivelift did not create are usually invisible to it and Drive returns 404; omit it to upload to My Drive root."),
        folder_path: z.string().optional().describe("Folder path like \"Reports/2026-09\", found or created under folder_id (or My Drive root). Only folders drivelift created are reused (drive.file scope)."),
        convert: z.enum(CONVERT_MODES).optional().describe("auto (default) / none / spreadsheet / document / presentation"),
        share: z
          .array(
            z.object({
              role: z.enum(SHARE_ROLES as [ShareRole, ...ShareRole[]]).describe("reader / commenter / writer"),
              type: z.enum(SHARE_TYPES as [ShareType, ...ShareType[]]).describe("user / group (target = email), domain (target = domain name), anyone (anyone with the link; no target)"),
              target: z.string().optional(),
            }),
          )
          .optional()
          .describe("Permissions to add to the uploaded file. Only when the user asked for it."),
        notify: z.boolean().optional().describe("Send Google's notification email to user/group shares. Default false."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ path, name, folder_id, folder_path, convert, share, notify }) =>
      run(() =>
        handleUpload(deps, {
          path,
          ...(name === undefined ? {} : { name }),
          ...(folder_id === undefined ? {} : { folder_id }),
          ...(folder_path === undefined ? {} : { folder_path }),
          ...(convert === undefined ? {} : { convert }),
          ...(share === undefined ? {} : { share: share.map((s) => ({ role: s.role, type: s.type, ...(s.target === undefined ? {} : { target: s.target }) })) }),
          ...(notify === undefined ? {} : { notify }),
        }),
      ),
  );

  return server;
}

export async function runServer(): Promise<void> {
  // クライアント切断後にループバックのログイン待ちが event loop を握って残らないようにする
  process.stdin.once("end", cancelPendingLogin);
  process.stdin.once("close", cancelPendingLogin);
  serveStdio(
    () => {
      try {
        return createServer();
      } catch (error) {
        console.error("failed to initialize drivelift server:", error);
        process.exit(1);
      }
    },
    {
      legacy: "serve",
      onerror: (error: Error) => {
        console.error("MCP stdio error:", error);
      },
    },
  );
}

function isDirectlyExecuted(): boolean {
  return typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
}

if (isDirectlyExecuted()) {
  runServer().catch((error: unknown) => {
    console.error("failed to start drivelift server:", error);
    process.exit(1);
  });
}
