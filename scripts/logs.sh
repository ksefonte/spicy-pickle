#!/bin/bash
# Log viewing script for Spicy Pickle app

GCP_PROJECT="spicy-pickle-484622"
GCP_REGION="australia-southeast1"
SERVICE_NAME="spicy-pickle"

case "${1:-tail}" in
    tail)
        echo "📋 Tailing Cloud Run logs (Ctrl+C to stop)..."
        gcloud run services logs tail "$SERVICE_NAME" \
            --project="$GCP_PROJECT" \
            --region="$GCP_REGION"
        ;;
    recent)
        LIMIT="${2:-50}"
        echo "📋 Last $LIMIT log entries..."
        gcloud run services logs read "$SERVICE_NAME" \
            --project="$GCP_PROJECT" \
            --region="$GCP_REGION" \
            --limit="$LIMIT"
        ;;
    webhooks)
        echo "📋 Recent webhook activity..."
        gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE_NAME\" AND (textPayload:\"Webhook\" OR textPayload:\"webhook\" OR textPayload:\"Pub/Sub\")" \
            --project="$GCP_PROJECT" \
            --limit="${2:-30}" \
            --format="table(timestamp,textPayload)"
        ;;
    errors)
        echo "📋 Recent errors..."
        gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE_NAME\" AND severity>=ERROR" \
            --project="$GCP_PROJECT" \
            --limit="${2:-20}" \
            --format="table(timestamp,textPayload)"
        ;;
    *)
        echo "Usage: ./scripts/logs.sh [command] [limit]"
        echo ""
        echo "Commands:"
        echo "  tail      - Live tail logs (default)"
        echo "  recent    - Show recent logs (default: 50)"
        echo "  webhooks  - Show webhook-related logs"
        echo "  errors    - Show error logs only"
        echo ""
        echo "Examples:"
        echo "  ./scripts/logs.sh tail"
        echo "  ./scripts/logs.sh recent 100"
        echo "  ./scripts/logs.sh webhooks 50"
        echo "  ./scripts/logs.sh errors"
        ;;
esac
