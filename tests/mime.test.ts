import { describe, expect, it } from "vitest";
import { defaultDriveName, extensionOf, GOOGLE_MIME, resolveTargetMime, sourceMimeFor } from "../src/mime.js";

describe("mime", () => {
  it("extensionOf は小文字・ドットなしで返す", () => {
    expect(extensionOf("/a/b/Report.XLSX")).toBe("xlsx");
    expect(extensionOf("noext")).toBe("");
  });

  it("auto は拡張子ごとに Google 形式へ寄せ、対象外は変換しない", () => {
    expect(resolveTargetMime("xlsx", "auto")).toBe(GOOGLE_MIME.spreadsheet);
    expect(resolveTargetMime("csv", "auto")).toBe(GOOGLE_MIME.spreadsheet);
    expect(resolveTargetMime("md", "auto")).toBe(GOOGLE_MIME.document);
    expect(resolveTargetMime("pptx", "auto")).toBe(GOOGLE_MIME.presentation);
    expect(resolveTargetMime("png", "auto")).toBeNull();
    expect(resolveTargetMime("", "auto")).toBeNull();
  });

  it("none は常に変換せず、明示指定は拡張子に関わらずその形式", () => {
    expect(resolveTargetMime("xlsx", "none")).toBeNull();
    expect(resolveTargetMime("png", "spreadsheet")).toBe(GOOGLE_MIME.spreadsheet);
  });

  it("sourceMimeFor は未知の拡張子で octet-stream", () => {
    expect(sourceMimeFor("xlsx")).toContain("spreadsheetml");
    expect(sourceMimeFor("weird")).toBe("application/octet-stream");
  });

  it("defaultDriveName は変換時だけ拡張子を落とす", () => {
    expect(defaultDriveName("/x/report.xlsx", true)).toBe("report");
    expect(defaultDriveName("/x/report.xlsx", false)).toBe("report.xlsx");
    expect(defaultDriveName("/x/README", true)).toBe("README");
  });
});
