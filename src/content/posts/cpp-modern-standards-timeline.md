---
title: C++11 到 C++23 特性时间线
description: 每个版本到底解决了什么问题，以及一份本机 g++ 13.1.0 的实测支持矩阵——std::expected 已经能用，而 std::print、mdspan、deducing this 还不行。
date: 2026-10-15
tags: [C++, 版本特性, 编译器支持]
category: cpp
section: cpp-modern-versions
---

> 环境：**GCC 13.1.0**（MinGW-Builds x86_64-posix-seh）。下面矩阵里每一项都是我把最小代码喂给 `g++ -std=c++NN -c` 实测得到的，不是查表抄的。

## 一、每个版本在解决什么问题

| 版本 | 一句话主题 | 关键特性 |
| --- | --- | --- |
| **C++98/03** | 基线 | 模板、异常、STL |
| **C++11** | **让 C++ 重新可写**：移动语义、`auto`、lambda、并发库、`constexpr`、`nullptr`、变参模板、`unique_ptr`/`shared_ptr`、范围 for、`thread`/`mutex`/`atomic` | 解决了"拷贝昂贵却无处可逃"和"手写线程不安全" |
| **C++14** | **补完 C++11 的毛刺**：泛型 lambda、变量模板、函数返回类型推导、`make_unique`、二进制字面量与数字分隔符 | 大多是把 C++11 里"差一点就能用"的东西补齐 |
| **C++17** | **库与语法的可用性爆发**：结构化绑定、`if constexpr`、折叠表达式、CTAD、inline 变量、`optional`/`variant`/`any`、`string_view`、`filesystem`、`std::apply`、并行算法（可选） | 消灭了"手写 pair+iterator"和"模板里靠继承做分支"两类样板 |
| **C++20** | **四大件**：concepts、ranges、coroutines、modules；外加 `<=>`、`format`、`span`、`consteval`/`constinit`、designated init、`atomic_ref` | 第一次让模板报错可读、让算法管道化 |
| **C++23** | **把 C++20 的东西做完整**：`expected`、`mdspan`、`print`、`generator`、deducing this、`if consteval`、静态 `operator()`、多维下标、monadic `optional` 操作 | 主要面向库作者与数值计算 |

一个实用判断：**学 C++ 的优先级是 C++11/14/17 打满，C++20 学 concepts + ranges + format 的用法，C++23 按需**。前三个版本是"每天都在写"的东西，后两个更多是"看到别人代码要能读懂"。

## 二、本机支持矩阵实测

每个特性写一段最小代码，用对应标准编译，结果：

```text
range-for                        c++11  ✅
auto/decltype                    c++11  ✅
lambda 捕获初始化                 c++14  ✅
generic lambda(auto)             c++14  ✅
make_unique                      c++14  ✅
变量模板                          c++14  ✅
函数返回类型推导                   c++14  ✅
结构化绑定                        c++17  ✅
if constexpr                      c++17  ✅
折叠表达式                        c++17  ✅
std::optional                     c++17  ✅
std::variant                      c++17  ✅
std::string_view                  c++17  ✅
CTAD                              c++17  ✅
inline 变量                       c++17  ✅
std::filesystem                   c++17  ✅
std::span                         c++20  ✅
concepts/requires                 c++20  ✅
spaceship operator<=>             c++20  ✅
designated initializers           c++20  ✅
consteval                         c++20  ✅
std::format                       c++20  ✅
ranges::views::iota               c++20  ✅
std::ranges::sort                 c++20  ✅
std::atomic_ref                   c++20  ✅
if consteval                      c++23  ✅
std::expected                     c++23  ✅
std::print                        c++23  ❌ fatal error: print: No such file or directory
std::generator                    c++23  ❌ fatal error: generator: No such file or directory
std::mdspan                       c++23  ❌ fatal error: mdspan: No such file or directory
deducing this                     c++23  ❌ error: expected identifier before 'this'
static operator()                 c++23  ❌ error: no match for call to '(S) ()'
```

**GCC 13.1.0 的意外收获**：`std::expected` 和 `if consteval` 已经可用（这两项通常被认为要等 GCC 14）。

**明确不行的**：`std::print`、`std::generator`、`std::mdspan`、deducing this、静态 `operator()` —— 这些是 GCC 14 才落地的。

### 两个测试过程中的坑（值得单独说）

第一次跑矩阵时，`if constexpr` 和 `operator<=>` 都报了 ❌，看着像编译器不支持。实际原因：

- `if constexpr` 我用了 `__is_integral(T)` 这个内部写法，语法不对；换成 `std::is_integral_v<T>` 并 `#include <type_traits>` 后 ✅。
- `operator<=>` 默认实现需要 `#include <compare>`（`std::strong_ordering` 在那里定义），漏了头就报 `'strong_ordering' is not a member of 'std'`，看起来像"不支持三路比较"。

**教训：判断"编译器是否支持某特性"，缺头文件和写错语法都会伪装成不支持。** 别照抄网上的支持表，也别用一次失败就下结论——查 `<version>` 里的 `__cpp_*` 宏最可靠：

```bash
g++ -std=c++23 -dM -E -x c++ /dev/null | grep __cpp_
```

## 三、`__cplusplus` 与标准宏的正确用法

本机实测 `g++ -dM -E -x c++ /dev/null` 得到 `__cplusplus 201703L`（GCC 13 的默认标准是 gnu++17）。关于这个宏有两条必须知道：

1. **MSVC 的 `__cplusplus` 默认恒为 `199711L`**，不管你用 `/std:c++17` 还是 `/std:c++20`——这是它为了兼容老代码刻意保留的行为，必须加 `/Zc:__cplusplus` 才会反映真实标准。本机是 MinGW 无法直接演示这一条，但它是跨平台项目里最常见的"标准判断失效"原因。
2. 判断**语言特性**用编译器扩展宏：`__has_feature`（Clang）、`_MSC_VER`、`__GNUC__`；判断**库特性**用 `<version>` 里的 `__cpp_lib_xxx` 宏（C++20 起标准强制要求）。
3. CMake 里用 `target_compile_features(mylib PUBLIC cxx_std_17)`，让依赖自动传播，比全局 `set(CMAKE_CXX_STANDARD 17)` 干净。

## 四、选标准的现实约束

| 约束 | 现实选择 |
| --- | --- |
| 车规/医疗（MISRA、老工具链） | C++03 或 C++11，GCC 4.8/ARM Compiler 6 |
| 嵌入式新板子（GCC 10+） | C++17 是甜点：够用、编译快、报错可读 |
| Qt 6 项目 | **最低 C++17**（Qt 6 要求），Qt 6.5+ 可用 C++20 |
| 桌面/服务端新项目 | C++20（concepts + format + ranges 一旦用上回不去） |
| 用第三方库多 | 取决于最旧的那个库的 ABI 与头文件标准 |

Qt 这条对你尤其实际：**Qt 6 本身要求 C++17**，所以 `optional`/`variant`/`if constexpr`/结构化绑定都可以直接用；`std::format` 与 concepts 在 Qt 6.5+/GCC 11+ 上也没问题，但如果要兼容 MSVC 2017 就得留后路。

## 五、几个"必须知道怎么用"的特性

### `std::optional`：可空返回值不再靠哨兵

```cpp
std::optional<int> parse(std::string_view s);
if (auto v = parse(s)) use(*v);          // 或 v.value() / v.value_or(0)
```

比返回 `-1` 或"输出参数 + bool"都好，且**不会误用未初始化的值**。注意 `*v` 不检查、`v.value()` 空时抛 `bad_optional_access`。

### `std::variant` + `std::visit`：类型安全的联合

```cpp
using Value = std::variant<int, double, std::string>;
std::visit([](auto &&v) { /* 用 if constexpr 分派 */ }, value);
```

配 C++17 的 `overloaded` 惯用法（多个 lambda 继承 `operator()`）比手写 tag switch 干净得多。C++20 的 `std::visit` 还能配合 `handle_type` 简化。

### `if constexpr`：模板里终于能写普通分支

第四节详细讲过，这里只补一句：**它替代的是 SFINAE 和标签转发**，而不是所有运行期分支。

### `std::format`：类型安全的 sprintf

```cpp
auto s = std::format("{:>{w}.2f}", 3.14159, w = 10);
```

编译期检查格式串（`FMT_COMPILE_TIME_CHECK`/GCC 13 起对字面量格式串做检查），比 `sprintf` 安全，比 `ostringstream` 快。GCC 13 已完整支持（实测 ✅），MSVC 2022 也支持；老工具链用 {fmt}（`std::format` 就是它标准化而来的）。

## 六、这一节的自查清单

- [ ] 项目里显式声明标准（CMake `cxx_std_17`/`20`），别依赖编译器默认值
- [ ] 判断库特性看 `__cpp_lib_*` 宏，判断语言特性看编译器版本宏，不用 `__cplusplus`（MSVC 会坑你）
- [ ] C++11/14/17 的特性当成默认武器：`auto`、range-for、`make_unique`、结构化绑定、`optional`
- [ ] 用 `if constexpr` 替换手写 SFINAE 分支
- [ ] 需要"要么有值要么没有"用 `optional`，"有限几种类型之一"用 `variant`，不再手写 tag union
- [ ] 上新特性前先在本机跑一段最小代码验证，别信网上的支持表（本节两个 ❌ 就是假的）
- [ ] 团队里统一标准版本，避免一半人用 C++17、一半人还在 C++11 写法
- [ ] 迁移大项目时按"先升标准、再改写法"两步走，别混在一个提交里

下一节讲对象模型与内存布局：虚表到底长什么样、多重继承下 `this` 指针为什么会变、`dynamic_cast` 为什么慢，以及用反汇编看一次虚函数调用的完整路径。
