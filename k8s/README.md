# waha-claude Kubernetes Deploy

Mirrors the cadence-summarizer deploy pattern (AKS `limekit-prod` cluster,
ACR `acrlcpub`, Traefik ingress, cert-manager) but in its own namespace
`waha-claude-prod` so the two products don't share a WAHA Plus instance or
collide on Service / PVC names.

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | `waha-claude-prod` namespace |
| `configmap.yaml` | Non-secret runtime config |
| `secret.example.yaml` | Template for required runtime secrets (keys only, no values) |
| `secret.yaml` | Secret manifest with real values, applied directly (NOT committed) |
| `deployment.yaml` | `waha-claude` Deployment + its `waha-claude-data` PVC (SQLite) |
| `service.yaml` | Service on port `8080` |
| `ingress.yaml` | Traefik ingress for `waha-claude.limechat.ai` |
| `waha.yaml` | WAHA Plus engine (PVC + Deployment + Service), in-cluster only |

## Build

```bash
docker build -f Dockerfile -t acrlcpub.azurecr.io/waha-claude:prod .
az acr login --name acrlcpub
docker push acrlcpub.azurecr.io/waha-claude:prod
```

---

## Full deploy runbook (with WhatsApp / WAHA Plus)

Run from a shell authenticated to the AKS cluster (context `limekit-prod`) and
to ACR. Order matters: namespace → registry pull secret → app secret → WAHA → app.

### Prerequisites
- `kubectl` access to the cluster; ACR push rights (`az acr login --name acrlcpub`)
- **devlikeapro Docker Hub credentials** (the WAHA Plus image is private)
- A populated `k8s/secret.yaml` (real values, delivered out of band — never committed)

### 1. Namespace
```bash
kubectl apply -f k8s/namespace.yaml
```

### 2. Registry pull secret for the private WAHA Plus image
```bash
kubectl -n waha-claude-prod create secret docker-registry waha-plus-pull \
  --docker-server=docker.io \
  --docker-username=<devlikeapro-user> \
  --docker-password=<devlikeapro-token>
```

### 3. Apply the app secret
```bash
kubectl -n waha-claude-prod apply -f k8s/secret.yaml
```
`waha-claude-secrets` must contain:
```
WAHA_API_KEY = <strong random string>
INVITE_CODE  = <strong random string — gates /signup>
```
The WAHA pod reads the same `WAHA_API_KEY` automatically via secretKeyRef
(wired in `waha.yaml`), so don't add a separate entry for it.

### 4. Build & push the app image
```bash
docker build -f Dockerfile -t acrlcpub.azurecr.io/waha-claude:prod .
az acr login --name acrlcpub
docker push acrlcpub.azurecr.io/waha-claude:prod
```

### 5. Deploy WAHA first (so WAHA_URL resolves before the backend starts)
```bash
kubectl -n waha-claude-prod apply -f k8s/waha.yaml
kubectl -n waha-claude-prod rollout status deployment waha
```

### 6. Deploy the app
```bash
kubectl -n waha-claude-prod apply -f k8s/configmap.yaml
kubectl -n waha-claude-prod apply -f k8s/deployment.yaml
kubectl -n waha-claude-prod apply -f k8s/service.yaml
kubectl -n waha-claude-prod apply -f k8s/ingress.yaml
kubectl -n waha-claude-prod rollout restart deployment waha-claude
kubectl -n waha-claude-prod rollout status deployment waha-claude
```

### 7. Verify
```bash
kubectl -n waha-claude-prod get pods -l app=waha-claude
kubectl -n waha-claude-prod get pods -l app=waha

kubectl -n waha-claude-prod exec deploy/waha-claude -- \
  wget -qO- http://localhost:8080/healthz

# WAHA reachable from the app pod
kubectl -n waha-claude-prod exec deploy/waha-claude -- \
  wget -qO- --header="X-Api-Key: <WAHA_API_KEY>" http://waha:3000/api/sessions
```
At `https://waha-claude.limechat.ai/healthz` you should see `{"ok":true}`.

### Gotchas
- **`waha` pod `ImagePullBackOff`** → wrong `waha-plus-pull` creds (step 2).
- **App pod can't reach WAHA** → `WAHA_URL` in `configmap.yaml` doesn't match
  the WAHA Service DNS name. Should be
  `http://waha.waha-claude-prod.svc.cluster.local:3000`.
- **`/mcp` returns 401 for valid token** → backend can't reach SQLite. Check
  the `waha-claude-data` PVC is mounted at `/app/data` and the pod is running
  as the `node` user (UID 1000).
- **`/signup` returns 403** even with the invite code → `INVITE_CODE` in the
  secret is empty or wrong; the gate requires an exact match.

---

## Notes

- WAHA runs as its own service and must **never** be exposed publicly — it is
  ClusterIP-only and has no Ingress. The backend reaches it in-cluster via
  `WAHA_URL`.
- WAHA session auth lives on the `waha-sessions` PVC; deleting that volume
  unpairs every connected user (they must re-scan QR).
- The waha-claude backend's user accounts + send audit log live on the
  `waha-claude-data` PVC; deleting that volume revokes every issued bearer
  token and forces every user to re-signup.
- SQLite on PVC means `replicas: 1`, `strategy: Recreate`. Swap to Azure
  Database for PostgreSQL Flexible Server if you ever need HA — the schema
  in `server/src/db.ts` is tiny (two tables) and easy to port.
