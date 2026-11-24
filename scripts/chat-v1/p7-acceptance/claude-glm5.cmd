@echo off
rem P7 回归用：上游 glm-5.4 持续 529 过载时的临时模型回退（仅本次验收进程）。
rem 不修改用户 settings.json；只给这一条子进程换模型。验收报告里如实写明是回退。
set ANTHROPIC_MODEL=glm-5
"C:\Users\Administrator\.local\bin\claude.exe" %*
