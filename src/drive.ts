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
