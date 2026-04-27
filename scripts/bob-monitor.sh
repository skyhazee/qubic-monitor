#!/usr/bin/env bash
#
# Bob Node Monitor + Smart Auto-Restart
#
# Key rule:
#   Do not restart just because tick/sec is low when the node is already synced
#   or close to synced. Slow tick/sec is only a restart signal while the node is
#   still far behind and should be catching up.
#
# Usage:
#   ./bob-monitor.sh              interactive monitor
#   ./bob-monitor.sh daemon       run short daemon loop for cron
#   ./bob-monitor.sh install      install cron daemon
#   ./bob-monitor.sh uninstall    remove cron daemon
#   ./bob-monitor.sh status       show daemon status and restart log
#   ./bob-monitor.sh logs         tail logs

set -u

API_PORT=${API_PORT:-40420}
CONTAINER_NAME=${CONTAINER_NAME:-qubic-bob}
DATA_DIR=${DATA_DIR:-/opt/qubic-bob}
NETWORK_RPC=${NETWORK_RPC:-https://rpc.qubic.org/v1/tick-info}

# Restart tuning.
# If behind <= SYNC_OK_BEHIND, the node is considered healthy enough and slow
# tick/sec will not trigger restart.
SYNC_OK_BEHIND=${SYNC_OK_BEHIND:-1000}
MIN_CATCHUP_SPEED=${MIN_CATCHUP_SPEED:-2.0}
SLOW_WINDOW=${SLOW_WINDOW:-180}
RESTART_COOLDOWN=${RESTART_COOLDOWN:-900}
API_FAIL_RESTART_AFTER=${API_FAIL_RESTART_AFTER:-3}

MONITOR_INTERVAL=${MONITOR_INTERVAL:-5}
DAEMON_INTERVAL=${DAEMON_INTERVAL:-30}

STATE_FILE=${STATE_FILE:-/tmp/bob-monitor.state}
LOG_FILE=${LOG_FILE:-/var/log/bob-monitor.log}
CRON_TAG="# bob-monitor-daemon"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_PATH=$(realpath "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")

log_info()  { echo -e "${BLUE}[*]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[+]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
log_error() { echo -e "${RED}[-]${NC} $1"; }

ensure_log() {
    touch "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/bob-monitor.log"
}

log_to_file() {
    ensure_log
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE" 2>/dev/null || true
}

format_time() {
    local secs=${1:-0}
    printf '%02dh:%02dm:%02ds' $((secs/3600)) $((secs%3600/60)) $((secs%60))
}

format_number() {
    printf "%'.0f" "$1" 2>/dev/null || echo "$1"
}

extract_first_number_after_key() {
    local key="$1"
    grep -o "\"${key}\"[[:space:]]*:[[:space:]]*[0-9]*" | grep -o '[0-9]*$' | head -1
}

get_local_tick() {
    local resp tick

    resp=$(curl -sf --max-time 5 "http://localhost:${API_PORT}/status" 2>/dev/null || true)
    if [ -n "$resp" ]; then
        tick=$(echo "$resp" | extract_first_number_after_key "currentFetchingTick")
        [ -n "$tick" ] && echo "$tick" && return 0
    fi

    resp=$(curl -sf --max-time 5 "http://localhost:${API_PORT}/qubic" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"qubic_getTickNumber","params":[],"id":1}' \
        2>/dev/null || true)
    if [ -n "$resp" ]; then
        tick=$(echo "$resp" | extract_first_number_after_key "result")
        [ -n "$tick" ] && echo "$tick" && return 0
    fi

    echo ""
}

get_net_tick() {
    local resp tick
    resp=$(curl -sf --max-time 5 "$NETWORK_RPC" 2>/dev/null || true)
    [ -z "$resp" ] && echo "" && return 0

    tick=$(echo "$resp" | extract_first_number_after_key "tick")
    [ -n "$tick" ] && echo "$tick" || echo ""
}

container_running() {
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"
}

read_state() {
    if [ -f "$STATE_FILE" ]; then
        # shellcheck disable=SC1090
        source "$STATE_FILE" 2>/dev/null || true
    fi
    SLOW_SINCE=${SLOW_SINCE:-0}
    LAST_RESTART=${LAST_RESTART:-0}
    PREV_TICK=${PREV_TICK:-0}
    PREV_TIME=${PREV_TIME:-0}
    API_FAIL_COUNT=${API_FAIL_COUNT:-0}
}

write_state() {
    cat > "$STATE_FILE" <<EOF
SLOW_SINCE=$SLOW_SINCE
LAST_RESTART=$LAST_RESTART
PREV_TICK=$PREV_TICK
PREV_TIME=$PREV_TIME
API_FAIL_COUNT=$API_FAIL_COUNT
EOF
}

cooldown_left() {
    local now
    now=$(date +%s)
    local left=$(( LAST_RESTART + RESTART_COOLDOWN - now ))
    [ "$left" -gt 0 ] && echo "$left" || echo 0
}

do_node_restart() {
    local reason="$1"
    log_to_file "=== AUTO-RESTART === Reason: $reason"

    if [ -f "${DATA_DIR}/docker-compose.yml" ]; then
        (cd "${DATA_DIR}" && docker compose up -d --force-recreate) >> "$LOG_FILE" 2>&1
    elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
        docker restart "${CONTAINER_NAME}" >> "$LOG_FILE" 2>&1
    else
        log_to_file "ERROR: container ${CONTAINER_NAME} not found"
        return 1
    fi

    LAST_RESTART=$(date +%s)
    SLOW_SINCE=0
    PREV_TICK=0
    PREV_TIME=0
    API_FAIL_COUNT=0
    log_to_file "Restart complete"

    if [ -f "$LOG_FILE" ]; then
        tail -n 1000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
}

try_restart() {
    local reason="$1"
    local left
    left=$(cooldown_left)
    if [ "$left" -le 0 ]; then
        do_node_restart "$reason"
    else
        log_to_file "Restart skipped, cooldown ${left}s left. Reason: $reason"
    fi
}

check_and_maybe_restart() {
    read_state

    local now
    now=$(date +%s)

    if ! container_running; then
        try_restart "container is not running"
        write_state
        return
    fi

    local local_tick
    local_tick=$(get_local_tick)

    if [ -z "$local_tick" ]; then
        API_FAIL_COUNT=$(( API_FAIL_COUNT + 1 ))
        log_to_file "API not responding on port ${API_PORT} (${API_FAIL_COUNT}/${API_FAIL_RESTART_AFTER})"
        if [ "$API_FAIL_COUNT" -ge "$API_FAIL_RESTART_AFTER" ]; then
            try_restart "API not responding after ${API_FAIL_COUNT} checks"
        fi
        write_state
        return
    fi

    API_FAIL_COUNT=0

    local net_tick
    net_tick=$(get_net_tick)

    local had_prev=false
    local speed=""
    if [ "$PREV_TICK" -gt 0 ] && [ "$PREV_TIME" -gt 0 ]; then
        had_prev=true
        local tick_diff=$(( local_tick - PREV_TICK ))
        local time_diff=$(( now - PREV_TIME ))
        if [ "$time_diff" -gt 0 ] && [ "$tick_diff" -ge 0 ]; then
            speed=$(awk "BEGIN {printf \"%.4f\", $tick_diff / $time_diff}")
        fi
    fi

    PREV_TICK=$local_tick
    PREV_TIME=$now

    if [ -z "$net_tick" ]; then
        SLOW_SINCE=0
        log_to_file "Reference tick unavailable; skip speed restart. local_tick=${local_tick}"
        write_state
        return
    fi

    local behind=$(( net_tick - local_tick ))
    [ "$behind" -lt 0 ] && behind=0

    if [ "$behind" -le "$SYNC_OK_BEHIND" ]; then
        if [ "$SLOW_SINCE" -ne 0 ]; then
            log_to_file "Node is inside sync band (${behind} behind <= ${SYNC_OK_BEHIND}); cancel slow restart timer"
        fi
        SLOW_SINCE=0
        write_state
        return
    fi

    if [ "$had_prev" != true ] || [ -z "$speed" ]; then
        log_to_file "Catch-up mode: behind=${behind}; waiting for next sample"
        write_state
        return
    fi

    local is_slow
    is_slow=$(awk "BEGIN {print ($speed < $MIN_CATCHUP_SPEED) ? 1 : 0}")

    if [ "$is_slow" -eq 1 ]; then
        if [ "$SLOW_SINCE" -eq 0 ]; then
            SLOW_SINCE=$now
            log_to_file "Catch-up speed slow: ${speed} tick/s, behind=${behind}, min=${MIN_CATCHUP_SPEED}; start timer"
        else
            local slow_duration=$(( now - SLOW_SINCE ))
            log_to_file "Still slow: ${speed} tick/s for ${slow_duration}s, behind=${behind}, window=${SLOW_WINDOW}s"
            if [ "$slow_duration" -ge "$SLOW_WINDOW" ]; then
                try_restart "catch-up speed ${speed} tick/s for ${slow_duration}s while ${behind} behind"
            fi
        fi
    else
        if [ "$SLOW_SINCE" -ne 0 ]; then
            log_to_file "Catch-up speed normal again: ${speed} tick/s, behind=${behind}"
        fi
        SLOW_SINCE=0
    fi

    write_state
}

do_daemon() {
    ensure_log
    local end_time=$(( $(date +%s) + 55 ))
    while [ "$(date +%s)" -lt "$end_time" ]; do
        check_and_maybe_restart
        sleep "$DAEMON_INTERVAL"
    done
}

do_monitor() {
    ensure_log

    local prev_tick=0
    local prev_time=0
    local speed=0

    trap 'echo ""; echo "Monitor stopped."; exit 0' INT

    while true; do
        clear
        read_state

        local now local_tick net_tick behind pct
        now=$(date +%s)
        local_tick=$(get_local_tick)
        net_tick=$(get_net_tick)

        if [ -n "$local_tick" ] && [ "$prev_tick" -gt 0 ]; then
            local tick_diff=$(( local_tick - prev_tick ))
            local time_diff=$(( now - prev_time ))
            if [ "$time_diff" -gt 0 ] && [ "$tick_diff" -ge 0 ]; then
                speed=$(awk "BEGIN {printf \"%.2f\", $tick_diff / $time_diff}")
            fi
        fi

        echo -e "${BOLD}==============================================${NC}"
        echo -e "${BOLD}          Qubic Bob Node Monitor              ${NC}"
        echo -e "${BOLD}==============================================${NC}"
        echo ""

        if container_running; then
            echo -e "  Container  : ${GREEN}RUNNING${NC}"
        else
            echo -e "  Container  : ${RED}STOPPED${NC}"
        fi

        if [ -z "$local_tick" ]; then
            echo -e "  API        : ${RED}not responding on port ${API_PORT}${NC}"
        else
            echo -e "  Local Tick : ${CYAN}$(format_number "$local_tick")${NC}"
            echo -e "  Net Tick   : $(format_number "${net_tick:-0}")"

            if [ -n "$net_tick" ] && [ "$net_tick" -gt 0 ]; then
                behind=$(( net_tick - local_tick ))
                [ "$behind" -lt 0 ] && behind=0
                pct=$(awk "BEGIN {printf \"%.2f\", $local_tick * 100 / $net_tick}")

                if [ "$behind" -le "$SYNC_OK_BEHIND" ]; then
                    echo -e "  Behind     : ${GREEN}$(format_number "$behind") tick (sync band <= ${SYNC_OK_BEHIND})${NC}"
                else
                    echo -e "  Behind     : ${YELLOW}$(format_number "$behind") tick${NC} (${pct}%)"
                fi
            fi
        fi

        echo ""
        if [ -n "$local_tick" ] && [ "$prev_tick" -gt 0 ]; then
            if [ -n "${behind:-}" ] && [ "$behind" -le "$SYNC_OK_BEHIND" ]; then
                echo -e "  Speed      : ${CYAN}${speed} tick/s${NC} (ignored while synced/near synced)"
            elif awk "BEGIN {exit !($speed < $MIN_CATCHUP_SPEED)}"; then
                echo -e "  Speed      : ${RED}${speed} tick/s${NC} (slow catch-up)"
            else
                echo -e "  Speed      : ${GREEN}${speed} tick/s${NC} (catch-up OK)"
            fi
        else
            echo -e "  Speed      : ${YELLOW}calculating...${NC}"
        fi

        echo ""
        echo -e "  ${BOLD}--- Auto-Restart Config -------------------${NC}"
        echo "  Sync band       : no speed restart when behind <= ${SYNC_OK_BEHIND}"
        echo "  Min catch-up    : ${MIN_CATCHUP_SPEED} tick/s"
        echo "  Slow window     : ${SLOW_WINDOW}s"
        echo "  Cooldown        : ${RESTART_COOLDOWN}s"

        if [ "$LAST_RESTART" -ne 0 ]; then
            echo -e "  Last restart    : ${MAGENTA}$(format_time "$(( now - LAST_RESTART ))") ago${NC}"
        else
            echo "  Last restart    : never"
        fi

        echo ""
        echo -e "  ${BLUE}Refresh every ${MONITOR_INTERVAL}s... Ctrl+C to exit${NC}"
        echo ""
        echo -e "  ${BOLD}--- Docker Logs (last 5 lines) ------------${NC}"
        docker logs --tail 5 "$CONTAINER_NAME" 2>/dev/null | sed 's/^/  /' || echo "  (no log)"

        prev_tick=${local_tick:-$prev_tick}
        prev_time=$now

        check_and_maybe_restart
        sleep "$MONITOR_INTERVAL"
    done
}

do_install() {
    log_info "Installing cron daemon..."
    ensure_log

    if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
        log_warn "Cron job already installed. Remove first with: $0 uninstall"
        exit 1
    fi

    (crontab -l 2>/dev/null; echo "* * * * * $SCRIPT_PATH daemon >> $LOG_FILE 2>&1 $CRON_TAG") | crontab -

    log_ok "Cron job installed"
    echo "  Sync band    : behind <= ${SYNC_OK_BEHIND}, no speed restart"
    echo "  Trigger      : behind > ${SYNC_OK_BEHIND} and speed < ${MIN_CATCHUP_SPEED} tick/s for ${SLOW_WINDOW}s"
    echo "  Cooldown     : ${RESTART_COOLDOWN}s"
    echo "  Log          : $LOG_FILE"
}

do_uninstall() {
    if ! crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
        log_warn "Cron job not found"
        return 0
    fi
    crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -
    log_ok "Cron job removed"
}

do_status() {
    echo ""
    echo -e "${BOLD}=== Bob Monitor Status ===${NC}"
    echo ""

    if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
        log_ok "Daemon cron active"
        crontab -l 2>/dev/null | grep "$CRON_TAG"
    else
        log_warn "Daemon cron inactive. Install with: $0 install"
    fi

    echo ""
    read_state
    if [ "$LAST_RESTART" -ne 0 ]; then
        echo "  Last restart : $(format_time "$(( $(date +%s) - LAST_RESTART ))") ago"
    else
        echo "  Last restart : never"
    fi
    echo "  Slow since   : ${SLOW_SINCE}"
    echo "  API failures : ${API_FAIL_COUNT}"

    echo ""
    echo -e "${BOLD}=== Restart Log ===${NC}"
    if [ -f "$LOG_FILE" ]; then
        grep -E "AUTO-RESTART|Restart complete|slow|cooldown|sync band|API not responding" "$LOG_FILE" | tail -30 || true
    else
        echo "  Log not found"
    fi
}

do_logs() {
    ensure_log
    tail -f "$LOG_FILE"
}

case "${1:-monitor}" in
    monitor|"") do_monitor ;;
    daemon) do_daemon ;;
    install) do_install ;;
    uninstall) do_uninstall ;;
    status) do_status ;;
    logs) do_logs ;;
    *)
        echo "Bob Node Monitor + Auto-Restart"
        echo ""
        echo "Usage: $0 [monitor|daemon|install|uninstall|status|logs]"
        echo ""
        echo "Important config:"
        echo "  SYNC_OK_BEHIND=${SYNC_OK_BEHIND}"
        echo "  MIN_CATCHUP_SPEED=${MIN_CATCHUP_SPEED}"
        echo "  SLOW_WINDOW=${SLOW_WINDOW}"
        echo "  RESTART_COOLDOWN=${RESTART_COOLDOWN}"
        ;;
esac
