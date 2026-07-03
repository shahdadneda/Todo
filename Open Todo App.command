#!/bin/bash
cd "$(dirname "$0")"

PORT=8080
URL="http://127.0.0.1:$PORT/index.html"

if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  nohup python3 -m http.server "$PORT" >/dev/null 2>&1 &
  disown
  sleep 1
fi

open "$URL"
