# PantryPilot

[![codecov](https://codecov.io/gh/codexblack/PantryPilot/graph/badge.svg)](https://codecov.io/gh/codexblack/PantryPilot)
[![CI](https://github.com/codexblack/PantryPilot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/codexblack/PantryPilot/actions/workflows/ci.yml)
[![Cloud Run deploy](https://github.com/codexblack/PantryPilot/actions/workflows/deploy-cloud-run.yml/badge.svg?branch=main)](https://github.com/codexblack/PantryPilot/actions/workflows/deploy-cloud-run.yml)

PantryPilot is a mobile kitchen inventory and recipe planning application. Users can scan a kitchen with one short video or up to four photos, correct the detected inventory, choose a cuisine and dietary restrictions, and generate a practical main dish. When ingredients are missing, the API can return nearby Google Shopping offers.

The repository contains an Expo and React Native mobile app, a FastAPI API, a hardened container image, and Cloud Run deployment automation.

## Features

- Video and photo inventory recognition with editable quantities and use-soon status
- Manual inventory entry without a scan
- Cuisine, taste profile, dietary, gluten-free, and oven controls
- Recipe steps, prep and cooking time, calories, dietary marks, and missing ingredients
- Lazy dish preview generation that does not block recipe generation
- Local saved recipes, notes, dates, and preview images
- Up to two Google Shopping options per missing ingredient, preferring one merchant first
- Nearby store lookup independent from recipe generation
- Abortable mobile requests and bounded provider, upload, and media-processing timeouts

## Architecture

```text
Expo mobile application
  |-- Firebase App Check attestation
  |-- HTTPS scan, recipe, image, and store requests with an attestation token
  |-- Device location, with user permission
  `-- AsyncStorage for saved recipes and preview images
             |
             v
Cloud Run default HTTPS endpoint
  |-- Verifies Firebase App Check tokens and registered application IDs
             |
             v
FastAPI container
  |-- OpenAI vision, recipe planning, and dish preview generation
  |-- SerpAPI Google Shopping offers
  `-- Google Places fallback
             |
             v
Google Secret Manager
```

The API is stateless. It does not persist recipes, photos, videos, or generated previews. Source media is written only to temporary storage while a request is processed and is deleted immediately afterward. The mobile client owns saved recipes and successful preview images.

## Repository layout

```text
.
|-- .github/workflows/
|   |-- ci.yml                       Validation, tests, image scan, and container smoke test
|   |-- deploy-cloud-run.yml         Production API deployment
|   `-- build-android-apk.yml        On-demand EAS preview APK build
|-- backend/
|   |-- app/                         FastAPI application and service integrations
|   |-- tests/                       API and domain tests
|   |-- Dockerfile                   Production API image
|   |-- requirements.txt             Runtime dependencies
|   `-- requirements.lock            Transitive dependency constraints
|-- cloudrun/config.env              Non-secret production runtime configuration
|-- mobile/
|   |-- assets/                      Application icons and splash assets
|   |-- src/                         API client, components, storage, and shared types
|   |-- App.tsx                      Mobile application entry point
|   |-- app.json                     Expo application configuration
|   `-- eas.json                     EAS build and submission profiles
`-- docker-compose.yml               Local API container
```

## Requirements

- Python 3.12 or newer
- Node.js 22 and npm
- Docker with Docker Compose for container-based local development
- Expo Go, an Android emulator, or an iOS Simulator for local mobile development
- Google Cloud CLI and a Google Cloud project with billing enabled for deployment
- An OpenAI API key for real recognition, planning, and dish previews
- A SerpAPI key for Google Shopping offers
- A Google Maps key with Places API (New) enabled for the location-only fallback

Building iOS locally requires macOS and Xcode. EAS Build can create signed Android and iOS binaries without local native toolchains.

## Install Node.js and npm

npm is bundled with Node.js and should not be installed separately. PantryPilot requires Node.js 22.

- **Windows and macOS:** Install the current Node.js 22 LTS release from [nodejs.org](https://nodejs.org/).
- **Linux or version-managed environments:** Install Node.js 22 using the platform package manager or a version manager such as [nvm](https://github.com/nvm-sh/nvm).

Confirm the installation:

```bash
node --version
npm --version
```

On Windows systems where PowerShell blocks `npm.ps1`, run `npm.cmd` instead of changing the execution policy.

## Local development

### API with a Python virtual environment

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
python -m pip install --requirement requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

On Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --requirement requirements-dev.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Set `OPENAI_API_KEY` in `backend/.env` to exercise real provider calls. Without it, the API returns deterministic demo data. The local API documentation is at `http://localhost:8000/docs` and the health endpoint is `http://localhost:8000/health`.

### API with Docker Compose

```bash
cp backend/.env.example backend/.env
docker compose up --build
```

The API listens on port 8000. No database, cache, or media store is required.

### Mobile application

```bash
cd mobile
cp .env.example .env
npm ci
npm start
```

Set `EXPO_PUBLIC_API_URL` to an address the runtime can reach:

| Runtime          | Value                           |
| ---------------- | ------------------------------- |
| Physical device  | `http://<computer-lan-ip>:8000` |
| Android emulator | `http://10.0.2.2:8000`          |
| iOS Simulator    | `http://localhost:8000`         |

Restart Expo after changing a mobile `.env` value.

## Configuration

Pydantic reads API settings from the process environment and from `backend/.env` during local development. Empty optional credentials disable their integration.

| Variable                       | Default                | Description                                                          |
| ------------------------------ | ---------------------- | -------------------------------------------------------------------- |
| `OPENAI_API_KEY`               | Empty                  | Server-side credential for recognition, planning, and dish previews. |
| `OPENAI_MODEL`                 | `gpt-5.6`              | Model used for recognition and recipe planning.                      |
| `OPENAI_TIMEOUT_SECONDS`       | `300`                  | Overall OpenAI request timeout.                                      |
| `MAX_UPLOAD_MB`                | `28`                   | Combined photo payload or video upload limit.                        |
| `MAX_IMAGE_UPLOAD_MB`          | `7`                    | Per-photo upload limit.                                              |
| `MAX_IMAGES`                   | `4`                    | Maximum photos accepted in one scan.                                 |
| `MAX_VIDEO_SECONDS`            | `35`                   | Maximum accepted video duration.                                     |
| `MAX_FRAMES`                   | `8`                    | Maximum video frames sent for recognition.                           |
| `SERPAPI_API_KEY`              | Empty                  | SerpAPI credential used for Google Shopping offers.                  |
| `GOOGLE_MAPS_API_KEY`          | Empty                  | Google Places credential for location-only fallback results.         |
| `RECIPE_IMAGE_MODEL`           | `gpt-image-2`          | Dish preview model.                                                  |
| `RECIPE_IMAGE_SIZE`            | `816x816`              | Generated image source size.                                         |
| `RECIPE_IMAGE_TIMEOUT_SECONDS` | `35`                   | Maximum dish preview generation time.                                |
| `CORS_ALLOWED_ORIGINS`         | Local Expo web origins | Comma-separated browser origins. Native clients do not use CORS.     |
| `ALLOWED_HOSTS`                | `*`                    | Comma-separated HTTP Host allowlist.                                 |
| `APP_CHECK_ENFORCED`           | `false`                | Requires a valid Firebase App Check token for every API route except `/health`. |
| `APP_CHECK_PROJECT_ID`         | Empty                  | Firebase project ID used to verify App Check tokens.                 |
| `APP_CHECK_ALLOWED_APP_IDS`    | Empty                  | Comma-separated Firebase Android and iOS App IDs permitted to call the API. |

Cloud Run accepts at most 32 MiB for HTTP/1 requests. The production limits of 28 MB total and 7 MB per image leave room for multipart overhead while supporting four photos. Larger uploads require a direct-to-Cloud-Storage upload design rather than a higher API setting. [Cloud Run quotas](https://docs.cloud.google.com/run/quotas)

`EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_CHECK_ENABLED` are the mobile production settings. Both are public build configuration and must never contain credentials.

### Mobile app attestation

Production native builds use Firebase App Check. Android uses Play Integrity and iOS uses App Attest. The app obtains an App Check token and sends it in `X-Firebase-AppCheck`; Cloud Run verifies the token and only accepts the two registered PantryPilot Firebase App IDs.

The Firebase Android and iOS configuration files are excluded from version control. Store their base64-encoded contents as `FIREBASE_ANDROID_CONFIG` and `FIREBASE_IOS_CONFIG` in the GitHub `production` environment. The release workflow writes the decrypted files to EAS secret file variables, and the dynamic Expo config supplies those paths only on EAS build workers.

Before setting `APP_CHECK_ENFORCED=true`, complete these provider registrations and verify a real release build:

1. Register the SHA-256 fingerprint of the EAS Android signing certificate and the Google Play App Signing certificate in the Firebase Android app.
2. Set the Apple Developer Team ID for the Firebase iOS app and enable the App Attest capability for the Apple bundle ID.
3. Test an Android closed-testing build and an iOS TestFlight build, then enable enforcement in `cloudrun/config.env` and deploy Cloud Run.

Keep enforcement disabled for local development and Expo Go. Expo Go cannot load native App Check modules.

## HTTP API

| Method | Path                | Purpose                                                   |
| ------ | ------------------- | --------------------------------------------------------- |
| `GET`  | `/health`           | Service health check.                                     |
| `POST` | `/v1/scan`          | Accepts one `video` part or one to four `images` parts.   |
| `POST` | `/v1/plan`          | Generates a recipe from inventory and preferences.        |
| `POST` | `/v1/stores`        | Resolves nearby offers without generating another recipe. |
| `POST` | `/v1/recipe-images` | Lazily generates a dish preview.                          |

The generated `/openapi.json` document is the authoritative request and response contract.

When App Check enforcement is enabled, protected requests without a valid token receive `401`; tokens issued to another Firebase app receive `403`.

## Quality checks

Backend:

```bash
cd backend
python -m ruff check app tests
python -m ruff format --check app tests
python -m pytest --quiet
python -m pip check
```

Mobile:

```bash
cd mobile
npm run lint
npm run format:check
npm run typecheck
npm run doctor
npm audit --omit=dev --audit-level=high
```

GitHub Actions runs the same checks, validates the non-secret Cloud Run configuration, scans the container for fixable high and critical vulnerabilities, and smoke-tests `/health` in the hardened container.

## Backend container

```bash
docker build --file backend/Dockerfile --tag pantrypilot-api:local .

docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=1g \
  --env-file backend/.env --publish 8000:8000 \
  pantrypilot-api:local
```

The image runs as an unprivileged user, uses temporary writable storage only, and writes logs to standard output.

## Deploy to Cloud Run

Cloud Run supplies a managed, permanent HTTPS `run.app` endpoint. No domain, load balancer, Kubernetes cluster, TLS certificate, or static IP is required.

The production profile is intentionally cost constrained:

- Request-based billing with CPU allocated only during requests
- Zero minimum instances, so idle traffic-free periods do not retain a warm API instance
- One concurrent request per instance to prevent parallel video decoding and provider calls from competing for memory
- One vCPU and 1 GiB memory for predictable media processing
- Three maximum instances to bound infrastructure and upstream-provider spend
- Startup CPU boost disabled to avoid paying for additional cold-start CPU

This is a launch profile. It trades occasional cold starts for low idle cost. Raise the minimum instance count only after measured latency warrants it. Cloud Run explicitly recommends beginning with a maximum of three instances as a cost safeguard. [Cloud Run maximum instances](https://docs.cloud.google.com/run/docs/configuring/max-instances), [request-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)

### Bootstrap the Google Cloud project

Run the following from Cloud Shell or a terminal authenticated with `gcloud`. Keep the Artifact Registry repository and Cloud Run service in the same region to avoid unnecessary network cost.

```bash
export PROJECT_ID=YOUR_PROJECT_ID
export REGION=us-central1
export REPOSITORY=pantrypilot
export SERVICE=pantrypilot-api
export RUNTIME_SA=pantrypilot-api@${PROJECT_ID}.iam.gserviceaccount.com

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com

gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="PantryPilot API images"

gcloud iam service-accounts create pantrypilot-api \
  --display-name="PantryPilot Cloud Run runtime"
```

Create the three Secret Manager secrets. Each command reads the secret from standard input; paste the value, then press `Ctrl+D` in Cloud Shell. Never add these values to a committed file.

```bash
for secret in pantrypilot-openai-api-key pantrypilot-serpapi-api-key pantrypilot-google-maps-api-key; do
  gcloud secrets create "$secret" --replication-policy=automatic
done

gcloud secrets versions add pantrypilot-openai-api-key --data-file=-
gcloud secrets versions add pantrypilot-serpapi-api-key --data-file=-
gcloud secrets versions add pantrypilot-google-maps-api-key --data-file=-

for secret in pantrypilot-openai-api-key pantrypilot-serpapi-api-key pantrypilot-google-maps-api-key; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

Build the image and deploy the initial service:

```bash
export IMAGE_URI=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/pantrypilot-api:initial

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker buildx build --platform linux/amd64 --push \
  --file backend/Dockerfile \
  --tag "$IMAGE_URI" \
  .

gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE_URI" \
  --service-account="$RUNTIME_SA" \
  --env-vars-file=cloudrun/config.env \
  --set-secrets=OPENAI_API_KEY=pantrypilot-openai-api-key:latest,SERPAPI_API_KEY=pantrypilot-serpapi-api-key:latest,GOOGLE_MAPS_API_KEY=pantrypilot-google-maps-api-key:latest \
  --port=8000 \
  --ingress=all \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=1 \
  --timeout=360 \
  --cpu-throttling \
  --no-cpu-boost

export API_URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --format='value(status.url)')

curl --fail "$API_URL/health"
echo "$API_URL"
```

Cloud Run prints and retains the generated HTTPS URL across new revisions. Store that URL in the EAS preview and production environments:

```bash
cd mobile
npx eas-cli@latest env:create \
  --name EXPO_PUBLIC_API_URL \
  --value "$API_URL" \
  --environment preview \
  --visibility plaintext

npx eas-cli@latest env:create \
  --name EXPO_PUBLIC_API_URL \
  --value "$API_URL" \
  --environment production \
  --visibility plaintext
```

### GitHub Actions deployment

`deploy-cloud-run.yml` deploys only after the `CI` workflow succeeds on `main`, or when manually dispatched. It uses Workload Identity Federation rather than a long-lived Google Cloud key. `build-android-apk.yml` is manual so ordinary backend changes do not consume EAS build capacity.

Create a GitHub Environment named `production`, then configure these variables:

| Variable                            | Value                                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| `GCP_PROJECT_ID`                    | Google Cloud project ID                                       |
| `GCP_REGION`                        | Cloud Run and Artifact Registry region, such as `us-central1` |
| `ARTIFACT_REGISTRY_REPOSITORY`      | `pantrypilot`                                                 |
| `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT` | `pantrypilot-api@PROJECT_ID.iam.gserviceaccount.com`          |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`    | Full Workload Identity Provider resource name                 |
| `GCP_DEPLOY_SERVICE_ACCOUNT`        | GitHub deployment service-account email                       |

Add `EXPO_TOKEN` as a `production` environment secret. Create it from the [Expo access-token page](https://expo.dev/settings/access-tokens). It authenticates EAS builds and must not be committed or shared in chat.

Create the GitHub deployment identity and grant only the permissions it needs:

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPOSITORY=YOUR_GITHUB_REPOSITORY
export DEPLOY_SA=pantrypilot-github-deployer@${PROJECT_ID}.iam.gserviceaccount.com

gcloud iam service-accounts create pantrypilot-github-deployer \
  --display-name="PantryPilot GitHub deployer"

for role in roles/artifactregistry.writer roles/run.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="$role"
done

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser"

gcloud iam workload-identity-pools create github \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global \
  --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='${GITHUB_OWNER}/${GITHUB_REPOSITORY}' && assertion.ref=='refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPOSITORY}"
```

Use the output of the following command for `GCP_WORKLOAD_IDENTITY_PROVIDER`:

```bash
gcloud iam workload-identity-pools providers describe github \
  --location=global \
  --workload-identity-pool=github \
  --format='value(name)'
```

Workload Identity Federation uses short-lived GitHub OIDC credentials and should be restricted to the intended repository and branch. [Google Cloud guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)

## Android and iOS releases

The `preview` EAS profile creates a directly installable Android APK. The `production` profile creates store artifacts.

`Build Mobile Release` is the GitHub Actions workflow for the production Android and iOS builds. It uses the `EXPO_TOKEN`, `FIREBASE_ANDROID_CONFIG`, and `FIREBASE_IOS_CONFIG` secrets from the `production` environment. EAS stores the decrypted mobile configuration as `GOOGLE_SERVICES_JSON` and `GOOGLE_SERVICE_INFO_PLIST` secret file variables.

```bash
cd mobile
npx eas-cli@latest login
npx eas-cli@latest build:configure

# Installable tester APK
npx eas-cli@latest build --platform android --profile preview

# Store artifacts
npx eas-cli@latest build --platform android --profile production
npx eas-cli@latest build --platform ios --profile production
```

Submit completed store artifacts only after closed testing or TestFlight validation:

```bash
npx eas-cli@latest submit --platform android --profile production
npx eas-cli@latest submit --platform ios --profile production
```

## Troubleshooting

| Symptom                                    | Checks                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile app cannot reach the production API | Verify `EXPO_PUBLIC_API_URL` points to the generated `https://...run.app` service URL, then rebuild the APK.                                  |
| `413` during a scan                        | Keep videos and all selected photos within the 28 MB Cloud Run limit. Larger media needs direct Cloud Storage uploads.                        |
| Cloud Run deployment cannot read a secret  | Confirm the runtime service account has `roles/secretmanager.secretAccessor` on each Secret Manager secret.                                   |
| Deployment workflow authentication fails   | Verify `id-token: write`, the Workload Identity Provider resource name, the service-account binding, repository, and `main` branch condition. |
| Google Shopping returns no priced matches  | Confirm `SERPAPI_API_KEY` is present in Secret Manager, location permission is granted, and inspect Cloud Run logs.                           |
| A dish preview is absent                   | Preview generation is lazy and bounded by `RECIPE_IMAGE_TIMEOUT_SECONDS`; retry after checking the OpenAI key and Cloud Run logs.             |
| Every protected request returns `401`      | Confirm the app was rebuilt with App Check enabled, the Android or iOS provider registration is complete, and Cloud Run has `APP_CHECK_ENFORCED=true`. |

## Security and operations

- Keep provider, signing, and store credentials in Secret Manager or GitHub Environment secrets. Never place them in mobile code or a public environment variable.
- The Cloud Run URL is public for native reachability, but protected API routes require a Firebase App Check token from a registered PantryPilot app when enforcement is enabled. App Check is app attestation, not user authentication; add user authentication before introducing user accounts or shared server-side data.
- Set Cloud Billing budgets and alerts before enabling production traffic. The three-instance cap limits a burst but does not replace application-level abuse protection.
- Monitor Cloud Run request count, latency, instance count, error rate, and OpenAI and SerpAPI usage. Set log retention deliberately to control logging costs.
- Rotate Secret Manager versions, deploy a new revision, and disable prior secret versions after verifying production.
- Treat location, pantry media, and inventory data as sensitive. The API does not retain uploads, but operational logs and client data must still follow the applicable retention and deletion policy.

## Contributing

Keep changes focused, preserve public API compatibility unless a versioned migration is included, and add tests for behavior changes. Do not commit `.env` files, credentials, signing material, captured media, or generated Google authentication files. Update configuration templates, deployment workflow, and this README when runtime behavior changes.
