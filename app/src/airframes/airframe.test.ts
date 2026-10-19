import { describe, expect, it } from "vitest";
import { setLanguageSetting } from "../i18n";
import { PHOTO_HIT_TTL_MS, PHOTO_MISS_TTL_MS, airframeName, matchesAirframe, needsPhotoLookup, normalizeRegistration, parseVapp, photoCredit, pickerOptions, safePhotoLink } from "./airframe";

const base = { registration: "D-AINA", customName: null, title: null, airline: null, icaoType: null };

describe("normalizeRegistration", () => {
  it("matches the store's rule", () => {
    expect(normalizeRegistration(" d-aina ")).toBe("D-AINA");
    expect(normalizeRegistration("n12345x")).toBe("N12345X");
    for (const bad of ["", "AB", "D-AINABCDE", "D_AINA", "12345", "-DAIN", "DAIN-", "D--AIN", "ASXGS", "N12345", "D-ÄINA", null]) {
      expect(normalizeRegistration(bad)).toBeNull();
    }
  });
});

describe("needsPhotoLookup", () => {
  const t0 = 1_700_000_000_000;
  it("follows the cache TTLs", () => {
    expect(needsPhotoLookup({ imageSource: null, imageFetchedMs: null }, t0)).toBe(true);
    expect(needsPhotoLookup({ imageSource: "planespotters", imageFetchedMs: t0 }, t0 + PHOTO_HIT_TTL_MS - 1)).toBe(false);
    expect(needsPhotoLookup({ imageSource: "planespotters", imageFetchedMs: t0 }, t0 + PHOTO_HIT_TTL_MS)).toBe(true);
    expect(needsPhotoLookup({ imageSource: "none", imageFetchedMs: t0 }, t0 + PHOTO_MISS_TTL_MS - 1)).toBe(false);
    expect(needsPhotoLookup({ imageSource: "none", imageFetchedMs: t0 }, t0 + PHOTO_MISS_TTL_MS)).toBe(true);
    expect(needsPhotoLookup({ imageSource: "user", imageFetchedMs: null }, t0)).toBe(false);
  });
});

describe("names and credits", () => {
  it("prefers the custom name", () => {
    expect(airframeName(base)).toBe("D-AINA");
    expect(airframeName({ ...base, airline: "DLH", icaoType: "A20N" })).toBe("DLH A20N");
    expect(airframeName({ ...base, title: "Airbus A320neo Lufthansa", airline: "DLH" })).toBe("Airbus A320neo Lufthansa");
    expect(airframeName({ ...base, title: "x", customName: " Kranich " })).toBe("Kranich");
  });
  it("credits Planespotters photos", () => {
    expect(photoCredit({ imageSource: "planespotters", imageCredit: "Max" })).toBe("© Max · Planespotters.net");
    expect(photoCredit({ imageSource: "planespotters", imageCredit: null })).toBe("© Planespotters.net");
    setLanguageSetting("de");
    expect(photoCredit({ imageSource: "user", imageCredit: null })).toBe("Eigenes Bild");
    setLanguageSetting("en");
    expect(photoCredit({ imageSource: "user", imageCredit: null })).toBe("Own image");
    setLanguageSetting("system");
    expect(photoCredit({ imageSource: "none", imageCredit: null })).toBeNull();
  });
});

describe("picker", () => {
  const all = [
    { ...base },
    { ...base, registration: "D-AVCT", customName: "Vecta One", icaoType: "A20N" },
    { ...base, registration: "G-EUPT", airline: "BAW", icaoType: "A319" },
  ];
  it("searches registration with or without hyphen, name, type, airline", () => {
    expect(matchesAirframe(all[0], "daina")).toBe(true);
    expect(matchesAirframe(all[1], "vecta")).toBe(true);
    expect(matchesAirframe(all[2], "baw")).toBe(true);
    expect(matchesAirframe(all[2], "a20n")).toBe(false);
  });
  it("offers a new registration only when valid and unknown", () => {
    expect(pickerOptions(all, "d-aina").newReg).toBeNull();
    expect(pickerOptions(all, "d-ainb")).toEqual({ matches: [], newReg: "D-AINB" });
    expect(pickerOptions(all, "a2").newReg).toBeNull();
    expect(pickerOptions(all, "").matches).toHaveLength(3);
    expect(pickerOptions(all, "", 2).matches).toHaveLength(2);
  });
});

describe("parseVapp", () => {
  it("empty means the flown value, numbers are rounded knots", () => {
    expect(parseVapp("")).toBeNull();
    expect(parseVapp("  ")).toBeNull();
    expect(parseVapp("138")).toBe(138);
    expect(parseVapp("137,6")).toBe(138);
  });
  it("refuses implausible values", () => {
    expect(parseVapp("12")).toBeUndefined();
    expect(parseVapp("400")).toBeUndefined();
    expect(parseVapp("abc")).toBeUndefined();
  });
});

describe("safePhotoLink (only Planespotters photo pages are opened)", () => {
  it("keeps https links to www.planespotters.net", () => {
    expect(safePhotoLink("https://www.planespotters.net/photo/1234567/d-aina-lufthansa")).toBe("https://www.planespotters.net/photo/1234567/d-aina-lufthansa");
  });
  it("drops other hosts, schemes, look-alikes and garbage", () => {
    for (const bad of [
      "http://www.planespotters.net/photo/1",
      "https://planespotters.net.evil.example/photo/1",
      "https://www.planespotters.net.evil.example/",
      "https://evil.example/?https://www.planespotters.net/",
      "https://user@www.planespotters.net/photo/1",
      "https://www.planespotters.net:8443/photo/1",
      "javascript:alert(1)",
      "file:///C:/Windows/System32/calc.exe",
      "not a url",
      "",
      null,
      undefined,
    ])
      expect(safePhotoLink(bad), String(bad)).toBeNull();
  });
});
