import { describe, it, expect } from "vitest";
import { extractFolderIdFromUrl } from "@/services/drive";

describe("extractFolderIdFromUrl", () => {
  it("extracts folder ID from standard URL", () => {
    expect(
      extractFolderIdFromUrl("https://drive.google.com/drive/folders/1abc2DEF3xyz")
    ).toBe("1abc2DEF3xyz");
  });

  it("extracts folder ID from /u/0/ URL", () => {
    expect(
      extractFolderIdFromUrl(
        "https://drive.google.com/drive/u/0/folders/1abc2DEF3xyz"
      )
    ).toBe("1abc2DEF3xyz");
  });

  it("returns null for a file URL", () => {
    expect(
      extractFolderIdFromUrl("https://drive.google.com/file/d/somefileid/view")
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractFolderIdFromUrl("")).toBeNull();
  });

  it("returns null for a non-Drive URL", () => {
    expect(extractFolderIdFromUrl("https://example.com")).toBeNull();
  });
});
