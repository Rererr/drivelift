/**
 * source.ts — 到達元(アップロードするファイルがある作業リポジトリ・ディレクトリ)の鍵と、そこからのアカウント解決。
 *
 * 鍵は2種類:
 * - git の作業ツリー: remote origin の URL を正規化したもの(github.com/org/repo)。clone 先や worktree が変わっても同じ。全体を小文字にそろえる
 * - それ以外(origin の無い git・git でないディレクトリ): 絶対パス。sources.json のパスの要素は前方一致(最長一致)で照合する。
 *   存在すれば実体のパス(シンボリックリンクを解き、大小を区別しない FS では実際の綴り)にそろえる
 *
 * git が読めない(未導入・dubious ownership 等)ときは鍵を「取得失敗」とし、パスに落とさない(本来の鍵で引ける対応づけを見落とすため)。
 *
 * 解決順(upload): 引数 account → 環境変数 DRIVELIFT_ACCOUNT → sources.json の照合 → 枠が1つならそれ → それ以外は解決しない(送らない)。
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { DriveliftError } from "./errors.js";

/** git ルートのディレクトリで remote origin の URL を返す。origin が無ければ null。git 自体が使えなければ投げる。 */
export type GitOriginUrl = (gitRoot: string) => string | null;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true }).trim();
}

function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail = typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
  return detail.split("\n")[0] ?? detail;
}

export function defaultGitOriginUrl(gitRoot: string): string | null {
  // dubious ownership の作業ツリーでは git config がリポジトリの設定を読まずに「キーなし」を返すので、先に git が作業ツリーとして扱えるかを確かめる
  try {
    git(["rev-parse", "--show-toplevel"], gitRoot);
  } catch (error) {
    throw new DriveliftError(`git cannot read the repository at ${gitRoot} (git rev-parse --show-toplevel): ${gitFailure(error)}`);
  }
  try {
    const url = git(["config", "--get", "remote.origin.url"], gitRoot);
    return url.length > 0 ? url : null;
  } catch (error) {
    // git config --get はキーが無いと終了コード 1 を返す
    if ((error as { status?: unknown }).status === 1) return null;
    throw new DriveliftError(`Could not read the git remote of ${gitRoot} (git config --get remote.origin.url): ${gitFailure(error)}`);
  }
}

/**
 * remote URL を host/path に正規化する。https・ssh://・scp 形式(git@host:org/repo)を同じ鍵にする。
 * 全体を小文字にそろえる(GitHub・GitLab は org/repo の大小を区別しない)。
 * ローカルパスや file:// の remote はリポジトリを指す安定した名前にならないので null(呼び出し側は git ルートのパスを鍵にする)。
 */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme) {
    if (scheme[1]?.toLowerCase() === "file") return null;
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  } else {
    if (isPathSource(trimmed)) return null;
    const scp = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(trimmed);
    if (!scp?.[2] || !scp[3]) return null;
    host = scp[2];
    // host:443/org/repo は port 付きの URL から scheme を落としたもの。user@ 付きの scp 形式に port は無く、git@host:123/repo の 123 はパスの一部
    path = scp[1] === undefined ? scp[3].replace(/^\d+\//, "") : scp[3];
  }
  const repoPath = path.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (host.length === 0 || repoPath.length === 0) return null;
  return `${host}/${repoPath}`.toLowerCase();
}

/** start から上へ辿り、.git(worktree・submodule ではファイル)を持つディレクトリを返す。 */
export function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 鍵。git remote の鍵なら、その作業ツリー(gitRoot)も持つ。git が読めなければ key: null と理由。 */
export type SourceKey = { key: string; gitRoot?: string } | { key: null; error: string };

/** 実体のパス(シンボリックリンクを解き、大小を区別しない FS では実際の綴り)。存在しなければ null。 */
function realPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** 絶対パス(ファイルかディレクトリ。存在しなければ親ディレクトリ)の到達元の鍵。 */
export function sourceKeyFor(location: string, gitOriginUrl: GitOriginUrl): SourceKey {
  const parent = existsSync(location) && statSync(location).isDirectory() ? location : dirname(location);
  const dir = realPath(parent) ?? parent;
  const root = findGitRoot(dir);
  if (!root) return { key: dir };
  let origin: string | null;
  try {
    origin = gitOriginUrl(root);
  } catch (error) {
    return { key: null, error: error instanceof Error ? error.message : String(error) };
  }
  const remote = origin === null ? null : normalizeRemoteUrl(origin);
  return remote === null ? { key: root } : { key: remote, gitRoot: root };
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
/** Windows の UNC パス(\\server\share\… と //server/share/…)。 */
const UNC = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/;

/** 絶対パスの到達元か(POSIX の /… と Windows の X:\… / X:/…・\\server\share\…)。それ以外は git remote の鍵。 */
export function isPathSource(source: string): boolean {
  return source.startsWith("/") || source.startsWith("\\\\") || WINDOWS_DRIVE.test(source);
}

/** 比較用の形。Windows のパスは区切りを / にそろえ、末尾の区切りを落とす。ドライブ文字は大文字(ルートは "" や "C:" になる)。 */
function comparablePath(path: string): string {
  const slashed = WINDOWS_DRIVE.test(path)
    ? `${path.charAt(0).toUpperCase()}${path.slice(1).replace(/\\/g, "/")}`
    : path.startsWith("\\\\")
      ? path.replace(/\\/g, "/")
      : path;
  return slashed.replace(/\/+$/, "");
}

/** sources.json の1要素が鍵に当たるか。パスの要素は前方一致(区切り単位)。 */
export function sourceMatches(entry: string, key: string): boolean {
  if (!isPathSource(entry)) return entry === key;
  if (!isPathSource(key)) return false;
  const prefix = comparablePath(entry);
  const target = comparablePath(key);
  return target === prefix || target.startsWith(`${prefix}/`);
}

/** 同じ到達元を指すか(パスは区切り・末尾・ドライブ文字の違いを無視する)。 */
export function sameSource(a: string, b: string): boolean {
  return isPathSource(a) && isPathSource(b) ? comparablePath(a) === comparablePath(b) : a === b;
}

export interface AccountSources {
  email: string;
  sources: string[];
}

/** 鍵に当たる対応づけのうち最長のものを持つ枠(同じ長さで複数なら全部)。当たらなければ空。 */
export function matchSource(key: string, accounts: AccountSources[]): string[] {
  let best = -1;
  let emails: string[] = [];
  for (const { email, sources } of accounts) {
    for (const entry of sources) {
      if (!sourceMatches(entry, key)) continue;
      const length = isPathSource(entry) ? comparablePath(entry).length : entry.length;
      if (length > best) {
        best = length;
        emails = [email];
      } else if (length === best && !emails.includes(email)) {
        emails.push(email);
      }
    }
  }
  return emails;
}

/** source は鍵を求めた場合だけ入る(引数・環境変数で決まれば求めないので null。取得失敗も null)。 */
export type Resolution =
  | { account: string; by: "argument" | "env" | "source" | "only_account"; source: string | null }
  | { account: null; reason: string; source: string | null };

/** sourceKey は引数・環境変数で決まらなかったときだけ呼ぶ(git を余計に呼ばず、git の失敗で指定が妨げられない)。 */
export function resolveAccount(input: { requested?: string | undefined; envAccount?: string | undefined; sourceKey: () => SourceKey; accounts: AccountSources[] }): Resolution {
  const { accounts } = input;
  const emails = accounts.map((a) => a.email);
  if (input.requested !== undefined) {
    if (!emails.includes(input.requested)) return { account: null, reason: `account ${input.requested} is not signed in`, source: null };
    return { account: input.requested, by: "argument", source: null };
  }
  if (input.envAccount) {
    if (!emails.includes(input.envAccount)) return { account: null, reason: `DRIVELIFT_ACCOUNT=${input.envAccount} is not signed in`, source: null };
    return { account: input.envAccount, by: "env", source: null };
  }
  if (accounts.length === 0) return { account: null, reason: "no account is signed in", source: null };
  const sourceKey = input.sourceKey();
  if (sourceKey.key === null) {
    // 枠が1つなら、どの対応づけもその枠を指すので結果は変わらない
    if (accounts.length === 1 && accounts[0]) return { account: accounts[0].email, by: "only_account", source: null };
    return { account: null, reason: `could not tell where the file is from, so the source mappings cannot be checked (${sourceKey.error})`, source: null };
  }
  const source = sourceKey.key;
  const matched = matchSource(source, accounts);
  if (matched.length > 1) return { account: null, reason: `${source} is mapped to more than one account (${matched.join(", ")})`, source };
  if (matched[0]) return { account: matched[0], by: "source", source };
  if (accounts.length === 1 && accounts[0]) return { account: accounts[0].email, by: "only_account", source };
  return { account: null, reason: `${source} is not mapped to any of the ${accounts.length} signed-in accounts`, source };
}

/**
 * map_source に渡された到達元を、照合に使う形にそろえる。URL や .git 付きで渡されても鍵と一致させる。
 * パスは存在すれば実体のパス(鍵と同じ形)。存在しなければ //・.・.. を畳むだけ(消えたディレクトリの対応づけを外せるように)。
 * remote は clone URL(scheme 付き・scp 形式)なら host を問わず受け付け、host/path の形は host にドットを要る。
 * owner/repo のような短縮形は host が無く鍵と一致しないので null。
 */
export function normalizeSourceInput(input: string): string | null {
  const trimmed = input.trim();
  if (isPathSource(trimmed)) {
    const windows = WINDOWS_DRIVE.test(trimmed) || UNC.test(trimmed);
    const path = realPath(trimmed) ?? (windows ? win32.normalize(trimmed) : posix.normalize(trimmed));
    if (!WINDOWS_DRIVE.test(path) && !path.startsWith("\\\\")) return path.replace(/\/+$/, "") || "/";
    const stripped = `${path.charAt(0).toUpperCase()}${path.slice(1)}`.replace(/\\+$/, "");
    return /^[A-Z]:$/.test(stripped) ? `${stripped}\\` : stripped;
  }
  if (/^[.~]/.test(trimmed)) return null;
  const cloneUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[^@/:]+@[^@/:]+:/.test(trimmed);
  const key = normalizeRemoteUrl(trimmed) ?? (cloneUrl ? null : normalizeRemoteUrl(`https://${trimmed}`));
  if (key === null) return null;
  const [host, ...rest] = key.split("/");
  return (cloneUrl || host?.includes(".")) && rest.join("/").length > 0 && !/\s/.test(key) ? key : null;
}

/** 対応づけると前方一致でほぼ全ファイルが当たるパス(ルート・roots(ホーム・一時ディレクトリ)と、それらの祖先)か。 */
export function isTooBroadPath(path: string, roots: string[]): boolean {
  const comparable = comparablePath(path);
  if (comparable === "" || /^[A-Z]:$/.test(comparable)) return true;
  return roots.some((root) => sourceMatches(path, root));
}
