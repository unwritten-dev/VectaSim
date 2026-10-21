import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { TagFilter } = await import("./Logbook");

const render = (tags: Array<{ tag: string; count: number }>, selected: string[] = []) =>
  renderToStaticMarkup(
    <I18nProvider lang="en">
      <TagFilter tags={tags} selected={selected} onChange={() => {}} defaultOpen />
    </I18nProvider>,
  );

describe("logbook tag filter", () => {
  it("the trigger is a menu button only – no aria-pressed next to aria-haspopup", () => {
    const h = render([{ tag: "VATSIM", count: 3 }], ["VATSIM"]);
    expect(h).toContain('aria-haspopup="menu"');
    expect(h).toContain('aria-expanded="true"');
    expect(h).not.toContain("aria-pressed");
    expect(h).toContain('role="menuitemcheckbox"');
  });

  it("without tags there is no empty role=menu, only the hint the trigger points to", () => {
    const h = render([]);
    expect(h).not.toContain('role="menu"');
    expect(h).not.toContain("aria-haspopup");
    const hint = /aria-describedby="([^"]+)"/.exec(h)?.[1];
    expect(hint).toBeTruthy();
    expect(h).toContain(`id="${hint}"`);
  });
});
