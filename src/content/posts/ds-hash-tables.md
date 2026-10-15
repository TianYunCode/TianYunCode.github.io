---
title: 哈希表与冲突处理
description: 200 万次查找实测 unordered_map 110.6ms、sorted vector 542.7ms、map 2512.3ms；键步长为 4 时低位散列只用 25% 的桶；空桶率 21.6% 才是正常状态。
date: 2026-10-15
tags: [数据结构, 哈希表, 散列]
category: data-structures
section: ds-hash
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17 -O2`。分布统计和耗时都是本机实测。

## 一、散列函数的质量，用桶的分布来量

10 万个随机键、65536 个桶，三种散列：

```text
除留余数 k % 65521（素数）   平均 1.53  最大链长  9  空桶 21.6%
乘法散列（取高位）           平均 1.53  最大链长  8  空桶 21.7%
直接取低位 k & 65535         平均 1.53  最大链长  9  空桶 21.5%
```

**空桶约 21.6% 是正常状态**，不是 bug：n 个球随机扔进 n 个盒子，空盒比例趋近 1/e ≈ 36.8%（这里负载 1.53，理论空桶率 e^(-1.53) ≈ 21.7%，与实测吻合）。**看到"有桶是空的"就去"优化"散列函数，是外行行为。**

真正能暴露问题的是**换一种键的分布**：

```text
键步长为 4 时：只用到 16384/65536 个桶，最大链长 7（这就是低位散列的灾难）
```

键是 4 的倍数时，低 2 位恒为 0，`k & 65535` 永远落在 1/4 的桶里——**用掉 25% 的桶，其余 75% 全空，平均链长变成 4 倍**。而乘法散列（`k * 常数` 后取**高位**）没有这个问题，因为乘法把低位的信息"搬"到了高位。

结论：

- **低位掩码法（`& (m-1)`）只在校验过键的低比特足够随机时才可用**；一旦键是 ID 递增、地址、时间戳这类低相关性的数，必须先把键"打乱"（乘一个大奇数常数、或 `splitmix64`）再取位。
- 除留余数法用**素数**模数，是为了避免与键的周期产生公因子。
- 这就是为什么 `std::hash` 对整数在 libstdc++ 里其实就是恒等函数——**它把"打乱"的责任留给了容器的桶数选择（素数桶）**。

## 二、冲突处理：链地址 vs 开放寻址

| | 链地址法 | 开放寻址（线性/二次/双重散列） |
| --- | --- | --- |
| 删除 | 简单（摘节点） | 麻烦，需要"墓碑"标记 |
| 内存 | 每元素一个节点（指针 + 分配头） | 数组连续，无额外指针 |
| 缓存 | 差（链表跳转） | **极好**（顺序探测） |
| 高负载时 | 优雅退化（链变长） | 急剧恶化（聚集） |
| 负载因子上限 | 可 > 1 | 必须 < 1（一般 0.7） |
| 典型实现 | libstdc++ `unordered_map` | `absl::flat_hash_map`、Python 3.4+ dict、Rust `hashbrown` |

**现代实现几乎都转向了开放寻址（尤其 robin hood 和 SwissTable）**，因为真实负载下缓存命中带来的收益远大于指针的灵活性。libstdc++ 的 `unordered_map` 还是链地址，这是它在大量小对象场景下慢于 `absl` 的主要原因。

## 三、`std::unordered_map` 的四个性能陷阱

### 陷阱 1：不 `reserve`

200 万个随机 int 键插入：

```text
不 reserve：1132.7 ms（bucket 2938679, load 0.68）
reserve(N)： 787.6 ms（bucket 2144977, load 0.93）  差 1.4 倍
```

省掉的是插入过程中十几次 rehash（每次都要重建全部节点链接）。**知道规模就先 `reserve`。**

顺带注意两个数字：不 reserve 最后桶数 2938679、负载 0.68（因为最后一次 rehash 后没装满），reserve 后桶数 2144977、负载 0.93（贴着 `max_load_factor` 默认 1.0）。**reserve 更省内存还更快。**

### 陷阱 2：`operator[]` 会插入

```cpp
int n = counts["不存在"];     // counts 多了一个值为 0 的键
```

只读要用 `find` 或 C++20 的 `contains`。上一节 C++ 标准库实测过：map 的 `operator[]` 比 `find` 慢 8%，`unordered_map` 同样。

### 陷阱 3：迭代器与引用在 rehash 后失效——但引用不失效

`unordered_map` 是节点式容器：**rehash 后所有迭代器失效，但元素的引用/指针仍然有效**（节点没搬动，只搬了桶链）。这一点和 `vector` 完全不同，写代码时要清楚依赖的是哪个保证。

### 陷阱 4：哈希碰撞攻击

如果键来自不可信输入（HTTP 头、用户名、文件名），而 `std::hash` 可预测，攻击者可以构造大量同桶键，把 O(1) 查找打成 O(n)。防御：**用自己的带随机种子的哈希**（每次进程启动随机化一个盐），或者用 SipHash。这是真实的 DoS 手法，不是理论。

## 四、实测：三种容器的查找性能

200 万个键、200 万次查找（全部命中）：

```text
unordered_map        110.6 ms（命中 2000000）
sorted vector 二分   542.7 ms（命中 2000000）
map                 2512.3 ms（命中 2000000）
```

- `unordered_map` 比 `map` 快 **22.7 倍**，比排序数组二分快 **4.9 倍**。
- **`map` 慢的原因不是 O(log n) 本身**（21 层而已），而是红黑树的节点分散在堆上、每层一次指针跳转，缓存全 miss。
- 排序数组二分虽然比较次数更多（21 次），但访问模式是**在同一块连续内存里跳**，缓存友好得多——所以它只比哈希慢 5 倍而不是 20 倍。

选型顺序（只看点查）：`unordered_map`（要 reserve）→ 数据静态就用 sorted vector（更省内存、可序列化、无哈希函数）→ 需要有序/范围才用 `map`。

## 五、字符串键的成本

50 万个随机字符串（长度 4–15）：

```text
插入 50 万个 string 键 249.0 ms | 预先算好哈希再插入 146.4 ms
```

**字符串键的开销主要是两件事**：① 每次哈希要扫全部字符（O(len)）；② 桶冲突时还要 `strcmp` 逐字节确认。

优化手段：

- ** intern（驻留）**：把字符串映射成 id，之后全程用整数键。编译器、JSON 解析器、数据库都这么做。
- **预计算哈希**：把 `(hash, string)` 一起存，rehash 时不必重算——上面 1.7 倍的差距就是这个思路的收益。
- **`string_view` 做键**（要确保底层缓冲区生命周期更长，例如常量池）。
- 短字符串（≤ 8 字节）可以直接塞进 `uint64_t` 当整数键，零哈希成本。

## 六、手写一个最小哈希表（链地址）

```cpp
struct hash_table {
    struct slot { int key, val; slot *next; };
    std::vector<slot*> buckets;
    size_t n = 0, mask;

    explicit hash_table(size_t pow2 = 16) : buckets(pow2, nullptr), mask(pow2 - 1) {}
    static uint64_t mix(uint64_t k) {                      /* splitmix64：把低位信息打散 */
        k += 0x9e3779b97f4a7c15ull; k = (k ^ (k >> 30)) * 0xbf58476d1ce4e5b9ull;
        k = (k ^ (k >> 27)) * 0x94d049bb133111ebull;       return k ^ (k >> 31);
    }
    int *find(int key) {
        for (slot *s = buckets[mix(key) & mask]; s; s = s->next) if (s->key == key) return &s->val;
        return nullptr;
    }
    void insert(int key, int val) {
        if (n + 1 > buckets.size() * 3 / 4) grow();                       /* 负载 0.75 触发 */
        size_t b = mix(key) & mask;
        slot *s = (slot*)malloc(sizeof *s); s->key = key; s->val = val; s->next = buckets[b];
        buckets[b] = s; n++;
    }
    void grow() {
        std::vector<slot*> old = std::move(buckets);
        buckets.assign(old.size() * 2, nullptr); mask = buckets.size() - 1; n = 0;
        for (slot *s : old) while (s) { slot *nx = s->next; size_t b = mix(s->key) & mask;   /* 复用节点，不重新 malloc */
            s->next = buckets[b]; buckets[b] = s; n++; s = nx; }
    }
};
```

四个要点：

1. **`mix()` 打散低位**，直接对上第一节的实测——不做这一步，递增键会让低位散列崩掉。
2. **桶数取 2 的幂 + 掩码**，比取模快（一条 `and`），代价是必须靠 `mix` 保证高位质量。
3. **rehash 时搬移节点而不是重新分配**（`s->next = buckets[b]`），省一半时间。
4. 负载因子 0.75 触发扩容，是链地址法的常见折中（再高链就长了）。

## 七、这一节的自查清单

- [ ] 键有规律（递增 ID、地址、时间戳）时，绝不用裸低位散列，先 `mix`
- [ ] `unordered_map` 插入前先 `reserve`
- [ ] 只读查询用 `find`/`contains`，不用 `operator[]`
- [ ] 记住 rehash 使迭代器失效、但不使元素引用失效
- [ ] 键来自外部输入时，用带随机盐的哈希防碰撞 DoS
- [ ] 大量字符串键 → intern 成整数 id，或预计算哈希
- [ ] 静态数据集先考虑 sorted vector + 二分（省内存、可序列化、缓存友好）
- [ ] 空桶率约 20% 是正常的，别拿它当散列质量指标；要看最大链长和分布方差
- [ ] 需要更高性能时评估 `absl::flat_hash_map`（开放寻址 + SIMD 探测）

下一节讲图的最短路：Dijkstra 与堆的配合、Bellman-Ford 处理负权、SPFA 为什么被禁用、以及 A* 的启发函数怎么设计。
