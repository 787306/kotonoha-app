@echo off
chcp 65001 >nul
set PYCMD=
where py >nul 2>&1 && set PYCMD=py -3
if "%PYCMD%"=="" (where python >nul 2>&1 && set PYCMD=python)
if "%PYCMD%"=="" (
  echo [오류] Python이 설치되어 있지 않습니다. https://www.python.org 에서 설치 후 다시 실행해 주세요.
  pause
  exit /b 1
)
echo Kotonoha 로컬 테스트 서버를 시작합니다: http://localhost:8080
start "" cmd /c "ping -n 2 127.0.0.1 >nul && start http://localhost:8080"
%PYCMD% -m http.server 8080 --directory www
pause
