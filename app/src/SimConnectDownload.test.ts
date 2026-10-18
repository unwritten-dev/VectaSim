import { describe, expect, it } from "vitest";
import { approxMB, downloadErrorText, fmtMB, progressFraction, progressText } from "./SimConnectDownload";

const ZIP = 113_306_986;

describe("SimConnect download progress", () => {
  it("formats MB with a German comma", () => {
    expect(fmtMB(0)).toBe("0,0 MB");
    expect(fmtMB(ZIP)).toBe("108,1 MB");
    expect(fmtMB(12.34 * 1024 * 1024)).toBe("12,3 MB");
    expect(fmtMB(-5)).toBe("0,0 MB");
    expect(approxMB(ZIP)).toBe("~108 MB");
  });
  it("phase texts", () => {
    expect(progressText(null)).toBe("Starte Download …");
    expect(progressText({ phase: "download", received: 12.34 * 1024 * 1024, total: ZIP })).toBe("Lade … 12,3 von 108,1 MB");
    expect(progressText({ phase: "download", received: 1024 * 1024, total: 0 })).toBe("Lade … 1,0 MB");
    expect(progressText({ phase: "verify", received: ZIP, total: ZIP })).toBe("Prüfe …");
    expect(progressText({ phase: "extract", received: ZIP, total: ZIP })).toBe("Entpacke …");
    expect(progressText({ phase: "done", received: ZIP, total: ZIP })).toBe("Fertig");
  });
  it("bar fraction", () => {
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction({ phase: "download", received: 5, total: 0 })).toBeNull();
    expect(progressFraction({ phase: "download", received: 25, total: 100 })).toBe(0.25);
    expect(progressFraction({ phase: "download", received: 200, total: 100 })).toBe(1);
    expect(progressFraction({ phase: "verify", received: 0, total: 0 })).toBe(1);
  });
  it("error texts", () => {
    expect(downloadErrorText("Download fehlgeschlagen (exit code: 6): curl: (6) Could not resolve host: sdk.flightsimulator.com")).toMatch(
      /Internetverbindung/,
    );
    expect(downloadErrorText("SDK-Paket ungültig: SHA-256 ab statt cd")).toMatch(/unvollständig/);
    expect(downloadErrorText("Der Download läuft bereits.")).toMatch(/läuft bereits/);
    expect(downloadErrorText("D:/x nicht schreibbar: Zugriff verweigert")).toBe("D:/x nicht schreibbar: Zugriff verweigert");
  });
});
