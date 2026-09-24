/**
 * mime.ts — 拡張子から「送る Content-Type」と「Drive 側で変換する Google 形式」を決める。
 *
 * 変換は Drive API の files.create に Google ネイティブの mimeType を指定するだけで起きる
 * (rclone の --drive-import-formats と同じ経路)。ここは対応表のみを持つ。
 */
import { basename, extname } from "node:path";

export const GOOGLE_MIME = {
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  document: "application/vnd.google-apps.document",
  presentation: "application/vnd.google-apps.presentation",
} as const;

export type GoogleKind = keyof typeof GOOGLE_MIME;
export type ConvertMode = "auto" | "none" | GoogleKind;
export const CONVERT_MODES = ["auto", "none", "spreadsheet", "document", "presentation"] as const satisfies readonly ConvertMode[];

const SOURCE_MIME: Readonly<Record<string, string>> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odp: "application/vnd.oasis.opendocument.presentation",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  zip: "application/zip",
};

/** convert: "auto" のときに拡張子から選ぶ変換先。載っていない拡張子はそのまま(変換なし)。 */
const AUTO_TARGET: Readonly<Record<string, GoogleKind>> = {
  xlsx: "spreadsheet",
  xlsm: "spreadsheet",
  xls: "spreadsheet",
  ods: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  docx: "document",
  doc: "document",
  odt: "document",
  rtf: "document",
  txt: "document",
  md: "document",
  html: "document",
  htm: "document",
  pptx: "presentation",
  ppt: "presentation",
  odp: "presentation",
};

/** 変換先ごとの拡張子一覧(ツール説明・README と表をずらさないため、ここから作る)。 */
export function autoTargetSummary(): string {
  const groups: Record<GoogleKind, string[]> = { spreadsheet: [], document: [], presentation: [] };
  for (const [ext, kind] of Object.entries(AUTO_TARGET)) groups[kind].push(ext);
  return `spreadsheets (${groups.spreadsheet.join("/")}) become Google Sheets, documents (${groups.document.join("/")}) become Google Docs, and slides (${groups.presentation.join("/")}) become Google Slides`;
}

export function extensionOf(filePath: string): string {
  return extname(filePath).replace(/^\./, "").toLowerCase();
}

export function sourceMimeFor(ext: string): string {
  return SOURCE_MIME[ext] ?? "application/octet-stream";
}

/** 変換先の Google mimeType。変換しない場合は null。 */
export function resolveTargetMime(ext: string, mode: ConvertMode): string | null {
  if (mode === "none") return null;
  if (mode === "auto") {
    const kind = AUTO_TARGET[ext];
    return kind ? GOOGLE_MIME[kind] : null;
  }
  return GOOGLE_MIME[mode];
}

/** Drive 上の既定名。ネイティブ形式へ変換するなら拡張子は意味を失うので落とす。 */
export function defaultDriveName(filePath: string, converting: boolean): string {
  const base = basename(filePath);
  if (!converting) return base;
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}
