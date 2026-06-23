# Deploy handoff — for the platform team

Hi. This is a small Node service that needs to run in the same AKS cluster as our existing **WAHA Plus** deployment, because it talks to WAHA over the private VNet. It is a **single replica, single small pod, one PVC**. End users reach it over HTTPS at a hostname you choose.

There is **no second backing service** — just this one Deployment + the existing WAHA you already manage.

You should be able to do this in ~10 minutes.

---

## What it is

- **Image:** `$CI_REGISTRY_IMAGE:<tag>` — built by GitLab CI ([.gitlab-ci.yml](.gitlab-ci.yml)) and pushed to **GitLab Container Registry**. The exact path looks like `registry.gitlab.com/<group>/<repo>:<tag>` on gitlab.com, or `<your-gitlab-host>/<group>/<repo>:<tag>` self-hosted. If the project is private, the cluster needs to pull with a deploy token — see *Pulling from a private GitLab registry* below. If GitLab CI is blocked or you'd rather build yourself: `docker build -t <your-registry>/waha-claude:0.1.0 .` against this repo's root.
- **Listens on:** `:8080` HTTP.
- **Exposed routes:** `/healthz`, `/signup`, `/signup/required`, `/mcp` (+ a static signup page). No admin/debug surface.
- **Calls outbound to:** WAHA Plus only. URL configured via `WAHA_URL`.
- **Persists:** ~1MB of SQLite (per-user tokens + send audit log) at `/app/data`. Needs an RWO PVC. Losing it means users have to re-link WhatsApp; not catastrophic.

## What I need from you

| Item | Why |
|---|---|
| In-cluster URL for WAHA (e.g. `http://waha.waha.svc.cluster.local:3000`) | The backend talks to it. |
| The WAHA `X-Api-Key` (the same one your WAHA Deployment uses) | Same reason. |
| A hostname to publish on, with TLS (e.g. `waha-claude.internal.yourteam.com`) | End users hit it from their browser once (to sign up) and from Claude (MCP). |
| Confirm your StorageClass name (or accept default) | For the SQLite PVC. ~2 GiB is plenty. |
| Confirm your IngressClass name (`nginx`?) and ClusterIssuer (`letsencrypt-prod`?) | We use cert-manager annotations in `k8s/ingress.yaml` — adjust to match yours. |

If you can't expose it on the public internet but Claude.ai needs to reach it: it needs **any** public HTTPS URL (Cloudflare Tunnel, internal ingress with split-horizon DNS + public route, whatever your team does for SaaS callbacks). It does not need to be on a corporate domain.

## What you give back

- The final `PUBLIC_BASE_URL` (the HTTPS hostname). I'll put it in the signup page so users can copy the MCP URL into Claude.

---

## Pulling from a private GitLab registry

Skip this section if the project is public.

1. In the GitLab project: **Settings → Repository → Deploy tokens** → create a token with the `read_registry` scope. Note the username and token value.
2. Create an imagePullSecret in the cluster namespace:

   ```bash
   kubectl -n waha-claude create secret docker-registry gitlab-pull \
     --docker-server="$CI_REGISTRY_HOST" \
     --docker-username="<deploy-token-username>" \
     --docker-password="<deploy-token-value>"
   ```

   `$CI_REGISTRY_HOST` is `registry.gitlab.com` for gitlab.com or your self-hosted host.
3. The Deployment already references `imagePullSecrets: [{name: gitlab-pull}]` (see `k8s/deployment.yaml`), so once the secret exists the rollout will pull successfully.

## Steps

```bash
git clone <this repo>
cd waha-claude

# 1. Namespace
kubectl apply -f k8s/namespace.yaml

# 2. Edit configmap.yaml: set PUBLIC_BASE_URL and WAHA_URL to real values.
kubectl apply -f k8s/configmap.yaml

# 3. Create the secret (use real values; do NOT commit them).
kubectl -n waha-claude create secret generic waha-claude-secrets \
  --from-literal=WAHA_API_KEY='<the existing WAHA X-Api-Key>' \
  --from-literal=INVITE_CODE='<a random string — gates signup>'

# 4. PVC. If your default StorageClass is fine, apply as-is. Otherwise uncomment
#    storageClassName in the file and set it.
kubectl apply -f k8s/pvc.yaml

# 5. Edit deployment.yaml: set `image:` to the GitLab Container Registry tag
#    (e.g. registry.gitlab.com/<group>/<repo>:<sha>) or your internal registry.
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# 6. Edit ingress.yaml: set host, ingressClassName, and the cert-manager
#    cluster-issuer annotation to match your cluster.
kubectl apply -f k8s/ingress.yaml

# 7. Optional: tighten egress/ingress with NetworkPolicy. Adjust the namespace
#    labels in this file to match your ingress controller and WAHA namespace.
kubectl apply -f k8s/networkpolicy.yaml
```

## Verify

```bash
kubectl -n waha-claude rollout status deploy/waha-claude
curl -fsS https://<PUBLIC_BASE_URL>/healthz       # → {"ok":true}
curl -fsS https://<PUBLIC_BASE_URL>/signup/required
# → {"invite_code_required":true}
```

That's it. Send back the public URL + the `INVITE_CODE` so I can hand them to users.

---

## Operational notes

- **Single replica.** SQLite on PVC means `replicas: 1`, `strategy: Recreate`. Don't scale horizontally without migrating to Postgres.
- **Resources.** Request 100m / 192Mi, limit 1000m / 512Mi. Stable footprint at near-zero load; spikes only when a user calls a tool.
- **Health probes.** `/healthz` is cheap (~1ms). Default 5s/20s should be fine.
- **Logs.** Standard pino JSON to stdout. `Authorization` and `X-Api-Key` are redacted.
- **No outbound internet required** other than WAHA. The image pulls run at install time; the runtime itself doesn't call out. You can put it behind a strict egress policy.
- **Backups.** Snapshot the PVC or dump `/app/data/app.db` to blob nightly. Restoring it brings every user back without re-signup.
- **Updating.** Bump `image:` tag and `kubectl rollout restart deploy/waha-claude`. Schema migrations are idempotent on startup.

## Security boundary I'm relying on you for

- The WAHA `X-Api-Key` never leaves this Deployment's pod. It's mounted only as an env var from the Secret, never returned in any HTTP response, never logged. Treat the Secret as sensitive.
- Per-user bearer tokens are stored in the SQLite DB **as SHA-256 only**, not plaintext. PVC compromise reveals hashes but not live tokens.
- The Ingress is the only path in. If you put this behind a corporate auth proxy, that's fine and additive — just make sure `Authorization: Bearer ...` headers pass through to the pod unmodified (Claude's MCP client puts the user's token there).

## Questions

Ping me (the requester) for any of the per-user behavior or product-side stuff. For the cluster mechanics above, everything you need is in this repo.
