import { describe, expect, it } from "vitest";
import { planespottersLink } from "./photoLink";

describe("planespottersLink", () => {
  it("keeps https links to www.planespotters.net", () => {
    expect(planespottersLink("https://www.planespotters.net/photo/1234567/d-aiab-lufthansa")).toBe("https://www.planespotters.net/photo/1234567/d-aiab-lufthansa");
  });

  it("drops everything else", () => {
    for (const bad of [
      "http://www.planespotters.net/photo/1",
      "https://planespotters.net/photo/1",
      "https://www.planespotters.net.evil.example/photo/1",
      "https://evil.example/?u=https://www.planespotters.net/",
      "https://user:pw@www.planespotters.net/photo/1",
      "https://www.planespotters.net:8443/photo/1",
      "javascript:alert(1)",
      "file:///C:/Windows/system32/calc.exe",
      "not a url",
      "",
      null,
      undefined,
    ])
      expect(planespottersLink(bad)).toBeNull();
  });
});
