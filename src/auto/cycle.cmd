@echo off
REM ============================================================================
REM One job-application cycle, for Windows Task Scheduler.
REM
REM WHY A .cmd AND NOT A DIRECT `node` ACTION: Task Scheduler runs an action
REM with no shell, no PATH inheritance you can rely on, and a working directory
REM it picks. All three matter here — the pipeline resolves jobs/, profile/ and
REM docs/application-limits.yaml relative to the repository root, and a run
REM started somewhere else silently reads a different fact base or none at all.
REM This wrapper pins the directory and writes a dated log, so a cycle that
REM failed at 04:00 is still readable at 09:00.
REM
REM REGISTERING IT IS THE USER'S ACT, not the agent's — it changes a system
REM setting. The Register-ScheduledTask command is in the header of cycle.mjs
REM and in docs/operate/01-commands.md §6.7 (it used to be only in a session
REM note, which is how it went missing). Register with --skip-apply and
REM -AllowStartIfOnBatteries; the 2026-08-03 registration had neither.
REM ============================================================================

setlocal

REM The repository root is this script's own directory, two levels up.
set "REPO=%~dp0..\.."
pushd "%REPO%" || exit /b 1

if not exist "logs" mkdir "logs"

REM Sortable, locale-independent timestamp. %DATE% is locale-formatted and
REM unusable in a filename on a machine set to anything but US English.
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set "STAMP=%%i"

echo ==== cycle %STAMP% ==== >> "logs\cycle.log"
node "scripts\auto\cycle.mjs" %* >> "logs\cycle.log" 2>&1
set "CODE=%ERRORLEVEL%"
echo ==== exit %CODE% ==== >> "logs\cycle.log"

popd
endlocal & exit /b %CODE%
