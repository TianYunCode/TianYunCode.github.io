---
title: STL 容器与迭代器
description: vector 每次翻倍的实测序列、reserve 把 15 次分配变成 1 次、list 遍历比 vector 慢 16.7 倍、emplace_back 省掉的正好是那 5 次移动——容器选型的数字版。
date: 2026-10-15
tags: [C++, STL, 容器]
category: cpp
section: cpp-stl
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17 -O2`（libstdc++）。下面所有容量、耗时、分配次数都是本机实测；换实现（MSVC STL、libc++）数字会变，结论方向不变。

## 一、`vector` 的扩容策略：实测是 2 倍

```cpp
std::vector<int> v;
for (int i = 0; i < 64; i++) { v.push_back(i); /* 容量变化时打印 */ }
```

```text
size= 1 capacity= 1
size= 2 capacity= 2   增长比 2.00
size= 3 capacity= 4   增长比 2.00
size= 5 capacity= 8   增长比 2.00
size= 9 capacity=16   增长比 2.00
size=17 capacity=32   增长比 2.00
size=33 capacity=64   增长比 2.00
```

本机 libstdc++ 是**严格 2 倍**。libc++ 也是 2 倍，MSVC STL 是 1.5 倍——所以**永远不要把某个增长比写进代码逻辑**。

倍增的数学结果是：n 次 `push_back` 的**总搬移次数是 O(n)**（等比级数），摊还到每次是 O(1)。这就是"vector 尾部插入很快"的真正理由，也是它比 `list` 更值得默认选择的原因。

## 二、`reserve` 到底省了什么

用重写的 `operator new` 计数：

```text
不 reserve：operator new 调用 15 次
reserve(10000)：operator new 调用 1 次
```

10000 次 `push_back` 触发 15 次分配（log₂10000 ≈ 13.3，加上初始几次，吻合）。`reserve` 之后只剩 1 次。**省掉的是 14 次"分配 + 全量搬移 + 释放"**。

规则：

- **能预估数量就 `reserve`**，尤其是元素较大、拷贝不便宜、或要放几十万个的时候。
- `reserve` 只改容量不改大小，`resize` 才构造元素。
- `shrink_to_fit` 是**非约束请求**（可能被忽略），而且会引发一次搬移；不要指望它，也不要为了省那点内存反复调用。
- 清空但保留容量用 `clear()`；真正要还内存给系统，只能构造一个空 vector 再 swap（`std::vector<T>().swap(v);`）。

## 三、迭代器失效：用 `data()` 指针亲眼看到

```cpp
std::vector<int> b; b.reserve(4);
for (int i = 0; i < 4; i++) b.push_back(i);
const int *before = b.data();
b.push_back(9);                    /* 超出 capacity，必须重新分配 */
```

```text
扩容前 data=000001f2b6927ab0 扩容后 data=000001f2b6927ad0 变了=1
⇒ 之前所有迭代器/指针/引用全部失效
```

指针变了，意味着所有指向旧缓冲区的迭代器、`&v[0]`、`begin()+i` 全部悬空。**这是 C++ 里最经典的崩溃来源**，而且它"平时不崩"——旧内存往往还在进程地址空间里，读到的是过期值。

### 失效规则表（`vector`/`deque`/`list`/关联容器）

| 操作 | 失效范围 |
| --- | --- |
| `vector::push_back`/`insert`/`resize`/`reserve`（触发扩容） | **全部**迭代器与引用 |
| 同上但未扩容 | 插入点及其之后的迭代器；引用仍有效 |
| `vector::erase` | 被删元素及其之后的全部迭代器 |
| `std::list`/`forward_list` 的 `insert`/`erase` | 仅被删元素的迭代器（**节点式容器地址稳定**） |
| `deque` 两端插入 | 迭代器全部失效，但**引用**仍有效 |
| `deque` 中间插入/删除 | 全部迭代器与引用 |
| `map`/`set` 插入 | 不失效（节点式，地址稳定） |
| `map`/`set` 删除 | 仅被删元素的迭代器 |
| `unordered_*` 插入导致 rehash | 迭代器全失效；**元素引用仍有效**（节点式） |
| `unordered_*` 删除 | 仅被删元素 |

由此得出两个高频正确写法：

```cpp
/* 边遍历边删：用 erase 的返回值 */
for (auto it = v.begin(); it != v.end(); )
    if (should_drop(*it)) it = v.erase(it);   // erase 返回下一个有效迭代器
    else                  ++it;

/* 条件删除：erase-if（首选，不会写错迭代器自增） */
std::erase_if(v, should_drop);                 // C++20；vector 专用
v.erase(std::remove_if(v.begin(), v.end(), should_drop), v.end());   // erase-remove 惯用法
```

## 四、`emplace_back` vs `push_back`：差的是那一次移动

```cpp
std::vector<Counted> c; c.reserve(10);
for (int i = 0; i < 5; i++) c.push_back(Counted(i));   // 先构造临时量，再移动进容器
for (int i = 0; i < 5; i++) c.emplace_back(i);         // 参数直接转发给构造函数
```

```text
push_back(Counted(i)) x5：就地构造 5 拷贝 0 移动 5
emplace_back(i)      x5：就地构造 5 拷贝 0 移动 0
```

`emplace_back` 把参数**就地构造**在容器内存里，省掉一次临时量的构造 + 一次移动。元素移动便宜时差别不大，元素是 `std::string`/`std::vector` 这类"移动=搬指针"时差别也不大；真正划算的是**构造成本高**或**数量巨大**的场景。

两个注意点：

1. `emplace_back` 会绕过 `explicit` 构造函数的检查吗？不会——它是直接构造，`explicit` 依然生效。但**它可能匹配到你没想到的重载**（因为参数被原样转发）。
2. `std::vector` 的 `emplace_back` 在需要扩容时仍然要搬移全部元素，**并不省掉扩容成本**，所以 `reserve` + `emplace_back` 才是完整答案。

## 五、`std::string` 的 SSO：15 字符是免费线

```text
"hi"（2 字节）        容量 15   ← 小字符串优化缓冲区
15 字节（SSO 边界）    容量 15
16 字节（刚超界）      容量 16
30 字节                容量 30
累加 100 次 10 字节：最终 size=1000 capacity=1920
```

libstdc++ 的 `std::string` 对象本体 32 字节，其中内嵌 **15 字符**的缓冲区（`sizeof(std::string)=32`，实测）（第 16 字节留给 `\0`）。长度 ≤15 的字符串**不产生堆分配**，所以：

- 短字符串成员（如状态码、单位、键名）用 `std::string` 几乎免费，不必自己写 `char buf[16]`。
- 频繁拼接要 `reserve`：上面 100 次 `+=` 把容量推到 1920（约 2 倍增长，实际是 15→30→…→1920），最终浪费了近一倍。预先 `reserve(1000)` 就只分配一次。
- 只读参数用 `std::string_view`（C++17），避免"为了调用函数而构造 string"。但注意 `string_view` **不持有内存**，返回局部串的 `string_view` 是经典悬空。

## 六、缓存才是主角：`vector` vs `list` 实测

同样放 200 万个 `int`，顺序遍历求和：

```text
vector 1ms    list 18ms    比值 16.7 倍（校验和相同）
```

理论上两者都是 O(n) 遍历。差 16.7 倍的原因全在硬件：

- `vector` 的数据连续，硬件预取器一路命中，缓存行了不浪费。
- `list` 每个节点是独立 `new` 出来的小块（数据 + 前指针 + 后指针，再加分配器头），地址随机分布，每次 `++it` 都是一次缓存未命中，甚至一次 TLB miss。

顺带把容器对象本身的大小也量一下（`sizeof(容器)` 与元素个数无关）：

```text
sizeof(std::string)=32  sizeof(std::vector<int>)=24  sizeof(std::list<int>)=24  sizeof(std::map<int,int>)=48
```

`vector` 是 3 个指针（起、终、容量尾），`map` 是 48 字节（红黑树根 + 节点计数 + 比较器占位）。这些常数在换 STL 实现时会变，需要精确内存预算时自己量。

**结论：教科书上"频繁中间插入用链表"的建议在现代机器上大部分时候是错的。** 真实项目里 `vector` + 下标 + 批量搬移，几乎总是赢过 `list`。`std::list` 只在两种情况下值得用：① 需要**地址/迭代器稳定**（有长期持有的迭代器，比如 LRU 表的链表部分）；② 元素巨大且移动代价高，中间插入的搬移成本无法接受。

## 七、`map` vs `unordered_map`：20 万次插入

```text
std::map 26ms    unordered_map 8ms
map 的 size=200000（有序），unordered 的 size=200000 bucket=410857 load_factor=0.49
```

- `unordered_map` 快 3 倍多，代价是**无序**、rehash 时迭代器失效、以及最坏情况 O(n)（哈希冲突退化）。
- 注意 `bucket=410857` 而元素 20 万，`load_factor=0.49`——我提前 `reserve(N/5)` 过，所以桶数偏多、内存换时间。**不 reserve 的话会在插入过程中反复 rehash**，那才是常见的性能悬崖。
- 需要**有序遍历、范围查询（`lower_bound`/`upper_bound`）、稳定的迭代器**时用 `std::map`。
- 键是整数且范围可控时，`std::vector` 当索引表比两者都快；键是短字符串时，考虑 `absl::flat_hash_map` 或自己开放寻址。

## 八、容器选型速查

| 需求 | 选择 |
| --- | --- |
| 默认容器，尾部增删 + 随机访问 | `std::vector` |
| 元素固定数量、编译期已知大小 | `std::array` |
| 两端进出（队列、滑动窗口） | `std::deque`（注意中间插入会全失效） |
| 需要地址稳定 + 频繁中间插删 + 小数量 | `std::list`（先确认性能真的够） |
| 键值、要有序或范围查询 | `std::map` |
| 键值、只要查得快 | `std::unordered_map` + `reserve` |
| 去重集合 | `std::set` / `unordered_set` |
| 位集合 | `std::vector<bool>`（代理对象，慎用 `auto&`）或 `boost::dynamic_bitset` |
| 变长且要零碎片 | 自己写 arena（C 专栏第八节） |

## 九、这一节的自查清单

- [ ] 数量可预估时先 `reserve`，别依赖增长比
- [ ] 记住"扩容即全失效"，`push_back` 之后不再使用旧迭代器/指针/引用
- [ ] 边遍历边删一律用 `it = c.erase(it)` 或 `erase_if`
- [ ] 需要地址稳定就明确选节点式容器，并在注释里写清为什么
- [ ] 优先 `vector`，用 `list` 前先测（本机实测差 16.7 倍）
- [ ] `emplace_back` 用于省构造+移动，但不能替代 `reserve`
- [ ] 短字符串靠 SSO 免费，长拼接先 `reserve`
- [ ] 只读参数用 `string_view`，注意它不持有内存
- [ ] `unordered_map` 记得 `reserve`，避免插入过程中反复 rehash
- [ ] 换 STL 实现（MSVC/libc++）后重新测，别把某平台的常数当真理

下一节讲 C++ 版本特性时间线：从 C++11 到 C++23，每个版本到底解决了什么问题，以及项目该选哪个标准、如何与 Qt/编译器版本对齐。
