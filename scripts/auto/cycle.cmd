@echo off
REM FORWARDING SHIM - the real file moved to src\auto\cycle.cmd in the
REM 2026-08-27 re-layout. The Windows Scheduled Task "AgenticJobApplication"
REM invokes THIS absolute path daily at 07:00; re-registering the task is the
REM user's act, not the agent's (docs/operate/01-commands.md, section 6.7).
REM Delete this file only after the task's action points at src\auto\cycle.cmd.
REM The real cycle.cmd pins the repo root itself, so forwarding needs no pushd.
echo [shim] scripts\auto\cycle.cmd forwards to src\auto\cycle.cmd 1>&2
call "%~dp0..\..\src\auto\cycle.cmd" %*
exit /b %ERRORLEVEL%
