# AWS Setup — What's Deployed and Why

A plain-English record of the AWS side of Easy Drop-In, for someone new to AWS.
It covers what was created, how the app runs in the cloud, how deployments work,
and where to read more.

If you only read one section, read **The 30-second version** and **Architecture**.

---

## The 30-second version

- The website is a static React app (GitHub Pages). It talks to a small API.
- That API is a **Lambda function** (just a Node.js script AWS runs for you),
  exposed over **API Gateway**, and it caches its data in an **S3** file.
- All of it is described in one file (`backend/template.yaml`) and deployed with
  **AWS SAM**, which wraps **CloudFormation** (AWS's "infrastructure as code"
  service).
- Deployments run automatically from **GitHub Actions**. GitHub proves its
  identity to AWS with **OIDC**, so no long-lived AWS passwords are stored in the
  repo.
- Estimated cost: within the AWS free tier for normal personal use.

---

## AWS services this project uses

| Service | What it is (plain English) | Role here |
|---------|----------------------------|-----------|
| **IAM** | AWS's identity/permissions system ("who may do what") | Holds the CI deploy role and the Lambda's execution role |
| **OIDC provider** | A trust relationship that lets an outside identity provider (GitHub) request temporary AWS credentials | Lets GitHub Actions assume the deploy role without stored keys |
| **Lambda** | Run a function on demand; no server to manage | Runs `backend/index.mjs` to proxy the ActiveNet data |
| **API Gateway (HTTP API)** | A managed front door that maps URLs to a backend | Exposes `GET /events`, `GET /spots`; handles CORS |
| **S3** | Object storage (files in "buckets") | Stores the cached feed JSON; also stores SAM deploy artifacts |
| **CloudFormation** | Infrastructure as code: describe resources, AWS creates/updates them | The "engine" underneath SAM that actually builds the stack |
| **SAM** | A friendlier layer on top of CloudFormation for serverless apps | Builds and deploys the backend from `template.yaml` |
| **CloudWatch Logs** | Collects logs from AWS services | Where the Lambda's `console.log`/errors show up |
| **GitHub Actions** | CI/CD that runs in GitHub | Builds and ships both frontend and backend |

---

## Architecture

```
                         GitHub repository (akim-ruslanov/easy-drop-in)
                         │
      push to main ──────┤
                         │
        ┌────────────────┴─────────────────┐
        │                                  │
  .github/workflows/                 .github/workflows/
  deploy.yml (frontend)              deploy-backend.yml (backend)
        │                                  │
        │ build Vite site                  │ OIDC: GitHub -> IAM role
        ▼                                  ▼
   GitHub Pages                    AWS CloudFormation stack
   (static files)                  "easy-drop-in-backend"
        │                                  │
        │                                  ├── Lambda: easy-drop-in-backend-EventsFunction-…
        ▼                                  ├── API Gateway HTTP API: easy-drop-in-backend
   Browser  ─── HTTPS (CORS) ──────────────┤   GET /events   → Lambda
                                           ├── S3: …-feedcachebucket-…  (feed.json cache)
                                           └── IAM execution role (Lambda's permissions)
```

Data flow at runtime: the browser calls `GET /events`; the Lambda either returns
a cached feed or fetches the ActiveNet calendars, merges them, caches the result
in S3, and returns JSON. The browser then calls `GET /spots` for the events on
screen.

---

## Part 1 — One-time bootstrap (the "who may deploy" setup)

Run once by a human with admin AWS access:

```bash
./bootstrap/setup-oidc-role.sh
```

It reads the account id automatically (`aws sts get-caller-identity`) and then:

### 1. GitHub OIDC provider
- **Resource:** `arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`
- **Why:** Instead of storing an AWS access key in GitHub, GitHub presents a
  short-lived signed token. AWS verifies it against this provider and hands back
  temporary credentials. Nothing long-lived to leak or rotate.

### 2. Deploy role `easy-drop-in-deploy`
- **Trust policy:** only a token for this repo's `main` branch may assume it.
  GitHub has two subject (`sub`) formats, and the policy allows both:
  - classic: `repo:akim-ruslanov/easy-drop-in:ref:refs/heads/main`
  - immutable: `repo:akim-ruslanov@<owner-id>/easy-drop-in@<repo-id>:ref:refs/heads/main`

  Repositories created after **2026-07-15** (this one is 2026-09-14) or that opt
  in to immutable subject claims use the second form. Matching only the classic
  form causes `Not authorized to perform sts:AssumeRoleWithWebIdentity`.
- **Why:** This is the identity the GitHub Actions job uses.
- **Permissions:** managed policies for the services SAM touches
  (`AWSCloudFormationFullAccess`, `AWSLambda_FullAccess`,
  `AmazonAPIGatewayAdministrator`, `AmazonS3FullAccess`) plus a scoped inline
  policy (`easy-drop-in-deploy-iam`) that may only manage IAM roles named
  `easy-drop-in-backend-*` and pass them to Lambda.
  - The managed policies are broad for convenience; the inline one is least
    privilege. Tighten the managed ones later if you want.

### 3. GitHub secret
Set the role ARN as a repository secret so the workflow knows what to assume:

```
AWS_ROLE_ARN = arn:aws:iam::<ACCOUNT_ID>:role/easy-drop-in-deploy
```

Add it under **Settings → Secrets and variables → Actions**, or:

```bash
gh secret set AWS_ROLE_ARN --body "arn:aws:iam::<ACCOUNT_ID>:role/easy-drop-in-deploy"
```

The bootstrap files are templates (`__ACCOUNT_ID__` etc.) so no account id is
committed; the script substitutes values into a temporary directory at run time.

---

## Part 2 — The deploy job (`.github/workflows/deploy-backend.yml`)

- **Triggers:** push to `main` that touches `backend/**` (or the workflow file),
  plus a manual **Run workflow** button.
- **Auth:** `permissions: id-token: write` lets the job request an OIDC token;
  `aws-actions/configure-aws-credentials` exchanges it for temporary credentials
  for `AWS_ROLE_ARN`. `contents: read` is all it needs from the repo.
- **Steps:** checkout → configure AWS credentials → install SAM → `sam build`
  → `sam deploy` (with `--resolve-s3 --capabilities CAPABILITY_IAM
  --no-confirm-changeset --no-fail-on-empty-changeset`).
- **Concurrency:** `group: deploy-backend` prevents two deploys racing.

The manual equivalent (requires your own AWS credentials, e.g. the admin user):

```bash
cd backend
sam build
sam deploy --guided     # first time; writes samconfig.toml (gitignored)
```

---

## Part 3 — What SAM creates (`backend/template.yaml`)

Deploying the stack `easy-drop-in-backend` created:

| Resource | Actual name (current deploy) | Notes |
|----------|------------------------------|-------|
| CloudFormation stack | `easy-drop-in-backend` | Groups everything below |
| Lambda function | `easy-drop-in-backend-EventsFunction-z1Dwf6fQhcVL` | `nodejs20.x`, 512 MB, 60 s timeout |
| API Gateway HTTP API | `easy-drop-in-backend` (`zxwih3in2j`) | Routes `GET /events`, `GET /spots`, `POST|GET /watch`, `DELETE /watch/{id}` |
| Feed cache bucket | `easy-drop-in-backend-feedcachebucket-nsrwwu14g4y2` | Holds `feed.json` (30-min cache) |
| Registration watches table | `easy-drop-in-backend-WatchesTable-…` | DynamoDB, on-demand, TTL on `expiresAt` |
| Scheduler role | `easy-drop-in-backend-WatchSchedulerRole-…` | Assumed by EventBridge Scheduler to invoke the Lambda |
| SAM artifacts bucket | `aws-sam-cli-managed-default-samclisourcebucket-xkyjwehlf7kk` | Where `sam deploy` uploads code zips |
| Lambda execution role | `easy-drop-in-backend-EventsFunctionRole-oRN082ecyCbJ` | Lambda's own permissions (S3, DynamoDB, Scheduler, PassRole, logs) |

- **API base URL:** `https://zxwih3in2j.execute-api.us-west-2.amazonaws.com`
  (the stack output `ApiUrl` appends `/events`).
- **Frontend secret:** `VITE_API_URL` should be the **base** URL above (no
  `/events`), because `frontend/src/api.js` appends the path.
- **Environment variables on the Lambda:** `SPORTS_CALENDARS`, `CACHE_BUCKET`,
  `CACHE_KEY`, `FEED_TTL_MS`, `WATCHES_TABLE`, `SCHEDULER_ROLE_ARN`,
  `NOTIFY_KIND`, `NOTIFY_WEBHOOK_URL`, `NOTIFY_TELEGRAM_CHAT_ID`.
- Bucket names are auto-generated and include a random suffix; don't hardcode
  them outside the stack. The Lambda gets the cache bucket name injected via
  `!Ref FeedCacheBucket`.

### Registration alerts

`POST /watch` writes a DynamoDB item and creates an EventBridge Scheduler
one-time schedule at the registration-open time (interpreted in
`America/Vancouver`, stored as UTC). At that instant Scheduler invokes the same
Lambda with `{ job: "watch", watchId }`, which posts a webhook message and marks
the item notified. `GET /watch` lists subscriptions; `DELETE /watch/{id}`
removes the record and its schedule.

Configure the destination with `NOTIFY_KIND` and `NOTIFY_WEBHOOK_URL` (the URL
is a secret, so keep it in the function env, not in git):

```bash
aws lambda update-function-configuration --function-name <function-name> \
  --environment "Variables={...,NOTIFY_KIND=ntfy,NOTIFY_WEBHOOK_URL=https://ntfy.sh/<topic>}"
```

- `ntfy` — `NOTIFY_WEBHOOK_URL` = `https://ntfy.sh/<topic>`
- `discord` — the channel webhook URL
- `telegram` — `https://api.telegram.org/bot<token>/sendMessage` plus `NOTIFY_TELEGRAM_CHAT_ID`
- `generic` — any URL accepting `{ title, text }`

---

## Your environment (facts)

| Item | Value |
|------|-------|
| AWS account | `557690618523` (kept as `<ACCOUNT_ID>` in committed files) |
| Region | `us-west-2` (Oregon) |
| Stack name | `easy-drop-in-backend` |
| Deploy role | `easy-drop-in-deploy` |
| GitHub repo | `akim-ruslanov/easy-drop-in` |
| Frontend workflow | `.github/workflows/deploy.yml` (GitHub Pages) |
| Backend workflow | `.github/workflows/deploy-backend.yml` (SAM → AWS) |

---

## Cost

This design targets the AWS Free Tier:

- **Lambda:** 1M requests + 400,000 GB-s per month (always free). A page load is
  2 requests.
- **S3:** 5 GB storage, 20,000 GET, 2,000 PUT per month for the first 12 months.
  The cache is one tiny object: ~1 GET per cold start, ~1 PUT per 30 minutes.
- **API Gateway HTTP API:** 1M requests/month free for 12 months.
- **DynamoDB (registration watches):** 25 GB storage + 25 WCU/RCU always free; a
  handful of items and requests.
- **EventBridge Scheduler:** 14M invocations/month free; one per watch.
- **Webhook (ntfy/Telegram/Discord):** free.
- **CloudFormation, IAM, OIDC:** no charge.
- **CloudWatch Logs:** small charges can apply for stored logs; set a retention
  period if you want to be strict.

After the first year, S3/API Gateway move to pay-as-you-go, but this usage is
pennies. Watch it in the **Billing and Cost Management** console and set a
budget alert.

---

## Day-2 operations

**View logs (most useful debugging tool):**
```bash
aws logs tail /aws/lambda/easy-drop-in-backend-EventsFunction-z1Dwf6fQhcVL --follow
# or via SAM
sam logs -n EventsFunction --stack-name easy-drop-in-backend --tail
```

**List what the stack built:**
```bash
aws cloudformation describe-stack-resources --stack-name easy-drop-in-backend \
  --query 'StackResources[].{Type:ResourceType,Id:LogicalResourceId,Status:ResourceStatus}' --output table
```

**Change configuration** (e.g. which calendars): edit `backend/template.yaml`,
commit to `main`, and the workflow redeploys. `SPORTS_CALENDARS` lives there.

**Delete everything:**
```bash
sam delete --stack-name easy-drop-in-backend
```
Then, if you want to fully undo the bootstrap: detach/delete the
`easy-drop-in-deploy` role and the OIDC provider, and delete the two S3 buckets
(empty them first).

**Check what a workflow will do before merging:** open a PR; the workflow only
runs on `main` and manual dispatch, so you can review `template.yaml` diffs.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Workflow: "Not authorized to perform sts:AssumeRoleWithWebIdentity" | Trust policy `sub` doesn't match the token. For repos created after 2026-07-15, GitHub issues immutable subjects (`repo:owner@id/repo@id:ref:refs/heads/main`); the policy includes both that and the classic form. Re-run `bootstrap/setup-oidc-role.sh`. Also check the `AWS_ROLE_ARN` secret. |
| Workflow: "The policy failed legacy parsing" | A policy document has an unsubstituted placeholder like `<ACCOUNT_ID>`; re-run `bootstrap/setup-oidc-role.sh` |
| `sam deploy` hangs on "confirm changeset" | In CI it passes `--no-confirm-changeset`; locally answer the prompt or add `--no-confirm-changeset` |
| API returns 502 | Lambda error; check CloudWatch Logs |
| Frontend loads but no data | `VITE_API_URL` secret/project mismatch, or a CORS issue |
| Stale data | Cache TTLs: feed `FEED_TTL_MS` (30 min), spots ~5 min |

---

## Glossary

- **Region** — a physical AWS location (`us-west-2` = Oregon). Resources live in
  one region.
- **IAM** — Identity and Access Management; users, roles, and policies.
- **Role** — an identity that can be assumed temporarily (by CI, or by a Lambda).
- **Policy** — a JSON document listing allowed/denied actions on resources.
- **ARN** — Amazon Resource Name; a unique id like
  `arn:aws:iam::123456789012:role/name`.
- **OIDC / OIDC provider** — OpenID Connect; here it's how GitHub's identity is
  trusted by AWS.
- **Lambda** — serverless compute: you upload code, AWS runs it per request.
- **API Gateway** — managed HTTP endpoint that routes to Lambda and other targets.
- **S3** — object storage; a "bucket" holds files ("objects").
- **CloudFormation** — infrastructure as code service.
- **SAM** — AWS Serverless Application Model; a simpler way to define and deploy
  serverless apps (used by `backend/template.yaml`).
- **Stack** — one CloudFormation deployment; `easy-drop-in-backend`.
- **Cold start** — the first Lambda invocation in a fresh container; caches are
  empty, so it rebuilds the feed.

---

## Further reading

**This repo**
- `WALKTHROUGH.md` — full code walkthrough incl. the runtime/AWS section.
- `bootstrap/setup-oidc-role.sh` and `bootstrap/*.json` — the bootstrap, in code.
- `backend/template.yaml` — the entire AWS resource definition.
- `.github/workflows/deploy-backend.yml` — the deploy job.

**GitHub + AWS (OIDC, no stored keys)**
- Configuring OpenID Connect in AWS (GitHub): https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services
- `aws-actions/configure-aws-credentials`: https://github.com/aws-actions/configure-aws-credentials
- `aws-actions/setup-sam`: https://github.com/aws-actions/setup-sam
- Creating OIDC providers in IAM: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html
- AWS blog: "Use IAM roles to connect GitHub Actions to actions in AWS": https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/

**Core services**
- What is AWS Lambda: https://docs.aws.amazon.com/lambda/latest/dg/welcome.html
- Lambda Node.js runtime: https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html
- API Gateway HTTP APIs: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html
- What is Amazon S3: https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
- CloudWatch Logs: https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/WhatIsCloudWatchLogs.html

**Infrastructure as code**
- What is AWS SAM: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html
- SAM CLI command reference: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-command-reference.html
- SAM template spec (`AWS::Serverless::Function`, `HttpApi`): https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-specification.html
- What is AWS CloudFormation: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html

**IAM & cost**
- IAM policies and permissions: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html
- AWS Free Tier: https://aws.amazon.com/free/
- AWS Pricing Calculator: https://calculator.aws/
- AWS CLI reference: https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-welcome.html
