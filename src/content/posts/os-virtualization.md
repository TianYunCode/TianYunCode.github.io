---
title: 虚拟化与容器原理
description: 未实测（本机无 Linux/ hypervisor 环境）：陷入模拟的分野、影子页表与 EPT 的两代地址翻译、KVM 的三件套（kvm/vcpu/运行循环）、容器与虚拟机的边界、以及逃逸防护的层次。
date: 2026-10-16
tags: [操作系统, 虚拟化, KVM, 容器, EPT]
category: os
section: os-virtualization
---

> **本文性质声明**：本机无 Linux 环境（WSL 被策略拦截），**全部内容未实测**，为原理级框架。站内对照：linux-ns（namespace/cgroup 的容器积木）、os-what-kernel-does（特权级与陷入的本机实测：陷入 82.4ns）、os-interrupt（设备模型）。

## 一、虚拟化的根本困难：特权指令

x86 的经典难题：**有些敏感指令只在最高特权级（ring 0）执行时才有效，在低特权级执行时要么静默失败要么行为不同**——客户机内核在 ring 1/3 跑这些指令，不陷入也不报错，hypervisor 根本捕获不到。Popek-Goldberg 定理刻画了"可虚拟化架构"的条件；**x86 历史上不可虚拟化**，直到 Intel VT-x/AMD-V 提供硬件支持：

```
VMX root 模式    ← hypervisor 在这跑
VMX non-root 模式 ← 客户机（内核+应用）在这跑
VMExit           ← 客户机做敏感操作 → 陷入 hypervisor（快：不保存全部状态）
VMEntry          ← hypervisor 把控制权还给客户机
```

**VT-x 之前的软件方案**（二进制翻译、半虚拟化）都是绕这个难题的历史遗产——理解"为什么需要硬件辅助"是这节的一半。

## 二、内存虚拟化：影子页表与 EPT

客户机的"物理地址"是假的——多个虚拟机共享同一台机器的真实内存。两层翻译：

```
客户机虚拟地址(GVA) → [客户机页表] → 客户机物理地址(GPA) → [hypervisor 映射] → 主机物理地址(HPA)
```

**影子页表（第一代）**：hypervisor 为每个客户机进程维护一份"直接映射 GVA→HPA"的假页表，硬件用它；客户机改自己的页表时陷入，hypervisor 同步影子。问题：客户机每次页表操作都陷入，开销大。

**EPT/NPT（第二代，硬件辅助）**：CPU 的 MMU 硬件支持**二维翻译**——先查客户机页表得 GPA，再查 EPT 表得 HPA，两步都不过 hypervisor。陷入从"每次页表操作"降到"EPT miss 和敏感配置"——**这是现代虚拟化性能的分水岭**（本站 os-page-table 在 Windows 侧量过 TLB/缺页的量级，可对照理解翻译开销的敏感度）。

## 三、KVM 的三件套与运行循环

KVM 把 Linux 变成 hypervisor，靠三个内核模块和一个用户态程序：

```
/dev/kvm            ← 字符设备：创建虚拟机的入口
kvm-intel/amd       ← 硬件 VT 支持
kvm.ko              ← 核心：vcpu、内存槽、VMCS 管理
QEMU (用户态)        ← 模拟外设（磁盘/网卡/显卡），通过 ioctl 把 vcpu 跑起来
```

运行循环（QEMU 侧）：`ioctl(KVM_RUN)` → 客户机跑 → **VMExit**（客户机做 IO/特权操作）→ QEMU 模拟这个 IO（比如写网卡队列 = 一次 tap 写）→ 再 `KVM_RUN`。**virtio** 是客户机与 QEMU 之间的半虚拟化总线：客户机知道自己在虚拟化环境里，用共享内存队列批量交付 IO——比模拟真实硬件（一个包一次退出）快一个量级。

**一句话架构**：KVM 管 CPU 和内存（陷入模拟 + EPT），QEMU 管外设（模拟 + virtio 快路径）。

## 四、容器 vs 虚拟机：隔离的边界

| | 容器 | 虚拟机 |
| --- | --- | --- |
| 隔离单位 | 进程（namespace 视角） | 整内核（硬件视角） |
| 共享的攻击面 | **宿主内核** | hypervisor（小得多） |
| 启动 | 毫秒级（就是个进程） | 秒级（要启内核） |
| 密度 | 高（无内核副本） | 低（每 VM 一份内存给内核） |
| 安全边界强度 | 中——**内核漏洞 = 全体逃逸** | 高——逃逸要找 hypervisor 的洞 |

**选型判据**：同信任域的应用用容器；跑不受信任的代码（多租户函数计算、CI 跑别人的 PR）用 VM 或 microVM（Firecracker/Kata——单内核单应用的轻量 VM，兼顾启动速度和隔离强度）。Linux-ns 那节说过：容器的六件套全在同一内核上，**USER namespace 是最后一道横向隔离**（容器内 root 映射成宿主高 UID），但它恰恰是漏洞历史最多的 namespace。

## 五、逃逸防护的层次

纵深防御，从外到内：

1. **减少攻击面**：默认 drop 所有 capability、`--security-opt no-new-privileges`、只读 rootfs + tmpfs、seccomp 过滤系统调用白名单（Docker 默认 profile 挡掉 40+ 危险调用）。
2. **USER namespace 隔离**：rootless 容器——容器内 root = 宿主的普通用户，**逃逸了也只拿到普通用户权限**。
3. **内核加固**：`kernel.yama.ptrace_scope`、锁住 `/sys`、KASLR——拉高利用内核漏洞的门槛。
4. **microVM/gVisor**：gVisor 用用户态重写的系统调用拦截层（不用宿主的 Linux 系统调用实现），**把"共享内核"换成"共享 sentry 进程"**——隔离强于容器、弱于 VM、开销在两者之间。

**审计的常识**：没有任何一层是银弹；组合使用 + 及时打补丁 + 不在容器里跑特权守护，比追新方案实在。

## 六、排障索引

| 症状 | 入口 |
| --- | --- |
| 客户机极慢 | EPT 没开（`kvm-ok`/dmesg）；virtio 驱动没用上（退化成模拟设备） |
| 嵌套虚拟化开不了 | BIOS 的 VT-x 没暴露给 L1；`cat /sys/module/kvm_intel/parameters/nested` |
| 容器内存超限被杀 | cgroup v2 的 `memory.max`（linux-ns 量过组内 OOM 机制） |
| 容器内看不到设备 | 没 `--device`；或 namespace 隔离正常，要共享 network/pid |
| 逃逸担忧的评估 | 逐条对照第五节；问"最坏情况拿到了什么"而不是"有没有洞" |

## 七、未实测清单

- 本文所有虚拟化机制——本机无 KVM/hypervisor 环境，未测。
- VMExit/VMEntry 的成本——未测（本站 os-what-kernel-does 的系统调用陷入成本可做量级参照，同为"进出内核"一族）。
- virtio 的性能——未测。
- gVisor/Firecracker 的实际行为——未部署。
