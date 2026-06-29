@echo off
echo Starting AI Proctoring Backend Server...
echo ---------------------------------------
echo 1. Launching Node.js Server on http://localhost:8000
echo 2. Please keep this window open while using the app.
echo ---------------------------------------
start "" "http://localhost:8000"
set PATH=C:\Program Files\nodejs;%PATH%
node server.js
pause
