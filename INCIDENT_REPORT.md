# ReproCare Incident Response & Post-Mortem Template

## Incident Overview
- **Incident ID**: INC-YYYYMMDD-01
- **Severity**: Critical / High / Medium / Low
- **Date & Time (UTC)**:
- **Incident Commander / Lead**:
- **Services Affected**: Web Application / Imaging Service / PostgreSQL / Background Workers

## Timeline of Events
- **HH:MM UTC**: Anomaly detected via monitoring alert / user report.
- **HH:MM UTC**: Incident response initiated; triage started.
- **HH:MM UTC**: Root cause identified.
- **HH:MM UTC**: Mitigation applied (e.g., rollback via `kubectl rollout undo deployment/reprocare-imaging` or service restart).
- **HH:MM UTC**: Health check verified; full recovery confirmed.

## Root Cause Analysis
- **Description**: Detailed explanation of why the failure occurred.
- **Trigger**: The specific condition, payload, or change that surfaced the issue.
- **Contributing Factors**: Secondary factors (e.g., missing validation, resource limit, timeout).

## Impact Assessment
- **Users Impacted**:
- **Data Integrity**: Verified whether any patient records, anatomical findings, or evidence links were compromised.
- **System Availability**: Duration of downtime or elevated error rates.

## Preventive & Corrective Actions
- [ ] Add regression test covering the triggering condition.
- [ ] Update monitoring thresholds or alert rules in `monitoring/alert.rules`.
- [ ] Refine validation or error boundaries.
- [ ] Documentation updated in `DEVELOPMENT_CHECKLIST.md`.

