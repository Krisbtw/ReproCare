/**
 * PCOS context guard.
 *
 * AnatomyBridge never diagnoses PCOS. This module only decides which cautionary
 * note to show beside PCOS-pathway records, and which published cycle-interval
 * band (if any) can be shown next to recorded cycles for a clinician to read.
 *
 * Source basis: the 2023 International Evidence-based Guideline for the Assessment
 * and Management of PCOS (Teede et al., 2023; published in Fertility and Sterility,
 * Human Reproduction, JCEM and EJE). As read for this project:
 *   - In adolescents both ovulatory dysfunction and hyperandrogenism are required.
 *   - Ovarian ultrasound should not be used for diagnosis when gynaecological age
 *     (years since first period, "menarche") is under 8 years.
 *   - Irregular cycles are defined by time since menarche:
 *       < 1 year: irregular cycles are normal (pubertal transition);
 *       1 to < 3 years: < 21 or > 45 days;
 *       >= 3 years: < 21 or > 35 days, or fewer than 8 cycles a year;
 *       > 1 year: any one cycle > 90 days.
 * Check these against the primary guideline text before citing them.
 *
 * Menarche is stored as a YEAR only (data minimisation). Elapsed time from a year
 * to a year is uncertain by up to one year either way, so any threshold that falls
 * inside that window is reported as "boundary" rather than guessed.
 *
 * When no menarche year is stored, the older year-of-birth rule applies. Its age
 * line (20) is this app's own conservative choice, NOT a guideline cutoff.
 */

export const ADOLESCENT_APP_THRESHOLD_YEARS = 20;
export const ULTRASOUND_GYN_AGE_YEARS = 8;
export const MENARCHE_MIN_AGE = 6;
export const MENARCHE_MAX_AGE = 25;

export type GynAge = {
  /** referenceYear - menarcheYear. */
  years: number;
  /** True elapsed time lies strictly between min and max (year-only precision). */
  min: number;
  max: number;
};

export type PcosLevel =
  | "adolescent-possible"
  | "age-unknown"
  | "adult-default"
  | "menarche-under-8"
  | "menarche-boundary-8"
  | "menarche-8-plus";

export type PcosContext = {
  level: PcosLevel;
  /** Which stored fact the note rests on. */
  basis: "menarche" | "birth-year" | "none";
  /** Age by year of birth only (error up to one year). Null when unknown. */
  approxAge: number | null;
  /** Years since first period, from a stored year. Null when not stored or implausible. */
  gynAge: GynAge | null;
  /** Set when a stored menarche year was rejected as implausible. */
  menarcheProblem: string | null;
  headline: string;
  lines: string[];
  /** True when ovarian ultrasound findings must not be presented as support for a PCOS label. Always true: the app never does this. */
  withholdUltrasoundAsSupport: boolean;
};

export type MenarcheCheck = { ok: true; year: number } | { ok: false; problem: string };

/** Plausibility check used by both the UI and the server validator. Does not guess a value. */
export function checkMenarcheYear(
  menarcheYear: number | null | undefined,
  yearOfBirth: number | null | undefined,
  referenceYear: number,
): MenarcheCheck {
  if (menarcheYear == null || !Number.isFinite(menarcheYear) || !Number.isInteger(menarcheYear)) {
    return { ok: false, problem: "Enter the year of the first period as a whole year, for example 2012." };
  }
  if (menarcheYear > referenceYear) return { ok: false, problem: "The first period cannot be in the future." };
  if (menarcheYear < referenceYear - 120) return { ok: false, problem: "That year is too far in the past to be plausible." };
  if (yearOfBirth != null && Number.isFinite(yearOfBirth)) {
    const age = menarcheYear - yearOfBirth;
    if (age < MENARCHE_MIN_AGE || age > MENARCHE_MAX_AGE) {
      return {
        ok: false,
        problem: `That would be age ${age} at first period by year of birth. Check the year; values outside ${MENARCHE_MIN_AGE}–${MENARCHE_MAX_AGE} are not stored.`,
      };
    }
  }
  return { ok: true, year: menarcheYear };
}

export function gynaecologicalAge(menarcheYear: number, referenceYear: number): GynAge {
  const years = referenceYear - menarcheYear;
  return { years, min: Math.max(0, years - 1), max: years + 1 };
}

const ULTRASOUND_LINE_UNDER =
  "The guideline says ovarian ultrasound should not be used for PCOS diagnosis within 8 years of the first period. Any ovarian finding here is a recorded observation only.";

export function pcosContext(
  yearOfBirth: number | null | undefined,
  referenceYear: number,
  menarcheYear?: number | null,
): PcosContext {
  const yobUnknown =
    yearOfBirth == null ||
    !Number.isFinite(yearOfBirth) ||
    yearOfBirth > referenceYear ||
    yearOfBirth < referenceYear - 120;
  const approxAge = yobUnknown ? null : referenceYear - (yearOfBirth as number);

  let menarcheProblem: string | null = null;
  if (menarcheYear != null) {
    const check = checkMenarcheYear(menarcheYear, yobUnknown ? null : yearOfBirth, referenceYear);
    if (check.ok) {
      return fromMenarche(gynaecologicalAge(check.year, referenceYear), approxAge);
    }
    menarcheProblem = check.problem;
  }

  const base = fromBirthYear(approxAge);
  if (menarcheProblem) {
    base.menarcheProblem = menarcheProblem;
    base.lines = [`A stored first-period year was not used: ${menarcheProblem}`, ...base.lines];
  }
  return base;
}

function fromMenarche(gyn: GynAge, approxAge: number | null): PcosContext {
  const common = {
    basis: "menarche" as const,
    approxAge,
    gynAge: gyn,
    menarcheProblem: null,
    withholdUltrasoundAsSupport: true,
  };
  const when = `About ${gyn.years} year${gyn.years === 1 ? "" : "s"} since the first period (stored as a year only, so between ${gyn.min} and ${gyn.max}).`;

  if (gyn.max <= ULTRASOUND_GYN_AGE_YEARS) {
    return {
      ...common,
      level: "menarche-under-8",
      headline: "Under 8 years since the first period.",
      lines: [
        when,
        ULTRASOUND_LINE_UNDER,
        "In adolescents the guideline needs both irregular cycles and signs of high androgens. The app does not apply either criterion.",
      ],
    };
  }
  if (gyn.min < ULTRASOUND_GYN_AGE_YEARS) {
    return {
      ...common,
      level: "menarche-boundary-8",
      headline: "Close to 8 years since the first period. The app cannot tell which side.",
      lines: [
        when,
        "The 8-year point falls inside that range. Treat the record as if ultrasound is not recommended for diagnosis until a clinician confirms the date.",
        "Ovarian appearance is shown as a recorded finding only.",
      ],
    };
  }
  return {
    ...common,
    level: "menarche-8-plus",
    headline: "8 or more years since the first period.",
    lines: [
      when,
      "Ovarian appearance is still shown as a recorded finding only. The app does not apply a follicle threshold, convert AMH into a label, or diagnose PCOS.",
    ],
  };
}

function fromBirthYear(approxAge: number | null): PcosContext {
  if (approxAge == null) {
    return {
      level: "age-unknown",
      basis: "none",
      approxAge: null,
      gynAge: null,
      menarcheProblem: null,
      headline: "Age is not recorded, so adolescent status cannot be assessed.",
      lines: [
        "The 2023 guideline applies stricter criteria to adolescents. This record has no usable year of birth, and no first-period year is stored.",
        "Ovarian appearance is shown as a recorded finding only. It is not support for a PCOS label.",
      ],
      withholdUltrasoundAsSupport: true,
    };
  }
  if (approxAge < ADOLESCENT_APP_THRESHOLD_YEARS) {
    return {
      level: "adolescent-possible",
      basis: "birth-year",
      approxAge,
      gynAge: null,
      menarcheProblem: null,
      headline: "Possible adolescent record. Adolescent criteria may apply.",
      lines: [
        "In adolescents the 2023 guideline needs both irregular cycles (ovulatory dysfunction) and signs of high androgens. It does not recommend ovarian ultrasound for diagnosis.",
        `The app flags anyone under ${ADOLESCENT_APP_THRESHOLD_YEARS} by year of birth. That threshold is this app's own conservative choice. The guideline counts time since the first period; record that year to use the guideline's own rule.`,
        "Cycle and lab entries below are shown for a clinician to read. Nothing here applies adolescent or adult criteria.",
      ],
      withholdUltrasoundAsSupport: true,
    };
  }
  return {
    level: "adult-default",
    basis: "birth-year",
    approxAge,
    gynAge: null,
    menarcheProblem: null,
    headline: "Adult record by year of birth.",
    lines: [
      "Ovarian appearance is still shown as a recorded finding only. The app does not apply a follicle threshold, convert AMH into a label, or diagnose PCOS.",
      "No first-period year is stored. The guideline's 8-year ultrasound rule cannot be checked until it is.",
    ],
    withholdUltrasoundAsSupport: true,
  };
}

/* ------------------------------------------------------------------ */
/* Cycle-interval band (display only)                                  */
/* ------------------------------------------------------------------ */

export type CycleBand =
  | { status: "unknown"; reason: string }
  | { status: "transition"; reason: string }
  | { status: "boundary"; reason: string }
  | { status: "band"; lowDays: number; highDays: number; anyCycleOverDays: number; minCyclesPerYear: number | null; label: string };

export function cycleBand(gyn: GynAge | null): CycleBand {
  if (!gyn) return { status: "unknown", reason: "No first-period year is stored, so the guideline's cycle band cannot be chosen." };
  if (gyn.max <= 1) {
    return { status: "transition", reason: "Under a year since the first period. The guideline treats irregular cycles as normal in this time." };
  }
  const straddles = (t: number) => gyn.min < t && gyn.max > t;
  if (straddles(1) || straddles(3)) {
    return { status: "boundary", reason: "The stored year puts this record on a band edge (1 or 3 years since the first period). No band is shown." };
  }
  if (gyn.max <= 3) {
    return { status: "band", lowDays: 21, highDays: 45, anyCycleOverDays: 90, minCyclesPerYear: null, label: "1 to 3 years since first period: under 21 or over 45 days falls outside the guideline range." };
  }
  return { status: "band", lowDays: 21, highDays: 35, anyCycleOverDays: 90, minCyclesPerYear: 8, label: "3 or more years since first period: under 21 or over 35 days, or fewer than 8 cycles a year, falls outside the guideline range." };
}

/** Whether one recorded interval is outside the band. Null when no band applies or the length is missing. */
export function outsideBand(lengthDays: number | null | undefined, band: CycleBand): boolean | null {
  if (band.status !== "band" || lengthDays == null || !Number.isFinite(lengthDays)) return null;
  return lengthDays < band.lowDays || lengthDays > band.highDays || lengthDays > band.anyCycleOverDays;
}
