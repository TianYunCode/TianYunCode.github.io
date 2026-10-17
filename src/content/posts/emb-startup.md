---
title: 启动流程与链接脚本
description: 未实测（本机无开发板）：从上电到 main 之间发生的五件事、向量表与栈初始化的细节、链接脚本的段布局与控制、.data 拷贝与 .bss 清零的代码与常见错误。
date: 2026-10-16
tags: [嵌入式, 启动流程, 链接脚本, Reset_Handler, BSS]
category: embedded
section: emb-startup
---

> **本文性质声明**：本机无开发板，**全部内容未实测**，为手册级框架。站内对照：build-object-files-sections-symbols（COFF/ELF 段与符号的本机实测）、linux-elf（ELF 装载的 Linux 侧对照）。

## 一、从上电到 main：硬件替你做的和你要做的

Cortex-M 上电后的硬件动作（芯片固定，不用写代码）：**取初始 SP = `*(uint32_t*)0x0`、取初始 PC = `*(uint32_t*)0x4`、切到 Thread 模式 + MSP**。所以启动代码的全部使命是：**把向量表放对地方、把内存初始化好、调 main**。启动文件（`startup_xxx.s` 或 C 版）的骨架：

```asm
Reset_Handler:
    bl  SystemInit        ; 1. 时钟/电源初始化（厂商库）
    ldr r0, =_sidata      ; 2. .data 的 Flash 源地址
    ldr r1, =_sdata       ;    RAM 目的地址
    ldr r2, =_edata
    bl  copy_loop         ;    逐字拷贝（站点： emb-startup 核心）
    ldr r0, =_sbss        ; 3. .bss 清零
    ldr r1, =_ebss
    movs r2, #0
    bl  zero_loop
    bl  main              ; 4. 进 main
    b   .                 ; 5. main 返回了？死循环（或重启）
```

五件事每件的坑：**向量表地址**（`VTOR` 寄存器，bootloader 跳转后要重设）；**SystemInit 的时钟**（外设时钟不开，后面全废）；**拷贝和清零的边界符号**（链接脚本定义，写错就是"全局变量初值不对"或"bss 不清零"的灵异 bug）；**栈顶符号**（向量表第一项 = `_estack`，通常是 SRAM 最高地址）；**main 返回的处理**（裸机 main 返回会回到启动代码，必须兜住）。

## 二、向量表：不只是中断

向量表（vector table）在 Flash 开头，布局固定：

```
[0]  初始 MSP
[1] Reset_Handler 地址
[2] NMI
[3] HardFault
[4..15] 其余内核异常（MemManage/BusFault/UsageFault/SVC/PendSV/SysTick）
[16..] 厂商外设中断（USART1_IRQHandler、EXTI0_IRQHandler……数量由芯片定）
```

三个实践点：

1. **弱符号（weak）**：启动文件把所有 handler 定义成 `Default_Handler` 的 weak 别名——用户只重写自己关心的那个（`USART1_IRQHandler`），没重写的自动落到死循环。**忘了写 handler 的中断来了 = 进 Default_Handler 死循环**，现象是"程序卡住不动"。
2. **重定位**：有 bootloader 时，应用的中断向量表在 Flash 别处，启动第一件事是 `SCB->VTOR = 应用向量表地址`——忘了这步，中断跳回 bootloader 的向量，直接跑飞（emb-bootloader 会回到这）。
3. **表放对 section**：链接脚本里 `.isr_vector` 必须是第一个（`KEEP(*(.isr_vector))`——**没有 KEEP，链接器的 `--gc-sections` 会把它当未引用节删掉**，现象是上电就跑飞）。

## 三、链接脚本：段布局的宪法

GNU ld 的脚本（`.ld`）决定"哪个输入节进哪个输出节、落在哪个地址"：

```ld
MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 128K
}
SECTIONS
{
  .text : {
    KEEP(*(.isr_vector))        ; 向量表必须在最前
    *(.text*) *(.rodata*)
  } > FLASH
  _sidata = LOADADDR(.data);    ; 拷贝的源（Flash 里的位置）
  .data : { _sdata = .; *(.data*) _edata = .; } > RAM AT > FLASH
  .bss  : { _sbss = .; *(.bss*) *(COMMON) _ebss = .; } > RAM
  _estack = ORIGIN(RAM) + LENGTH(RAM);   ; 栈顶
}
```

四个必懂的概念：

1. **`> RAM AT > FLASH`**：`.data` 的**运行地址在 RAM、装载地址在 Flash**——启动代码从 `_sidata`（= LOADADDR）拷到 `_sdata`。忘了 `AT>` 就是最常见的"变量初值是错的"。
2. **`*(COMMON)`**：未初始化的全局变量在 COMMON 节，**漏了它 BSS 清零就不全**（本站 build-object 量过 `-fno-common` 与弱符号的关系，MCU 侧同样要显式包含）。
3. **`KEEP`**：防 `--gc-sections` 删掉没人"引用"但必需的节（向量表、某些寄存器区）。
4. **`_estack`**：向量表第一项从这取——**RAM 大小配错（LENGTH）时栈会溢出到未映射区**，现象是随机 hardfault。

## 四、.data 拷贝与 .bss 清零：自己写，别抄错

C 版启动代码（比汇编可读）：

```c
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss;
void Reset_Handler(void) {
    uint32_t *src = &_sidata, *dst = &_sdata;
    while (dst < &_edata) *dst++ = *src++;      // .data: Flash → RAM
    for (dst = &_sbss; dst < &_ebss; ) *dst++ = 0;  // .bss: 清零
    main();
    for (;;) ;                                  // 兜底
}
```

三个常见错误：**拷贝方向反了**（Flash 不能写，表现为启动就 hardfault）；**`while` 写成 `do-while`**（BSS 为空时清零循环多清一个字——踩到栈顶）；**用 `memcpy` 但它的运行依赖还没初始化**（libc 的 memcpy 在极端启动场景可能自身需要 .data——用字循环最稳）。

**C++ 的全局对象构造**：M3/M4 上 `__libc_init_array` 调 `_init` 跑全局构造——**链接时要确认它被调用**，否则全局 C++ 对象的构造函数不执行（表现为"对象在但成员是垃圾"）。

## 五、排障索引

| 症状 | 入口 |
| --- | --- |
| 上电就跑飞/不进 main | 向量表第一项不是 `_estack`；`VTOR` 错；栈顶符号算错 |
| 全局变量初值不对 | `.data` 没拷（`AT>` 漏了）或 `_sidata` 取错 |
| BSS 不清零 | `*(COMMON)` 漏了；清零循环边界错 |
| 大数组让 Flash 超了 | 常量进 `.rodata` 查 `objdump -h`；考虑压缩/外部 Flash |
| 加了 bootloader 后异常 | `VTOR` 没重设到应用向量表（第二节第 3 点） |
| 用 --gc-sections 后启动失败 | 向量表/启动节没 `KEEP` |

## 六、未实测清单

- 本文所有启动行为——无开发板，未测。
- 具体芯片的向量表布局——以你的 Reference Manual 为准。
- 全局构造的时机——未测。
- 各 GCC 版本的启动代码模板差异——未对比（CubeMX/厂商 SDK 自带的可作基线）。
