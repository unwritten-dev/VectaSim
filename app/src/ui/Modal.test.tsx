import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal } from "./Modal";

// node environment: no document, so the modal renders inline (no portal) and no effect runs
const noop = () => {};

describe("Modal markup", () => {
  it("is a labelled modal dialog that can hold focus itself", () => {
    const h = renderToStaticMarkup(
      <Modal onClose={noop} className="debrief-overlay" labelledBy="k t" describedBy="d">
        <h2 id="t">Landung</h2>
      </Modal>,
    );
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
    expect(h).toContain('aria-labelledby="k t"');
    expect(h).toContain('aria-describedby="d"');
    expect(h).toContain('tabindex="-1"');
    // without a backdrop the dialog is the overlay and the stack's root
    expect(h).toMatch(/^<div[^>]*class="modal-root debrief-overlay"[^>]*role="dialog"/);
  });

  it("wraps the dialog in its backdrop when one is given; passes extra attributes through", () => {
    const h = renderToStaticMarkup(
      <Modal onClose={noop} backdropClassName="csv-backdrop" className="csv-dialog" labelledBy="t" aria-busy>
        <p>x</p>
      </Modal>,
    );
    expect(h).toMatch(/^<div class="modal-root csv-backdrop"><div[^>]*class="csv-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
    expect(h).toContain('aria-busy="true"');
    // the backdrop itself is not the dialog
    expect(h.match(/role="dialog"/g)).toHaveLength(1);
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(<Modal open={false} onClose={noop}>x</Modal>)).toBe("");
  });
});
