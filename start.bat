@echo off
setlocal
title SkyPhreak

rem Always run from the folder this script lives in, no matter where it's launched from.
cd /d "%~dp0"

echo ============================================
echo   SkyPhreak launcher
echo ============================================
echo.

rem Make sure Node.js is available.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo         Install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

rem Install dependencies the first time (or if they were removed).
if not exist "node_modules\electron\path.txt" (
  echo Installing dependencies, this only happens the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

rem Build the renderer if it hasn't been built yet, then launch.
if not exist "dist\index.html" (
  echo Building the app...
  call npm run build
  if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See the messages above.
    pause
    exit /b 1
  )
)

echo Starting SkyPhreak...
echo (Closing this window will close the app.)
echo.
call npx electron .

endlocal
