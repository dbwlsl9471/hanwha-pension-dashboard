@echo off
cd /d "%~dp0"
echo.
echo  한화투자증권 퇴직연금 공시 비교
echo  브라우저에서 http://127.0.0.1:8765  을 여세요.
echo  종료: 이 창에서 Ctrl+C
echo.
python -m http.server 8765
pause
