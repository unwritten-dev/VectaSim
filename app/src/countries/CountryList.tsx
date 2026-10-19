import { useLanguage, useT } from "../i18n";
import { fmt, fmtDate } from "../i18n/number";
import { continentLabel, countryName, otherCountryName, type CountryRow } from "./countries.ts";

interface Props {
  rows: CountryRow[];
  selected: string | null;
  onSelect: (iso2: string | null) => void;
}

/**
 * Every country with ✓ (landed in, with count and last date) or – (open): the table
 * alternative to the map. A row's name is a button that selects the country.
 */
export default function CountryList({ rows, selected, onSelect }: Props) {
  const t = useT();
  const lang = useLanguage();
  return (
    <table className="flights country-list">
      <thead>
        <tr>
          <th className="country-mark-col">
            <span className="sr-only">{t("countries.list.visited")}</span>
          </th>
          <th>{t("countries.list.country")}</th>
          <th className="num right">{t("countries.list.landings")}</th>
          <th className="right">{t("countries.list.last")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr className="empty-row">
            <td colSpan={4} className="detail">
              {t("countries.list.none")}
            </td>
          </tr>
        )}
        {rows.map(({ country: c, visit: v }) => (
          <tr key={c.iso2} className={`static${v ? " country-visited" : ""}${selected === c.iso2 ? " selected" : ""}`}>
            <td className={`country-mark ${v ? "country-yes" : "country-no"}`} aria-label={v ? t("countries.list.yes") : t("countries.list.no")}>
              {v ? "✓" : "–"}
            </td>
            <td>
              <button
                type="button"
                className="country-name btn-ghost"
                aria-pressed={selected === c.iso2}
                onClick={() => onSelect(selected === c.iso2 ? null : c.iso2)}
                // full name first: long names are cut with an ellipsis in the list (countries.css)
                title={`${countryName(c, lang)} · ${otherCountryName(c, lang)} · ${continentLabel(c.continent, lang)}`}
              >
                <span className="mono country-iso">{c.iso2}</span> {countryName(c, lang)}
              </button>
            </td>
            <td className="num right">{v ? fmt(v.landings, 0, "", lang) : ""}</td>
            <td className="num right detail">{v ? fmtDate(v.lastMs, { lang }) : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
