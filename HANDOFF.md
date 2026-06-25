# Infra Deploy Handoff — waha-claude (Claude × WhatsApp via WAHA Plus)

**To:** Infra / DevOps
**Branch:** `main`
**Cluster:** AKS, namespace `waha-claude-prod` (new — please create)
**Registry:** `acrlcpub.azurecr.io`
**App URL:** https://waha-claude.limechat.ai

This deploy stands up a small Node service that lets each user wire their own
Claude (via an MCP connector) to their own WhatsApp account through a private
in-cluster **WAHA Plus** instance. Same shape as the cadence-summarizer deploy
you've done before — same registry, same ingress controller, same WAHA
sidecar pattern — but in its own namespace so the two products don't share
WAHA pods, PVCs, or Service names. Full command sequence is in
[`k8s/README.md`](k8s/README.md); this doc is the access + credentials
checklist for the person running it.

---

## 1. What goes live

- **New namespace:** `waha-claude-prod`.
- **New service:** `waha` Deployment + Service + PVC (`k8s/waha.yaml`) — WAHA
  Plus on the NOWEB engine, ClusterIP-only (no public ingress).
- **App:** `waha-claude` Deployment + PVC (`k8s/deployment.yaml`) — Node
  backend on port 8080. Exposes only `/healthz`, `/signup`, and
  `/mcp` (Streamable HTTP MCP) externally.
- **Public host:** `waha-claude.limechat.ai` via Traefik + cert-manager
  (`le-az-http-certissuer-prod`).
- **SQLite-on-PVC** for users + send audit log. ~50 MB at most, single
  replica, `Recreate` strategy.

---

## 2. Access you must have

- [ ] `kubectl` access to the **AKS** cluster
      (`az aks get-credentials --resource-group <rg> --name <aks-cluster>`)
- [ ] **ACR push** rights on `acrlcpub` (`az acr login --name acrlcpub`)
- [ ] Docker installed on the build machine
- [ ] **WAHA Plus Docker credentials** (private image — see §3)
- [ ] Ability to create namespace `waha-claude-prod` in the cluster, or have
      someone create it for you

---

## 3. Credentials to obtain before starting

### 3a. WAHA Plus Docker login (private image)
WAHA Plus (`devlikeapro/waha-plus`) is a **paid, private image**. The
credentials come from the org's **WAHA Plus subscription at waha.devlike.pro**
(same subscription the cadence-summarizer deploy uses). Get them from the
subscription owner.

```
WAHA_PLUS_DOCKER_USERNAME = devlikeapro
WAHA_PLUS_DOCKER_TOKEN    = <from the subscription owner>
```

Used to create the image pull secret (in this namespace):
```bash
kubectl -n waha-claude-prod create secret docker-registry waha-plus-pull \
  --docker-server=docker.io \
  --docker-username="$WAHA_PLUS_DOCKER_USERNAME" \
  --docker-password="$WAHA_PLUS_DOCKER_TOKEN"
```

### 3b. App secrets
Two values, both `kubectl create`-ed (or applied from a populated
`k8s/secret.yaml` that you keep local and uncommitted):

```
WAHA_API_KEY  = <strong random string, e.g. `openssl rand -hex 32`>
INVITE_CODE   = <strong random string — gates POST /signup>
```

`WAHA_API_KEY` is the single source of truth: WAHA enforces it as
`X-Api-Key` on every request, and the backend sends the same value as that
header. The WAHA pod reads it via `secretKeyRef` (no separate entry needed).

`INVITE_CODE` gates user signup. Without it, anyone with the URL can
provision themselves an account. Give the final value to the requester so
they can hand it to the first batch of users.

---

## 4. Deploy runbook (order matters)

```bash
# 0. Namespace
kubectl apply -f k8s/namespace.yaml

# 1. WAHA Plus pull secret (from §3a)
kubectl -n waha-claude-prod create secret docker-registry waha-plus-pull \
  --docker-server=docker.io \
  --docker-username="$WAHA_PLUS_DOCKER_USERNAME" \
  --docker-password="$WAHA_PLUS_DOCKER_TOKEN"

# 2. App secret (from §3b)
kubectl -n waha-claude-prod create secret generic waha-claude-secrets \
  --from-literal=WAHA_API_KEY="$WAHA_API_KEY" \
  --from-literal=INVITE_CODE="$INVITE_CODE"

# 3. Build & push the app image (from a clean `main` checkout)
docker build -f Dockerfile -t acrlcpub.azurecr.io/waha-claude:prod .
az acr login --name acrlcpub
docker push acrlcpub.azurecr.io/waha-claude:prod

# 4. WAHA first (so WAHA_URL resolves before the app starts)
kubectl -n waha-claude-prod apply -f k8s/waha.yaml
kubectl -n waha-claude-prod rollout status deployment waha

# 5. App
kubectl -n waha-claude-prod apply -f k8s/configmap.yaml
kubectl -n waha-claude-prod apply -f k8s/deployment.yaml
kubectl -n waha-claude-prod apply -f k8s/service.yaml
kubectl -n waha-claude-prod apply -f k8s/ingress.yaml
kubectl -n waha-claude-prod rollout restart deployment waha-claude
kubectl -n waha-claude-prod rollout status deployment waha-claude
```

---

## 5. Verify

```bash
kubectl -n waha-claude-prod get pods -l app=waha-claude
kubectl -n waha-claude-prod get pods -l app=waha

kubectl -n waha-claude-prod exec deploy/waha-claude -- \
  wget -qO- http://localhost:8080/healthz
```

External: `https://waha-claude.limechat.ai/healthz` → `{"ok":true}`.
`https://waha-claude.limechat.ai/signup/required` → `{"invite_code_required":true}`.

Send back the **app URL** and the **INVITE_CODE** to the requester.

---

## 6. Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `waha` pod `ImagePullBackOff` | Wrong/missing WAHA Plus pull secret | Re-check §3a creds + secret name `waha-plus-pull` |
| `waha-claude` pod `CrashLoopBackOff` immediately | Missing/empty `WAHA_API_KEY` or `WAHA_URL` env | Check ConfigMap + Secret are both `kubectl get`-able and pod has both via envFrom |
| `POST /signup` returns 403 with right invite code | `INVITE_CODE` value mismatch | Re-create the secret with the exact string; restart deploy |
| `POST /mcp` returns 401 for valid bearer | SQLite PVC didn't mount or got wiped | Check `kubectl -n waha-claude-prod get pvc waha-claude-data` is `Bound` |
| Inbound TLS doesn't issue | cert-manager issuer name typo | Confirm `le-az-http-certissuer-prod` exists in the cluster (same one cadence-summarizer uses) |

---

## 7. Rollback

```bash
kubectl -n waha-claude-prod rollout undo deployment waha-claude
```

To take the public surface down without removing infra: scale the Deployment to 0.
```bash
kubectl -n waha-claude-prod scale deployment waha-claude --replicas=0
```

---

## 8. Security notes

- **No secrets in git.** `k8s/secret.example.yaml` is the template (tracked).
  `k8s/secret.yaml` (real values) is in `.gitignore` and should be applied
  via `kubectl apply -f` from a local copy, or directly via `kubectl create
  secret` as shown in §4.
- **WAHA stays internal.** No Ingress is defined for the `waha` Service. The
  backend reaches it only via the in-cluster ClusterIP.
- **WAHA_API_KEY rotation** invalidates every paired user's WAHA session
  the next time the pod restarts — they must re-scan their QR. Rotate only
  on schedule.
- **Backend bearer tokens** are stored only as SHA-256 in SQLite. Rotating
  by wiping the `waha-claude-data` PVC also wipes every user's `INVITE_CODE`
  signup and every audit_log row. Snapshot the PVC before any such reset.

---

## 9. Persistence note

Two PVCs, both ReadWriteOnce, both must survive pod restarts:

- `waha-sessions` (in `waha.yaml`) — WAHA Plus session auth. Deleting it
  unpairs every connected user.
- `waha-claude-data` (in `deployment.yaml`) — backend's SQLite. Deleting it
  revokes every issued bearer token and erases every send's audit log.

Snapshot daily if the cluster has a snapshot policy; otherwise schedule a
nightly job that dumps both volumes to blob storage.
