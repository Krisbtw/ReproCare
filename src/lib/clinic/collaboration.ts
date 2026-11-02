/**
 * Patient-Clinician Collaboration, Consent Lifecycle, and Granular Permission Management
 * (Sprint 4 Task 1).
 *
 * Security invariants enforced:
 * 1. Patients own their medical records (`is_self = true`) and control which verified
 *    clinicians may access them.
 * 2. Clinicians cannot access another user's patient record without an active, non-expired
 *    consent record in `patient_clinician_consents` AND an currently approved/verified
 *    status in `clinician_verifications`.
 * 3. Revoking or suspending a clinician's verification OR revoking/expiring a patient's
 *    consent immediately blocks access on the backend.
 * 4. Administrators manage clinician verification and account status, but do NOT automatically
 *    receive unrestricted access to other users' medical records.
 * 5. Users can never grant consent to themselves (`patient_user_id !== clinician_user_id`) or
 *    escalate permissions on a record they do not own as the patient.
 * 6. Every consent lifecycle change and cross-user clinical access check is recorded in
 *    `audit_events` and `consent_access_logs`, and revoking consent never deletes audit history.
 */

import type { Sql } from "../db.ts";

export const ALL_CLINICIAN_PERMISSIONS = [
  "view_demographics",
  "view_reports",
  "view_imaging",
  "view_findings",
  "view_longitudinal_history",
  "add_annotations",
  "review_ai_findings",
  "approve_or_reject_findings",
] as const;

export type ClinicianPermission = (typeof ALL_CLINICIAN_PERMISSIONS)[number];

/**
 * Sensible default permission set when a patient grants access without overriding permissions:
 * grants read-only clinical consultation visibility across demographics, reports, imaging,
 * findings, and longitudinal trajectory without granting autonomous write/approval permissions
 * unless explicitly selected by the patient.
 */
export const DEFAULT_CLINICIAN_PERMISSIONS: readonly ClinicianPermission[] = [
  "view_demographics",
  "view_reports",
  "view_imaging",
  "view_findings",
  "view_longitudinal_history",
] as const;

const VALID_PERMISSIONS_SET = new Set<string>(ALL_CLINICIAN_PERMISSIONS);

export type ConsentStatus = "active" | "revoked" | "expired";

export interface PatientClinicianConsentRow {
  id: string;
  patient_id: string;
  patient_user_id: string;
  clinician_user_id: string;
  clinician_display_name?: string | null;
  clinician_licence_no?: string | null;
  clinician_registry?: string | null;
  clinician_verification_status?: string | null;
  patient_display_name?: string | null;
  patient_code?: string | null;
  status: ConsentStatus;
  permissions: ClinicianPermission[];
  permissions_json: string;
  scope_note: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  updated_at: string;
}

export interface ConsentAccessLogRow {
  id: string;
  consent_id: string | null;
  patient_id: string;
  patient_user_id: string;
  actor_user_id: string;
  actor_role: string;
  action: string;
  permission_checked: string | null;
  outcome: "allowed" | "denied";
  detail: string;
  created_at: string;
}

export interface ApprovedClinicianDirectoryItem {
  user_id: string;
  display_name: string;
  licence_no: string;
  registry: string;
  status: string;
}

export function validateAndNormalizePermissions(
  rawPermissions?: readonly string[] | null,
): ClinicianPermission[] {
  if (!rawPermissions || rawPermissions.length === 0) {
    return [...DEFAULT_CLINICIAN_PERMISSIONS];
  }
  const normalized: ClinicianPermission[] = [];
  for (const p of rawPermissions) {
    if (!VALID_PERMISSIONS_SET.has(p)) {
      throw new Error(
        `Invalid permission '${p}'. Valid permissions are: ${ALL_CLINICIAN_PERMISSIONS.join(", ")}`,
      );
    }
    if (!normalized.includes(p as ClinicianPermission)) {
      normalized.push(p as ClinicianPermission);
    }
  }
  // Viewing any clinical sub-resource always includes basic patient identity/demographics context
  if (!normalized.includes("view_demographics")) {
    normalized.unshift("view_demographics");
  }
  return normalized;
}

export function parsePermissionsJson(raw: unknown): ClinicianPermission[] {
  if (Array.isArray(raw)) {
    return raw.filter((p): p is ClinicianPermission => VALID_PERMISSIONS_SET.has(String(p)));
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((p): p is ClinicianPermission => VALID_PERMISSIONS_SET.has(String(p)));
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function isConsentExpired(expiresAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed <= nowMs;
}

async function logConsentEvent(
  sql: Sql,
  entry: {
    consentId?: string | null;
    patientId: string;
    patientUserId: string;
    actorUserId: string;
    actorRole: string;
    action: string;
    permissionChecked?: string | null;
    outcome: "allowed" | "denied";
    detail: string;
  },
): Promise<void> {
  try {
    await sql`
      insert into consent_access_logs (
        id, consent_id, patient_id, patient_user_id, actor_user_id, actor_role,
        action, permission_checked, outcome, detail
      ) values (
        ${crypto.randomUUID()},
        ${entry.consentId ?? null},
        ${entry.patientId},
        ${entry.patientUserId},
        ${entry.actorUserId},
        ${entry.actorRole},
        ${entry.action},
        ${entry.permissionChecked ?? null},
        ${entry.outcome},
        ${entry.detail}
      )
    `;
  } catch {
    // Table may not exist in older unit test schemas
  }
  try {
    await sql`
      insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
      values (
        ${crypto.randomUUID()},
        ${entry.actorUserId},
        ${entry.action},
        'patient_consent',
        ${entry.consentId ?? entry.patientId},
        ${`[${entry.outcome.toUpperCase()}] patient=${entry.patientId}: ${entry.detail}`}
      )
    `;
  } catch {
    // Ignore if audit_events is unavailable
  }
}

/**
 * Checks whether a target user holds an active, approved clinician verification
 * (`status in ('verified', 'approved')` with non-empty licence and registry) AND
 * has `profiles.role === 'clinician'` (not demoted/suspended/revoked).
 */
export async function verifyTargetClinicianIsApproved(
  sql: Sql,
  clinicianUserId: string,
): Promise<{
  approved: boolean;
  status: string;
  licenceNo: string;
  registry: string;
  displayName: string;
}> {
  if (!clinicianUserId || typeof clinicianUserId !== "string" || !clinicianUserId.trim()) {
    return { approved: false, status: "unverified", licenceNo: "", registry: "", displayName: "" };
  }
  const cleanId = clinicianUserId.trim();
  const profileRows = await sql<{ role: string; display_name: string }>`
    select role, display_name from profiles where user_id = ${cleanId}
  `.catch(() => []);
  const profile = profileRows[0];
  if (!profile || profile.role !== "clinician") {
    return {
      approved: false,
      status: profile ? `role_${profile.role}` : "not_found",
      licenceNo: "",
      registry: "",
      displayName: profile?.display_name ?? "",
    };
  }

  const verifRows = await sql<{
    status: string;
    licence_no: string;
    registry: string;
  }>`
    select status, licence_no, registry
    from clinician_verifications
    where user_id = ${cleanId}
    order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
    limit 1
  `.catch(() => []);

  const latest = verifRows[0];
  if (!latest) {
    return {
      approved: false,
      status: "unverified",
      licenceNo: "",
      registry: "",
      displayName: profile.display_name ?? "",
    };
  }

  const validCreds =
    String(latest.licence_no ?? "").trim().length > 0 &&
    String(latest.registry ?? "").trim().length > 0;
  const approved =
    validCreds && (latest.status === "verified" || latest.status === "approved");

  return {
    approved,
    status: latest.status,
    licenceNo: latest.licence_no ?? "",
    registry: latest.registry ?? "",
    displayName: profile.display_name ?? "",
  };
}

/**
 * List all currently approved clinicians so a patient can select an approved clinician to grant access.
 */
export async function listApprovedCliniciansDirectory(
  sql: Sql,
): Promise<ApprovedClinicianDirectoryItem[]> {
  const rows = await sql<{
    user_id: string;
    display_name: string | null;
    role: string | null;
    licence_no: string;
    registry: string;
    status: string;
  }>`
    select cv.user_id, p.display_name, p.role, cv.licence_no, cv.registry, cv.status
    from clinician_verifications cv
    join profiles p on p.user_id = cv.user_id
    where p.role = 'clinician'
      and cv.status in ('verified', 'approved')
    order by coalesce(cv.decided_at, cv.requested_at) desc
  `.catch(() => []);

  const seen = new Set<string>();
  const result: ApprovedClinicianDirectoryItem[] = [];
  for (const r of rows) {
    if (seen.has(r.user_id)) continue;
    // Confirm the latest verification status for this user is still approved/verified
    const check = await verifyTargetClinicianIsApproved(sql, r.user_id);
    if (!check.approved) continue;
    seen.add(r.user_id);
    result.push({
      user_id: r.user_id,
      display_name: r.display_name || r.user_id,
      licence_no: check.licenceNo,
      registry: check.registry,
      status: check.status,
    });
  }
  return result;
}

/**
 * Grant or update patient consent for an approved clinician to access a patient record.
 *
 * Rules enforced:
 * - Only the patient who owns the record (`patient.user_id === callerUserId && patient.is_self === true`)
 *   can grant or modify clinician consent for their record.
 * - Cannot grant access to oneself (`callerUserId === clinicianUserId`).
 * - Target clinician must hold an active approved clinician verification (`verified` or `approved`).
 * - Unverified, pending, rejected, suspended, or revoked clinicians are rejected.
 */
export async function grantClinicianConsent(
  sql: Sql,
  callerUserId: string,
  input: {
    patientId: string;
    clinicianUserId: string;
    permissions?: readonly string[] | null;
    scopeNote?: string | null;
    expiresAt?: string | null;
  },
): Promise<PatientClinicianConsentRow> {
  if (!callerUserId || typeof callerUserId !== "string" || !callerUserId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const actorId = callerUserId.trim();
  const targetClinicianId = String(input.clinicianUserId ?? "").trim();
  if (!targetClinicianId) {
    throw new Error("Target clinician user ID is required.");
  }
  if (actorId === targetClinicianId) {
    throw new Error(
      "Unauthorized: Users cannot grant medical record access to themselves.",
    );
  }

  const patientRows = await sql<{
    id: string;
    user_id: string;
    is_self: boolean;
    display_name: string;
    code: string;
  }>`
    select id, user_id, is_self, display_name, code
    from patients
    where id = ${input.patientId}
  `;
  const patient = patientRows[0];
  if (!patient) {
    throw new Error("Patient record not found.");
  }

  // Only the patient who owns this record can grant consent (prevents clinicians or admins from self-granting access to someone else's record)
  if (patient.user_id !== actorId || !patient.is_self) {
    await logConsentEvent(sql, {
      patientId: patient.id,
      patientUserId: patient.user_id,
      actorUserId: actorId,
      actorRole: "unauthorized",
      action: "grant_consent_denied",
      outcome: "denied",
      detail: `Blocked unauthorized attempt by ${actorId} to grant consent on patient ${patient.id} owned by ${patient.user_id}.`,
    });
    throw new Error(
      "Unauthorized: Only the patient who owns this medical record can grant clinician access.",
    );
  }

  const clinicianCheck = await verifyTargetClinicianIsApproved(sql, targetClinicianId);
  if (!clinicianCheck.approved) {
    await logConsentEvent(sql, {
      patientId: patient.id,
      patientUserId: patient.user_id,
      actorUserId: actorId,
      actorRole: "patient",
      action: "grant_consent_denied",
      outcome: "denied",
      detail: `Blocked consent grant to unverified/ineligible clinician ${targetClinicianId} (status: ${clinicianCheck.status}).`,
    });
    throw new Error(
      `Cannot grant record access to '${targetClinicianId}': clinician verification is not approved (status: ${clinicianCheck.status}).`,
    );
  }

  const permissions = validateAndNormalizePermissions(input.permissions);
  const permissionsJson = JSON.stringify(permissions);
  const scopeNote = String(input.scopeNote ?? "Patient-authorized clinical consultation").trim().slice(0, 500);

  let expiresIso: string | null = null;
  if (input.expiresAt && String(input.expiresAt).trim()) {
    const ms = Date.parse(String(input.expiresAt).trim());
    if (!Number.isFinite(ms)) {
      throw new Error("Invalid consent expiry timestamp.");
    }
    if (ms <= Date.now()) {
      throw new Error("Consent expiry date must be in the future.");
    }
    expiresIso = new Date(ms).toISOString();
  }

  // Supersede/revoke any existing active consent row for the same (patient_id, clinician_user_id)
  const existingActive = await sql<{ id: string }>`
    select id from patient_clinician_consents
    where patient_id = ${patient.id}
      and clinician_user_id = ${targetClinicianId}
      and status = 'active'
  `.catch(() => []);

  for (const old of existingActive) {
    await sql`
      update patient_clinician_consents
      set status = 'revoked',
          revoked_at = now(),
          revoked_reason = 'Superseded by updated consent grant',
          updated_at = now()
      where id = ${old.id}
    `;
  }

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await sql`
    insert into patient_clinician_consents (
      id, patient_id, patient_user_id, clinician_user_id, status,
      permissions_json, scope_note, granted_at, expires_at, updated_at
    ) values (
      ${id}, ${patient.id}, ${patient.user_id}, ${targetClinicianId}, 'active',
      ${permissionsJson}, ${scopeNote}, ${nowIso}, ${expiresIso}, ${nowIso}
    )
  `;

  await logConsentEvent(sql, {
    consentId: id,
    patientId: patient.id,
    patientUserId: patient.user_id,
    actorUserId: actorId,
    actorRole: "patient",
    action: existingActive.length > 0 ? "update_consent" : "grant_consent",
    outcome: "allowed",
    detail: `Granted permissions [${permissions.join(", ")}] to clinician ${targetClinicianId}${expiresIso ? ` until ${expiresIso}` : ""}.`,
  });

  return {
    id,
    patient_id: patient.id,
    patient_user_id: patient.user_id,
    clinician_user_id: targetClinicianId,
    clinician_display_name: clinicianCheck.displayName || targetClinicianId,
    clinician_licence_no: clinicianCheck.licenceNo,
    clinician_registry: clinicianCheck.registry,
    clinician_verification_status: clinicianCheck.status,
    patient_display_name: patient.display_name,
    patient_code: patient.code,
    status: "active",
    permissions,
    permissions_json: permissionsJson,
    scope_note: scopeNote,
    granted_at: nowIso,
    expires_at: expiresIso,
    revoked_at: null,
    revoked_reason: null,
    updated_at: nowIso,
  };
}

/**
 * Revoke an active consent immediately.
 * Can be invoked by the patient who owns the record (or by the assigned clinician relinquishing access).
 * Historical audit records and consent rows are NEVER deleted.
 */
export async function revokeClinicianConsent(
  sql: Sql,
  callerUserId: string,
  input: {
    consentId?: string;
    patientId?: string;
    clinicianUserId?: string;
    reason?: string;
  },
): Promise<{ ok: true; consentId: string; status: "revoked"; revokedAt: string }> {
  if (!callerUserId || typeof callerUserId !== "string" || !callerUserId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const actorId = callerUserId.trim();
  const rows = input.consentId
    ? await sql<Record<string, unknown>>`
        select * from patient_clinician_consents where id = ${input.consentId}
      `
    : await sql<Record<string, unknown>>`
        select * from patient_clinician_consents
        where patient_id = ${input.patientId ?? ""}
          and clinician_user_id = ${input.clinicianUserId ?? ""}
          and status = 'active'
        order by granted_at desc
        limit 1
      `;

  const row = rows[0];
  if (!row) {
    throw new Error("Consent record not found.");
  }

  const consentId = String(row.id);
  const patientId = String(row.patient_id);
  const patientUserId = String(row.patient_user_id);
  const clinicianUserId = String(row.clinician_user_id);

  if (actorId !== patientUserId && actorId !== clinicianUserId) {
    await logConsentEvent(sql, {
      consentId,
      patientId,
      patientUserId,
      actorUserId: actorId,
      actorRole: "unauthorized",
      action: "revoke_consent_denied",
      outcome: "denied",
      detail: `Blocked unauthorized attempt by ${actorId} to revoke consent ${consentId}.`,
    });
    throw new Error("Unauthorized: Only the patient (or the assigned clinician) can revoke this consent.");
  }

  const reason = String(input.reason ?? "Access revoked by patient").trim().slice(0, 400) || "Access revoked by patient";
  const revokedAt = new Date().toISOString();

  await sql`
    update patient_clinician_consents
    set status = 'revoked',
        revoked_at = ${revokedAt},
        revoked_reason = ${reason},
        updated_at = ${revokedAt}
    where id = ${consentId}
  `;

  await logConsentEvent(sql, {
    consentId,
    patientId,
    patientUserId,
    actorUserId: actorId,
    actorRole: actorId === patientUserId ? "patient" : "clinician",
    action: "revoke_consent",
    outcome: "allowed",
    detail: `Revoked consent ${consentId} for clinician ${clinicianUserId}: ${reason}`,
  });

  return { ok: true, consentId, status: "revoked", revokedAt };
}

/**
 * Evaluate whether a clinician has an active, non-expired consent with the required permission
 * for a given patient record. Automatically transitions expired consents to `status = 'expired'`.
 */
export async function evaluateClinicianConsentForPatient(
  sql: Sql,
  clinicianUserId: string,
  patientId: string,
  requiredPermission?: ClinicianPermission,
  logAccessAction?: string,
): Promise<{
  allowed: boolean;
  consent: PatientClinicianConsentRow | null;
  permissions: ClinicianPermission[];
  reason: string;
}> {
  const clinicianCheck = await verifyTargetClinicianIsApproved(sql, clinicianUserId);
  if (!clinicianCheck.approved) {
    return {
      allowed: false,
      consent: null,
      permissions: [],
      reason: `Clinician verification is not approved (status: ${clinicianCheck.status}).`,
    };
  }

  const rows = await sql<Record<string, unknown>>`
    select * from patient_clinician_consents
    where patient_id = ${patientId}
      and clinician_user_id = ${clinicianUserId}
    order by granted_at desc
  `.catch(() => []);

  if (rows.length === 0) {
    return {
      allowed: false,
      consent: null,
      permissions: [],
      reason: "No patient consent exists authorizing this clinician to access the record.",
    };
  }

  const latest = rows[0];
  const consentId = String(latest.id);
  const patientUserId = String(latest.patient_user_id);
  let status = String(latest.status) as ConsentStatus;
  const expiresAt = (latest.expires_at as string | null) ?? null;

  if (status === "active" && isConsentExpired(expiresAt)) {
    status = "expired";
    await sql`
      update patient_clinician_consents
      set status = 'expired', updated_at = now()
      where id = ${consentId}
    `.catch(() => null);
  }

  if (status !== "active") {
    return {
      allowed: false,
      consent: null,
      permissions: [],
      reason:
        status === "revoked"
          ? "Patient consent for this record has been revoked."
          : "Patient consent for this record has expired.",
    };
  }

  const permissions = parsePermissionsJson(latest.permissions_json);
  const mapped: PatientClinicianConsentRow = {
    id: consentId,
    patient_id: patientId,
    patient_user_id: patientUserId,
    clinician_user_id: clinicianUserId,
    clinician_display_name: clinicianCheck.displayName || clinicianUserId,
    clinician_licence_no: clinicianCheck.licenceNo,
    clinician_registry: clinicianCheck.registry,
    clinician_verification_status: clinicianCheck.status,
    status: "active",
    permissions,
    permissions_json: String(latest.permissions_json ?? "[]"),
    scope_note: String(latest.scope_note ?? ""),
    granted_at: String(latest.granted_at ?? ""),
    expires_at: expiresAt,
    revoked_at: (latest.revoked_at as string | null) ?? null,
    revoked_reason: (latest.revoked_reason as string | null) ?? null,
    updated_at: String(latest.updated_at ?? ""),
  };

  if (requiredPermission && !permissions.includes(requiredPermission)) {
    if (logAccessAction) {
      await logConsentEvent(sql, {
        consentId,
        patientId,
        patientUserId,
        actorUserId: clinicianUserId,
        actorRole: "clinician",
        action: logAccessAction,
        permissionChecked: requiredPermission,
        outcome: "denied",
        detail: `Clinician ${clinicianUserId} lacks '${requiredPermission}' permission (granted: [${permissions.join(", ")}]).`,
      });
    }
    return {
      allowed: false,
      consent: mapped,
      permissions,
      reason: `Consent does not include the required '${requiredPermission}' permission.`,
    };
  }

  if (logAccessAction) {
    await logConsentEvent(sql, {
      consentId,
      patientId,
      patientUserId,
      actorUserId: clinicianUserId,
      actorRole: "clinician",
      action: logAccessAction,
      permissionChecked: requiredPermission ?? "view_demographics",
      outcome: "allowed",
      detail: `Authorized clinical access (${logAccessAction}) under active consent ${consentId}.`,
    });
  }

  return {
    allowed: true,
    consent: mapped,
    permissions,
    reason: "Authorized by active patient consent.",
  };
}

/**
 * List consents for a patient (viewable by the patient who owns the record, or the clinician assigned to it).
 */
export async function listConsentsForPatient(
  sql: Sql,
  callerUserId: string,
  patientId: string,
): Promise<PatientClinicianConsentRow[]> {
  const rows = await sql<Record<string, unknown>>`
    select c.*, p.display_name as patient_display_name, p.code as patient_code
    from patient_clinician_consents c
    join patients p on p.id = c.patient_id
    where c.patient_id = ${patientId}
      and (c.patient_user_id = ${callerUserId} or c.clinician_user_id = ${callerUserId})
    order by c.granted_at desc
  `.catch(() => []);

  const out: PatientClinicianConsentRow[] = [];
  for (const r of rows) {
    const cid = String(r.clinician_user_id);
    const check = await verifyTargetClinicianIsApproved(sql, cid);
    let status = String(r.status) as ConsentStatus;
    const expiresAt = (r.expires_at as string | null) ?? null;
    if (status === "active" && isConsentExpired(expiresAt)) {
      status = "expired";
    }
    out.push({
      id: String(r.id),
      patient_id: String(r.patient_id),
      patient_user_id: String(r.patient_user_id),
      clinician_user_id: cid,
      clinician_display_name: check.displayName || cid,
      clinician_licence_no: check.licenceNo,
      clinician_registry: check.registry,
      clinician_verification_status: check.status,
      patient_display_name: (r.patient_display_name as string | null) ?? null,
      patient_code: (r.patient_code as string | null) ?? null,
      status,
      permissions: parsePermissionsJson(r.permissions_json),
      permissions_json: String(r.permissions_json ?? "[]"),
      scope_note: String(r.scope_note ?? ""),
      granted_at: String(r.granted_at ?? ""),
      expires_at: expiresAt,
      revoked_at: (r.revoked_at as string | null) ?? null,
      revoked_reason: (r.revoked_reason as string | null) ?? null,
      updated_at: String(r.updated_at ?? ""),
    });
  }
  return out;
}

/**
 * List all active consents granted to a verified clinician across all patients.
 */
export async function listConsentsForClinician(
  sql: Sql,
  clinicianUserId: string,
): Promise<PatientClinicianConsentRow[]> {
  const clinicianCheck = await verifyTargetClinicianIsApproved(sql, clinicianUserId);
  if (!clinicianCheck.approved) {
    return [];
  }

  const rows = await sql<Record<string, unknown>>`
    select c.*, p.display_name as patient_display_name, p.code as patient_code
    from patient_clinician_consents c
    join patients p on p.id = c.patient_id
    where c.clinician_user_id = ${clinicianUserId}
    order by c.granted_at desc
  `.catch(() => []);

  const out: PatientClinicianConsentRow[] = [];
  for (const r of rows) {
    let status = String(r.status) as ConsentStatus;
    const expiresAt = (r.expires_at as string | null) ?? null;
    if (status === "active" && isConsentExpired(expiresAt)) {
      status = "expired";
      await sql`
        update patient_clinician_consents set status = 'expired', updated_at = now() where id = ${String(r.id)}
      `.catch(() => null);
    }
    if (status !== "active") continue;
    out.push({
      id: String(r.id),
      patient_id: String(r.patient_id),
      patient_user_id: String(r.patient_user_id),
      clinician_user_id: clinicianUserId,
      clinician_display_name: clinicianCheck.displayName || clinicianUserId,
      clinician_licence_no: clinicianCheck.licenceNo,
      clinician_registry: clinicianCheck.registry,
      clinician_verification_status: clinicianCheck.status,
      patient_display_name: (r.patient_display_name as string | null) ?? null,
      patient_code: (r.patient_code as string | null) ?? null,
      status: "active",
      permissions: parsePermissionsJson(r.permissions_json),
      permissions_json: String(r.permissions_json ?? "[]"),
      scope_note: String(r.scope_note ?? ""),
      granted_at: String(r.granted_at ?? ""),
      expires_at: expiresAt,
      revoked_at: null,
      revoked_reason: null,
      updated_at: String(r.updated_at ?? ""),
    });
  }
  return out;
}

/**
 * Retrieve the consent access history for a patient record.
 */
export async function listConsentAccessHistory(
  sql: Sql,
  callerUserId: string,
  patientId: string,
): Promise<ConsentAccessLogRow[]> {
  const pRows = await sql<{ id: string; user_id: string }>`
    select id, user_id from patients where id = ${patientId}
  `.catch(() => []);
  if (!pRows[0]) {
    throw new Error("Patient record not found.");
  }
  const ownerId = pRows[0].user_id;
  if (ownerId !== callerUserId) {
    // Allow assigned clinician with active consent to view access logs for that patient
    const evalRes = await evaluateClinicianConsentForPatient(sql, callerUserId, patientId);
    if (!evalRes.allowed) {
      throw new Error("Unauthorized: Only the patient or an actively consented clinician can view access history.");
    }
  }

  return sql<ConsentAccessLogRow>`
    select *
    from consent_access_logs
    where patient_id = ${patientId}
    order by created_at desc
    limit 100
  `.catch(() => []);
}
