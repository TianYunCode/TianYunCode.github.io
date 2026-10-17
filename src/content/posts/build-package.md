---
title: 依赖管理：vcpkg 与 Conan
description: 未实测（本机未装 vcpkg/conan）：C++ 依赖的四种集成方式对比、manifest 模式与版本锁定、二进制缓存的命中结构、离线与内网构建的三条路线；附从"直接塞源码"迁移到包管理的决策树。
date: 2026-10-16
tags: [编译, 构建, vcpkg, Conan, 依赖管理]
category: build
section: build-package
---

> **本文性质声明**：本机没有 vcpkg、没有 Conan、没有私有 NuGet/Artifactory 实例——**所有内容为文档级知识**，用于建立选型地图。本篇引用本站其他章节的本机实测（build-cmake 的 target 模型、build-cross 的 sysroot、db-ddl-dml 的迁移校验思路）。任何"某个版本某个行为"以你手头工具的官方文档为准。

## 一、C++ 依赖的四种集成方式，按治理成本排序

| 方式 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **源码进仓库** | 第三方库作为 submodule 或直接 vendored | 零工具链依赖，离线可构建 | 仓库膨胀、升级靠手工、构建时间全量 |
| **find_package + 系统包** | `apt install libfoo-dev` / vcpkg 集成 | 系统级复用，构建快 | 版本跟着系统走，**CI 和生产机的版本漂移是噩梦源头** |
| **包管理器 manifest** | vcpkg manifest / Conan recipe，版本写进仓库 | **可复现构建**，版本锁定进 git | 要学一套工具，二进制缓存要维护 |
| **Conan 自建 remote** | 私有 Artifactory/conan-server | 组织级复用、内部库分发 | 基础设施成本 |

选型的核心问题是：**"别人 clone 你的仓库后，多久能构建成功"**。答案是"装三个系统包再说"的项目，在新人机器上必然卡住——系统包版本、名字、是否可选编译项全不受你控制。**把版本写进仓库（manifest 模式）是唯一能让 CI、同事、未来的你构建出同一个二进制的做法**。

## 二、vcpkg：微软的"装即用"路线

vcpkg 的模型：`vcpkg.json`（manifest）声明依赖，`vcpkg install` 从源码构建到 `installed/` 目录，CMake 通过 toolchain 文件自动找到。核心概念：

- **manifest 模式 vs classic 模式**：manifest（每个项目一个 `vcpkg.json`，版本锁 `vcpkg-lock.json`）是现代用法，**版本进 git，构建可复现**；classic（全局 `vcpkg install fmt`）只适合个人机器。
- **triplet**：目标平台描述（`x64-windows-static`、`arm64-linux`），决定 CRT 链接、动态/静态库。**和 build-cross 那节的 triplet 是同一个词**——包管理器把交叉编译抽象成"选 triplet"。
- **overlay ports / registry**：私有库通过自定义 port 或 registry 加入，不必 fork 整个 vcpkg。
- **二进制缓存**：`--binarysource=clear;default,readwrite`，配 Azure DevOps/NuGet 做远程缓存——同一个包第二次构建命中缓存，秒级完成。

工程实践：CI 里 `vcpkg install` 是构建的大头（首次全源码编译几十分钟），**缓存命中与否决定 CI 时长**——见 build-ci 那节的缓存策略。

## 三、Conan：C++ 的"包+配方"路线

Conan 的模型更接近 Python/Node 生态：中心化的 recipe（`conanfile.py` 描述怎么构建、依赖什么）+ profile（编译器/架构/构建类型）。核心概念：

- **profile**：`[settings] os/arch/compiler/compiler.version/build_type` 的组合，**一个包在不同 profile 下是不同的二进制 ID**——换编译器就重新构建，这是 C++ ABI 现实的直接映射（win-msvc-mingw 那节量过 MSVC 与 MinGW 的 ABI 不相认）。
- **options**：`-o shared=True -o fPIC=True` 一类开关进包 ID，**选项变了就是另一个包**。
- **lockfile**：`conan lock create` 固定传递依赖的精确版本——manifest 模式的标配。
- **revision（recipe revision）**：同一个版本号的 recipe 本身也参与 ID，配方改了缓存自动失效。

**vcpkg vs Conan 的实务差别**：vcpkg 偏"微软生态、Windows 友好、源码构建为主"；Conan 偏"跨平台、profile 严谨、二进制分发成熟、私有 remote 是标配"。选型看团队：全 Windows/MSVC 选 vcpkg 摩擦小；混合工具链/要私有分发选 Conan。**两个都别手写脚本调**——脚本调包管理器是失去 lockfile 的最快方式。

## 四、二进制缓存：命中的结构

CI 构建慢的账要算在"重复劳动"上：同一个依赖同一个编译器，每次 CI 都从源码编一遍。二进制缓存把这个劳动记忆下来：

```
缓存 key = 包名 + 版本 + recipe revision + profile + options + 依赖闭包的 ID
```

三个设计点：

1. **key 必须包含依赖闭包**：A 依赖 B，B 升级了，A 的缓存必须失效——传递依赖进 key 是基本要求，漏了就出现"用了旧 A 配新 B"的灵异现场。
2. **缓存要能读能写还要能清理**：CI 的缓存有容量上限和保留期，配 LRU 淘汰；命中率的健康值是 >80%（build-ci 那节量过同族问题）。
3. **本地也要缓存**：开发者机器和 CI 共享同一缓存后端（或至少同一种子），否则"我本地 30 秒 CI 20 分钟"的差异永远存在。

## 五、离线与内网构建的三条路线

不能连公网的环境（工厂内网、涉密、CI 隔离）：

1. ** vendoring 全套**：`vcpkg export` / `conan download` 把依赖的源码/二进制打包进仓库或内网制品库。构建机零外网依赖，代价是仓库/制品库变大。
2. **私有 registry/remote 镜像**：内网搭 NuGet/Artifactory/conan-server，缓存公网包的副本。开发体验最接近公网，代价是基础设施。
3. **sysroot 路线**：交叉构建把依赖预装进 sysroot（build-cross 那节实测过 MinGW 的 `--print-sysroot` 行为），工具链 + sysroot 打成一个镜像。**这是嵌入式/CI 容器的正统做法**——镜像即环境。

三条路线的共同点：**把"从公网取"变成"从仓库/镜像取"**。内网项目的构建时长和可复现性，90% 取决于这一层做没做。

## 六、从"源码塞仓库"迁移的步骤

存量项目迁移到 manifest 模式，按风险从低到高：

1. **先盘点**：`grep -r "third_party\|external\|vendor"` 找出所有内嵌依赖，列出名称、版本、 LICENSE。
2. **选一个试点**：用一个小依赖（如 fmt、spdlog）走通 manifest 流程，验证 CI 缓存命中。
3. **建 lockfile 进 git**：从这一刻起构建可复现。
4. **逐个迁移，旧的并行一段时间**：每个依赖迁移后跑全量测试；**别一次性大爆炸**——一次迁十个依赖，出问题无法归因。
5. **清理 vendored 副本**：确认无引用后删除，仓库瘦身（git 历史里的还在，要彻底瘦得 rewrite history，那是另一件事）。

迁移的验收标准（ borrowed from db-ddl-dml 的思路）：**新人 clone → 按 README 两条命令 → 构建成功**，全程不装任何系统包、不下载任何仓库外的东西。

## 七、未实测清单

- vcpkg/Conan 的任何实际行为、输出、耗时——本机未安装。
- 二进制缓存的命中率数字——未部署。
- 私有 registry 的搭建与鉴权——未部署。
- 各流行库的 recipe 质量差异——未评估。
- vcpkg 的 `x64-windows-static` triplet 与 Qt for MinGW 的 CRT 混用——未测（win-msvc-mingw 那节量过 -static 不静态化 msvcrt 的相关现象）。
