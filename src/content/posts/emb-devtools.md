---
title: 开发板、调试器与烧录
description: 未实测（本机无开发板/探针）：SWD 与 JTAG 的接线与速度取舍、三条开发路线（IDE/命令行/Makefile）、固件格式（hex/bin/elf）与烧录工具链、以及串口日志的最小可观测性设计。
date: 2026-10-16
tags: [嵌入式, SWD, OpenOCD, 烧录, 串口日志]
category: embedded
section: emb-devtools
---

> **本文性质声明**：本机没有开发板、没有调试探针（用户环境的开发板未直通、Linux 开发机不可达），**全部内容未实测**，为工具链级框架。站内对照：dbg-gdb（GDB 调试本机实测）、engineering-ci-cd（构建流水线实测）、os-what-kernel-does（陷入成本的量级参照）。

## 一、SWD 与 JTAG：接线、速度与陷阱

两种调试接口的实务差别：

| | SWD | JTAG |
| --- | --- | --- |
| 线数 | 4（SWDIO/SWCLK/nRST/GND） | 5+（TMS/TCK/TDI/TDO/nRST/GND） |
| 引脚占用 | **少，省 GPIO** | 多 |
| 速度 | 数 MHz 常见 | 边界扫描可慢，内核调试同 SWD 级 |
| 能力 | 调试够用 | 多：边界扫描（测板级连线）、链式多器件 |

接线三查：**nRST 建议接**（不接也能跑，但"调试器连上后芯片已跑飞"的场景没法恢复）；**线要短**（SWD 的时钟线长了升速就丢连接——`Adapter speed` 从 1MHz 起步）；**别和强干扰源并排**（电机线旁边 SWD 时钟会被打乱，现象是随机 `JTAG-DP STICKY ERROR`）。

**探针生态**：ST-Link（便宜、官方）、J-Link（快、兼容广、贵）、CMSIS-DAP（开源、很多国产板载）、Daplink。OpenOCD 是开源的服务端（把探针抽象成 GDB Server + telnet 命令），J-Link 配自己的 GDB Server。

## 二、三条开发路线

1. **IDE 路线**（Keil/IAR/STM32CubeIDE/PlatformIO）：点按钮编译烧录调试，**入门快、调试器图形化好**；代价是工程文件绑定生态（换工具链 = 搬家）。
2. **命令行路线**（arm-none-eabi-gcc + OpenOCD + GDB/Makefile）：全部脚本化——**CI 能复现、版本控制友好**；代价是每个环节自己配（烧录命令、启动文件、链接脚本）。
3. **混合路线**（推荐）：**IDE 管调试（图形化看变量/断点），Makefile/CMake 管构建**——CubeIDE/PlatformIO 都支持"外部构建系统"或导入 Makefile 工程。本站 build-cmake 讲过 CMake 的 target 模型，交叉编译的 toolchain 文件就是这条路线的入口（用户环境里那套 `arm-rockchip830-linux-uclibcgnueabihf` 工具链即此类）。

**最小可复现构建的四件套**：toolchain（gcc/binutils/gdb）、启动代码+链接脚本（emb-startup）、构建系统（Makefile 起步，build-make 的量产实践直接适用）、烧录调试脚本（OpenOCD 的 `.cfg`）。四件套进 git，新机器 clone 即编。

## 三、固件格式与烧录

| 格式 | 内容 | 用途 |
| --- | --- | --- |
| `.elf` | 代码 + 符号 + 调试信息 | **调试用这个**（GDB/OpenOCD 直接读） |
| `.bin` | 纯二进制，无地址信息 | **烧录用这个**（烧录工具按固定地址写） |
| `.hex` | Intel HEX（ASCII 记录地址+数据） | 老工具/某些 Bootloader 的输入 |
| `.dfu`/`.hex`+工具链 | ST 的 DFU、厂商私有格式 | USB DFU 或厂商烧录器 |

烧录的三条路：**调试器烧**（OpenOCD `program firmware.bin 0x08000000 verify reset`——开发期主力）、**Bootloader 烧**（串口/USB/CAN 进 bootloader 收固件，emb-bootloader 专节）、**量产烧录器**（产线上位机 + 治具，一次多片，本文不展开）。

**烧录失败的排查顺序**：探针认不到（接线/供电/探针坏了）→ 擦除失败（Flash 被写保护，选项字节的 RDP 级别）→ 校验失败（固件超了 Flash 容量——`size` 命令看）。**`verify` 一定要开**——读回来比对是唯一能发现"线太长导致 bit 错"的手段。

## 四、串口日志：最小可观测性

没有 semihosting（慢且阻塞）、没有 J-Link RTT（要探针在场）时，**UART printf 是永远的底线**。设计要点：

1. **重定向 `fputc`**：`int fputc(int c, FILE*) { usart_send_blocking(c); return c; }`，配 `-u` 关掉 newlib 的缓冲（或启动早期先 `setvbuf(stdout, NULL, _IONBF, 0)`）——**崩溃前日志没打出来，九成是缓冲没关**。
2. **分级别 + 可编译裁剪**：`LOG_ERROR/LOG_INFO/LOG_DEBUG` 宏，release 编掉 DEBUG——本站 dbg-log 量过"级别短路放在格式化之前 0.2ns/行、之后 181.2ns（900 倍）"，MCU 上同样先判级别再拼串。
3. **环形缓冲 + 掉电快照**：日志进 RAM 环形缓冲，**崩溃时把最后 N 行写进备用 RAM/Flash 的保留区**——重启后第一件事把它 dump 到串口。这是"现场取证"的最小实现（emb-reliability 会展开）。
4. **波特率与线序**：115200 8N1 是通用约定；**TX/RX 反了的现象是收到 0x00 或乱码**；长线用 9600 更稳。上电第一帧打出版本号+复位原因（`RCC->CSR` 的复位标志位）——**"这颗板子为什么重启了"从第一行日志就有答案**。

## 五、排障索引

| 症状 | 入口 |
| --- | --- |
| 调试器连不上 | 接线/供电；SWD 速度降；芯片被 RDP 锁 |
| 烧录后不运行 | 向量表/启动代码（emb-startup）；VTOR |
| 串口无输出 | TX/RX 反；时钟树错了波特率全变；缓冲没关 |
| 日志乱码 | 波特率不匹配；停胶位；线太长 |
| 偶发 hardfault 且没日志 | 开 HardFault 的寄存器打印（emb-mcu 的 CFSR）；日志缓冲提前 flush |
| CI 编不出 | 构建四件套缺一；用容器的 toolchain 镜像固化环境 |

## 六、未实测清单

- 本文所有工具链行为——无开发板/探针，未测。
- OpenOCD/J-Link 的具体命令输出——未部署。
- DFU/USB 烧录——未部署。
- 用户 Linux 开发机上的 Rockchip 工具链实跑——该机不可达，未涉及。
