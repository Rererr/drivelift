/**
 * core.ts — MCP サーバー(server.ts)と CLI(cli.ts)が共有するハンドラ。
 *
 * 各ハンドラは JSON 化できるオブジェクトを返し、失敗は DriveliftError を投げる。
 * 未設定・未ログイン・API 未有効化のときの DriveliftError は status(次の一手)を持つので、
 * 上位はそれをそのまま応答に載せればよい(利用者は upload をいきなり呼んでも誘導される)。
 *
 * 外部依存(設定ディレクトリ・fetch・時計・ブラウザ起動)は Deps で注入し、テストで差し替える。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { openBrowser } from "./browser.js";
import {
  clientSecretPath,
  findClientSecretCandidates,
  loadClientCredentials,
  resolveConfigDir,
  saveClientSecret,
  type ClientCredentials,
} from "./config.js";
import { createPermission, DriveRequestError, driveAbout, ensureFolderPath, uploadToDrive, validateShare, type DriveFailure, type FetchLike, type ShareSpec } from "./drive.js";
import { defaultExecGcloud, runGcloudSetup, type ExecGcloud, type GcloudSetupInput, type GcloudSetupResult } from "./gcloud.js";
import { DriveliftError } from "./errors.js";
import { CONVERT_MODES, defaultDriveName, extensionOf, resolveTargetMime, sourceMimeFor, type ConvertMode } from "./mime.js";
import { getAccessToken, startLoginSession, type LoginSession } from "./oauth.js";
import { apiDisabledStatus, noClientStatus, noTokenStatus, readyStatus, tokenInvalidStatus, type Status } from "./status.js";

export interface Deps {
  configDir: string;
  fetchImpl: FetchLike;
  now: () => number;
  env: NodeJS.ProcessEnv;
  openBrowser: (url: string) => Promise<boolean>;
  loginTimeoutMs: number;
  /** client_secret*.json を探すダウンロードディレクトリ。 */
  downloadsDir: string;
  /** gcloud CLI が使えるか。 */
  hasGcloud: () => boolean;
  /** gcloud の実行(gcloud_setup が confirm: true のときだけ使う)。 */
  execGcloud: ExecGcloud;
}

/** PATH 上に実行ファイルがあるか。Windows は .exe/.cmd も見る。 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  return (env["PATH"] ?? "").split(delimiter).filter(Boolean).some((dir) => names.some((n) => existsSync(join(dir, n))));
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  return {
    configDir: resolveConfigDir(env),
    fetchImpl: fetch,
    now: () => Date.now(),
    env,
    openBrowser,
    loginTimeoutMs: 10 * 60 * 1000,
    downloadsDir: join(homedir(), "Downloads"),
    hasGcloud: () => findOnPath("gcloud", env),
    execGcloud: defaultExecGcloud,
  };
}

// ---- gcloud ---------------------------------------------------------------

export function handleGcloudSetup(deps: Deps, input: GcloudSetupInput = {}): Promise<GcloudSetupResult> {
  return runGcloudSetup(input, { exec: deps.execGcloud, hasGcloud: deps.hasGcloud, secretPath: clientSecretPath(deps.configDir) });
}

function noClient(deps: Deps): Status {
  return noClientStatus(deps.configDir, { gcloud: deps.hasGcloud(), candidates: findClientSecretCandidates(deps.downloadsDir).map((c) => c.path) });
}

/** LLM は "~/..." をそのまま渡しがちなので、先頭の ~ だけ展開してから解決する。 */
export function resolveUserPath(input: string): string {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? `${homedir()}${input.slice(1)}` : input;
  return resolve(process.cwd(), expanded);
}

function requireCreds(deps: Deps): ClientCredentials {
  const creds = loadClientCredentials(deps.configDir, deps.env);
  if (!creds) throw new DriveliftError("OAuth client is not configured.", noClient(deps));
  return creds;
}

function statusFromDriveFailure(deps: Deps, failure: DriveFailure): Status | null {
  if (failure.kind === "api_disabled") return apiDisabledStatus(deps.configDir, failure.enableUrl);
  if (failure.kind === "unauthorized") return tokenInvalidStatus(deps.configDir, `Drive API returned 401: ${failure.message}`);
  return null;
}

// ---- status -------------------------------------------------------------

export async function handleStatus(deps: Deps): Promise<Status> {
  const creds = loadClientCredentials(deps.configDir, deps.env);
  if (!creds) return noClient(deps);
  let access: Awaited<ReturnType<typeof getAccessToken>>;
  try {
    access = await getAccessToken(creds, deps.configDir, deps.fetchImpl, deps.now);
  } catch (error) {
    if (error instanceof DriveliftError && error.status) return error.status;
    throw error;
  }
  if (!access) return noTokenStatus(deps.configDir, creds.source);
  try {
    const { emailAddress } = await driveAbout(access.accessToken, deps.fetchImpl);
    return readyStatus(deps.configDir, emailAddress ?? access.token.account ?? null, creds.source);
  } catch (error) {
    if (error instanceof DriveRequestError) {
      const status = statusFromDriveFailure(deps, error.failure);
      if (status) return status;
    }
    throw error;
  }
}

// ---- auth ---------------------------------------------------------------

type LoginOutcome = { kind: "pending" } | { kind: "completed"; account: string | null } | { kind: "failed"; message: string };

interface PendingLogin {
  session: LoginSession;
  startedAt: number;
  outcome: LoginOutcome;
}

/** MCP は1ツール呼び出しでブラウザ操作を待てない(タイムアウト)ので、開始と確認を分けてプロセス内に保持する。 */
let pendingLogin: PendingLogin | null = null;

export interface AuthStartResult {
  state: "pending" | "completed" | "failed";
  url: string;
  browser_opened: boolean;
  expires_in_seconds: number;
  account?: string | null;
  message: string;
  next: string;
}

/** 決着か wait_ms 経過のどちらか早い方まで待つ。決着していなければ pending のまま返す。 */
function waitForOutcome(entry: PendingLogin, waitMs: number): Promise<LoginOutcome> {
  if (waitMs <= 0 || entry.outcome.kind !== "pending") return Promise.resolve(entry.outcome);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(entry.outcome), waitMs);
    entry.session.done.then(
      () => {
        clearTimeout(timer);
        resolve(entry.outcome);
      },
      () => {
        clearTimeout(timer);
        resolve(entry.outcome);
      },
    );
  });
}

export const DEFAULT_AUTH_WAIT_SECONDS = 90;
export const MAX_AUTH_WAIT_SECONDS = 600;

function clampWait(seconds: number | undefined, fallback: number): number {
  if (seconds === undefined) return fallback;
  return Math.max(0, Math.min(MAX_AUTH_WAIT_SECONDS, Math.floor(seconds)));
}

export async function handleAuthStart(deps: Deps, input: { open_browser?: boolean; wait_seconds?: number } = {}): Promise<AuthStartResult> {
  const creds = requireCreds(deps);
  if (pendingLogin && pendingLogin.outcome.kind === "pending") pendingLogin.session.cancel();
  const session = await startLoginSession({ creds, configDir: deps.configDir, fetchImpl: deps.fetchImpl, now: deps.now, timeoutMs: deps.loginTimeoutMs });
  const entry: PendingLogin = { session, startedAt: deps.now(), outcome: { kind: "pending" } };
  pendingLogin = entry;
  session.done.then(
    (result) => {
      entry.outcome = { kind: "completed", account: result.account };
    },
    (error: unknown) => {
      entry.outcome = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    },
  );
  const browserOpened = input.open_browser === false ? false : await deps.openBrowser(session.url);
  // ブラウザでの同意が終わるまでここで待つ(既定 90 秒)。利用者が「終わった」と言わなくても完了が返る
  const outcome = await waitForOutcome(entry, clampWait(input.wait_seconds, DEFAULT_AUTH_WAIT_SECONDS) * 1000);
  const base = { url: session.url, browser_opened: browserOpened, expires_in_seconds: Math.round(deps.loginTimeoutMs / 1000) };
  switch (outcome.kind) {
    case "completed":
      return { ...base, state: "completed", account: outcome.account, message: outcome.account ? `Signed in as ${outcome.account}.` : "Signed in.", next: "You can call upload now." };
    case "failed":
      return { ...base, state: "failed", message: outcome.message, next: "Call auth_start to try again." };
    case "pending":
      return {
        ...base,
        state: "pending",
        message: browserOpened ? "A browser tab was opened but the sign-in has not finished yet." : "The sign-in has not finished yet.",
        next: browserOpened
          ? "Ask the user to finish the Google sign-in in the opened tab, then call auth_status (it can wait with wait_seconds)."
          : "Ask the user to open the URL in a browser and finish the Google sign-in, then call auth_status (it can wait with wait_seconds).",
      };
  }
}

export type AuthStatusResult =
  | { state: "idle"; message: string }
  | { state: "pending"; message: string; url: string; waited_seconds: number }
  | { state: "completed"; message: string; account: string | null }
  | { state: "failed"; message: string };

export async function handleAuthStatus(deps: Deps, input: { wait_seconds?: number } = {}): Promise<AuthStatusResult> {
  if (!pendingLogin) return { state: "idle", message: "No sign-in in progress. Call auth_start to begin, or status to see whether a token already exists." };
  const outcome = await waitForOutcome(pendingLogin, clampWait(input.wait_seconds, 0) * 1000);
  const { session, startedAt } = pendingLogin;
  switch (outcome.kind) {
    case "pending":
      return { state: "pending", message: "Waiting for the user to finish the sign-in in the browser.", url: session.url, waited_seconds: Math.round((deps.now() - startedAt) / 1000) };
    case "completed":
      return { state: "completed", message: outcome.account ? `Signed in as ${outcome.account}. You can call upload now.` : "Signed in. You can call upload now.", account: outcome.account };
    case "failed":
      return { state: "failed", message: `${outcome.message} Call auth_start to try again.` };
  }
}

/** stdio 切断時などに、待ち受け中のログインを閉じる(ループバックサーバーが event loop を握ってプロセスが残るのを防ぐ)。 */
export function cancelPendingLogin(): void {
  if (pendingLogin && pendingLogin.outcome.kind === "pending") pendingLogin.session.cancel();
}

/** ログイン完了まで待つ(CLI 用)。MCP では使わない。 */
export async function waitForLogin(): Promise<{ account: string | null }> {
  if (!pendingLogin) throw new DriveliftError("No sign-in in progress.");
  return pendingLogin.session.done;
}

// ---- client secret ------------------------------------------------------

export type ImportClientSecretResult =
  | { imported: true; saved_to: string; next: string }
  | { imported: false; candidates: Array<{ path: string; modified: string }>; next: string };

export function handleImportClientSecret(deps: Deps, input: { path?: string } = {}): ImportClientSecretResult {
  if (input.path) {
    const path = resolveUserPath(input.path);
    if (!existsSync(path)) throw new DriveliftError(`File not found: ${path}`);
    const { path: savedTo, tokenCleared } = saveClientSecret(deps.configDir, readFileSync(path, "utf-8"));
    return { imported: true, saved_to: savedTo, next: tokenCleared ? "The OAuth client changed, so the previous sign-in was discarded. Call auth_start to sign in with the new client." : "Call auth_start to sign in." };
  }
  const candidates = findClientSecretCandidates(deps.downloadsDir);
  return {
    imported: false,
    candidates,
    next: candidates.length > 0
      ? "Ask the user which file to import (newest first), then call import_client_secret again with that path. Nothing was copied yet."
      : "No client_secret*.json found in ~/Downloads. Download the Desktop-app OAuth client JSON from Google Cloud Console first (see status for the URLs), then call import_client_secret with its path.",
  };
}

// ---- upload -------------------------------------------------------------

export interface UploadInput {
  path: string;
  name?: string;
  folder_id?: string;
  /** "a/b" 形式。folder_id(省略時はマイドライブ直下)の下に探し、無ければ作る。 */
  folder_path?: string;
  convert?: ConvertMode;
  share?: ShareSpec[];
  /** user/group への共有で通知メールを送るか。既定 false。 */
  notify?: boolean;
}

export interface ShareOutcome {
  role: string;
  type: string;
  target: string | null;
  ok: boolean;
  error?: string;
}

export interface UploadResult {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  converted_to: string | null;
  account: string | null;
  folder_id: string | null;
  folders_created: string[];
  shared: ShareOutcome[];
}

export async function handleUpload(deps: Deps, input: UploadInput): Promise<UploadResult> {
  const convert = input.convert ?? "auto";
  if (!CONVERT_MODES.includes(convert)) throw new DriveliftError(`convert must be one of ${CONVERT_MODES.join(", ")}.`);
  const filePath = resolveUserPath(input.path);
  if (!existsSync(filePath)) throw new DriveliftError(`File not found: ${filePath}`);
  if (!statSync(filePath).isFile()) throw new DriveliftError(`Not a regular file: ${filePath}`);

  // 共有指定の誤りは何も作る前に弾く(アップロード後に失敗すると中途半端な状態が残る)
  for (const spec of input.share ?? []) validateShare(spec);

  const creds = requireCreds(deps);
  const access = await getAccessToken(creds, deps.configDir, deps.fetchImpl, deps.now);
  if (!access) throw new DriveliftError("Not signed in.", noTokenStatus(deps.configDir, creds.source));

  const ext = extensionOf(filePath);
  const targetMime = resolveTargetMime(ext, convert);
  const name = input.name ?? defaultDriveName(filePath, targetMime !== null);
  try {
    let folderId = input.folder_id;
    let foldersCreated: string[] = [];
    if (input.folder_path) {
      const folder = await ensureFolderPath(access.accessToken, input.folder_path, input.folder_id, deps.fetchImpl);
      folderId = folder.id;
      foldersCreated = folder.created;
    }
    const file = await uploadToDrive({
      accessToken: access.accessToken,
      filePath,
      name,
      sourceMime: sourceMimeFor(ext),
      targetMime,
      ...(folderId ? { folderId } : {}),
      fetchImpl: deps.fetchImpl,
    });
    // 共有はファイルができた後なので、1件の失敗で全体を失敗にしない(ファイルは残る)。件ごとの成否を返す
    const shared: ShareOutcome[] = [];
    for (const spec of input.share ?? []) {
      try {
        await createPermission(access.accessToken, file.id, spec, input.notify ?? false, deps.fetchImpl);
        shared.push({ role: spec.role, type: spec.type, target: spec.target ?? null, ok: true });
      } catch (error) {
        shared.push({ role: spec.role, type: spec.type, target: spec.target ?? null, ok: false, error: error instanceof DriveRequestError && error.failure.kind !== "other" ? `${error.failure.kind}` : error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      url: file.webViewLink,
      converted_to: targetMime,
      account: access.token.account ?? null,
      folder_id: folderId ?? null,
      folders_created: foldersCreated,
      shared,
    };
  } catch (error) {
    if (error instanceof DriveRequestError) {
      const status = statusFromDriveFailure(deps, error.failure);
      if (status) throw new DriveliftError(error.message, status);
      if (error.failure.kind === "not_found") throw new DriveliftError(`Drive returned 404 (${error.failure.message}). If you passed folder_id: with the drive.file scope Drive only exposes files and folders that drivelift itself created, so an existing folder is usually invisible to it and cannot be used as a destination — this is a known limitation of the scope, not of the account's permissions. Retry without folder_id (the file goes to My Drive root) and move it in the Drive UI.`);
    }
    throw error;
  }
}
