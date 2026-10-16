import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGitOriginUrl, findGitRoot, isTooBroadPath, matchSource, normalizeRemoteUrl, normalizeSourceInput, resolveAccount, sourceKeyFor, sourceMatches, type SourceKey } from "../src/source.js";

describe("normalizeRemoteUrl", () => {
  it.each([
    ["https://github.com/org/repo.git", "github.com/org/repo"],
    ["https://github.com/org/repo", "github.com/org/repo"],
    ["https://github.com/org/repo/", "github.com/org/repo"],
    ["https://github.com/org/repo.git/", "github.com/org/repo"],
    ["https://user:token@github.com/org/repo.git", "github.com/org/repo"],
    ["git@github.com:org/repo.git", "github.com/org/repo"],
    ["git@github.com:org/repo", "github.com/org/repo"],
    ["ssh://git@github.com/org/repo.git", "github.com/org/repo"],
    ["ssh://git@github.com:22/org/repo.git", "github.com/org/repo"],
    ["https://GitHub.com/Org/Repo.git", "github.com/org/repo"],
    ["git@GitHub.com:Org/Repo.git", "github.com/org/repo"],
    ["ssh://git@GitHub.com:22/Org/Repo", "github.com/org/repo"],
    ["https://gitlab.example.com/group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
    ["  git@github.com:org/repo.git\n", "github.com/org/repo"],
    ["https://github.com//org//repo", "github.com/org/repo"],
  ])("%s → %s", (url, key) => {
    expect(normalizeRemoteUrl(url)).toBe(key);
  });

  it("ローカルパスや file:// の remote は鍵にしない", () => {
    expect(normalizeRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("../repo")).toBeNull();
    expect(normalizeRemoteUrl("file:///srv/git/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("C:\\repos\\a")).toBeNull();
  });

  it("scheme の無い host:port/path は port を落とし、ssh://host:port/path と同じ鍵になる。user@ 付きの scp 形式の数字はパスの一部", () => {
    expect(normalizeRemoteUrl("gitlab.example.com:443/org/repo")).toBe("gitlab.example.com/org/repo");
    expect(normalizeRemoteUrl("ssh://gitlab.example.com:22/org/repo")).toBe("gitlab.example.com/org/repo");
    expect(normalizeRemoteUrl("git@gitlab.example.com:123/repo.git")).toBe("gitlab.example.com/123/repo");
  });

  it("UNC パスは remote にしない", () => {
    expect(normalizeRemoteUrl("\\\\server\\share\\repo")).toBeNull();
  });

  it("URL として壊れた % エスケープは投げずに null", () => {
    expect(normalizeRemoteUrl("https://github.com/org/%E0%A4%A.git")).toBeNull();
  });
});

/** 一時ディレクトリが大小を区別しない FS にあるか(macOS の既定)。 */
const caseInsensitiveFs = (() => {
  const probe = mkdtempSync(join(tmpdir(), "drivelift-Case-"));
  try {
    return existsSync(probe.toLowerCase().replace(tmpdir().toLowerCase(), tmpdir()));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("findGitRoot / sourceKeyFor", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "drivelift-source-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("上へ辿って .git ディレクトリを見つけ、origin の正規化 URL を鍵にする", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "reports", "2026"), { recursive: true });
    const file = join(repo, "reports", "2026", "r.xlsx");
    writeFileSync(file, "x");
    const asked: string[] = [];
    const key = sourceKeyFor(file, (gitRoot) => {
      asked.push(gitRoot);
      return "git@github.com:org/repo.git";
    });
    expect(key).toEqual({ key: "github.com/org/repo", gitRoot: repo });
    expect(asked).toEqual([repo]);
  });

  it("worktree(.git がファイル)も git ルートとして扱い、clone 先が違っても同じ鍵になる", () => {
    const wt = join(root, "elsewhere", "repo-wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /x/.git/worktrees/repo-wt\n");
    expect(findGitRoot(join(wt))).toBe(wt);
    expect(sourceKeyFor(wt, () => "https://github.com/org/repo")).toEqual({ key: "github.com/org/repo", gitRoot: wt });
  });

  it("origin が無い git は git ルートの絶対パス、git でなければディレクトリの絶対パスを鍵にする", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "sub"));
    expect(sourceKeyFor(join(repo, "sub"), () => null)).toEqual({ key: repo });
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "a.md"), "x");
    expect(findGitRoot(plain)).toBeNull();
    const notAsked = () => {
      throw new Error("git must not be asked outside a repository");
    };
    expect(sourceKeyFor(join(plain, "a.md"), notAsked)).toEqual({ key: plain });
    expect(sourceKeyFor(plain, notAsked)).toEqual({ key: plain });
  });

  it("存在しないパスは親ディレクトリから辿る", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(sourceKeyFor(join(plain, "not-yet.md"), () => null)).toEqual({ key: plain });
  });

  it("パスの鍵はシンボリックリンクを解いた実体のパス。リンク経由の git ルートも実体になる", () => {
    const real = join(root, "real");
    mkdirSync(join(real, "repo", ".git"), { recursive: true });
    symlinkSync(real, join(root, "link"));
    expect(sourceKeyFor(join(root, "link"), () => null)).toEqual({ key: real });
    expect(sourceKeyFor(join(root, "link", "repo", "not-yet.md"), () => null)).toEqual({ key: join(real, "repo") });
    expect(sourceKeyFor(join(root, "link", "repo"), () => "git@github.com:org/a.git")).toEqual({ key: "github.com/org/a", gitRoot: join(real, "repo") });
  });

  it.runIf(caseInsensitiveFs)("大小を区別しない FS では、パスの鍵をディスク上の綴りにそろえる", () => {
    mkdirSync(join(root, "Proj", "Sub"), { recursive: true });
    expect(sourceKeyFor(join(root, "proj", "sub"), () => null)).toEqual({ key: join(root, "Proj", "Sub") });
  });

  it("git が読めなければ鍵は取得失敗で、パスに落とさない", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(sourceKeyFor(repo, () => {
      throw new Error("detected dubious ownership");
    })).toEqual({ key: null, error: "detected dubious ownership" });
  });
});

describe("defaultGitOriginUrl(実際の git)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drivelift-git-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  it("origin があれば URL、無ければ null", () => {
    run(root, "init", "-q");
    expect(defaultGitOriginUrl(root)).toBeNull();
    run(root, "remote", "add", "origin", "git@github.com:org/a.git");
    expect(defaultGitOriginUrl(root)).toBe("git@github.com:org/a.git");
  });

  it("git が作業ツリーとして読めない(.git が偽物)なら、origin なしとせずに投げる", () => {
    mkdirSync(join(root, ".git"));
    expect(() => defaultGitOriginUrl(root)).toThrow(/git cannot read the repository/);
  });

  it("git が無ければ投げる", () => {
    run(root, "init", "-q");
    const saved = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      expect(() => defaultGitOriginUrl(root)).toThrow(/git cannot read the repository/);
    } finally {
      process.env["PATH"] = saved;
    }
  });
});

describe("sourceMatches", () => {
  it("鍵はそのまま一致、/ で始まる要素はパス区切り単位の前方一致", () => {
    expect(sourceMatches("github.com/org/repo", "github.com/org/repo")).toBe(true);
    expect(sourceMatches("github.com/org/repo", "github.com/org/repo2")).toBe(false);
    expect(sourceMatches("/work/a", "/work/a")).toBe(true);
    expect(sourceMatches("/work/a", "/work/a/b")).toBe(true);
    expect(sourceMatches("/work/a/", "/work/a/b")).toBe(true);
    expect(sourceMatches("/work/a", "/work/ab")).toBe(false);
    expect(sourceMatches("/work/a", "github.com/work/a")).toBe(false);
    expect(sourceMatches("/", "/anything/below")).toBe(true);
  });

  it("UNC パスも区切り単位の前方一致(\\ と / を問わない)", () => {
    expect(sourceMatches("\\\\server\\share\\a", "\\\\server\\share\\a\\b")).toBe(true);
    expect(sourceMatches("\\\\server\\share\\a", "\\\\server\\share\\ab")).toBe(false);
    expect(sourceMatches("\\\\server\\share\\a", "\\\\server\\share\\a")).toBe(true);
    expect(sourceMatches("\\\\server\\share\\a", "server/share/a")).toBe(false);
  });

  it("Windows のドライブ付きパスも区切り単位の前方一致(区切りとドライブ文字の大小を問わない)", () => {
    expect(sourceMatches("C:\\work\\a", "C:\\work\\a\\b")).toBe(true);
    expect(sourceMatches("c:/work/a", "C:\\work\\a\\b")).toBe(true);
    expect(sourceMatches("C:\\work\\a", "C:\\work\\ab")).toBe(false);
    expect(sourceMatches("C:\\", "C:\\work")).toBe(true);
    expect(sourceMatches("C:\\work", "github.com/work")).toBe(false);
  });
});

describe("matchSource は最長一致", () => {
  const A = { email: "a@example.com", sources: ["/work"] };
  const B = { email: "b@example.com", sources: ["/work/clientB"] };
  it("長い方の対応づけが勝ち、短い方は残りに当たる", () => {
    expect(matchSource("/work/clientB/x", [A, B])).toEqual(["b@example.com"]);
    expect(matchSource("/work/clientA/x", [A, B])).toEqual(["a@example.com"]);
    expect(matchSource("/other", [A, B])).toEqual([]);
  });
  it("同じ長さ(完全一致の重複)だけ複数返す", () => {
    expect(matchSource("/work/clientB/x", [A, B, { email: "c@example.com", sources: ["/work/clientB/"] }])).toEqual(["b@example.com", "c@example.com"]);
  });
});

describe("resolveAccount の解決順", () => {
  const A = { email: "a@example.com", sources: ["github.com/org/a", "/work/a"] };
  const B = { email: "b@example.com", sources: ["github.com/org/b"] };
  const key = (k: string) => (): SourceKey => ({ key: k });
  const gitFails = (): SourceKey => ({ key: null, error: "detected dubious ownership" });
  const notAsked = (): SourceKey => {
    throw new Error("the source must not be computed");
  };

  it("1. 引数 account が環境変数・対応づけより優先し、到達元は求めない", () => {
    expect(resolveAccount({ requested: "b@example.com", envAccount: "a@example.com", sourceKey: notAsked, accounts: [A, B] })).toEqual({ account: "b@example.com", by: "argument", source: null });
  });

  it("2. DRIVELIFT_ACCOUNT が対応づけより優先し、到達元は求めない", () => {
    expect(resolveAccount({ envAccount: "b@example.com", sourceKey: notAsked, accounts: [A, B] })).toMatchObject({ account: "b@example.com", by: "env" });
  });

  it("3. sources.json の照合(git の鍵・パスの前方一致)", () => {
    expect(resolveAccount({ sourceKey: key("github.com/org/b"), accounts: [A, B] })).toMatchObject({ account: "b@example.com", by: "source" });
    expect(resolveAccount({ sourceKey: key("/work/a/reports"), accounts: [A, B] })).toMatchObject({ account: "a@example.com", by: "source" });
  });

  it("3. パスの対応づけが重なれば最長一致", () => {
    const wide = { email: "a@example.com", sources: ["/work"] };
    const narrow = { email: "b@example.com", sources: ["/work/clientB"] };
    expect(resolveAccount({ sourceKey: key("/work/clientB/x"), accounts: [wide, narrow] })).toMatchObject({ account: "b@example.com", by: "source" });
    expect(resolveAccount({ sourceKey: key("/work/clientA/x"), accounts: [wide, narrow] })).toMatchObject({ account: "a@example.com", by: "source" });
  });

  it("4. 対応づけが無くても枠が1つならそれを使う", () => {
    expect(resolveAccount({ sourceKey: key("github.com/org/zzz"), accounts: [B] })).toMatchObject({ account: "b@example.com", by: "only_account" });
  });

  it("5. どれにも当たらず枠が2つ以上なら解決しない", () => {
    const r = resolveAccount({ sourceKey: key("github.com/org/zzz"), accounts: [A, B] });
    expect(r.account).toBeNull();
    expect(r).toMatchObject({ source: "github.com/org/zzz", reason: expect.stringMatching(/not mapped/) });
  });

  it("複数の枠が同じ到達元を持っていたら、枠の数によらず解決しない", () => {
    const B2 = { email: "b@example.com", sources: ["github.com/org/a"] };
    expect(resolveAccount({ sourceKey: key("github.com/org/a"), accounts: [A, B2] })).toMatchObject({ account: null, reason: expect.stringMatching(/more than one account/) });
  });

  it("git が読めず鍵が取れなければ、枠が2つ以上なら git の失敗を理由に解決しない(枠が1つならそれ)", () => {
    expect(resolveAccount({ sourceKey: gitFails, accounts: [A, B] })).toEqual({ account: null, reason: expect.stringMatching(/dubious ownership/), source: null });
    expect(resolveAccount({ sourceKey: gitFails, accounts: [B] })).toMatchObject({ account: "b@example.com", by: "only_account", source: null });
  });

  it("ログインしていないアカウントを引数・環境変数で指定したら、ほかの手段に落ちずに解決しない", () => {
    expect(resolveAccount({ requested: "c@example.com", sourceKey: key("github.com/org/a"), accounts: [A] })).toMatchObject({ account: null, reason: expect.stringMatching(/c@example.com is not signed in/) });
    expect(resolveAccount({ envAccount: "c@example.com", sourceKey: key("github.com/org/a"), accounts: [A] })).toMatchObject({ account: null, reason: expect.stringMatching(/DRIVELIFT_ACCOUNT/) });
  });

  it("枠が無ければ解決しない", () => {
    expect(resolveAccount({ sourceKey: key("/x"), accounts: [] })).toMatchObject({ account: null, reason: "no account is signed in" });
  });
});

describe("normalizeSourceInput", () => {
  it("URL・scp 形式・正規化済みの鍵・絶対パスを照合に使う形にそろえ、相対パスは受けない", () => {
    expect(normalizeSourceInput("https://github.com/org/repo.git")).toBe("github.com/org/repo");
    expect(normalizeSourceInput("git@github.com:org/repo.git")).toBe("github.com/org/repo");
    expect(normalizeSourceInput("github.com/org/repo")).toBe("github.com/org/repo");
    expect(normalizeSourceInput("/work/a/")).toBe("/work/a");
    expect(normalizeSourceInput("./a")).toBeNull();
    expect(normalizeSourceInput("~/a")).toBeNull();
    expect(normalizeSourceInput("repo")).toBeNull();
  });

  it("host の無い owner/repo は受けない(host にドットが要る)", () => {
    expect(normalizeSourceInput("owner/repo")).toBeNull();
    expect(normalizeSourceInput("github.com")).toBeNull();
    expect(normalizeSourceInput("gitlab.example.com/group/sub/repo")).toBe("gitlab.example.com/group/sub/repo");
  });

  it("clone URL(scheme 付き・user@host:path)ならドットの無い host(社内 git)も受ける。host/path の形はドットが要る", () => {
    expect(normalizeSourceInput("git@gitserver:org/repo")).toBe("gitserver/org/repo");
    expect(normalizeSourceInput("https://gitserver/org/repo.git")).toBe("gitserver/org/repo");
    expect(normalizeSourceInput("ssh://git@gitserver:2222/org/repo")).toBe("gitserver/org/repo");
    expect(normalizeSourceInput("gitserver/org/repo")).toBeNull();
    expect(normalizeSourceInput("gitserver:org/repo")).toBeNull();
  });

  it("存在しないパスは //・.・.. を畳むだけ。remote はパス部分の // を畳み、全体を小文字にする", () => {
    for (const path of ["/no-such/work//proj", "/no-such/work/./proj", "/no-such/work/x/../proj", "/no-such/work/proj/"]) expect(normalizeSourceInput(path)).toBe("/no-such/work/proj");
    expect(normalizeSourceInput("/no-such/WORK/proj")).toBe("/no-such/WORK/proj");
    expect(normalizeSourceInput("//")).toBe("/");
    expect(normalizeSourceInput("C:/work//x/../proj/")).toBe("C:\\work\\proj");
    expect(normalizeSourceInput("c:\\work\\.\\proj")).toBe("C:\\work\\proj");
    expect(normalizeSourceInput("github.com/org//repo")).toBe("github.com/org/repo");
    expect(normalizeSourceInput("GitHub.com/Org/Repo")).toBe("github.com/org/repo");
    expect(normalizeSourceInput("gitlab.example.com:443/Org/Repo")).toBe("gitlab.example.com/org/repo");
  });

  describe("存在するパスは実体のパスにそろえる", () => {
    let root: string;
    beforeEach(() => {
      root = realpathSync.native(mkdtempSync(join(tmpdir(), "drivelift-input-")));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("シンボリックリンク・//・.・.. を解き、末尾の / を落とす", () => {
      const proj = join(root, "work", "proj");
      mkdirSync(proj, { recursive: true });
      symlinkSync(join(root, "work"), join(root, "link"));
      for (const path of [`${root}/work//proj`, `${root}/work/./proj`, `${root}/work/proj/`, `${root}/link/proj`]) expect(normalizeSourceInput(path)).toBe(proj);
    });

    it.runIf(caseInsensitiveFs)("大小を区別しない FS ではディスク上の綴りにする", () => {
      mkdirSync(join(root, "Proj"));
      expect(normalizeSourceInput(join(root, "proj"))).toBe(join(root, "Proj"));
    });
  });

  it("UNC パス(\\ と /)はパスとして \\ 区切りにそろえる", () => {
    expect(normalizeSourceInput("\\\\server\\share\\a\\")).toBe("\\\\server\\share\\a");
    expect(normalizeSourceInput("//server/share/a/../b")).toBe("\\\\server\\share\\b");
  });

  it("Windows のドライブ付きパスは \\ 区切り・大文字ドライブにそろえる", () => {
    expect(normalizeSourceInput("c:/work/a/")).toBe("C:\\work\\a");
    expect(normalizeSourceInput("C:\\work\\a")).toBe("C:\\work\\a");
    expect(normalizeSourceInput("C:\\")).toBe("C:\\");
  });
});

describe("isTooBroadPath", () => {
  const roots = [homedir(), tmpdir()];
  it("ルート・ホーム・一時ディレクトリとその祖先は広すぎる", () => {
    for (const path of ["/", homedir(), dirname(homedir()), tmpdir(), dirname(tmpdir()), "C:\\"]) expect(isTooBroadPath(path, roots)).toBe(true);
  });
  it("その下のディレクトリは対応づけられる", () => {
    expect(isTooBroadPath(join(homedir(), "work"), roots)).toBe(false);
    expect(isTooBroadPath(join(tmpdir(), "x"), roots)).toBe(false);
    expect(isTooBroadPath("C:\\work", roots)).toBe(false);
  });
});
