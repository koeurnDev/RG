@echo off
chcp 65001 >nul
title EZA PRO Downloader
cd /d "%~dp0"

echo ================================================================
echo   🎬 EZA PRO DOWNLOADER (Multi-Platform Short Drama Downloader)
echo   • 50+ Platforms (Hongguo, DramaBox, ReelShort, Douyin, TikTok...)
echo   • Multi-Worker Grid Downloader + Auto Movie Merge
echo   កំពុងបើកដំណើរការកម្មវិធី...
echo ================================================================

start /b "" node ui_server.js
timeout /t 2 /nobreak >nul
start http://localhost:3000
