---
title: 异常与错误处理策略
description: 一次 throw+catch 实测 4 微秒、比返回码慢十倍；析构函数抛异常和 noexcept 里抛异常都在编译期就被 -Wterminate 点出来；expected 的开销只有 24 字节。
date: 2026-10-15
tags: [C++, 异常, 错误处理]
category: cpp
section: cpp-error-strategy
---

> 环境：**GCC 13.1.0**，`g++ -std=c++23 -O2 -Wall`。所有耗时、大小、退出码都是本机实测。

## 一、异常的真实成本

```cpp
for (int i = 0; i < 200000; i++) {
    try { throw std::runtime_error("x"); }
    catch (const std::runtime_error &) { }
}
```

```text
throw + catch 200000 次：802.4 ms，单次 4012 ns
```

**一次抛出并捕获约 4 微秒**。作为对照，同一个"查找失败"的场景用三种写法各跑 20 万次：

```text
异常 643.0 ms   返回码 64.4 ms   expected 67.2 ms
```

- 异常路径比返回码慢 **约 10 倍**（这里主要是构造 `runtime_error` + 栈展开）。
- `std::expected` 与返回码基本同速（67 vs 64ms），但类型安全、强制调用方处理。

关键认知：**"零成本异常"（zero-cost landing pad，不用异常时不产生运行时代价）只对"不抛"成立。一旦真的抛出，代价是微秒级。** 所以：

| 场景 | 该用什么 |
| --- | --- |
| 罕见、不可本地恢复（内存不足、文件打不开、初始化失败） | 异常 |
| 高频、属于正常业务分支（解析失败、查找未命中、超时） | `expected` / 错误码 |
| 热循环内部 | 都不用，返回码或直接状态标志 |

用异常做控制流（`for(;;) try { pop(); } catch(empty&) { break; }`）是性能与可读性的双重灾难。

## 二、栈展开正是 RAII 的立身之本

```cpp
struct Guard { ~Guard() { ++cleanup; } };
try { Guard g1; { Guard g2; throw 1; } } catch (...) { }
```

```text
抛出穿过 2 个作用域，析构被调用 2 次
栈上 RAII 对象析构正常，无泄漏
```

**异常会沿栈回溯并逐层执行析构**——这就是 RAII 比"手动 free + 检查每个 return"可靠的根本原因：错误路径不需要你记得做任何事。

代价是：栈展开是异常 4µs 里的主要成分，展开深度越深越慢；而且它要求编译器为每个可能抛出的调用点生成 landing pad（这也是 `-fno-exceptions` 能缩体积的原因）。

## 三、两条会直接 terminate 的红线

### 红线一：`noexcept` 函数里抛异常

```cpp
void f() noexcept { throw 1; }
int main() { f(); }
```

编译期：

```text
warning: 'throw' will always call 'terminate' [-Wterminate]
```

运行期：

```text
before
terminate called after throwing an instance of 'int'
  exit=3
```

**不是"异常被吞掉"，是整个进程 `std::terminate`。** 而且它不会打印你 catch 的东西，也没有栈回溯可查。

### 红线二：析构函数抛异常

```cpp
struct S { ~S() { throw 1; } };
int main() { try { S s; } catch (...) { } }
```

```text
warning: 'throw' will always call 'terminate' [-Wterminate]
before
terminate called after throwing an instance of 'int'
  exit=3
```

注意：即使对象是在 `try` 块里构造的，析构函数抛异常仍然 terminate——因为析构可能发生在栈展开过程中，此时**两个异常同时在飞**，标准直接判死。

推论（务必记住）：

- 析构函数**隐式是 `noexcept`**（C++11 起），任何想从中抛出的代码都要自己吞掉。
- 日志 flush、关闭 socket 这类"可能失败"的操作，要么在析构外显式调用并检查，要么在析构里记内部状态标志、绝不抛。
- 线程/锁的封装（`std::thread` 的析构、`std::jthread`）之所以设计成"不 join 就 terminate"，就是这个道理。

好消息：这两类错误 **`-Wterminate` 能在编译期抓到**，务必开（它在 `-Wall` 里）。

## 四、异常安全等级：你的函数承诺到哪一级

| 等级 | 承诺 | 实现手段 |
| --- | --- | --- |
| 无保证 | 抛了就烂 | 别这样 |
| **基本保证** | 对象处于有效状态（值未定），无泄漏 | RAII 覆盖所有资源 |
| **强保证** | 要么全成，要么**完全回滚**，像没发生过 | copy-and-swap、prepare-then-commit |
| 不抛 | `noexcept` | 移动、交换、析构、哈希 |

强保证的标准实现就是 copy-and-swap：

```cpp
struct Safe {
    std::vector<int> data;
    void strong_update(std::vector<int> next) {   // 参数按值：可能抛的构造发生在函数外
        swap(data, next);                        // noexcept 交换
    }                                            // next 析构带走旧数据
};
```

```text
更新后 size=2 首元素=9
```

如果 `std::vector<int> next` 的构造抛出，函数体根本没执行，`data` 原封不动——**这就是"要么全成要么不动"**。反过来写成 `data = expensive_compute();`（原地改）就做不到。

`std::vector` 的 `push_back` 就是强保证（扩容失败时原容器不变），而 `emplace_back` 同样是——但前提是元素的移动/拷贝构造不抛。这也是"移动必须 `noexcept`"的第三个理由。

## 五、跨语言边界：异常不能越界

这是 Qt 与 Win32 项目里最容易出事的地方：

| 边界 | 后果 |
| --- | --- |
| 异常穿过 C 栈帧（回调、`qsort` 比较器、窗口过程） | **未定义行为**（C 没有 landing pad，通常直接崩或栈错乱） |
| 异常穿过 Qt 信号 → 槽 | Qt 明确说"从槽抛出的异常会传播回发射者"，但**跨 Qt 事件循环边界（queued connection、槽里再抛）就是未定义** |
| 异常穿过 Win32 API（SEH ↔ C++ 异常） | 需要 `/EHsc`；`/EHs` 与 `/EHa` 行为不同，MinGW 默认可能不匹配 |
| 线程函数里抛出没接住 | `std::terminate` |

实践规则：

1. **所有回调入口包一层 `try/catch`**，把异常转成错误码或日志：

   ```cpp
   extern "C" int on_event(void *self, int code) try {
       return static_cast<Handler *>(self)->handle(code);
   } catch (const std::exception &e) { log(e.what()); return -1; }
     catch (...) { return -2; }
   ```

2. **Qt 槽函数不抛异常**；需要报告错误就用返回值/信号/状态成员。
3. `main` 最外层留一个 `try/catch(...)` 兜底，把 `what()` 打进日志再退出（比裸 terminate 好排查一百倍）。
4. 线程入口用 `std::packaged_task` 或手写 catch 把异常转成 `future`，别让它逃逸。

## 六、`std::error_code`、`expected` 与错误码的取舍

```text
sizeof(std::error_code)=16   sizeof(std::expected<int,std::string>)=40   sizeof(std::expected<int,std::error_code>)=24
```

- **`int` 错误码**：最省，但语义丢失（`-1` 是什么？），且能被忽略。
- **`std::error_code`（16 字节）**：带 category，能表达"这是 errno 还是 Windows API 错误还是我自己的域"，跨库传递最合适，`std::errc` 覆盖 POSIX 语义。
- **`std::expected<T, E>`（24 字节起）**：编译期强制调用方处理，支持单子链式调用，是"高频可恢复失败"的现代答案：

  ```cpp
  std::expected<int, std::string> find_with_expected(const std::vector<int> &v, int target);

  auto f = find_with_expected({1,2,3}, 9);
  if (!f) log(f.error());
  int x = f.value_or(0);
  auto y = find_with_expected(v, 1).and_then(scale).or_else(fallback);   // 单子
  ```

  ```text
  命中：2；未命中： 没找到 9
  ```

  实测 `expected` 路径与返回码同速（67ms vs 64ms），却带类型安全和可组合性。**GCC 13.1.0 已完整支持 `<expected>`**（上一节矩阵实测 ✅）。

选型建议：库的公开接口用 `expected`（或 `error_code` 出参，兼容 C）；应用层罕见致命错误用异常；性能敏感的热路径用返回码。

## 七、这一节的自查清单

- [ ] 析构函数、`swap`、移动构造/赋值一律 `noexcept`，且真的不抛
- [ ] 不在 `noexcept` 函数和析构里抛异常，开 `-Wterminate`（`-Wall` 已含）
- [ ] 高频可恢复失败不用异常（实测单次 4µs）
- [ ] 需要"要么全成要么不动"的操作用 copy-and-swap 或 prepare-then-commit
- [ ] 所有 C 回调、窗口过程、Qt 槽的入口包 `try/catch` 转成错误码
- [ ] `main` 最外层兜住 `std::exception` 与 `...`，记录后再退出
- [ ] 线程函数不逃逸异常（`packaged_task` 或手写 catch）
- [ ] 新代码优先 `std::expected`，跨语言边界才退回错误码
- [ ] 不要为了"看起来现代"给每个函数加 `noexcept`——只在它真的不抛、或你需要那个优化承诺时加

下一节讲 RAII 与三法则的实战形态：`scoped_lock`、退出回调、句柄封装类，以及怎么把"资源一定被释放"变成编译器能保证的事。
