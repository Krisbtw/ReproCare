/**
 * ReproTrace Cross-Examination Matching logic.
 * Computes spatial correspondence and volumetric consistency across longitudinal findings.
 */

export interface FindingCoord {
  x: number;
  y: number;
  z: number;
}

export interface FindingItem {
  id: string;
  anatomicalLabel: string;
  coordinates: FindingCoord;
  volume: number;
  studyUID: string;
  anatomicalFindings?: string[];
}

export interface RegistrationResultTransform {
  transform: {
    translation: FindingCoord;
    rotation?: FindingCoord;
  };
}

export interface MatchResult {
  confidence: "high" | "medium" | "low";
  type: "likely_same" | "potentially_new" | "requires_review";
  spatialDistance: number;
}

/**
 * Calculates Euclidean distance between two 3D anatomical coordinates after applying registration transform.
 */
export function calculateSpatialDistance(
  coord1: FindingCoord,
  coord2: FindingCoord,
  registration?: RegistrationResultTransform | null,
): number {
  const tx = registration?.transform?.translation ?? { x: 0, y: 0, z: 0 };
  const transformedCoord2 = {
    x: coord2.x + tx.x,
    y: coord2.y + tx.y,
    z: coord2.z + tx.z,
  };

  return Math.sqrt(
    Math.pow(coord1.x - transformedCoord2.x, 2) +
    Math.pow(coord1.y - transformedCoord2.y, 2) +
    Math.pow(coord1.z - transformedCoord2.z, 2),
  );
}

/**
 * Evaluates whether two findings from paired studies correspond to the same lesion.
 */
export function matchFindings(
  finding1: FindingItem,
  finding2: FindingItem,
  registration?: RegistrationResultTransform | null,
): MatchResult {
  const spatialDistance = calculateSpatialDistance(
    finding1.coordinates,
    finding2.coordinates,
    registration,
  );

  const labelMatch =
    finding1.anatomicalLabel.toLowerCase().trim() ===
    finding2.anatomicalLabel.toLowerCase().trim();

  const baseVol = Math.max(finding1.volume, 1e-4);
  const volumeDelta = Math.abs(finding1.volume - finding2.volume) / baseVol;

  if (spatialDistance < 10 && labelMatch && volumeDelta < 0.2) {
    return {
      confidence: "high",
      type: "likely_same",
      spatialDistance: Number(spatialDistance.toFixed(2)),
    };
  } else if (spatialDistance < 20 && labelMatch) {
    return {
      confidence: "medium",
      type: "potentially_new",
      spatialDistance: Number(spatialDistance.toFixed(2)),
    };
  } else {
    return {
      confidence: "low",
      type: "requires_review",
      spatialDistance: Number(spatialDistance.toFixed(2)),
    };
  }
}
