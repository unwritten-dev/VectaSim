import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabPanel, Tabs } from "./Tabs";

const tabs = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];

describe("Tabs", () => {
  it("points aria-controls at its TabPanels", () => {
    const html = renderToStaticMarkup(
      <>
        <Tabs tabs={tabs} active="a" onChange={() => {}} idBase="x" label="L" />
        <TabPanel idBase="x" id="a">
          A
        </TabPanel>
      </>,
    );
    expect(html).toContain('aria-controls="x-panel-a"');
    expect(html).toContain('id="x-panel-a"');
  });

  it("without panels (logbook sections) there is no dangling aria-controls", () => {
    const html = renderToStaticMarkup(<Tabs tabs={tabs} active="a" onChange={() => {}} idBase="logbook" label="L" panels={false} />);
    expect(html).not.toContain("aria-controls");
    expect(html).toContain('role="tab"');
    expect(html).toContain('id="logbook-tab-a"');
  });
});
