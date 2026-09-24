#!/usr/bin/env node
/**
 * cli.ts — drivelift のコマンドラインエントリ。MCP サーバーと同じ core.ts を使う。
 *
 *   drivelift                       MCP stdio サーバーとして起動(.mcp.json の "command": "drivelift" 用)
 *   drivelift serve                 同上
 *   drivelift doctor                導入状態と次の一手を表示
 *   drivelift login                 ブラウザで Google ログイン(完了まで待つ)
 *   drivelift import-secret [path]  client_secret JSON を取り込む(省略時は ~/Downloads の候補を列挙)
 *   drivelift setup-gcloud [--project ID] [--yes]  gcloud で手順 1-2 を実行(--yes なしは計画表示)
 *   drivelift upload <file> [--folder ID] [--name N] [--convert MODE] [--json]
 *                                アップロードして URL を出力(--json で全項目)
 */
import { parseArgs } from "node:util";
import { defaultDeps, handleAuthStart, handleGcloudSetup, handleImportClientSecret, handleStatus, handleUpload, waitForLogin } from "./core.js";
import { DriveliftError } from "./errors.js";
import { CONVERT_MODES, type ConvertMode } from "./mime.js";
import { runServer } from "./server.js";
import type { Status } from "./status.js";
import { resolvePackageVersion } from "./version.js";

const USAGE = `drivelift ${resolvePackageVersion()} — carry local files into Google Drive as Docs/Sheets/Slides

Usage:
  drivelift [serve]                         run as MCP stdio server
  drivelift doctor                          show setup status and next steps
  drivelift login                           sign in with Google (opens browser)
  drivelift import-secret [path]            import a downloaded OAuth client JSON
  drivelift setup-gcloud [--project <id>] [--yes]
                                         create/select a project and enable the Drive API via gcloud
                                         (without --yes: show the plan only)
  drivelift upload <file> [options]         upload (and convert) a file, print its URL
      --folder <id>    destination folder ID
      --name <name>    name in Drive
      --convert <mode> auto | none | spreadsheet | document | presentation (default auto)
      --json           print the full result as JSON
  drivelift --help | --version
`;

function parseUploadArgs(args: string[]): ReturnType<typeof parseUploadArgsRaw> {
  try {
    return parseUploadArgsRaw(args);
  } catch (error) {
    // parseArgs は未知のオプション等で TypeError を投げる。利用者向けの文言に直す
    throw new DriveliftError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

function parseUploadArgsRaw(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      folder: { type: "string" },
      name: { type: "string" },
      convert: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
}

function formatStatus(status: Status): string {
  const lines = [`state: ${status.state}`, status.message];
  if (status.account) lines.push(`account: ${status.account}`);
  lines.push(`config: ${status.config_dir}`);
  if (!status.ready) {
    lines.push("", "next steps:");
    for (const step of status.next_steps) lines.push(`  ${step}`);
  }
  return lines.join("\n");
}

function printError(error: unknown): void {
  if (error instanceof DriveliftError) {
    console.error(`error: ${error.message}`);
    if (error.status) console.error("", formatStatus(error.status));
    return;
  }
  console.error("unexpected error:", error);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "serve") {
    await runServer();
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${resolvePackageVersion()}\n`);
    return 0;
  }

  const deps = defaultDeps();
  try {
    switch (command) {
      case "doctor": {
        const status = await handleStatus(deps);
        process.stdout.write(`${formatStatus(status)}\n`);
        return status.ready ? 0 : 2;
      }
      case "login": {
        const started = await handleAuthStart(deps, { wait_seconds: 0 });
        process.stderr.write(`${started.browser_opened ? "Opened your browser." : "Open this URL in your browser:"}\n${started.url}\n\nWaiting for the sign-in to finish (up to ${started.expires_in_seconds}s)...\n`);
        const { account } = await waitForLogin();
        process.stdout.write(account ? `Signed in as ${account}.\n` : "Signed in.\n");
        return 0;
      }
      case "import-secret": {
        const path = rest[0];
        const result = handleImportClientSecret(deps, path === undefined ? {} : { path });
        if (result.imported) {
          process.stdout.write(`Saved to ${result.saved_to}\n${result.next}\n`);
          return 0;
        }
        if (result.candidates.length === 0) {
          process.stdout.write(`${result.next}\n`);
          return 2;
        }
        process.stdout.write("Candidates in ~/Downloads (newest first):\n");
        for (const c of result.candidates) process.stdout.write(`  ${c.path}  (${c.modified})\n`);
        process.stdout.write("Re-run: drivelift import-secret <path>\n");
        return 2;
      }
      case "setup-gcloud": {
        const { values } = parseArgs({ args: rest, options: { project: { type: "string" }, yes: { type: "boolean", default: false } } });
        const result = await handleGcloudSetup(deps, { ...(values.project === undefined ? {} : { project_id: values.project }), confirm: values.yes });
        process.stdout.write(`${result.message}\n`);
        if (result.state === "plan" || result.state === "needs_login") {
          for (const c of result.planned_commands) process.stdout.write(`  $ ${c}\n`);
          process.stdout.write("Re-run with --yes to execute.\n");
        }
        if (result.executed_commands.length > 0) for (const c of result.executed_commands) process.stdout.write(`  ran: ${c}\n`);
        if (result.next_steps.length > 0) {
          process.stdout.write("\nnext steps:\n");
          for (const s of result.next_steps) process.stdout.write(`  ${s}\n`);
        }
        return result.state === "done" || (result.state === "plan" && result.planned_commands.length === 0) ? 0 : 2;
      }
      case "upload": {
        const { values, positionals } = parseUploadArgs(rest);
        const file = positionals[0];
        if (!file) {
          process.stderr.write(USAGE);
          return 2;
        }
        if (values.convert !== undefined && !(CONVERT_MODES as readonly string[]).includes(values.convert)) {
          throw new DriveliftError(`--convert must be one of ${CONVERT_MODES.join(", ")}.`);
        }
        const result = await handleUpload(deps, {
          path: file,
          ...(values.name === undefined ? {} : { name: values.name }),
          ...(values.folder === undefined ? {} : { folder_id: values.folder }),
          ...(values.convert === undefined ? {} : { convert: values.convert as ConvertMode }),
        });
        process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.url}\n`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    printError(error);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // serve は常駐なので exit しない(runServer は接続後に戻る)
    if (process.argv[2] !== undefined && process.argv[2] !== "serve") process.exit(code);
  },
  (error: unknown) => {
    printError(error);
    process.exit(1);
  },
);
