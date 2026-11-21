@echo off
rem Starts a tiny local web server so Invite Desk can read PDFs. Nothing leaves your computer.
cd /d "%~dp0"
echo.
echo  Invite Desk is starting at http://localhost:8080  (close this window to stop it)
echo.
start "" http://localhost:8080
where py >nul 2>nul && (py -m http.server 8080 --bind 127.0.0.1 & goto :eof)
where python >nul 2>nul && (python -m http.server 8080 --bind 127.0.0.1 & goto :eof)
where npx >nul 2>nul && (npx --yes serve -l 8080 . & goto :eof)
echo Could not find Python or Node. Use the hosted link instead, or install Python from python.org.
pause
