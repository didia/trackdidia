import { describe, expect, it } from "vitest";
import type { FinanceImportProfile } from "../../domain/finance";
import { buildImportRequest, buildImportRows, decodeCsvBytes } from "./import-request";

const profile: FinanceImportProfile = {
  id: "profile-1",
  name: "Test",
  signature: "sig",
  columnMap: { date: 0, description: 1, amount: 2 },
  dateFormat: "YYYY-MM-DD",
  amountMode: "single_signed",
  signConvention: null,
  defaultAccountId: null,
  createdAt: "",
  updatedAt: "",
  lastUsedAt: null,
};

describe("decodeCsvBytes", () => {
  const encodeUtf8 = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

  it("decodes valid UTF-8 without a retry", () => {
    const result = decodeCsvBytes(encodeUtf8("Date,Description,Amount\n2024-01-01,Café,1.00\n"));
    expect(result.reencodedAsWindows1252).toBe(false);
    expect(result.text).toContain("Café");
  });

  it("retries as windows-1252 when UTF-8 decoding yields a replacement character", () => {
    // 0xE9 alone is not valid UTF-8 but is "é" in windows-1252.
    const latin1Bytes = new Uint8Array([0x44, 0xe9, 0x50, 0xe9]);
    const result = decodeCsvBytes(latin1Bytes.buffer);
    expect(result.reencodedAsWindows1252).toBe(true);
    expect(result.text).toBe("DéPé");
  });
});

describe("buildImportRows", () => {
  it("maps rows and resolves accounts via the provided resolver", () => {
    const result = buildImportRows({
      header: ["Date", "Description", "Amount"],
      rows: [["2024-01-05", "Grocery Store", "-12.34"]],
      profile,
      currency: "CAD",
      resolveAccountId: () => "account-1",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      accountId: "account-1",
      postedDate: "2024-01-05",
      amountMinor: -1234,
      descriptionRaw: "Grocery Store",
    });
  });

  it("reports an error and tracks the unresolved key when the account cannot be resolved", () => {
    const accountProfile: FinanceImportProfile = {
      ...profile,
      columnMap: { ...profile.columnMap, account: 3 },
    };
    const result = buildImportRows({
      header: ["Date", "Description", "Amount", "Account"],
      rows: [["2024-01-05", "Grocery Store", "-12.34", "Checking ****1234"]],
      profile: accountProfile,
      currency: "CAD",
      resolveAccountId: () => null,
    });

    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(2);
    expect(result.unresolvedAccountKeys).toEqual(["Checking ****1234"]);
  });

  it("reports an error for an unparseable row without throwing", () => {
    const result = buildImportRows({
      header: ["Date", "Description", "Amount"],
      rows: [["not-a-date", "Grocery Store", "-12.34"]],
      profile,
      currency: "CAD",
      resolveAccountId: () => "account-1",
    });

    expect(result.rows).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain("unparseable date");
  });
});

describe("buildImportRequest", () => {
  it("builds a full FinanceImportRequest from parsed rows", () => {
    const { request, errors } = buildImportRequest({
      accountId: "account-1",
      profileId: profile.id,
      fileName: "export.csv",
      fileHash: "hash-1",
      header: ["Date", "Description", "Amount"],
      rows: [["2024-01-05", "Grocery Store", "-12.34"]],
      profile,
      currency: "CAD",
      resolveAccountId: () => "account-1",
    });

    expect(errors).toHaveLength(0);
    expect(request).toMatchObject({
      accountId: "account-1",
      profileId: profile.id,
      fileName: "export.csv",
      fileHash: "hash-1",
    });
    expect(request.rows).toHaveLength(1);
  });
});
