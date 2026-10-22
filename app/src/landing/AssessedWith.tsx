import { useT } from "../i18n";
import { profileName, profileTooltip, useApproachProfiles } from "./approachProfiles";
import ProfileTip from "./ProfileTip";

/**
 * "Assessed with: Airbus-style profile" – the assessment profile of an approach, with the
 * values that differ from the generic profile as the tooltip; focusable, and the same lines are
 * its accessible description (ProfileTip).
 */
export default function AssessedWith({ profileId, className = "" }: { profileId: string | null | undefined; className?: string }) {
  const t = useT();
  const profiles = useApproachProfiles();
  return (
    <ProfileTip className={`assessed-with detail ${className}`.trim()} tip={profileTooltip(profileId, profiles, t)}>
      {t("approach.assessment.assessedWith", { name: profileName(profileId, profiles, t) })}
    </ProfileTip>
  );
}
