#!/usr/bin/env bash
echo "Starting Kotonoha local test server on http://localhost:8080 ..."
python3 -m http.server 8080 --directory www
