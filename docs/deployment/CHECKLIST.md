# ReproCare Production Deployment Checklist

## Pre-Deployment
- [x] All code changes reviewed and merged to main branch
- [x] Automated test suite passing (203+ tests across 18+ suites)
- [x] TypeScript typechecking passed with 0 errors
- [x] Docker image configurations verified (`Dockerfile`, `imaging-service/Dockerfile`)
- [x] Database migrations verified (0001 through 0006)
- [x] Disaster recovery scripts prepared (`scripts/backup.sh`, `scripts/restore.sh`)

## Deployment
- [ ] Deploy multi-container stack with `docker-compose.prod.yml` or Kubernetes (`k8s/deployment.yaml`)
- [ ] Verify health endpoints (`/health` HTTP 200)
- [ ] Confirm PostgreSQL container health and connection pooling
- [ ] Check HTTP security headers (`nosniff`, `DENY`, `HSTS`)
- [ ] Ensure `ANATOMYBRIDGE_SERVICE_API_KEY` is loaded server-side only

## Post-Deployment
- [ ] Run automated verification: `./scripts/verify_deployment.sh`
- [ ] Confirm Prometheus metrics scraping (`monitoring/prometheus.yml`)
- [ ] Verify Grafana dashboard import (`monitoring/grafana-dashboard.json`)
- [ ] Perform smoke test on Volume Lab and Report Ingestion workflows
- [ ] Validate patient-isolated access boundaries and RBAC enforcement
