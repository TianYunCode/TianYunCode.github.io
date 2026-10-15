---
title: 数组与字符串
description: 数组就是一段连续内存，这句话能解释 C 里九成的数组 bug。地址实测、退化规则、\0 终止符、strncpy 的陷阱，以及越界访问为什么"看起来能用"。
date: 2026-10-15
tags: [C语言, 数组, 字符串]
category: c-language
section: c-array-string
---

> 环境同前两节：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，`-std=c17 -Wall -Wextra -O0`。文中所有地址、字节数、退出码都是实测输出。

## 一、数组 = 一段连续内存

这句话不是比喻，是可以逐字节验证的：

```c
int a[5] = {10, 20, 30, 40, 50};
for (size_t i = 1; i < 5; i++) printf("%td ", (char *)&a[i] - (char *)&a[i - 1]);
```

```text
sizeof(a)=20  a 与 &a 数值相同：a=0000009716bffde0 &a=0000009716bffde0
相邻元素地址差：4 4 4 4 (字节)
```

每个元素间隔恰好 `sizeof(int)`，没有间隙、没有头部信息。由此直接推出四件事：

1. `a[i]` 就是 `*(a + i)` 的语法糖，所以**下标可以是负数**，只要指针往回指：

   ```c
   int *mid = &a[2];
   printf("mid[-1]=%d mid[-2]=%d\n", mid[-1], mid[-2]);   /* 20 10 */
   ```

2. 随机访问是 O(1)：地址算出来就行，不需要遍历。
3. 插入/删除是 O(n)：后面所有元素都得搬。
4. **长度不在数组里**，内存里没有任何地方记着"我有 5 个"。这是后面所有退化和越界问题的根源。

### 多维数组是行优先的一维内存

```c
int m[2][3] = {{1, 2, 3}, {4, 5, 6}};
printf("sizeof(m)=%zu sizeof(m[0])=%zu sizeof(m[0][0])=%zu\n", sizeof m, sizeof m[0], sizeof m[0][0]);
printf("&m[0][2] 与 &m[1][0] 差 %td 字节\n", (char *)&m[1][0] - (char *)&m[0][2]);
int flat[6];
memcpy(flat, m, sizeof m);
```

```text
sizeof(m)=24 sizeof(m[0])=12 sizeof(m[0][0])=4
&m[0][2]=0000009716bffdf8  &m[1][0]=0000009716bffdfc  差 4 字节 ⇒ 行与行首尾相接（行优先）
把整个二维数组当一维 memcpy 后：1 2 3 4 5 6
```

`m[0][2]` 和 `m[1][0]` 只差 4 字节——上一行的结尾紧接着下一行的开头，整个 `m` 就是一块 24 字节的连续内存，可以一次 `memcpy` 搬走。行优先的直接后果：**遍历二维数组时内层循环要沿着行走**。按列遍历会让每一步都跳过一整行，缓存全部失效，这在数值计算里是几倍的差距。

## 二、数组名退化：以及三个不退化的例外

绝大多数表达式里，数组名会转换成"指向首元素的指针"，这叫退化（decay）。但有三处**不退化**，忘了就会算错 `sizeof`：

| 场景 | 表达式的类型 | 实测结果 |
| --- | --- | --- |
| `a` 用在表达式里 | `int *` | `a + 1` 前进 **4** 字节 |
| `sizeof a` | 整个数组 | `sizeof a` = **20** |
| `&a` | `int (*)[5]` | `&a + 1` 前进 **20** 字节 |
| `char s[] = "abc"` 的右侧 | 用字面量初始化数组 | 拷贝 4 字节进数组，不是取指针 |

```text
a+1 前进 4 字节，&a+1 前进 20 字节
```

`a` 和 `&a` **数值相同、类型不同**：都指向同一块内存开头，但 `a + 1` 走一个元素，`&a + 1` 走整个数组。这个区别在指针算术里会真实改变结果。

### 退化之后 sizeof 就废了

```c
static void array_param(int arr[5]) {      /* 这里的 [5] 只是注释 */
    printf("sizeof(arr)=%zu ⇒ \"元素个数\"=%zu\n", sizeof arr, sizeof arr / sizeof arr[0]);
}
```

```text
main 里 sizeof(arr)/sizeof(arr[0]) = 5
函数内 sizeof(arr)=8 sizeof(arr[0])=4 ⇒ 算出的"元素个数"=2
```

编译器会警告，但**警告不等于错误**，代码照样编译通过：

```text
warning: 'sizeof' on array function parameter 'arr' will return size of 'int *' [-Wsizeof-array-argument]
```

所以规矩只有一条：**数组进函数，指针和长度成对传**。形参写 `int arr[5]`、`int arr[]`、`int *arr` 三者完全等价，`[5]` 不产生任何约束。

### 二维数组的形参必须保留"列宽"

```c
int f(int (*m)[3], int rows);   /* 合法：行宽 3 必须写进类型 */
int g(int m[][3]);              /* 同上，只是写法不同 */
int h(int m[][4]);              /* 列宽不同就是不同类型 */
```

因为编译器要算 `m[i][j]` 的地址：`base + (i * 列宽 + j) * sizeof(int)`——**列宽是地址计算的一部分，行数是参数所以可以不写**。把 `int a[2][3]` 传给 `h(int m[][4])`，本机只给警告不报错：

```text
warning: passing argument 1 of 'h' from incompatible pointer type [-Wincompatible-pointer-types]
```

然后一切照跑，读到的全是错位的数据。这类"警告后继续运行"的分支，就是必须开 `-Werror` 的理由。

## 三、初始化规则

```c
int partial[5] = {1, 2};
int all_zero[5] = {0};
int designated[4] = {[3] = 9, [1] = 7};
```

```text
部分初始化补齐：partial = 1 2 0 0 0
= {0} 清零：all_zero[4] = 0
指定初始化（乱序写，按下标落位）：designated = 0 7 0 9
```

- **写了初始化列表但没写满，剩余元素自动补 0**（不是随机值）。这是把结构体/数组清零最省事的办法。
- 没初始化的局部数组是**未定义内容**，别猜它是不是 0。静态存储期的数组才保证为 0。
- `[3] = 9` 这种指定初始化器（designated initializer）在 C 里**可以乱序写**，落位按下标来——上面实测 `0 7 0 9`。做"枚举 → 配置表"时非常好用。

## 四、字符数组与字符串字面量：差一个 `\0` 就是两种东西

```c
char withNul[] = "abc";
char *p = "abc";
char noNul[3] = {'a', 'b', 'c'};
char guard = 'Z';
```

```text
char a[]="abc": sizeof=4 strlen=3（自动补 \0）
char *p="abc":  sizeof(p)=8（只是个指针，指向只读段）
char a[3]={'a','b','c'}: strlen=6 ← 没有终止符，读到了相邻的 'Z'
```

三行代码三个教训：

1. `char a[] = "abc"` 会**拷贝**字面量（含 `\0`）进数组，`sizeof` 是 4，数组可写。
2. `char *p = "abc"` 只是让 `p` 指向只读段里的字面量，`sizeof(p)` 是指针宽度 8。**改它会当场段错误**：

   ```c
   char *p = "abc";
   p[0] = 'X';
   ```

   ```text
   Segmentation fault    退出码 = 139
   ```

   要可写就写 `char p[] = "abc";`。
3. 第三个数组**没有终止符**，`strlen` 一路读过数组末尾，读到 6——它把相邻的 `'Z'` 和后面的字节都当成了字符串内容。这是 UB，本机给出 6 只是运气。

### 内嵌 `\0` 会劈成两种"相等"

```c
char buf[8] = {'a', 'b', 0, 'c', 0, 0, 0, 0};
strlen(buf);            memcmp(buf, "ab\0cd", 5);   strcmp(buf, "ab\0cd");
```

```text
含内嵌 \0 的 5 字节数据：strlen=2 memcmp(5 字节)=-1 strcmp=0
```

同样两个缓冲区：`strlen` 认为只有 2 字节，`strcmp` 认为两者相等（都在第 3 字节看到 `\0` 就停了），`memcmp` 认为不等（老老实实比满 5 字节）。**结论：文本用 `str*` 系列，二进制数据必须显式带长度并用 `mem*` 系列。** 拿 `strlen` 去量图片、序列化的协议帧，就是这个坑。

## 五、字符串函数怎么选

### `strcpy` 永远不要用

它不检查目标缓冲区大小，源串多长就写多长。历史上大半的字符串溢出漏洞都来自它和它的兄弟 `sprintf`、`strcat`。

### `strncpy` 也不是安全版

```c
char dst[8];
strncpy(dst, "1234567890", sizeof dst);
```

```text
strncpy 截断后 dst = [12345678] 最后一字节 = 56（'8'）→ 没有 \0
```

它的语义是"最多拷 n 个字节"，**源串长度 ≥ n 时不补 `\0`**。紧接着 `printf("%s", dst)` 就会越界读。而且当源串短时它会把剩余空间全部填 0，在大缓冲区上是白白的性能开销。编译器对此有专门警告：

```text
warning: 'strncpy' output truncated copying 8 bytes from a string of length 10 [-Wstringop-truncation]
```

### 用 `snprintf`，并读懂它的返回值

```c
char dst[8];
int need = snprintf(dst, sizeof dst, "%s", "1234567890");
```

```text
snprintf 返回 10（本该写入的长度），dst = [1234567] 长度 7，一定有终止符
```

`snprintf` **保证**在缓冲区内留下 `\0`（除非 size 传 0），截断时安全。返回值是"如果缓冲区够大本该写入的字符数"（不含 `\0`），所以 `need >= sizeof dst` 就说明被截断了——这是判断截断的标准写法。

### 别忘了 `strlen` 是 O(n)

```c
for (size_t i = 0; i < strlen(s); i++)   /* 每轮都从头再数一遍，O(n²) */
```

编译器不一定能把它移出循环。要么先存进变量，要么直接遍历到 `\0`。

## 六、越界访问为什么"看起来能用"

这是 C 和带边界检查的语言最大的差别：**数组访问没有任何运行时检查**。`a[5]` 只是"从 `a` 起第 20 个字节开始读"，地址算得出来，指令就能执行。

```c
volatile int guard = 111;
int arr[3] = {1, 2, 3};
volatile int *raw = arr;
raw[3] = 999;              /* 越界：arr 只有 3 个元素 */
```

```text
写之前 guard=111，arr 与 guard 地址差 12 字节
写 arr[3]=999 之后 guard=999 ← 越界写踩到了相邻对象
```

`guard` 恰好排在 `arr` 后面 12 字节，也就是 `arr[3]` 的位置，于是它被无声地改成了 999。**程序没有崩，没有报错，只是某个变量的值从此不对了**——这就是越界最典型的破坏形式：症状出现在离病因很远的地方。

那编译器能帮忙抓吗？本机实测的答案是：抓不到。

```text
gcc -std=c17 -Wall -Wextra -O2 p9a.c        → 无输出
gcc -std=c17 -Wall -Wextra -O2 -Warray-bounds=2 p9a.c  → 无输出
gcc -std=c17 -O1 -fanalyzer p9a.c           → 无输出
```

对一个**字面量下标**的越界写，`-Wall -Wextra`、`-Warray-bounds=2` 甚至 GCC 的静态分析器 `-fanalyzer` 都没报。想靠编译器兜底是不现实的。

工具链层面还有 ASAN，但本机这个 MinGW 构建**不带 sanitizer 运行时**：

```text
ld.exe: cannot find -lasan: No such file or directory
```

（上一节提到的 `-fsanitize=undefined` 同理，`libubsan` 也没有。）要在 Windows 上用这些工具，得换 MSVC（`/fsanitize=address` 已支持）或 WSL/Linux 侧的 GCC/Clang。

所以越界的防线按有效性排序是：

1. **写的时候就别越界**：长度和指针成对传，循环条件用 `i < n` 而不是 `i <= n`，`unsigned` 长度先判 0。
2. **`-Wall -Wextra -Werror`**：至少把能报的都报出来，并且不让警告积累成噪音。
3. **换有 sanitizer 的工具链跑测试**（Linux/WSL 上的 `-fsanitize=address,undefined`），CI 里挂上。
4. 评审时专门看数组下标和 `memcpy`/`snprintf` 的长度参数。

## 七、这一节的自查清单

- [ ] 数组进函数一律"指针 + 长度"成对传，不用 `sizeof` 推算元素个数
- [ ] 清楚 `a`、`&a`、`a+1`、`&a+1` 各自的类型和步长
- [ ] 二维数组按行遍历；形参写清列宽；不把 `int (*)[3]` 传给 `int (*)[4]`
- [ ] 可写的字符串用 `char buf[N]`，绝不改写字符串字面量
- [ ] 手工构造的字符数组确认有 `\0`，或者根本不用 `\0` 结尾而是显式传长度
- [ ] 二进制数据用 `mem*` + 长度，不用 `str*` + `strlen`
- [ ] 全项目搜不到 `strcpy`/`strcat`/裸 `sprintf`；字符串拼接统一 `snprintf`
- [ ] `snprintf` 的返回值拿来做截断判断
- [ ] 循环条件里的 `strlen` 提出去
- [ ] 越界不能指望编译器，靠写法 + `-Werror` + sanitizer 三层

下一节进入结构体与联合体：内存对齐到底怎么算、`offsetof` 与柔性数组、联合体做类型双关的边界，以及为什么 `sizeof` 常常比你算的大。
