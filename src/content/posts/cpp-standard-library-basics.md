---
title: 常用标准库入门
description: 30 万次查找实测：map 比 unordered_map 慢 10 倍，sorted vector 二分反而快过 set；operator[] 会偷偷插入，reserve 让 push_back 快 2.4 倍。
date: 2026-10-15
tags: [C++, 标准库, 性能]
category: cpp
section: cpp-common-lib
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++23 -O2 -Wall`。下面每个数字都是本机实测（微秒），换机器绝对值会变，**相对关系基本稳定**。

## 一、四个访问方式的实测差距

30 万次访问一个已装好 30 万元素的容器：

```text
map operator[] 30923 µs | map find 28702 µs | umap operator[] 3101 µs | umap find 2810 µs
```

三个结论：

1. **`unordered_map` 比 `map` 快约 10 倍**（哈希 vs 红黑树，且缓存友好）。需要有序遍历才选 `map`。
2. **`operator[]` 比 `find` 慢 8%**，因为它要处理"键不存在则插入"的路径。
3. `operator[]` 的**真正危险不是慢，是它会插入**：

```cpp
std::map<int, int> m;
m.emplace(1, 100);
if (m[2] == 0) { }        // 看起来只是查询
std::cout << m.size();     // 2 ← 键 2 被偷偷插进来了
```

只读场景一律 `find`/`contains`（C++20）；要"存在才用"就 `if (auto it = m.find(k); it != m.end())`；要"不存在则插入"用 `try_emplace`（C++17，不覆盖已有值，且不要求 `mapped_type` 可默认构造）。

## 二、`reserve` 的收益实测

30 万个 `int` 三种填法：

```text
裸 push_back 1067 µs | reserve+push 443 µs | vector<int> v(N) 后赋值 1006 µs
```

- **`reserve` 后 `push_back` 快 2.4 倍**：省掉 18 次"分配 + 全量搬移 + 释放"。
- `vector<int> v(N)` 会先把 N 个元素**值初始化**（全写 0），再逐个赋值 → 白干一遍，只比裸 `push_back` 快一点点。要预留空间用 `reserve`，不是 `resize`。

字符串同理，但收益小得多：

```text
string += 不 reserve 988 µs | reserve(400000) 912 µs（结果长度 238890）
```

只快 8%——因为 `std::string` 的 `+=` 本身已经是摊还 O(1) 倍增，且这里的耗时大头是 `std::to_string`。这提醒我们：**优化前先看瓶颈在哪，别照搬"一定要 reserve"的教条**。

## 三、查找容器实测：sorted vector 赢了 `std::set`

20 万次未命中查询（容器里 30 万个偶数，查奇数）：

```text
sorted vector + 二分 8938 µs | std::set 13749 µs | unordered_set 1262 µs
```

- `unordered_set` 最快（O(1)），但**要求可哈希、无序、rehash 时迭代器失效**。
- **`std::set` 竟然比"排序数组 + 二分"还慢 53%**。理论上两者是 O(log n) 同级，但 `set` 的每个节点独立分配、指针跳转，缓存全 miss；`vector` 的二分虽然比较次数更多，却全在缓存行里。
- 实践排序：**静态数据用 sorted vector**（构建后不再变），**频繁插删 + 需要有序**才用 `set`，**只要成员判定**用 `unordered_set`。

## 四、算法优先于手写循环

```cpp
std::vector<int> v(1000000);
std::iota(v.begin(), v.end(), 1);            // 填 1..1000000
```

```text
accumulate 404 µs | reduce 199 µs | filter+transform 管道（无中间容器）706 µs
结果 500000500000 / 500000500000 / 500001000000
```

```cpp
auto s1 = std::accumulate(v.begin(), v.end(), 0LL);              // 顺序
auto s2 = std::reduce(v.begin(), v.end(), 0LL);                  // 可并行/向量化
for (int x : v | std::views::filter([](int x){ return x % 2 == 0; })
             | std::views::transform([](int x){ return x * 2; })) sum += x;
```

- **`std::reduce` 比 `accumulate` 快 2 倍**：`accumulate` 规定严格左结合顺序，`reduce` 允许重排，于是能被向量化。代价是**不满足结合律的运算不能用 reduce**（浮点求和结果会变、以及有副作用的操作符）。
- **ranges 管道比手写循环慢 76%**（706 vs 404µs 的累加），因为 `filter` 里那个 `x % 2 == 0` 是真正的除法，而且管道多一层间接。**"ranges 一定更快"是错的**——它的价值是不产生中间容器、可读性好、可组合；性能要测。
- 但注意：如果不用管道而要先 `filter` 到一个新 vector 再 `transform` 到另一个 vector，那才是真的慢（两次分配 + 两次遍历）。**管道省的是中间容器，不一定省时间。**

## 五、必会的十个算法

| 算法 | 用途 | 注意 |
| --- | --- | --- |
| `std::sort` | 排序 | 不稳定；要稳定用 `stable_sort`；比较器必须严格弱序 |
| `std::find` / `find_if` | 线性查找 | 返回迭代器，判 `== end()` |
| `std::binary_search` / `lower_bound` / `upper_bound` | 有序区间 | 先保证已排序，否则结果无意义 |
| `std::count_if` | 计数 | |
| `std::any_of` / `all_of` / `none_of` | 谓词判定 | 比手写循环清楚 |
| `std::transform` | 映射 | 输出容器要先 `resize` 或用 `back_inserter` |
| `std::copy` / `copy_if` | 搬移 | 目标要够大，或用 `std::back_inserter` |
| `std::remove_if` + `erase` | 条件删除 | `remove` 不改变容器长度，必须配 `erase` |
| `std::accumulate` / `reduce` | 归约 | 初值类型决定累加类型，`0` 与 `0LL` 差一个溢出 |
| `std::iota` | 填充递增序列 | |

两个高频错误：

```cpp
std::transform(a.begin(), a.end(), b.begin(), f);   // ❌ b 为空 ⇒ 越界写
std::transform(a.begin(), a.end(), std::back_inserter(b), f);  // ✅

v.erase(std::remove_if(v.begin(), v.end(), p), v.end());   // erase–remove：remove 单独用不删元素
std::erase_if(v, p);                                        // C++20 更短
```

## 六、`string` / `string_view` / `span` 的边界

| 类型 | 拥有内存 | 可为空 | 适用 |
| --- | --- | --- | --- |
| `std::string` | 是 | 是（`""` 合法） | 需要持有、要修改 |
| `std::string_view` | **否** | 是 | 只读参数、临时切片 |
| `std::span<T>` | **否** | 是（size 可为 0） | 数组 + 长度的安全替代 |
| `const char *` | 不定 | 是 | 只在 C 边界 |

三条铁律：

1. **`string_view` 不保证以 `\0` 结尾**，传给 `fopen`/`strlen` 前要么自己确认，要么 `.data()` 来自一个 `std::string`。
2. **不要返回指向局部量的 `string_view`/`span`**：

   ```cpp
   std::string_view bad() { std::string s = make(); return s; }   // 悬空
   ```

3. 函数参数是"只读的一串数"时，`std::span<const int>` 优于 `const std::vector<int>&`（能接受 `vector`、`array`、C 数组，且不锁死容器类型）。

## 七、`std::array`、`std::pair/tuple` 与结构化绑定

```cpp
std::array<int, 4> a{};                 // 零初始化，大小编译期固定，无堆分配
auto [x, y] = std::pair{1, 2.0};        // 结构化绑定
auto [w, h, name] = rect;               // 也能拆聚合类型（公有非静态成员）
```

`std::array` 是 C 数组的完全替代品：知道 `.size()`、可拷贝、可比较、能进容器、越界检查（`.at()`）。**新代码里不该再出现 `int arr[4]`**（除了和 C API 交界的地方）。

## 八、这一节的自查清单

- [ ] 只读查询用 `find`/`contains`，不用 `operator[]`（它会插入）
- [ ] 数量已知就 `reserve`，但先测瓶颈是不是这里
- [ ] 静态数据优先 sorted vector，别默认 `std::set`
- [ ] 需要哈希就用 `unordered_map` 并 `reserve`
- [ ] 能用算法就别手写循环，但 `reduce` 只在运算满足结合律时用
- [ ] `transform`/`copy` 的输出端用 `back_inserter` 或先 `resize`
- [ ] 条件删除用 `std::erase_if`（或 erase-remove）
- [ ] 只读参数用 `string_view`/`span`，并绝不返回悬空的视图
- [ ] 用 `std::array` 替代裸数组
- [ ] `accumulate` 的初值类型写对（`0LL` 而不是 `0`）

下一节讲 C++ 元编程与 `constexpr`：编译期能算什么、`constexpr` 与 `consteval` 的边界、变参模板与折叠表达式怎么写出类型安全的日志函数。
