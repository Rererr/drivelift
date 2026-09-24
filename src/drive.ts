/**
 * drive.ts — Google Drive API v3 の呼び出し(REST を fetch で直接叩く。SDK 依存なし)。
 *
 * - about.get: ログイン確認とメールアドレス取得。scope drive.file で呼べる
 * - files.create(resumable): メタデータ送信 → セッション URL へ本体 PUT の2段。
 *   metadata.mimeType に Google ネイティブ形式を入れると Drive 側で変換される
 * - 失敗は classifyDriveFailure で「API 未有効化 / 認証切れ / 対象なし / その他」に分類し、
 *   上位が Status(次の一手)に変換できるようにする
 */
import { readFileSync } from "node:fs";
import { DriveliftError } from "./errors.js";

export type FetchLike = typeof fetch;

const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,webViewLink";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
}

export type DriveFailure =
  | { kind: "api_disabled"; enableUrl: string | null }
  | { kind: "unauthorized"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "other"; status: number; message: string };

export function classifyDriveFailure(status: number, bodyText: string): DriveFailure {
  let message = bodyText;
  let reasons: string[] = [];
  let activationUrl: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string; metadata?: { activationUrl?: string } }> } };
    message = parsed.error?.message ?? bodyText;
    reasons = [
      ...(parsed.error?.errors?.map((e) => e.reason ?? "") ?? []),
      ...(parsed.error?.details?.map((d) => d.reason ?? "") ?? []),
    ];
    activationUrl = parsed.error?.details?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl ?? null;
  } catch {
    // JSON でない本文(HTML エラーページ等)はそのまま message に載せる
  }
  if (status === 403 && (reasons.includes("accessNotConfigured") || reasons.includes("SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(message))) {
    const fromMessage = message.match(/https?:\/\/[^\s"']+/)?.[0] ?? null;
    return { kind: "api_disabled", enableUrl: activationUrl ?? fromMessage };
  }
  if (status === 401) return { kind: "unauthorized", message };
  if (status === 404) return { kind: "not_found", message };
  return { kind: "other", status, message };
}

async function failureOf(res: Response): Promise<DriveFailure> {
  return classifyDriveFailure(res.status, await res.text());
}

export class DriveRequestError extends DriveliftError {
  readonly failure: DriveFailure;
  constructor(failure: DriveFailure) {
    super(failure.kind === "other" ? `Drive API error ${failure.status}: ${failure.message}` : `Drive API: ${failure.kind}`);
    this.name = "DriveRequestError";
    this.failure = failure;
  }
}

export async function driveAbout(accessToken: string, fetchImpl: FetchLike): Promise<{ emailAddress: string | null }> {
  const res = await fetchImpl(`${API_BASE}/about?fields=user(emailAddress)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new DriveRequestError(await failureOf(res));
  const body = (await res.json()) as { user?: { emailAddress?: string } };
  return { emailAddress: body.user?.emailAddress ?? null };
}

export interface UploadRequest {
  accessToken: string;
  filePath: string;
  name: string;
  sourceMime: string;
  /** Google ネイティブ形式へ変換するなら その mimeType、そのまま置くなら null。 */
  targetMime: string | null;
  folderId?: string;
  fetchImpl: FetchLike;
}

export async function uploadToDrive(req: UploadRequest): Promise<DriveFile> {
  const bytes = readFileSync(req.filePath);
  const metadata: Record<string, unknown> = { name: req.name };
  if (req.targetMime) metadata["mimeType"] = req.targetMime;
  if (req.folderId) metadata["parents"] = [req.folderId];

  const init = await req.fetchImpl(`${UPLOAD_BASE}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": req.sourceMime,
      "X-Upload-Content-Length": String(bytes.byteLength),
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(60_000),
  });
  if (!init.ok) throw new DriveRequestError(await failureOf(init));
  const sessionUrl = init.headers.get("location");
  if (!sessionUrl) throw new DriveliftError("Drive did not return a resumable upload session URL.");

  const put = await req.fetchImpl(sessionUrl, {
    method: "PUT",
    // セッション URL 自体が認証を兼ねる仕様だが、Authorization を付けても害はないので付けておく(未実測の仕様に依存しない)
    headers: { Authorization: `Bearer ${req.accessToken}`, "Content-Type": req.sourceMime, "Content-Length": String(bytes.byteLength) },
    body: bytes,
    // 本体送信。回線が細い場合を考えて長めに取る
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!put.ok) throw new DriveRequestError(await failureOf(put));
  const file = (await put.json()) as Partial<DriveFile>;
  if (typeof file.id !== "string") throw new DriveliftError(`Drive upload finished but the response has no file id: ${JSON.stringify(file)}`);
  return {
    id: file.id,
    name: file.name ?? req.name,
    mimeType: file.mimeType ?? req.targetMime ?? req.sourceMime,
    webViewLink: file.webViewLink ?? `https://drive.google.com/open?id=${file.id}`,
  };
}

// ---- folders ------------------------------------------------------------

const FOLDER_MIME = "application/vnd.google-apps.folder";

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** "a/b/c" を分解する。空の要素("a//b"・先頭末尾の /)は無視する。 */
export function splitFolderPath(path: string): string[] {
  return path.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * parentId(省略時はマイドライブ直下)の下に folderPath のフォルダを順に探し、無ければ作る。末端のフォルダ ID を返す。
 * drive.file スコープでは drivelift が作ったフォルダしか検索に出ないので、「探す」は実質「以前 drivelift が作ったものを再利用する」になる。
 */
/** 同じ親・同じ名前の「探す→無ければ作る」を同時に走らせない(並行 upload で同名フォルダが複数できるのを防ぐ)。同一プロセス内のみ有効。 */
const inflightFolders = new Map<string, Promise<{ id: string; created: boolean }>>();

async function findOrCreateFolder(accessToken: string, name: string, parent: string, fetchImpl: FetchLike): Promise<{ id: string; created: boolean }> {
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeQuery(name)}' and '${escapeQuery(parent)}' in parents and trashed=false`;
  // 親が共有ドライブ内にあっても見つけられるよう corpora=allDrives。作成順で並べ、同名が複数あっても毎回同じもの(最古)を選ぶ
  const list = await fetchImpl(`${API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&orderBy=createdTime&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!list.ok) throw new DriveRequestError(await failureOf(list));
  const found = ((await list.json()) as { files?: Array<{ id?: string }> }).files?.[0]?.id;
  if (found) return { id: found, created: false };
  const res = await fetchImpl(`${API_BASE}/files?fields=id&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new DriveRequestError(await failureOf(res));
  const id = ((await res.json()) as { id?: string }).id;
  if (!id) throw new DriveliftError(`Drive created folder "${name}" but returned no id.`);
  return { id, created: true };
}

export async function ensureFolderPath(accessToken: string, folderPath: string, parentId: string | undefined, fetchImpl: FetchLike): Promise<{ id: string; created: string[] }> {
  const parts = splitFolderPath(folderPath);
  if (parts.length === 0) throw new DriveliftError("folder_path is empty.");
  let parent = parentId ?? "root";
  const created: string[] = [];
  for (const name of parts) {
    const key = `${parent}\u0000${name}`;
    let step = inflightFolders.get(key);
    if (!step) {
      step = findOrCreateFolder(accessToken, name, parent, fetchImpl).finally(() => inflightFolders.delete(key));
      inflightFolders.set(key, step);
    }
    const r = await step;
    if (r.created) created.push(name);
    parent = r.id;
  }
  return { id: parent, created };
}

// ---- permissions ----------------------------------------------------------

export type ShareRole = "reader" | "commenter" | "writer";
export type ShareType = "user" | "group" | "domain" | "anyone";
export const SHARE_ROLES: readonly ShareRole[] = ["reader", "commenter", "writer"];
export const SHARE_TYPES: readonly ShareType[] = ["user", "group", "domain", "anyone"];

export interface ShareSpec {
  role: ShareRole;
  type: ShareType;
  /** user/group はメールアドレス、domain はドメイン名。anyone では使わない。 */
  target?: string;
}

export function validateShare(spec: ShareSpec): void {
  if (!SHARE_ROLES.includes(spec.role)) throw new DriveliftError(`share role must be one of ${SHARE_ROLES.join(", ")}.`);
  if (!SHARE_TYPES.includes(spec.type)) throw new DriveliftError(`share type must be one of ${SHARE_TYPES.join(", ")}.`);
  if (spec.type === "anyone") {
    if (spec.target) throw new DriveliftError('share type "anyone" takes no target.');
    return;
  }
  if (!spec.target) throw new DriveliftError(`share type "${spec.type}" needs a target (${spec.type === "domain" ? "domain name" : "email address"}).`);
  if (spec.type === "domain" ? spec.target.includes("@") : !spec.target.includes("@")) {
    throw new DriveliftError(`share target "${spec.target}" does not look like ${spec.type === "domain" ? "a domain name" : "an email address"}.`);
  }
}

export const MAX_SHARES = 20;

export async function createPermission(accessToken: string, fileId: string, spec: ShareSpec, notify: boolean, fetchImpl: FetchLike): Promise<{ id: string }> {
  const body: Record<string, unknown> = { role: spec.role, type: spec.type };
  if (spec.type === "user" || spec.type === "group") body["emailAddress"] = spec.target;
  if (spec.type === "domain") body["domain"] = spec.target;
  // 通知メールは user/group にだけ意味がある(他の種類に付けると API が拒否する場合がある)
  const notifyParam = spec.type === "user" || spec.type === "group" ? `&sendNotificationEmail=${notify}` : "";
  const res = await fetchImpl(`${API_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=id&supportsAllDrives=true${notifyParam}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new DriveRequestError(await failureOf(res));
  return { id: ((await res.json()) as { id?: string }).id ?? "" };
}
