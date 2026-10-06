# Environment for converting production's v1 data into prod (www.underlay.org), or
# repairing it (edge-redesign-build.md, "Deployment targets"). Source it from the repo root:
#
#   . packages/migrate/scripts/prod-env.sh
#
# Secrets are decrypted from .env.prod-v2.enc and .env.prod.enc (SOPS) into this
# shell's environment only; nothing is written to disk. The v1 source is production's
# Postgres, read over SSH (src/ssh-psql.ts), and v1's file bucket.

_ul_dotenv() { sops -d --input-type dotenv --output-type dotenv "$1" | grep -E "^($2)="; }
eval "$(_ul_dotenv .env.prod-v2.enc 'SIGNING_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY' | sed 's/^/export /')"
eval "$(_ul_dotenv .env.prod.enc 'S3_ACCESS_KEY|S3_SECRET_KEY' | sed 's/^S3_/export V1_S3_/')"
unset -f _ul_dotenv

_ul_r2=https://b66a542ad5e0af992703a2ce8d1d8747.r2.cloudflarestorage.com
# Target: prod's bucket. Source: v1's file bucket (shared by v1 dev and prod; read only).
export S3_ENDPOINT=$_ul_r2 S3_BUCKET=underlay-prod
export S3_ACCESS_KEY=$R2_ACCESS_KEY_ID S3_SECRET_KEY=$R2_SECRET_ACCESS_KEY
export V1_S3_ENDPOINT=$_ul_r2 V1_S3_BUCKET=underlay-assets
unset _ul_r2
# Production's Postgres. The same box runs underlay-dev_postgres and underlay-mirror_postgres:
# ssh-psql refuses any container whose name doesn't start with "$V1_CONTAINER.".
export V1_SSH="-i $HOME/.ssh/kf_internal -o BatchMode=yes -o ServerAliveInterval=30 deploy@62.238.23.177"
export V1_CONTAINER=underlay-prod_postgres
