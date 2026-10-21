import { useT } from "../i18n";
import { profileName, profileTooltip, useApproachProfiles } from "./approachProfiles";

/**
 * "Assessed with: Airbus-style profile" – the assessment profile of an approach, with the
 * values that differ from the generic profile as the tooltip.
 */
export default function AssessedWith({ profileId, className = "" }: { profileId: string | null | undefined; className?: string }) {
  const t = useT();
  const profiles = useApproachProfiles();
  const tip = profileTooltip(profileId, profiles, t);
  return (
    <span className={`assessed-with detail ${className}`.trim()} title={tip} aria-label={`${t("approach.assessment.assessedWith", { name: profileName(profileId, profiles, t) })}. ${tip}`}>
      {t("approach.assessment.assessedWith", { name: profileName(profileId, profiles, t) })}
    </span>
  );
}
