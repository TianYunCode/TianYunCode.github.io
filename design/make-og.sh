#!/usr/bin/env bash
# 生成 public/og.png（社交分享卡片 1200x630）。改完标题/副标题后重跑：bash design/make-og.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p design/font
cp /c/Windows/Fonts/msyh.ttc /c/Windows/Fonts/msyhbd.ttc /c/Windows/Fonts/simsun.ttc design/font/
printf '拾光集' > design/t-mark.txt
printf '拾光集' > design/t-title.txt
printf 'C/C++、Qt、嵌入式与工程实践' > design/t-sub.txt
printf 'Astro 构建 · GitHub Pages 托管 · RSS 订阅' > design/t-foot.txt

ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0xfbfaf7:s=1200x630" -frames:v 1 -vf "drawbox=x=80:y=76:w=15:h=15:color=0x2f5fd0:t=fill,drawtext=fontfile=design/font/msyhbd.ttc:textfile=design/t-mark.txt:fontsize=25:fontcolor=0x8b929d:x=108:y=70,drawtext=fontfile=design/font/simsun.ttc:textfile=design/t-title.txt:fontsize=104:fontcolor=0x1b1e23:x=78:y=236,drawtext=fontfile=design/font/msyh.ttc:textfile=design/t-sub.txt:fontsize=31:fontcolor=0x5a616c:x=80:y=386,drawbox=x=80:y=508:w=1040:h=2:color=0xe3e0d8:t=fill,drawtext=fontfile=design/font/msyh.ttc:textfile=design/t-foot.txt:fontsize=24:fontcolor=0x8b929d:x=80:y=540" public/og.png

ls -l public/og.png
