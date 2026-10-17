import { fmt, fmtNum } from "../format";
import { CRITERION_LABEL, CRITERION_ORDER, STATUS_ICON, limitText, measuredText } from "./facts";
import type { Criterion, GateCheck } from "./types";

const STATUS_TEXT = { pass: "erfüllt", fail: "nicht erfüllt", unavailable: "nicht messbar" } as const;

function Cell({ c }: { c?: Criterion }) {
  if (!c) return <td className="sa-cell sa-unavailable">–</td>;
  return (
    <td className={`sa-cell sa-${c.status}`} title={STATUS_TEXT[c.status]}>
      <span className="sa-icon" aria-label={STATUS_TEXT[c.status]}>
        {STATUS_ICON[c.status]}
      </span>
      <span className="num">{measuredText(c)}</span>
    </td>
  );
}

/** Stabilised-approach criteria at the 1000 ft and 500 ft gates: ✓/✗, measured value, limit. */
export default function StabilisedTable({ gates }: { gates: GateCheck[] }) {
  const limitSource = gates.find((g) => g.criteria.length > 0);
  return (
    <table className="mini-table sa-table">
      <thead>
        <tr>
          <th>Kriterium</th>
          <th>Grenze</th>
          {gates.map((g) => (
            <th key={g.gateFt}>
              bei {fmtNum(g.gateFt)} ft
              {g.sample && <span className="detail"> · {fmt(g.sample.distM / 1852, 1, "nm")}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CRITERION_ORDER.map((kind) => {
          const ref = limitSource?.criteria.find((c) => c.kind === kind);
          return (
            <tr key={kind}>
              <td>{CRITERION_LABEL[kind]}</td>
              <td className="detail num">{ref ? limitText(ref) : "–"}</td>
              {gates.map((g) =>
                g.reached ? (
                  <Cell key={g.gateFt} c={g.criteria.find((c) => c.kind === kind)} />
                ) : (
                  <td key={g.gateFt} className="sa-cell sa-unavailable detail">
                    nicht erreicht
                  </td>
                ),
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
