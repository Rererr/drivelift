import { describe, expect, it } from "vitest";
import { DriveliftError } from "../src/errors.js";
import { generateProjectId, runGcloudSetup, type ExecGcloud, type ExecResult } from "../src/gcloud.js";

/** gcloud の各サブコマンドを状態付きで模す。呼び出しを記録する。 */
function fakeGcloud(state: { account: string | null; project: string | null; existing: string[]; enabled: string[] }): { exec: ExecGcloud; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const exec: ExecGcloud = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "auth" && b === "list") return ok(state.account ?? "");
    if (a === "auth" && b === "login") {
      state.account = "me@example.com";
      return ok();
    }
    if (a === "config") return ok(state.project ?? "(unset)");
    if (a === "projects" && b === "describe") return state.existing.includes(args[2] ?? "") ? ok(args[2]) : { code: 1, stdout: "", stderr: "not found" };
    if (a === "projects" && b === "create") {
      state.existing.push(args[2] ?? "");
      return ok();
    }
    if (a === "services" && b === "list") return ok(state.enabled.includes((args[3] ?? "").replace("--project=", "")) ? "drive.googleapis.com" : "");
    if (a === "services" && b === "enable") {
      state.enabled.push((args[3] ?? "").replace("--project=", ""));
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls };
}

const deps = (exec: ExecGcloud, hasGcloud = true) => ({ exec, hasGcloud: () => hasGcloud, secretPath: "/cfg/client_secret.json" });

describe("runGcloudSetup", () => {
  it("gcloud が無ければ unavailable", async () => {
    const { exec, calls } = fakeGcloud({ account: null, project: null, existing: [], enabled: [] });
    const r = await runGcloudSetup({}, deps(exec, false));
    expect(r.state).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("confirm なしは計画だけ返し、何も実行しない", async () => {
    const st = { account: "me@example.com", project: null, existing: [], enabled: [] };
    const { exec, calls } = fakeGcloud(st);
    const r = await runGcloudSetup({}, deps(exec));
    expect(r.state).toBe("plan");
    expect(r.project_id).toMatch(/^drivelift-[0-9a-f]{8}$/);
    expect(r.planned_commands).toEqual([`gcloud projects create ${r.project_id} --name=drivelift`, `gcloud services enable drive.googleapis.com --project=${r.project_id}`]);
    expect(calls.some((c) => c[1] === "create" || c[1] === "enable")).toBe(false);
    expect(st.existing).toEqual([]);
  });

  it("confirm: true で作成と有効化を実行し、残りの手順をプロジェクト付き URL で返す", async () => {
    const st = { account: "me@example.com", project: null, existing: [], enabled: [] };
    const { exec } = fakeGcloud(st);
    const r = await runGcloudSetup({ project_id: "my-proj-1", confirm: true }, deps(exec));
    expect(r.state).toBe("done");
    expect(st.existing).toEqual(["my-proj-1"]);
    expect(st.enabled).toEqual(["my-proj-1"]);
    expect(r.executed_commands).toEqual(["gcloud projects create my-proj-1 --name=drivelift", "gcloud services enable drive.googleapis.com --project=my-proj-1"]);
    expect(r.urls["create_oauth_client"]).toContain("?project=my-proj-1&authuser=me%40example.com");
    // サンプル値のメールはログイン中の gcloud アカウントで埋まる
    expect(r.console_form?.consent_screen.find((f) => f.field === "User support email")?.value).toBe("me@example.com");
    expect(r.next_steps.join("\n")).toContain("App name: drivelift");
    expect(r.next_steps.join("\n")).toContain("/cfg/client_secret.json");
  });

  it("gcloud config の既定プロジェクトが describe できなければ同名作成せず新 ID を生成する", async () => {
    const st = { account: "me@example.com", project: "ghost-proj", existing: [], enabled: [] };
    const { exec } = fakeGcloud(st);
    const r = await runGcloudSetup({}, deps(exec));
    expect(r.project_id).toMatch(/^drivelift-/);
    expect(r.planned_commands[0]).not.toContain("ghost-proj");
    expect(r.message).toContain("ghost-proj");
  });

  it("既存プロジェクトで API も有効なら何も実行せず、手順 3 以降だけ返す", async () => {
    const st = { account: "me@example.com", project: "p-existing", existing: ["p-existing"], enabled: ["p-existing"] };
    const { exec } = fakeGcloud(st);
    const r = await runGcloudSetup({}, deps(exec));
    expect(r.state).toBe("plan");
    expect(r.planned_commands).toEqual([]);
    expect(r.next_steps[0]).toMatch(/^3\./);
  });

  it("未ログインなら confirm なしでは needs_login、confirm ありなら auth login を先に走らせる", async () => {
    const st = { account: null, project: null, existing: [], enabled: [] };
    const { exec, calls } = fakeGcloud(st);
    const plan = await runGcloudSetup({}, deps(exec));
    expect(plan.state).toBe("needs_login");
    expect(plan.planned_commands).toEqual(["gcloud auth login"]);

    const done = await runGcloudSetup({ project_id: "p-new-01", confirm: true }, deps(exec));
    expect(done.state).toBe("done");
    expect(calls.some((c) => c[0] === "auth" && c[1] === "login")).toBe(true);
    expect(done.account).toBe("me@example.com");

    const refused = await runGcloudSetup({ confirm: true, login_if_needed: false }, deps(fakeGcloud({ account: null, project: null, existing: [], enabled: [] }).exec));
    expect(refused.state).toBe("needs_login");
  });

  it("コマンド失敗は exit と stderr 付きの DriveliftError", async () => {
    const exec: ExecGcloud = async (args) => (args[0] === "auth" ? { code: 0, stdout: "me@example.com", stderr: "" } : args[1] === "describe" ? { code: 1, stdout: "", stderr: "" } : args[1] === "create" ? { code: 1, stdout: "", stderr: "PERMISSION_DENIED: org policy" } : { code: 0, stdout: "", stderr: "" });
    await expect(runGcloudSetup({ project_id: "p-denied-1", confirm: true }, deps(exec))).rejects.toThrow(/exit 1.*PERMISSION_DENIED/);
    await expect(runGcloudSetup({ project_id: "p-denied-1", confirm: true }, deps(exec))).rejects.toBeInstanceOf(DriveliftError);
  });

  it("生成 ID は Google の制約(先頭英字・6-30 文字・小文字)を満たす", () => {
    expect(generateProjectId()).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  });
});
