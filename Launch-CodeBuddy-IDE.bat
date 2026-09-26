@echo off
title CodeBuddy IDE Launcher
cd /d %~dp0
echo Launching CodeBuddy Windows Desktop IDE...
start node_modules\.bin\electron.cmd electron-main.js
