# Deploying the WhatsApp backend on AKS

Assumes your WAHA Plus is already running in the cluster in namespace `waha`
exposed as Service `waha:3000`, and NGINX Ingress + cert-manager are installed.
Adjust the manifests if your setup differs.

## 1. Build and push the image

```bash
# from repo root
az acr login --name <your-acr>     # or docker login ghcr.io
docker build -t <registry>/waha-claude:0.1.0 .
docker push <registry>/waha-claude:0.1.0
```

Update `image:` in `deployment.yaml` to the tag you just pushed.

## 2. Edit the placeholders

- `configmap.yaml` — set `PUBLIC_BASE_URL` to your public hostname and `WAHA_URL`
  to the in-cluster URL for WAHA.
- `ingress.yaml` — replace `wa.example.com` with your hostname and
  `letsencrypt-prod` with the cluster issuer you have configured.

## 3. Create the namespace + secrets

```bash
kubectl apply -f namespace.yaml

kubectl -n waha-claude create secret generic waha-claude-secrets \
  --from-literal=WAHA_API_KEY='<same key as your WAHA pod>' \
  --from-literal=INVITE_CODE='<random invite code>'
```

If you prefer GitOps, copy `secret.example.yaml` to `secret.yaml`, populate, and
seal it with SealedSecrets or wire it through ExternalSecrets — do NOT commit
plain values.

## 4. Apply

```bash
kubectl apply -f configmap.yaml
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml
kubectl apply -f networkpolicy.yaml   # optional, recommended
```

## 5. Verify

```bash
kubectl -n waha-claude rollout status deploy/waha-claude
curl -fsS https://wa.example.com/healthz   # → {"ok":true}
```

## Notes

- **Single replica.** SQLite + PVC means `replicas: 1`. Swap to Postgres
  (Azure Database for PostgreSQL Flexible Server is fine) and bump replicas
  if you need HA. The schema is in `server/src/db.ts`.
- **Backups.** Snapshot the PVC daily, or just dump `app.db` to blob storage.
  Losing it means every user has to re-signup and re-link WhatsApp.
- **Rate limits.** The deployment sets `SEND_MAX_PER_WINDOW=30` and
  `SEND_WINDOW_SECONDS=60` (per user). Tighten or loosen via ConfigMap.
- **Open signup.** If `INVITE_CODE` is not set, anyone with the hostname can
  create accounts. Keep it set in production.
- **Logs.** `Authorization` and `X-Api-Key` are redacted by the Fastify logger.
  Bind `kubectl logs` to an audit pipeline if you need long-term retention.
