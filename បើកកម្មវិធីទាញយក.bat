@echo off
chcp 65001 >nul
title HDRG Pro Plus Studio - All-in-One Downloader & Dubbing
cd /d "%~dp0"

echo ================================================================
echo   🎬 HDRG PRO PLUS STUDIO v3.5 (All-in-One Downloader & Dubbing)
echo   • 50+ Platforms (Hongguo, DramaBox, ReelShort, Douyin, TikTok...)
echo   • Multi-Worker Grid Downloader (EP01..EP80)
echo   • Auto Khmer AI Dubbing & Khmer Subtitle (.srt)
echo   កំពុងបើកដំណើរការ Studio...
echo ================================================================

start /b "" node ui_server.js
timeout /t 2 /nobreak >nul
start http://localhost:3000
