#!/bin/bash
#
# Start the Obsidian CLI Proxy service
# Run this on the host (macOS) before using Obsidian from containers
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_JS="${SCRIPT_DIR}/obsidian-proxy.cjs"
PID_FILE="${SCRIPT_DIR}/obsidian-proxy.pid"
LOG_FILE="${SCRIPT_DIR}/logs/proxy.log"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Obsidian proxy is already running (PID: $(cat "$PID_FILE"))"
        echo "Access it at: http://localhost:9955"
        exit 0
    fi

    echo "Starting Obsidian CLI Proxy..."
    nohup node "$PROXY_JS" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    sleep 1
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Obsidian proxy started successfully!"
        echo "PID: $(cat "$PID_FILE")"
        echo "URL: http://localhost:9955"
        echo ""
        echo "To stop: $0 stop"
        echo "To check status: $0 status"
    else
        echo "Failed to start proxy"
        rm -f "$PID_FILE"
        exit 1
    fi
}

stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping Obsidian proxy (PID: $PID)..."
            kill "$PID"
            rm -f "$PID_FILE"
            echo "Stopped."
        else
            echo "Proxy is not running"
            rm -f "$PID_FILE"
        fi
    else
        echo "Proxy is not running (no PID file)"
    fi
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Obsidian proxy is running (PID: $(cat "$PID_FILE"))"
        echo "URL: http://localhost:9955"

        # Test connectivity
        if curl -s http://localhost:9955 -X POST -H "Content-Type: application/json" -d '{"command":"vaults"}' > /dev/null 2>&1; then
            echo "Status: Healthy"
        else
            echo "Status: May not be responding correctly"
        fi
    else
        echo "Obsidian proxy is not running"
    fi
}

case "${1:-start}" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 1
        start
        ;;
    status)
        status
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
