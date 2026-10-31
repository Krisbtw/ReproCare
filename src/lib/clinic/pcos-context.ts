/**
 * PCOS context guard.
 *
 * AnatomyBridge never diagnoses PCOS. This module only decides which cautionary
 * note to show beside PCOS-pathway records.
 *
 * Source basis: the 2023 international PCOS guideline, as read in the research
 * report (docs/RESEARCH_REPORT.md): in adolescents both ovulatory dysfunction and
 * hyperandrogenism are required, and ovarian ultrasound is not recommended for
 * diagnosis. The guideline works from time since first period. The app stores only
 * year of birth, so it cannot know that. The age line below is therefore an app
 * threshold chosen to be conservative. It is NOT a guideline cutoff.
 */

export const ADOLESCENT_APP_THRESHOLD_YEARS = 20;

export type PcosContext = {
  level: "adolescent-possible" | "age-unknown" | "adult-default";
  /** Age by year of birth only (error up to one year). Null when unknown. */
  approxAge: number | null;
  headline: string;
  lines: string[];
  /** True when ovarian ultrasound findings must not be presented as support for a PCOS label. */
  withholdUltrasoundAsSupport: boolean;
};

export function pcosContext(
  yearOfBirth: number | null | undefined,
  referenceYear: number,
): PcosContext {
  const unknown =
    yearOfBirth == null ||
    !Number.isFinite(yearOfBirth) ||
    yearOfBirth > referenceYear ||
    yearOfBirth < referenceYear - 120;

  if (unknown) {
    return {
      level: "age-unknown",
      approxAge: null,
      headline: "Age is not recorded, so adolescent status cannot be assessed.",
      lines: [
        "The 2023 guideline applies stricter criteria to adolescents. This record has no usable year of birth, and no first-period date is stored.",
        "Ovarian appearance is shown as a recorded finding only. It is not support for a PCOS label.",
      ],
      withholdUltrasoundAsSupport: true,
    };
  }

  const approxAge = referenceYear - (yearOfBirth as number);

  if (approxAge < ADOLESCENT_APP_THRESHOLD_YEARS) {
    return {
      level: "adolescent-possible",
      approxAge,
      headline: "Possible adolescent record. Adolescent criteria may apply.",
      lines: [
        "In adolescents the 2023 guideline needs both irregular cycles (ovulatory dysfunction) and signs of high androgens. It does not recommend ovarian ultrasound for diagnosis.",
        `The app flags anyone under ${ADOLESCENT_APP_THRESHOLD_YEARS} by year of birth. That threshold is this app's own conservative choice. The guideline counts time since the first period, which is not stored here.`,
        "Cycle and lab entries below are shown for a clinician to read. Nothing here applies adolescent or adult criteria.",
      ],
      withholdUltrasoundAsSupport: true,
    };
  }

  return {
    level: "adult-default",
    approxAge,
    headline: "Adult record by year of birth.",
    lines: [
      "Ovarian appearance is still shown as a recorded finding only. The app does not apply a follicle threshold, convert AMH into a label, or diagnose PCOS.",
    ],
    withholdUltrasoundAsSupport: true,
  };
}
