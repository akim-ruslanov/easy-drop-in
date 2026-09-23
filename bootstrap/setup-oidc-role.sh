#!/usr/bin/env bash
#
# One-time bootstrap of the AWS access used by
# .github/workflows/deploy-backend.yml (GitHub Actions -> OIDC -> IAM role).
#
# Creates the GitHub OIDC provider if missing, a deploy role whose trust policy
# allows only this repository/branch, the managed policies the SAM stack needs,
# and a scoped inline IAM policy so CloudFormation can manage the Lambda
# execution role. Safe to re-run: it updates instead of duplicating.
#
# Usage:
#   ./bootstrap/setup-oidc-role.sh
#   ROLE_NAME=my-role REPO=owner/repo BRANCH=main ./bootstrap/setup-oidc-role.sh
set -euo pipefail

ROLE_NAME="${ROLE_NAME:-easy-drop-in-deploy}"
REPO="${REPO:-akim-ruslanov/easy-drop-in}"
BRANCH="${BRANCH:-main}"
OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"
OIDC_HOST="token.actions.githubusercontent.com"
MANAGED_POLICIES=(
  AWSCloudFormationFullAccess
  AWSLambda_FullAccess
  AmazonAPIGatewayAdministrator
  AmazonS3FullAccess
)

cd "$(dirname "$0")"

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

render() {
  sed -e "s|__ACCOUNT_ID__|${ACCOUNT_ID}|g" \
      -e "s|__REPO__|${REPO}|g" \
      -e "s|__OWNER__|${OWNER}|g" \
      -e "s|__REPO_NAME__|${REPO_NAME}|g" \
      -e "s|__BRANCH__|${BRANCH}|g" \
      "$1" > "$tmpdir/$(basename "$1")"
}
render oidc-trust-policy.json
render deploy-permissions-policy.json

echo "Account: ${ACCOUNT_ID}"
echo "Role:    ${ROLE_NAME}"
echo "Subject: repo:${REPO}:ref:refs/heads/${BRANCH}"
echo

# 1. OIDC provider
if aws iam list-open-id-connect-providers \
     --query "OpenIDConnectProviderList[?Arn=='${OIDC_ARN}'].Arn" \
     --output text | grep -q .; then
  echo "✓ OIDC provider already exists"
else
  echo "• Creating OIDC provider"
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_HOST}" \
    --client-id-list sts.amazonaws.com >/dev/null
fi

# 2. Role + trust policy
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "• Updating trust policy"
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "file://$tmpdir/oidc-trust-policy.json"
else
  echo "• Creating role"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$tmpdir/oidc-trust-policy.json" >/dev/null
fi

# 3. Managed policies (idempotent)
for policy in "${MANAGED_POLICIES[@]}"; do
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/${policy}"
done
echo "✓ Attached managed policies: ${MANAGED_POLICIES[*]}"

# 4. Scoped inline IAM policy for the Lambda execution role
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${ROLE_NAME}-iam" \
  --policy-document "file://$tmpdir/deploy-permissions-policy.json"
echo "✓ Attached inline policy: ${ROLE_NAME}-iam"

echo
echo "Done. Add this GitHub Actions secret:"
echo
echo "  AWS_ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo
echo "  gh secret set AWS_ROLE_ARN --body \"arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}\""
