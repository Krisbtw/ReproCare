import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../auth/middleware.ts";
import type {
  reviewAndEditReportExtraction,
  decideExtractedFinding,
  IngestInput,
  QuoteLinkInput,
} from "../reports/store.ts";
import type { recordFibroidPathwayAssessment } from "./workflows.ts";
import type { RegistrationTransformInput } from "../imaging/registration.ts";
import type { ImagingArtifactKind } from "../imaging/storage.ts";
import type { ClinicianVerificationDecision } from "./server.backend.ts";

const VALID_VERIFICATION_DECISIONS = new Set<string>([
  "verified",
  "approved",
  "rejected",
  "suspended",
  "revoked",
]);

const REGIONS = [
  "uterus",
  "left_ovary",
  "right_ovary",
  "cervix",
  "pouch_of_douglas",
  "bladder",
  "bowel",
  "pelvic_peritoneum",
  "other",
];

export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetWorkspace(sql, context.userId);
  });

export const setRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((role: string) => {
    if (role !== "patient" && role !== "clinician" && role !== "admin") throw new Error("Unknown role");
    return role;
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    await b.ensure(sql, context.userId);
    return b.executeSetRole(sql, context.userId, data);
  });

export const promoteUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetUserId: string; newRole: string }) => {
    if (!input || typeof input !== "object") throw new Error("Expected an input object.");
    if (typeof input.targetUserId !== "string" || !input.targetUserId.trim()) {
      throw new Error("Target user ID is required.");
    }
    if (input.newRole !== "patient" && input.newRole !== "clinician" && input.newRole !== "admin") {
      throw new Error("Invalid target role: must be patient, clinician, or admin.");
    }
    return { targetUserId: input.targetUserId.trim(), newRole: input.newRole };
  })
  .handler(async ({ context, data: { targetUserId, newRole } }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executePromoteUser(sql, context.userId, targetUserId, newRole);
  });

export const setActivePatient = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSetActivePatient(sql, context.userId, data);
  });

export const setMenarcheYear = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; menarcheYear: number | null; reason: string }) => {
    if (typeof input.patientId !== "string" || !input.patientId) throw new Error("Record not found.");
    if (input.menarcheYear !== null && (!Number.isInteger(input.menarcheYear) || input.menarcheYear < 1900 || input.menarcheYear > 2200)) {
      throw new Error("Enter the year of the first period as a whole year, or clear it.");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 300);
    if (reason.length < 4) throw new Error("Say where the year came from (for example: patient-reported at visit).");
    return { ...input, reason };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSetMenarcheYear(sql, context.userId, data);
  });

export const addSymptom = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; region: string; intensity: number; cycleDay: number | null; description: string; recordedOn: string }) => {
    if (!REGIONS.includes(input.region)) throw new Error("Choose a listed body region.");
    if (input.intensity < 0 || input.intensity > 10) throw new Error("Intensity is 0 to 10.");
    if (!input.description.trim()) throw new Error("Add a short description.");
    return { ...input, description: input.description.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeAddSymptom(sql, context.userId, data);
  });

export const addCycle = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; startDate: string; lengthDays: number; flow: string; note: string }) => {
    if (!Number.isFinite(input.lengthDays) || input.lengthDays < 1 || input.lengthDays > 120) throw new Error("Cycle length looks invalid.");
    return { ...input, note: input.note.trim().slice(0, 400), flow: input.flow.slice(0, 40) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeAddCycle(sql, context.userId, data);
  });

export const addLab = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; observedOn: string; analyte: string; valueText: string; unit: string; referenceText: string }) => {
    if (!input.analyte.trim() || !input.valueText.trim()) throw new Error("Analyte and value are required.");
    return {
      ...input,
      analyte: input.analyte.trim().slice(0, 80),
      valueText: input.valueText.trim().slice(0, 40),
      unit: input.unit.trim().slice(0, 24),
      referenceText: input.referenceText.trim().slice(0, 80),
    };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeAddLab(sql, context.userId, data);
  });

export const addReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetType: string; targetId: string; status: string; note: string }) => {
    if (!["verified", "rejected", "needs_more_information"].includes(input.status)) throw new Error("Unknown review status.");
    if (!["finding_version", "correspondence", "discrepancy"].includes(input.targetType)) throw new Error("Unknown review target.");
    return { ...input, note: input.note.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeAddReview(sql, context.userId, data);
  });

export const correctVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { versionId: string; axes: [number, number, number]; reason: string }) => {
    if (!Array.isArray(input.axes) || input.axes.length !== 3 || input.axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) {
      throw new Error("Axes must be three positive millimetre values.");
    }
    if (input.reason.trim().length < 8) throw new Error("Say why the measurement changed.");
    return { ...input, reason: input.reason.trim().slice(0, 500) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeCorrectVersion(sql, context.userId, data);
  });

export const saveLabMeasurement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      findingId: string;
      axes: [number, number, number];
      longest: number;
      sliceIndex: number;
      reason: string;
      evidenceNote: string;
      studyId?: string | null;
      seriesId?: string | null;
      centroidMm?: [number, number, number] | null;
      frame?: string | null;
      modelId?: string | null;
      segmentationSource?: string | null;
      segmentationRunId?: string | null;
      volumeMm3?: number | null;
      uncertaintyMm3?: number | null;
      newStudy?: {
        patientId: string;
        modality?: string;
        studyDate?: string;
        description?: string;
        accession?: string;
        sourceNote?: string;
      };
      newSeries?: {
        seriesNumber?: number;
        description?: string;
        plane?: string;
        sliceCount?: number;
        pixelSpacingMm?: string;
        sliceThicknessMm?: number;
      };
    }) => {
      if (!Array.isArray(input.axes) || input.axes.length !== 3 || input.axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) {
        throw new Error("Axes must be three positive millimetre values.");
      }
      if (!Number.isFinite(input.longest) || input.longest <= 0 || input.longest > 300) throw new Error("Longest extent must be 0 to 300 mm.");
      if (!Number.isInteger(input.sliceIndex) || input.sliceIndex < 0 || input.sliceIndex > 5000) throw new Error("Slice index is not valid.");
      if (input.reason.trim().length < 8) throw new Error("Say why the measurement was recorded.");
      return {
        ...input,
        reason: input.reason.trim().slice(0, 500),
        evidenceNote: input.evidenceNote.trim().slice(0, 1500),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSaveLabMeasurement(sql, context.userId, data);
  });

export const decideCorrespondence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { correspondenceId: string; decision: string; note: string }) => {
    if (!["accept", "reject", "defer"].includes(input.decision)) throw new Error("Unknown decision.");
    return { ...input, note: input.note.trim().slice(0, 400) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeDecideCorrespondence(sql, context.userId, data);
  });

export const resolveDiscrepancy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { discrepancyId: string; resolution: string; note: string }) => {
    if (!["acknowledged", "resolved", "dismissed"].includes(input.resolution)) throw new Error("Unknown resolution.");
    return { ...input, note: input.note.trim().slice(0, 400) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeResolveDiscrepancy(sql, context.userId, data);
  });

export const saveDicomMeta = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string | null; fileName: string; transferSyntax: string; metadata: Record<string, string>; warnings: string[] }) => {
    const fileName = input.fileName.slice(0, 180);
    const metadata = Object.fromEntries(Object.entries(input.metadata).slice(0, 40).map(([k, v]) => [k.slice(0, 80), String(v).slice(0, 240)]));
    return { ...input, fileName, metadata, warnings: input.warnings.slice(0, 12).map((w) => w.slice(0, 240)) };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSaveDicomMeta(sql, context.userId, data);
  });

export const exportRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeExportRecord(sql, context.userId, data);
  });

export const resetWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeResetWorkspace(sql, context.userId);
  });

export const uploadReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: IngestInput) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeUploadReport(sql, context.userId, data);
  });

export const linkReportEvidence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: QuoteLinkInput) => {
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end)) throw new Error("Quote offsets are not valid.");
    if (typeof input.quote !== "string" || input.quote.length < 1 || input.quote.length > 1200) throw new Error("Quote length is not valid.");
    return input;
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeLinkReportEvidence(sql, context.userId, data);
  });

export const requestClinicianVerification = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { licenceNo: string; registry: string; evidenceNote: string }) => {
    if (!input || typeof input !== "object") throw new Error("Expected an input object.");
    const licenceNo = String(input.licenceNo ?? "").trim().slice(0, 100);
    const registry = String(input.registry ?? "").trim().slice(0, 100);
    const evidenceNote = String(input.evidenceNote ?? "").trim().slice(0, 1000);
    if (!licenceNo || !registry) throw new Error("Licence number and medical registry are required.");
    return { licenceNo, registry, evidenceNote };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    await b.ensure(sql, context.userId);
    return b.executeRequestClinicianVerification(sql, context.userId, data);
  });

export const verifyClinician = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { verificationId: string; decision: ClinicianVerificationDecision; reason: string }) => {
    if (!input || typeof input !== "object" || !VALID_VERIFICATION_DECISIONS.has(input.decision)) {
      throw new Error("Decision must be verified, approved, rejected, suspended, or revoked.");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new Error("A reason for the decision is required for auditing.");
    return { verificationId: input.verificationId, decision: input.decision, reason };
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeVerifyClinician(sql, context.userId, data);
  });

export const listPendingClinicians = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeListPendingClinicians(sql, context.userId);
  });

export const getVerificationStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetVerificationStatus(sql, context.userId);
  });

export const saveVolumeRegistration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    patientId: string;
    fixedSeriesId: string;
    movingSeriesId: string;
    nccScore: number;
    residualMm: number;
    transformMatrix: RegistrationTransformInput;
    status?: "verified" | "unverified" | "failed";
  }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSaveVolumeRegistration(sql, context.userId, data);
  });

export const saveEndometriosisRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; lesionSites: string[]; surgicalHistory: string; stagingRASRM?: string; imagingNote: string }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSaveEndometriosisRecord(sql, context.userId, data);
  });

export const getEndometriosisRecords = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetEndometriosisRecords(sql, context.userId, patientId);
  });

export const saveOvarianCystRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { patientId: string; laterality: "left" | "right" | "bilateral"; maxDiameterMm: number; featuresText: string; followUpMonths?: number; clinicalNote: string }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSaveOvarianCystRecord(sql, context.userId, data);
  });

export const getOvarianCystRecords = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetOvarianCystRecords(sql, context.userId, patientId);
  });

export const savePcosAssessment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    patientId: string;
    cycleIrregularity: boolean;
    hyperandrogenismClinical: boolean;
    hyperandrogenismBiochemical: boolean;
    ultrasoundOrAmhFeatures: boolean;
    notes: string;
  }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSavePcosAssessment(sql, context.userId, data);
  });

export const getPcosAssessments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetPcosAssessments(sql, context.userId, patientId);
  });

export const uploadImagingArtifact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      patientId: string;
      studyId?: string | null;
      seriesId?: string | null;
      findingVersionId?: string | null;
      sourceObjectId?: string | null;
      sopInstanceUid?: string | null;
      instanceNumber?: number | null;
      kind: ImagingArtifactKind;
      fileName?: string | null;
      mimeType?: string | null;
      dataBase64: string;
      metadata?: Record<string, unknown>;
    }) => {
      if (!input.patientId || typeof input.patientId !== "string") {
        throw new Error("patientId is required.");
      }
      if (!input.dataBase64 || typeof input.dataBase64 !== "string") {
        throw new Error("dataBase64 payload is required.");
      }
      return input;
    },
  )
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeStoreImagingArtifact(sql, context.userId, data);
  });

export const retrieveImagingArtifact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; includeData?: boolean }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetImagingArtifact(
      sql,
      context.userId,
      data.objectId,
      data.includeData ?? true,
    );
  });

export const listPatientImagingArtifacts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      patientId: string;
      studyId?: string;
      seriesId?: string;
      findingVersionId?: string;
      kind?: ImagingArtifactKind;
      includePurged?: boolean;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeListImagingArtifacts(sql, context.userId, data);
  });

export const checkImagingIntegrity = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((objectId: string) => objectId)
  .handler(async ({ context, data: objectId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeVerifyImagingObjectIntegrity(sql, context.userId, objectId);
  });

export const deleteImagingArtifact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { objectId: string; reason: string }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executePurgeImagingArtifact(sql, context.userId, data);
  });

export const getFindingImagingEvidence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((findingVersionId: string) => findingVersionId)
  .handler(async ({ context, data: findingVersionId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetHistoricalFindingImagingEvidence(sql, context.userId, findingVersionId);
  });

export const getLongitudinalComparisonProvenance = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((correspondenceId: string) => correspondenceId)
  .handler(async ({ context, data: correspondenceId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return (await b.executeGetLongitudinalComparisonProvenance(sql, context.userId, correspondenceId)) as any;
  });

export const grantPatientConsent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      patientId: string;
      clinicianUserId: string;
      permissions?: string[] | null;
      scopeNote?: string | null;
      expiresAt?: string | null;
    }) => {
      if (!input || typeof input.patientId !== "string" || !input.patientId.trim()) {
        throw new Error("patientId is required.");
      }
      if (typeof input.clinicianUserId !== "string" || !input.clinicianUserId.trim()) {
        throw new Error("clinicianUserId is required.");
      }
      return input;
    },
  )
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGrantClinicianConsent(sql, context.userId, data);
  });

export const revokePatientConsent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      consentId?: string;
      patientId?: string;
      clinicianUserId?: string;
      reason?: string;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeRevokeClinicianConsent(sql, context.userId, data);
  });

export const getPatientConsents = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeListPatientConsents(sql, context.userId, patientId);
  });

export const getClinicianConsents = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeListClinicianConsents(sql, context.userId);
  });

export const getApprovedClinicians = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeListApprovedClinicians(sql, context.userId);
  });

export const getConsentAccessHistory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetConsentAccessHistory(sql, context.userId, patientId);
  });

export const parseReportDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { fileName: string; dataBase64: string }) => {
    if (!input || !input.fileName || !input.dataBase64) {
      throw new Error("fileName and dataBase64 are required.");
    }
    return input;
  })
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeExtractReportDocument(sql, context.userId, data);
  });

export const interpretClinicalReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { reportId: string; allowExternalDeidentified?: boolean }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeInterpretReportWithLlm(sql, context.userId, data);
  });

export const askClinicalReportQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { reportId: string; question: string }) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeAnswerReportQuestion(sql, context.userId, data);
  });

export const reviewReportExtraction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: Parameters<typeof reviewAndEditReportExtraction>[2]) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeReviewAndEditReportExtraction(sql, context.userId, data);
  });

export const decideReportFinding = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: Parameters<typeof decideExtractedFinding>[2]) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeDecideExtractedFinding(sql, context.userId, data);
  });

export const getOriginalReportDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((reportId: string) => reportId)
  .handler(async ({ context, data: reportId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetOriginalReportDocument(sql, context.userId, reportId);
  });

export const getReportRevisions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((reportId: string) => reportId)
  .handler(async ({ context, data: reportId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetReportRevisions(sql, context.userId, reportId);
  });

export const saveFibroidAssessment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: Parameters<typeof recordFibroidPathwayAssessment>[3]) => input)
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeSaveFibroidAssessment(sql, context.userId, data);
  });

export const getFibroidAssessments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetFibroidAssessments(sql, context.userId, patientId);
  });

export const reviewPathwayRecord = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      patientId: string;
      pathway: "fibroids" | "endometriosis" | "ovarian_cyst" | "pcos";
      recordId: string;
      decision: "clinician_reviewed" | "clinician_confirmed_assessment" | "rejected";
      note: string;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeReviewPathwayRecord(sql, context.userId, data);
  });

export const getUnifiedPatientHistoryServer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((patientId: string) => patientId)
  .handler(async ({ context, data: patientId }) => {
    const b = await import("./server.backend.ts");
    const sql = await b.getSql();
    return b.executeGetUnifiedPatientHistory(sql, context.userId, patientId);
  });
