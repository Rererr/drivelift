/**
 * browser.ts — 認可 URL を既定ブラウザで開く(ベストエフォート)。
 * 開けなくても URL は呼び出し側へ返るので、失敗は false で知らせるだけにする。
 */
import { spawn } from "node:child_process";

function windowsCommand(url: string): [string, string[]] {
  // cmd /c start に URL を渡すと "&" がコマンド区切りに解釈されて切れる(spawn は空白を含まない引数を
  // quote しない)。PowerShell の EncodedCommand なら引数の quote 規則を一切通らない
  const script = `Start-Process '${url.replace(/'/g, "''")}'`;
  return ["powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]];
}

export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? windowsCommand(url) : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
