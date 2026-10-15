#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "=========================================="
echo " Starting FileDost AI"
echo " Next-Generation Document Processing Engine"
echo "=========================================="
echo "Open your browser at: http://localhost:8000"
echo "API documentation: http://localhost:8000/docs"
echo "=========================================="

# Local development: only this computer can connect, and the API docs are on.
# (Use HOST=0.0.0.0 ./run.sh to let other devices on your network in.)
ULTRAPDF_API_DOCS=1 python3 -m uvicorn main:app --host "${HOST:-127.0.0.1}" --port 8000 --reload
