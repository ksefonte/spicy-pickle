#!/bin/bash
# Deploy script for Spicy Pickle app
# Deploys to both Google Cloud Run and Shopify

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🌶️  Spicy Pickle Deploy Script${NC}"
echo "================================"
echo ""

# Configuration
GCP_PROJECT="spicy-pickle-484622"
GCP_REGION="australia-southeast1"
SERVICE_NAME="spicy-pickle"

# Parse arguments
SKIP_GCP=false
SKIP_SHOPIFY=false
SKIP_TESTS=false

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --skip-gcp) SKIP_GCP=true ;;
        --skip-shopify) SKIP_SHOPIFY=true ;;
        --skip-tests) SKIP_TESTS=true ;;
        --help|-h)
            echo "Usage: ./scripts/deploy.sh [options]"
            echo ""
            echo "Options:"
            echo "  --skip-gcp      Skip Google Cloud Run deployment"
            echo "  --skip-shopify  Skip Shopify app deployment"
            echo "  --skip-tests    Skip running tests before deploy"
            echo "  -h, --help      Show this help message"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

# Change to project root
cd "$(dirname "$0")/.."

# Step 1: Run tests (unless skipped)
if [ "$SKIP_TESTS" = false ]; then
    echo -e "${YELLOW}📋 Running pre-deploy checks...${NC}"
    
    echo "  → Type checking..."
    npm run typecheck
    
    echo "  → Linting..."
    npm run lint
    
    echo "  → Running tests..."
    npm run test
    
    echo -e "${GREEN}  ✓ All checks passed${NC}"
    echo ""
fi

# Step 2: Deploy to Google Cloud Run
if [ "$SKIP_GCP" = false ]; then
    echo -e "${YELLOW}☁️  Deploying to Google Cloud Run...${NC}"
    echo "  Project: $GCP_PROJECT"
    echo "  Region:  $GCP_REGION"
    echo "  Service: $SERVICE_NAME"
    echo ""
    
    gcloud run deploy "$SERVICE_NAME" \
        --project="$GCP_PROJECT" \
        --region="$GCP_REGION" \
        --source=. \
        --quiet
    
    echo -e "${GREEN}  ✓ Cloud Run deployment complete${NC}"
    echo ""
else
    echo -e "${YELLOW}⏭️  Skipping Cloud Run deployment${NC}"
    echo ""
fi

# Step 3: Deploy Shopify app config
if [ "$SKIP_SHOPIFY" = false ]; then
    echo -e "${YELLOW}🛍️  Deploying Shopify app configuration...${NC}"
    
    npx shopify app deploy --force
    
    echo -e "${GREEN}  ✓ Shopify deployment complete${NC}"
    echo ""
else
    echo -e "${YELLOW}⏭️  Skipping Shopify deployment${NC}"
    echo ""
fi

# Done!
echo -e "${GREEN}🎉 Deployment complete!${NC}"
echo ""
echo "Cloud Run URL: https://${SERVICE_NAME}-990586804218.${GCP_REGION}.run.app"
echo ""
