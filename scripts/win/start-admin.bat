@echo off
rem World Driving Engine · admin dev server (8848) via Task Scheduler
cd /d "E:\桌面\项目总览\世界驱动引擎\admin-web" >> "E:\桌面\项目总览\世界驱动引擎\scripts\win\admin.log" 2>&1
echo [%date% %time%] cd exit=%errorlevel% dir=%cd% >> "E:\桌面\项目总览\世界驱动引擎\scripts\win\admin.log"
node node_modules\vite\bin\vite.js --port 8848 >> "E:\桌面\项目总览\世界驱动引擎\scripts\win\admin.log" 2>&1
echo [%date% %time%] vite exit=%errorlevel% >> "E:\桌面\项目总览\世界驱动引擎\scripts\win\admin.log"
