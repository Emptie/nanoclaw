#!/bin/bash
#
# Obsidian CLI Client for Container
# This script runs inside the container to call the host's Obsidian CLI proxy
#
# Usage:
#   obsidian <command> [args...]
#
# Examples:
#   obsidian vaults
#   obsidian files vault="Emptie的知识库"
#   obsidian read file="Note Name" vault="Emptie的知识库"
#   obsidian create name="New Note" content="Hello" vault="Emptie的知识库"

PROXY_HOST="${OBSIDIAN_PROXY_HOST:-host.docker.internal}"
PROXY_PORT="${OBSIDIAN_PROXY_PORT:-9955}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

# Build command and args
COMMAND="$1"
shift
ARGS="$*"

if [ -z "$COMMAND" ]; then
    echo "Usage: obsidian <command> [args...]"
    echo ""
    echo "Examples:"
    echo "  obsidian vaults"
    echo "  obsidian files vault=\"Emptie的知识库\""
    echo "  obsidian read file=\"Note Name\" vault=\"Emptie的知识库\""
    exit 1
fi

# Make request to proxy
RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    "${PROXY_URL}" \
    -d "{\"command\":\"${COMMAND}\",\"args\":\"${ARGS}\"}" \
    2>&1)

if [ $? -ne 0 ]; then
    echo "Error: Failed to connect to Obsidian proxy at ${PROXY_URL}"
    echo "Make sure the proxy is running on the host:"
    echo "  node tools/obsidian-proxy/obsidian-proxy.js"
    exit 1
fi

# Parse response and extract output
if command -v jq &> /dev/null; then
    # Use jq if available
    SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
    OUTPUT=$(echo "$RESPONSE" | jq -r '.output')
    ERROR=$(echo "$RESPONSE" | jq -r '.error')

    if [ "$SUCCESS" = "true" ]; then
        echo "$OUTPUT"
        exit 0
    else
        echo "Error: $ERROR" >&2
        echo "$OUTPUT" >&2
        exit 1
    fi
else
    # Fallback: simple grep/sed parsing
    if echo "$RESPONSE" | grep -q '"success":true'; then
        echo "$RESPONSE" | grep -o '"output":"[^"]*' | sed 's/"output":"//' | sed 's/\\n/\n/g'
        exit 0
    else
        echo "Error calling Obsidian CLI" >&2
        echo "$RESPONSE" >&2
        exit 1
    fi
fi
