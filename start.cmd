@echo off
rem Serves the calculator on http://localhost:8765/ and opens it in the default browser.
cd /d "%~dp0"
start "" http://localhost:8765/
python serve.py
