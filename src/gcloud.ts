/**
 * gcloud.ts — gcloud CLI が入っている利用者向けに、導入手順 1-2 を代理実行する。
 *
 *   1. プロジェクトの用意(既存を使う / 新規作成)
 *   2. Drive API の有効化
 *
 * 同意画面と Desktop クライアントの作成(手順 3-4)は gcloud に API が無いので扱わない。
 * 実行は confirm: true のときだけ。confirm なしは「これから打つコマンド」を返す計画モードで、
 * 利用者(またはホストの許可プロンプト)が内容を見てから承認できるようにする。
 * gcloud の出力は stdio(MCP のチャネル)に流さず、すべて捕捉する。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DriveliftError } from "./errors.js";
import { CONSOLE_URLS, consoleForm, consoleSteps, type ConsoleForm } from "./status.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecGcloud = (args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

export const defaultExecGcloud: ExecGcloud = (args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile("gcloud", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      // 非ゼロ終了なら error.code は数値、起動失敗(ENOENT 等)なら文字列。後者は 1 に丸めて stderr に理由を残す
      const raw: unknown = error ? (error as { code?: unknown }).code : 0;
      const code = typeof raw === "number" ? raw : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && typeof raw === "string" ? `${raw}: ${error.message}` : "") });
    });
  });

export interface GcloudSetupInput {
  /** 使う/作るプロジェクト ID。省略時は gcloud の現在のプロジェクト、それも無ければ新規 ID を生成する。 */
  project_id?: string;
  /** true のときだけ実行する。false/省略は計画のみ。 */
  confirm?: boolean;
  /** gcloud にログインしていないとき `gcloud auth login` を(ブラウザを開いて)代理実行するか。既定 true。 */
  login_if_needed?: boolean;
}

export interface GcloudSetupResult {
  state: "plan" | "done" | "needs_login" | "unavailable";
  message: string;
  account: string | null;
  project_id: string | null;
  /** 計画モードで返す、これから実行するコマンド。 */
  planned_commands: string[];
  /** 実行モードで実際に走らせたコマンド。 */
  executed_commands: string[];
  next_steps: string[];
  urls: Record<string, string>;
  /** 手順 3-4 の入力サンプル(done / 実行不要の plan のとき)。 */
  console_form?: ConsoleForm;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CMD_TIMEOUT_MS = 120_000;

function quote(args: string[]): string {
  return ["gcloud", ...args].map((a) => (/[\s"']/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
}

export function generateProjectId(): string {
  // プロジェクト ID は 6-30 文字・小文字英数とハイフン・先頭は英字・全世界で一意
  return `drivelift-${randomBytes(4).toString("hex")}`;
}

/** プロジェクトとアカウントを URL に固定する(別アカウントの Console セッションで開いて権限エラーになるのを防ぐ)。 */
function projectUrls(projectId: string, account: string | null): { consent_screen: string; create_oauth_client: string } {
  const q = `?project=${encodeURIComponent(projectId)}${account ? `&authuser=${encodeURIComponent(account)}` : ""}`;
  return { consent_screen: `${CONSOLE_URLS.consent_screen}${q}`, create_oauth_client: `${CONSOLE_URLS.create_oauth_client}${q}` };
}

function remainingSteps(projectId: string, account: string | null, secretPath: string): string[] {
  return [
    ...consoleSteps(projectUrls(projectId, account), account),
    `5. Put the JSON at ${secretPath} (status returns a ready-made mv command once it is in ~/Downloads), then call auth_start.`,
    ...(account ? [`If the Console says you lack permissions, it is open with a different Google account: switch to ${account} (the links already pin it with authuser).`] : []),
  ];
}

async function activeAccount(exec: ExecGcloud): Promise<string | null> {
  const r = await exec(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { timeoutMs: CMD_TIMEOUT_MS });
  if (r.code !== 0) return null;
  const line = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : null;
}

async function currentProject(exec: ExecGcloud): Promise<string | null> {
  const r = await exec(["config", "get-value", "project"], { timeoutMs: CMD_TIMEOUT_MS });
  const v = r.stdout.trim();
  return r.code === 0 && v.length > 0 && v !== "(unset)" ? v : null;
}

async function projectExists(exec: ExecGcloud, projectId: string): Promise<boolean> {
  const r = await exec(["projects", "describe", projectId, "--format=value(projectId)"], { timeoutMs: CMD_TIMEOUT_MS });
  return r.code === 0 && r.stdout.trim() === projectId;
}

async function driveApiEnabled(exec: ExecGcloud, projectId: string): Promise<boolean> {
  const r = await exec(["services", "list", "--enabled", `--project=${projectId}`, "--filter=config.name:drive.googleapis.com", "--format=value(config.name)"], { timeoutMs: CMD_TIMEOUT_MS });
  return r.code === 0 && r.stdout.includes("drive.googleapis.com");
}

function failed(cmd: string[], r: ExecResult): never {
  throw new DriveliftError(`\`${quote(cmd)}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
}

/** Google のプロジェクト ID の規則。gcloud の引数へ渡す前に必ず通す(先頭 "-" でオプションとして解釈させない)。 */
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export async function runGcloudSetup(input: GcloudSetupInput, deps: { exec: ExecGcloud; hasGcloud: () => boolean; secretPath: string }): Promise<GcloudSetupResult> {
  if (input.project_id !== undefined && !PROJECT_ID_PATTERN.test(input.project_id)) {
    throw new DriveliftError(`Invalid project_id "${input.project_id}": use 6-30 lowercase letters, digits or hyphens, starting with a letter and not ending with a hyphen.`);
  }
  const base = (): Pick<GcloudSetupResult, "account" | "project_id" | "planned_commands" | "executed_commands" | "urls"> => ({ account: null, project_id: null, planned_commands: [], executed_commands: [], urls: {} });
  if (!deps.hasGcloud()) {
    return {
      ...base(),
      state: "unavailable",
      message: "gcloud is not installed (not found on PATH). Follow the Console steps from status instead, or install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install",
      next_steps: ["Call status for the Console links."],
    };
  }

  const executed: string[] = [];
  const run = async (args: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<ExecResult> => {
    executed.push(quote(args));
    const r = await deps.exec(args, { timeoutMs });
    if (r.code !== 0) failed(args, r);
    return r;
  };

  let account = await activeAccount(deps.exec);
  const loginCmd = ["auth", "login"];
  if (!account) {
    if (!input.confirm) {
      return {
        ...base(),
        state: "needs_login",
        message: "gcloud has no active account. With confirm: true, drivelift runs `gcloud auth login` (opens a browser) before the setup commands.",
        planned_commands: [quote(loginCmd)],
        next_steps: ["Call gcloud_setup again with confirm: true to sign in to gcloud and continue, or run `gcloud auth login` yourself first."],
      };
    }
    if (input.login_if_needed === false) {
      return { ...base(), state: "needs_login", message: "gcloud has no active account and login_if_needed is false.", next_steps: ["Run `gcloud auth login`, then call gcloud_setup again."] };
    }
    await run(loginCmd, LOGIN_TIMEOUT_MS);
    account = await activeAccount(deps.exec);
    if (!account) throw new DriveliftError("`gcloud auth login` finished but no active account was found.");
  }

  // 明示された ID はそのまま使う(無ければ作る)。gcloud config の既定プロジェクトは「見えるときだけ」使い、
  // describe できない(存在しない/権限がない)なら同名での作成を試みず、新しい ID を生成する
  const configured = input.project_id ? null : await currentProject(deps.exec);
  let projectId: string;
  let exists: boolean;
  let note = "";
  if (input.project_id) {
    projectId = input.project_id;
    exists = await projectExists(deps.exec, projectId);
  } else if (configured && PROJECT_ID_PATTERN.test(configured) && (await projectExists(deps.exec, configured))) {
    projectId = configured;
    exists = true;
  } else {
    projectId = generateProjectId();
    exists = false;
    if (configured) note = ` gcloud's configured project "${configured}" is not accessible from this account, so a new project ID was generated (pass project_id to choose one).`;
  }
  const enabled = exists ? await driveApiEnabled(deps.exec, projectId) : false;

  const planned: string[][] = [];
  if (!exists) planned.push(["projects", "create", projectId, "--name=drivelift"]);
  if (!enabled) planned.push(["services", "enable", "drive.googleapis.com", `--project=${projectId}`]);

  if (!input.confirm) {
    return {
      ...base(),
      state: "plan",
      account,
      project_id: projectId,
      planned_commands: planned.map(quote),
      message:
        planned.length === 0
          ? `Project ${projectId} already exists and the Drive API is enabled. Nothing to run.`
          : `Signed in to gcloud as ${account}. These commands will run with confirm: true${exists ? "" : ` (project ${projectId} will be created)`}.${note}`,
      next_steps: planned.length === 0 ? remainingSteps(projectId, account, deps.secretPath) : ["Ask the user to approve, then call gcloud_setup again with confirm: true (and the same project_id)."],
      ...(planned.length === 0 ? { console_form: consoleForm(account) } : {}),
      urls: projectUrls(projectId, account),
    };
  }

  for (const cmd of planned) await run(cmd);

  return {
    ...base(),
    state: "done",
    account,
    project_id: projectId,
    executed_commands: executed,
    message: `Project ${projectId} is ready with the Drive API enabled (gcloud account ${account}). Steps 3-4 must be done in the Console.`,
    next_steps: remainingSteps(projectId, account, deps.secretPath),
    urls: projectUrls(projectId, account),
    console_form: consoleForm(account),
  };
}
