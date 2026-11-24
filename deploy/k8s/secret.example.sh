#!/bin/sh
# Creates the Secret the Deployment reads. Run where kubectl reaches the cluster (cplane).
#  - HSM_PASSWORD_HASH: from `npm run set-password -- --print` (never store the plain password)
#  - GITHUB_TOKEN: fine-grained token with Contents read/write on the two site repos
#  - MC_HOST_minio: MinIO endpoint + access/secret key, e.g. http://ACCESS:SECRET@<minio-svc>.myminio.svc:9000
set -eu
kubectl -n myminio create secret generic hugo-site-manager \
  --from-literal=HSM_PASSWORD_HASH="$HSM_PASSWORD_HASH" \
  --from-literal=HSM_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=GITHUB_TOKEN="$GITHUB_TOKEN" \
  --from-literal=MC_HOST_minio="$MC_HOST_minio" \
  --dry-run=client -o yaml | kubectl apply -f -
