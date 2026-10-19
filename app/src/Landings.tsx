import Dispersion from "./landing/Dispersion";
import ApproachDispersion from "./landing/ApproachDispersion";
import Trends from "./landing/Trends";
import { TabPanel, Tabs, type TabDef } from "./ui/Tabs";
import { useStoredState } from "./live/hooks";
import { useT } from "./i18n";

type LandingsTab = "touchdowns" | "approaches" | "trends";
const TAB_IDS: LandingsTab[] = ["touchdowns", "approaches", "trends"];
const TAB_KEY = "vectasim.landingsTab";
const ID_BASE = "landings";

/**
 * Logbook section "Landungen": where the last landings touched down (normalised runway) and
 * how the last approaches passed their gates, and how both develop over time ("Verlauf").
 */
export default function Landings() {
  const [stored, setTab] = useStoredState<string>(TAB_KEY, "touchdowns");
  const tab: LandingsTab = stored === "approaches" || stored === "trends" ? stored : "touchdowns";
  const t = useT();
  const tabs: TabDef<LandingsTab>[] = TAB_IDS.map((id) => ({ id, label: t(`logbook.landings.${id}`) }));
  return (
    <section className="logbook landings-view">
      <Tabs tabs={tabs} active={tab} onChange={setTab} idBase={ID_BASE} label={t("logbook.landings.tabsLabel")} className="landings-tabs" />
      <TabPanel idBase={ID_BASE} id={tab}>
        {tab === "touchdowns" ? <Dispersion limit={20} /> : tab === "approaches" ? <ApproachDispersion limit={20} /> : <Trends />}
      </TabPanel>
    </section>
  );
}
