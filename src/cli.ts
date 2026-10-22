#!/usr/bin/env node
/**
 * cli.ts — drivelift のコマンドラインエントリ。MCP サーバーと同じ core.ts を使う。
 *
 *   drivelift                       MCP stdio サーバーとして起動(.mcp.json の "command": "drivelift" 用)
 *   drivelift serve                 同上
 *   drivelift doctor                導入状態と次の一手、ログイン済みのアカウントと cwd から解決される枠を表示
 *   drivelift login [--hint EMAIL]  ブラウザで Google ログイン(完了まで待つ)。アカウントごとに枠ができる
 *   drivelift import-secret [path]  client_secret JSON を取り込む(省略時は ~/Downloads の候補を列挙)
 *   drivelift setup-gcloud [--project ID] [--yes]  gcloud で手順 1-2 を実行(--yes なしは計画表示)
 *   drivelift upload <file> [--account EMAIL] [--folder ID] [--folder-path A/B] [--name N] [--convert MODE]
 *                    [--share ROLE:TYPE[:TARGET]]... [--share-new-folder] [--notify] [--replace ID] [--json]
 *   drivelift map <email> [source] [--remove]  到達元をアカウントに対応づける/外す(source 省略時は cwd の鍵を表示するだけ)
 *
 * 終了コード: 0 成功 / 1 実行時エラー / 2 使い方の誤り・未導入(doctor)・アカウントが決まらない・map の候補表示 / 3 アップロードは成功したが共有の一部が失敗
 *                                アップロードして URL を出力(--json で全項目)
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultDeps, handleAuthStart, handleGcloudSetup, handleImportClientSecret, handleMapSource, handleStatus, handleUpload, waitForLogin, type Deps } from "./core.js";
import { AccountUnresolvedError, DriveliftError, DriveliftInputError } from "./errors.js";
import { accountsDir } from "./config.js";
import type { ShareSpec } from "./drive.js";
import { CONVERT_MODES, type ConvertMode } from "./mime.js";
import { runServer } from "./server.js";
import type { Status } from "./status.js";
import { resolvePackageVersion } from "./version.js";

const USAGE = `drivelift ${resolvePackageVersion()} — carry local files into Google Drive as Docs/Sheets/Slides

Usage:
  drivelift [serve]                         run as MCP stdio server
  drivelift doctor                          show setup status, signed-in accounts and the one
                                         used from the current directory
  drivelift login [--hint <email>]          sign in with Google (opens browser); each account
                                         gets its own slot
  drivelift import-secret [path]            import a downloaded OAuth client JSON
  drivelift setup-gcloud [--project <id>] [--yes]
                                         create/select a project and enable the Drive API via gcloud
                                         (without --yes: show the plan only)
  drivelift upload <file> [options]         upload (and convert) a file, print its URL
      --account <email>  signed-in account to upload with (default: DRIVELIFT_ACCOUNT, the
                       account mapped to this repository/directory, or the only account)
      --folder <id>    destination folder ID
      --folder-path <a/b>  find or create folders (drivelift-made) under --folder or My Drive
      --name <name>    name in Drive
      --share <role:type[:target]>  grant access; repeatable. e.g. reader:domain:example.com,
                       writer:user:alice@example.com, reader:anyone (public link)
      --share-new-folder  also apply --share to the --folder-path folder if this upload
                       created it (reused folders are never shared)
      --notify         email user/group shares
      --replace <id>   replace the contents of an earlier upload (same URL) instead of
                       creating a new file; refused if trashed, renamed or a different kind
      --convert <mode> auto | none | spreadsheet | document | presentation (default auto)
      --json           print the full result as JSON
  drivelift map <email> [source] [--remove]
                                         map a source (git remote like github.com/org/repo, or an
                                         absolute path) to an account; without source, print the
                                         current directory's source and change nothing
  drivelift --help | --version
`;

/** 使い方の誤り。終了コード 2 にする。 */
class UsageError extends DriveliftError {}

/** parseArgs は未知のオプション等で TypeError を投げる。利用者向けの UsageError に直す。 */
function parseOrUsage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

function parseUploadArgs(args: string[]): ReturnType<typeof parseUploadArgsRaw> {
  return parseOrUsage(() => parseUploadArgsRaw(args));
}

function parseUploadArgsRaw(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      folder: { type: "string" },
      "folder-path": { type: "string" },
      share: { type: "string", multiple: true },
      "share-new-folder": { type: "boolean", default: false },
      notify: { type: "boolean", default: false },
      replace: { type: "string" },
      account: { type: "string" },
      name: { type: "string" },
      convert: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
}

/** "role:type[:target]" を ShareSpec にする。検証は core 側(validateShare)に任せる。 */
export function parseShareArg(arg: string): ShareSpec {
  const [role, type, ...rest] = arg.split(":");
  const target = rest.join(":");
  if (!role || !type) throw new UsageError(`--share must be role:type[:target] (got "${arg}").`);
  return { role: role as ShareSpec["role"], type: type as ShareSpec["type"], ...(target ? { target } : {}) };
}

/** 案内するコマンドの引数を POSIX シェル向けに単一引用符で包む。到達元は git remote やディレクトリ名から来るので `$(...)` を含みうる。 */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function formatStatus(status: Status): string {
  const lines = [`state: ${status.state}`, status.message];
  if (status.account) lines.push(`account: ${status.account}`);
  lines.push(`config: ${status.config_dir}`);
  if (status.accounts) {
    lines.push("", "accounts:");
    if (status.accounts.length === 0) lines.push("  (none)");
    for (const a of status.accounts) lines.push(`  ${a.email}  ${a.state}  client: ${a.client_source ?? "-"}  sources: ${a.sources.length > 0 ? a.sources.join(", ") : "-"}`);
    if (status.accounts.length > 0) lines.push(`  (to remove an account: rm -r "${accountsDir(status.config_dir)}/<email>")`);
  }
  if (status.resolved) {
    const r = status.resolved;
    lines.push(`resolved: ${r.account === null ? `none — ${r.reason}` : `${r.account} (by ${r.by})`}`, `source: ${r.source ?? "-"}`);
  }
  if (!status.ready) {
    lines.push("", "next steps:");
    for (const step of status.next_steps) lines.push(`  ${step}`);
  }
  if (status.candidates) lines.push("", "candidates (newest first):", ...status.candidates.map((c) => `  ${c}`));
  return lines.join("\n");
}

function printError(error: unknown): void {
  if (error instanceof DriveliftError) {
    console.error(`error: ${error.message}`);
    if (error.status) console.error("", formatStatus(error.status));
    if (error instanceof AccountUnresolvedError) console.error(`\ncandidates: ${error.candidates.join(", ")}\nsource: ${error.source ?? "-"}`);
    return;
  }
  console.error("unexpected error:", error);
}

export async function main(argv: string[], deps: Deps = defaultDeps()): Promise<number> {
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

  try {
    switch (command) {
      case "doctor": {
        const status = await handleStatus(deps);
        process.stdout.write(`${formatStatus(status)}\n`);
        return status.ready ? 0 : 2;
      }
      case "login": {
        const { values } = parseOrUsage(() => parseArgs({ args: rest, options: { hint: { type: "string" } } }));
        const started = await handleAuthStart(deps, { wait_seconds: 0, ...(values.hint === undefined ? {} : { login_hint: values.hint }) });
        process.stderr.write(`${started.browser_opened ? "Opened your browser." : "Open this URL in your browser:"}\n${started.url}\n\nWaiting for the sign-in to finish (up to ${started.expires_in_seconds}s)...\n`);
        const { account } = await waitForLogin();
        process.stdout.write(`Signed in as ${account}.\n`);
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
        const { values } = parseOrUsage(() => parseArgs({ args: rest, options: { project: { type: "string" }, yes: { type: "boolean", default: false } } }));
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
        if (rest.includes("--help") || rest.includes("-h")) {
          process.stdout.write(USAGE);
          return 0;
        }
        const { values, positionals } = parseUploadArgs(rest);
        const file = positionals[0];
        if (!file) {
          process.stderr.write(USAGE);
          return 2;
        }
        if (values.convert !== undefined && !(CONVERT_MODES as readonly string[]).includes(values.convert)) {
          throw new UsageError(`--convert must be one of ${CONVERT_MODES.join(", ")}.`);
        }
        const share = (values.share ?? []).map(parseShareArg);
        const result = await handleUpload(deps, {
          path: file,
          ...(values["folder-path"] === undefined ? {} : { folder_path: values["folder-path"] }),
          ...(share.length > 0 ? { share } : {}),
          ...(values["share-new-folder"] ? { share_new_folder: true } : {}),
          ...(values.notify ? { notify: true } : {}),
          ...(values.replace === undefined ? {} : { replace_id: values.replace }),
          ...(values.name === undefined ? {} : { name: values.name }),
          ...(values.folder === undefined ? {} : { folder_id: values.folder }),
          ...(values.convert === undefined ? {} : { convert: values.convert as ConvertMode }),
          ...(values.account === undefined ? {} : { account: values.account }),
        });
        process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.url}\n`);
        const failedShares = result.shared.filter((s) => !s.ok);
        for (const s of failedShares) process.stderr.write(`share failed: ${s.role}:${s.type}${s.target ? `:${s.target}` : ""} (${s.error ?? "unknown"})\n`);
        const failedFolderShares = result.folder_shared.filter((s) => !s.ok);
        for (const s of failedFolderShares) process.stderr.write(`folder share failed: ${s.role}:${s.type}${s.target ? `:${s.target}` : ""} (${s.error ?? "unknown"})\n`);
        // 意図した挙動だが、フォルダの URL を渡しても相手は開けないので知らせる
        if (values["share-new-folder"] && result.folder_shared.length === 0) process.stderr.write("folder not shared: the --folder-path folder already existed, and drivelift never shares a reused folder (share it in Drive if needed)\n");
        if (result.mapped_to) process.stderr.write(`note: uploaded with ${result.account} as given by --account, but this source is mapped to ${result.mapped_to}.\n`);
        if (result.suggest_map) process.stderr.write(`${result.suggest_map.source} is not mapped to any account. To use ${result.suggest_map.account} from here without --account: drivelift map ${shellArg(result.suggest_map.account)} ${shellArg(result.suggest_map.source)}\n`);
        return failedShares.length + failedFolderShares.length > 0 ? 3 : 0;
      }
      case "map": {
        const { values, positionals } = parseOrUsage(() => parseArgs({ args: rest, allowPositionals: true, options: { remove: { type: "boolean", default: false } } }));
        const [account, source] = positionals;
        if (!account || positionals.length > 2) throw new UsageError(`map takes <email> [source].\n\n${USAGE}`);
        const result = await handleMapSource(deps, { account, ...(source === undefined ? {} : { source }), ...(values.remove ? { remove: true } : {}) });
        process.stdout.write(`${result.message}\n`);
        if (result.state !== "candidate") {
          process.stdout.write(`sources of ${result.account}: ${result.sources.length > 0 ? result.sources.join(", ") : "-"}\n`);
          return 0;
        }
        process.stdout.write(`Re-run to ${values.remove ? "unmap" : "map"} it: drivelift map ${shellArg(result.account)} ${shellArg(result.source)}${values.remove ? " --remove" : ""}\n`);
        return 2;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    printError(error);
    return error instanceof UsageError || error instanceof DriveliftInputError ? 2 : 1;
  }
}

function isDirectlyExecuted(): boolean {
  return typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
}

if (isDirectlyExecuted()) main(process.argv.slice(2)).then(
  (code) => {
    // serve は常駐なので exit しない(runServer は接続後に戻る)
    if (process.argv[2] !== undefined && process.argv[2] !== "serve") process.exit(code);
  },
  (error: unknown) => {
    printError(error);
    process.exit(1);
  },
);
