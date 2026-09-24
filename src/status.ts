/**
 * status.ts — 導入状態(Status)の型と、各状態で返す「次の一手」の組み立て。
 *
 * MCP サーバーには UI がないので、ツールの戻り値そのものが導入経路になる。
 * どの状態でも state / message / next_steps / urls を同じ形で返し、
 * 呼び出し側(LLM)がそのまま利用者へ中継できるようにする。
 * ここは純粋関数のみで、実際の判定(ファイル・ネットワーク)は core.ts の handleStatus が行う。
 */
import { clientSecretPath } from "./config.js";

export type StatusState = "no_client" | "no_token" | "token_invalid" | "api_disabled" | "ready";
export type ClientSource = "env" | "file";

export interface Status {
  state: StatusState;
  ready: boolean;
  message: string;
  next_steps: string[];
  urls: Record<string, string>;
  config_dir: string;
  client_source?: ClientSource;
  account?: string;
  /** no_client のとき、~/Downloads で見つかった client_secret*.json(新しい順)。 */
  candidates?: string[];
  /** no_client のとき、Console に入力する値のサンプル(next_steps と同じ内容の構造化版)。 */
  console_form?: ConsoleForm;
}

export interface NoClientContext {
  /** gcloud が PATH にあるなら、手順 1-2 の同等コマンドを併記する(実行はしない)。 */
  gcloud: boolean;
  candidates: string[];
  /** サンプル値に入れるメールアドレス(gcloud のアクティブアカウント等)。不明なら null。 */
  email?: string | null;
}

/**
 * 手順 3-4 で Console に入力する値のサンプル。慣れない利用者がそのまま埋められるよう、
 * 画面の並び(アプリ情報 → 対象 → 連絡先情報 → 終了)どおりに持つ。email は分かれば実値を入れる。
 */
export interface ConsoleForm {
  consent_screen: Array<{ step: string; field: string; value: string; note?: string }>;
  oauth_client: Array<{ field: string; value: string; note?: string }>;
}

export function consoleForm(email: string | null): ConsoleForm {
  const mail = email ?? "<your email address>";
  return {
    consent_screen: [
      { step: "1 App information", field: "App name", value: "drivelift", note: "Shown on the Google sign-in page. Any name works." },
      { step: "1 App information", field: "User support email", value: mail },
      { step: "2 Audience", field: "User type", value: "Internal", note: "Google Workspace accounts. Personal Gmail cannot choose Internal: pick External, then publish the app to Production after creation (Testing status expires sign-ins every 7 days)." },
      { step: "3 Contact information", field: "Email addresses", value: mail },
      { step: "4 Finish", field: "Agree to the Google API Services: User Data Policy", value: "check, then Create" },
    ],
    oauth_client: [
      { field: "Application type", value: "Desktop app", note: "Must be Desktop app. Web application will not work." },
      { field: "Name", value: "drivelift" },
      { field: "(after Create)", value: "Download JSON", note: "Scopes and test users do not need to be added." },
    ],
  };
}

/** next_steps 用の文。consoleForm と同じ値を1行ずつ書き下す。 */
export function consoleSteps(urls: { consent_screen: string; create_oauth_client: string }, email: string | null): string[] {
  const form = consoleForm(email);
  const consent = form.consent_screen.map((f) => `     - [${f.step}] ${f.field}: ${f.value}${f.note ? ` (${f.note})` : ""}`);
  const client = form.oauth_client.map((f) => `     - ${f.field}: ${f.value}${f.note ? ` (${f.note})` : ""}`);
  return [
    [`3. Configure the OAuth consent screen: ${urls.consent_screen} — sample values:`, ...consent].join("\n"),
    [`4. Create an OAuth client: ${urls.create_oauth_client} — sample values:`, ...client].join("\n"),
  ];
}

/** Google Cloud Console の導線。UI 改変で変わりうるのでここ1箇所に集める。 */
export const CONSOLE_URLS = {
  create_project: "https://console.cloud.google.com/projectcreate",
  enable_drive_api: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  consent_screen: "https://console.cloud.google.com/auth/overview",
  create_oauth_client: "https://console.cloud.google.com/auth/clients/create",
} as const;

export function noClientStatus(configDir: string, ctx: NoClientContext = { gcloud: false, candidates: [] }): Status {
  const email = ctx.email ?? null;
  const secretPath = clientSecretPath(configDir);
  const gcloudHint = ctx.gcloud
    ? ` — gcloud is installed: the gcloud_setup tool can do steps 1-2 for you (call it without confirm to see the commands, then with confirm: true after the user approves). Steps 3-4 have no gcloud equivalent.`
    : "";
  const newest = ctx.candidates[0];
  const step5 = newest
    ? `5. A downloaded client JSON was found: ${newest}. Put it in place with \`mv "${newest}" "${secretPath}" && chmod 600 "${secretPath}"\` (or call import_client_secret with that path). ${ctx.candidates.length > 1 ? `${ctx.candidates.length} candidates exist; the newest is listed first in \`candidates\`. ` : ""}Alternatively set DRIVELIFT_CLIENT_ID and DRIVELIFT_CLIENT_SECRET.`
    : `5. Save the JSON as ${secretPath} (e.g. \`mv ~/Downloads/client_secret_*.json "${secretPath}" && chmod 600 "${secretPath}"\`), or call import_client_secret with the downloaded file's path. Alternatively set DRIVELIFT_CLIENT_ID and DRIVELIFT_CLIENT_SECRET.`;
  return {
    state: "no_client",
    ready: false,
    message: "No OAuth client credentials found. drivelift never ships a shared client; bring your own (about 5 minutes in Google Cloud Console).",
    next_steps: [
      `1. Create (or pick) a Google Cloud project: ${CONSOLE_URLS.create_project}${gcloudHint}`,
      `2. Enable the Google Drive API for that project: ${CONSOLE_URLS.enable_drive_api}`,
      ...consoleSteps(CONSOLE_URLS, email),
      step5,
      "6. Then call auth_start to sign in (it waits for the browser sign-in to finish).",
    ],
    urls: { ...CONSOLE_URLS },
    config_dir: configDir,
    console_form: consoleForm(email),
    ...(ctx.candidates.length > 0 ? { candidates: ctx.candidates } : {}),
  };
}

export function noTokenStatus(configDir: string, clientSource: ClientSource): Status {
  return {
    state: "no_token",
    ready: false,
    message: "OAuth client is configured but no Google account is signed in yet.",
    next_steps: [
      "Call auth_start (CLI: `drivelift login`). It opens the Google sign-in page; finish it in the browser.",
      "Then call auth_status to confirm, or just call upload.",
    ],
    urls: {},
    config_dir: configDir,
    client_source: clientSource,
  };
}

/**
 * errorCode は Google の OAuth エラーコード。invalid_client(クライアント削除・secret リセット)は
 * 再ログインしても直らないので、案内をクライアント JSON の取り直しに切り替える。
 */
export function tokenInvalidStatus(configDir: string, reason: string, errorCode: string | null = null): Status {
  if (errorCode === "invalid_client") {
    return {
      state: "token_invalid",
      ready: false,
      message: `Google rejected the OAuth client itself (${reason}). The client may have been deleted or its secret reset; signing in again will not help until the client is fixed.`,
      next_steps: [
        `Open the OAuth clients page (${CONSOLE_URLS.create_oauth_client.replace(/\/create$/, "")}), download the JSON of a valid Desktop-app client (or create a new one), and import it with import_client_secret.`,
        "Then call auth_start to sign in again.",
      ],
      urls: { create_oauth_client: CONSOLE_URLS.create_oauth_client },
      config_dir: configDir,
    };
  }
  return {
    state: "token_invalid",
    ready: false,
    message: `The stored token was rejected by Google (${reason}). Sign in again.`,
    next_steps: [
      "Call auth_start (CLI: `drivelift login`) and finish the sign-in in the browser.",
      `If this happens every 7 days, your consent screen is External + Testing: publish it to Production (${CONSOLE_URLS.consent_screen}) or, on Google Workspace, switch the user type to Internal.`,
    ],
    urls: { consent_screen: CONSOLE_URLS.consent_screen },
    config_dir: configDir,
  };
}

export function apiDisabledStatus(configDir: string, enableUrl: string | null): Status {
  const url = enableUrl ?? CONSOLE_URLS.enable_drive_api;
  return {
    state: "api_disabled",
    ready: false,
    message: "Signed in, but the Google Drive API is not enabled for the project that owns this OAuth client.",
    next_steps: [`Enable the Drive API here: ${url}`, "Wait about a minute for the change to propagate, then retry."],
    urls: { enable_drive_api: url },
    config_dir: configDir,
  };
}

export function readyStatus(configDir: string, account: string | null, clientSource: ClientSource): Status {
  return {
    state: "ready",
    ready: true,
    message: account ? `Ready. Signed in as ${account}.` : "Ready.",
    next_steps: ["Call upload with a local file path (and optionally folder_id)."],
    urls: {},
    config_dir: configDir,
    client_source: clientSource,
    ...(account ? { account } : {}),
  };
}
