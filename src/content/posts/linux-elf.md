---
title: 动态库、ELF 与装载
description: 未实测（本机无 Linux）：ELF 的段与节的映射、符号表/重定位/PLT/GOT 的协作、动态库搜索路径的五层顺序、LD_PRELOAD 插桩、可见性属性与体积优化的实测口径。
date: 2026-10-16
tags: [Linux, ELF, 动态链接, LD_PRELOAD, 符号]
category: linux
section: linux-elf
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。Windows 对侧的本机实测见 build-object-files-sections-symbols（COFF 段与符号表）、build-static-shared-libraries-and-link-order（导入库与链接顺序）、build-link-and-symbol-troubleshooting（undefined reference 的诊断路径）。

## 一、ELF 的结构：段（segment）与节（section）

ELF 文件头之后是两类表：**节（section）**给链接器用（`.text`/`.data`/`.bss`/`.rodata`/`.symtab`/`.strtab`/`.rela.text`），**段（segment）**给加载器用（`LOAD` 段把若干节打包成页对齐的内存映射）。关系：**一个 LOAD 段包含多个节**——加载器只认段，节是链接期概念。

| 节 | 内容 | 内存属性 |
| --- | --- | --- |
| `.text` | 代码 | r-x |
| `.rodata` | 常量、字符串字面量 | r-- |
| `.data` | 已初始化全局/静态变量 | rw- |
| `.bss` | 未初始化（**不占文件字节**，只占内存，加载时清零） | rw- |
| `.got`/`.plt` | 全局偏移表/过程链接表（动态链接的跳板） | rw-/r-x |
| `.symtab` | 符号表（strip 后没了） | 不加载 |

**`readelf -l` 看段、`-S` 看节、`-s` 看符号**——三个命令覆盖 90% 的 ELF 排障。`.bss` 不占文件是"1MiB 未初始化数组的 .o 只有 748 字节"的原因（本站 build-object 在 Windows/COFF 侧实测过同款现象）。

## 二、动态链接的三角：符号表、重定位、PLT/GOT

静态链接期：链接器给每个未定义符号找定义，写**重定位**（"这个位置要填符号的最终地址"）。动态链接期这三件事延后到装载时：

1. **符号解析**：`ld.so` 按依赖顺序（可执行 → DT_NEEDED 的库，广度优先）建全局符号表。**符号冲突时先到先得**——这就是 `LD_PRELOAD` 能生效的原理（第四节）。
2. **重定位**：`R_X86_64_GLOB_DAT`/`JUMP_SLOT` 一类条目在装载时或懒绑定首次调用时填写。
3. **PLT/GOT 跳板**：调用 `printf` 实际跳到 `.plt` 的一小段，经 `.got` 槽位间接到真地址。**懒绑定（`-z lazy`，默认）**：首次调用才解析——省启动时间，但每次跨库调用多一跳；`-z now` 全部启动时解析——启动慢但可预测（且是安全加固的常规项）。

**`LD_DEBUG=bindings ./a.out`** 能看到每一次符号绑定的过程——"为什么调到了错误的库函数"的标准诊断（哪个文件、哪个地址、哪个符号赢了）。

## 三、动态库搜索路径的五层顺序

`ld.so` 找 `libfoo.so` 的顺序（从先到后）：

```
1. DT_RPATH（可执行里写的，已废弃）        2. LD_LIBRARY_PATH
3. DT_RUNPATH（链接时 -rpath 写的）        4. /etc/ld.so.cache（ldconfig 的缓存）
5. 默认目录 /lib、/usr/lib
```

实践要点：

- **RPATH 里写 `$ORIGIN`**（可执行所在目录）做"库放旁边"的便携部署——比改 LD_LIBRARY_PATH 干净（不污染环境、不怕拼错路径）。
- **`ldd ./a.out`** 看实际加载了哪些库、从哪来——"本地能跑发布版跑不了"的第一命令。
- **`ldconfig -p | grep foo`** 看缓存里有什么；改了 `/etc/ld.so.conf.d/` 要 `ldconfig` 重建缓存。
- 安全侧：**setuid 程序忽略 LD_LIBRARY_PATH**（否则提权后门）——依赖注入类漏洞的常见入口。

## 四、LD_PRELOAD：符号插桩的标准姿势

`LD_PRELOAD=/path/to/hook.so ./target` 让你的库**优先于所有其他库**解析符号——劫持 `malloc`/`open`/`connect` 一类调用的正规手段。经典应用：

```c
// hook.c：包装 malloc 计数
void* malloc(size_t n) {
    static void* (*real)(size_t) = NULL;
    if (!real) real = dlsym(RTLD_NEXT, "malloc");   // RTLD_NEXT = 下一个定义者
    void* p = real(n);
    count_malloc(p, n);
    return p;
}
```

三个坑：**`RTLD_NEXT` 是灵魂**（否则无限递归）；**多线程下计数要原子**；**被插桩程序的静态内联/直接系统调用不经过你**（GCC 可能把 `strlen` 内联——插桩覆盖率靠 `-fno-builtin` 或只插动态符号）。同类工具：`ltrace`（库调用跟踪）就是这套的用户态版。

## 五、可见性属性与体积优化

**符号默认全部导出**的库有三重代价：加载时符号表大、`dlsym` 可被劫持、ABI 面变大难维护。编译时收紧：

```c
__attribute__((visibility("hidden"))) void internal_helper(void);  // 只在本库可见
// 编译选项 -fvisibility=hidden 全局默认隐藏，公开 API 逐个标 default：
__attribute__((visibility("default"))) void public_api(void);
```

收益（本站 build-object 在 Windows 侧实测过 strip 的同类效果，Linux 侧数字未测）：`.dynsym` 缩小、装载变快、**意外的符号冲突消失**（两个库的内部同名函数不再互相顶）。

体积三板斧（口径：都是减少最终产物的字节，不影响语义）：`strip`（去 `.symtab`/`.debug_*`，调试符号单独归档，本站 engineering-version 提过符号归档）、`-ffunction-sections -fdata-sections` + `--gc-sections`（链接器删未引用节）、`-Os` 换体积（dbg-asm 提过优化档位的取舍）。**优化前先量**：`size`/`nm -S` 看谁占地方，别凭感觉砍。

## 六、排障索引

| 症状 | 命令 |
| --- | --- |
| `error while loading shared libraries: libfoo.so` | `ldd` 看缺哪个；`LD_LIBRARY_PATH`/RPATH |
| 符号版本冲突（`version GLIBC_2.xx not found`） | 在老系统上编新东西了；`objdump -T` 看版本需求 |
| 调用了错误的实现 | `LD_DEBUG=bindings` 看绑定过程 |
| 启动慢 | `LD_DEBUG=statistics`；改 `-z lazy`、砍不必要 DT_NEEDED |
| 库升级后行为变了 | 同名符号被另一个库抢先（第三节顺序）；`LD_PRELOAD` 你的版本验证 |

## 七、未实测清单

- 本文所有 ELF/动态链接行为与命令输出——无 Linux 环境，未测。
- 懒绑定 vs `-z now` 的启动差异、可见性属性的体积收益数字——未测（Windows 侧 strip 的实测见 build-object）。
- PIE/ASLR 与重定位类型（本站 build-configuration 实测过 Windows 侧 PIC 是恒开的，Linux 侧未对比）。
- glibc 的版本符号机制细节——未展开。
