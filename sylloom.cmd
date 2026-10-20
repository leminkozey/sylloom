@echo off
setlocal DisableDelayedExpansion
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(process.arch==='x64'&&(a>22||(a===22&&b>=18))?0:1)" >nul 2>&1
if not errorlevel 1 goto systemnode
for /d %%D in ("%LOCALAPPDATA%\Sylloom\node\node-v24.*-win-x64") do if exist "%%~fD\node.exe" set "SYLLOOM_NODE=%%~fD\node.exe"
if defined SYLLOOM_NODE goto portablenode
echo Node.js 22.18 or later is missing. Run install.ps1 first. 1>&2
exit /b 1
:systemnode
node "%~dp0sylloom" %*
exit /b %errorlevel%
:portablenode
"%SYLLOOM_NODE%" "%~dp0sylloom" %*
exit /b %errorlevel%
