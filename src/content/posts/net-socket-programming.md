---
title: socket 编程基础
description: 实测：Windows 上 SO_REUSEADDR 绑相同地址报 10013 而 bind(0.0.0.0) 直接成功；recv 超时是 10060 不是 10035；粘的是读法不是网络。
date: 2026-10-16
tags: [网络, socket, Winsock, 字节序, getaddrinfo, select, 粘包, 超时]
category: network
section: net-socket
---

> 环境：Windows 11 x64，**GCC 13.1.0（`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`，`-O2 -lws2_32`）**，探针是本节新写的 `net4/sk.c`（六个模式：`byte` / `gai` / `reuse` / `blk` / `pack` / `sel`）与 `net4/rcb.c`，全部流量打在 **127.0.0.1**；抓包用 Npcap（`C:\Windows\System32\Npcap\wpcap.dll`）。口径沿用前两节：**回环 MSS=65495、本机 TIME_WAIT≈119–120 秒、TCP 动态端口 1024 起共 13977 个**、**每场实验都要核对"抓到的字节数 vs 应用侧字节数"**，比例型结论只在两侧都完整时才下；耗时给 3 次重复的中位数（区间）。本机是 Winsock 2.2 + 中文版 Windows，错误码全是 `WSA*` 那一套（10035/10040/10048/10060/10061/10013/10022/10054），Linux 的 `E*` 只有编号含义相通、**触发条件不相通**，本节不预测 Linux 行为。

## 一、骨架：先记住"句柄不是 fd"，再记两件事

服务端与客户端的最小可跑形状（`sk.c` 里的实际写法，去掉了错误检查）：

```c
WSADATA w; WSAStartup(MAKEWORD(2,2),&w);                 /* 每个线程所在进程一次，必须先于任何 socket() */
SOCKET srv=socket(AF_INET,SOCK_STREAM,0);
struct sockaddr_in m; memset(&m,0,sizeof m);
m.sin_family=AF_INET; m.sin_port=htons(port); m.sin_addr.s_addr=inet_addr("127.0.0.1");
bind(srv,(struct sockaddr*)&m,sizeof m);  listen(srv,4);
SOCKET acc=accept(srv,0,0);                              /* 主动 accept，别用 WSAAccept 的完成例程 */
char rb[1024]; int r=recv(acc,rb,sizeof rb,0);
send(acc,"ok",2,0);
closesocket(acc); closesocket(srv);                      /* 不是 close()！CRT 的 close 会拿错句柄 */
WSACleanup();
```

`WSAStartup` 回来的结构体里有两处会让人误读：

```text
WSAStartup(2.2) r=0  wVersion=0x0202 wHighVersion=0x0202 szSysStatus="Running" szDescription="WinSock 2.0" iMaxUdpDg=0 iMaxSockets=0
```

**`iMaxUdpDg=0`、`iMaxSockets=0` 不是"不能发 UDP、不能开 socket"**，它们是 Winsock 1.x 遗留字段，2.x 里规定就是 0，任何拿它们当上限的代码都是错的。真要 UDP 单包上限看第 6 节实测的 **65507 字节**。

`SOCKET` 在 x64 上是 64 位句柄，`sel` 模式把它的数值打了出来：

```text
前 4 个 SOCKET 句柄的数值： 236 240 244 248
最后 1 个：444
```

它是内核句柄（4 递增只是巧合），**不是小整数文件描述符**，所以 `select(maxfd+1,…)` 这种写法在 Windows 上毫无意义（`nfds` 被忽略，实测传 0 完全合法，见第七节）。移植代码时把 `#ifdef _WIN32` 的分支留给这三件事：`closesocket` / `WSAGetLastError` / `ioctlsocket(FIONBIO)`，别指望 `close(fd)` 和 `errno`。

## 二、绑定与端口复用：Windows 的 SO_REUSEADDR 不是 Linux 那个意思

`sk.exe reuse 19890` 的完整读数（A 先 `bind(127.0.0.1:19890)` 并 `listen`，全程不退出，其他 socket 都是后来者）：

```text
A bind(127.0.0.1:19890) r=0 err=0
  A 自身再 bind 一次同端口 -> r=-1 err=10022 (WSAEINVAL)
B 再 bind 同一 127.0.0.1:19890 -> r=-1 err=10048 (WSAEADDRINUSE=10048)
B 设 SO_REUSEADDR 后 bind 完全相同的 127.0.0.1:19890 -> r=-1 err=10013 (WSAEACCES=10013)
C0 【对照】不设任何选项，bind(0.0.0.0:19890) 而 A 正 LISTEN 在 127.0.0.1:19890 -> r=0 err=0
C1 SO_REUSEADDR + bind(0.0.0.0:19890) -> r=0 err=0
D 干净端口 19897：setsockopt(SO_EXCLUSIVEADDRUSE) r=0 err=0，bind(0.0.0.0:19897) r=0 err=0，已 listen
  F 独占者在场时，带 SO_REUSEADDR 的 F bind(0.0.0.0:19897) -> r=-1 err=10013
  G 独占者在场时，不带选项的 G bind(0.0.0.0:19897) -> r=-1 err=10048
  H 独占者已关闭：两个都带 SO_REUSEADDR 各自 bind(0.0.0.0:19897) -> r=0 / r=0（只有 H2 在 listen）
  H 一条新连接进来：select ret=1  H2(在 listen)就绪=1  H3(只 bind 未 listen)就绪=0
E 客户端 socket bind 到 LISTEN 中的端口 -> r=-1 err=10048
F 让系统随机选端口 3 次： 7831 7832 7833
```

五条本机结论，其中前两条**直接推翻"Windows 的 SO_REUSEADDR 就是允许抢地址"这句流传很广的话**：

1. **同一个 socket 重复 bind 永远是 10022（WSAEINVAL）**，和选项无关，这是"你想用 SO_REUSEADDR 改端口"的常见误用。
2. **别人已经在该地址:端口上 LISTEN 时，你带 SO_REUSEADDR 去 bind 完全相同的地址得到的是 10013（WSAEACCES），不是成功**。所以"服务重启 Address already in use → 加个 SO_REUSEADDR 就好"在 Windows 上并不成立；`TIME_WAIT` 场景要靠第 4 节那条正确路径（或换端口）。
3. **换本地地址就不算冲突**：C0 **什么选项都不设**，`bind(0.0.0.0:19890)` 在 A 已经 LISTEN 于 `127.0.0.1:19890` 时照样成功（r=0）。C1 加了 SO_REUSEADDR 结果一样 —— **也就是说这里 SO_REUSEADDR 根本没起作用，别把它当原因**。这也是多网卡服务"通配 + 具体地址各绑一个"能共存的本机依据。
4. **要真正的独占就得用 `SO_EXCLUSIVEADDRUSE`**：独占者（D）在场时，带 SO_REUSEADDR 的后来者拿 **10013**、不带选项的拿 **10048**；而独占者一关闭，两个都带 SO_REUSEADDR 的 socket 就能同时 bind 在 `0.0.0.0:19897`（H 行两个 r=0）。此时**投递给谁看谁在 listen**：只 `bind` 不 `listen` 的那个 `select` 就绪=0，永远收不到连接。
5. **随机端口是从 1024 往上顺着给的**：三次拿到 7831/7832/7833（连号），与第 4 节 `netsh` 读回的"起始 1024 共 13977 个"一致。客户端侧想 `bind` 到已经被服务端占住的端口同样 10048（E 行）。

顺带把缓冲区口径钉死（`rcb.exe`，UDP 与 TCP 各扫一遍，`bind` 前后都读了）：

```text
UDP 请求 SO_RCVBUF=512/1024/2048/4096/8192/16384/32768/65536/131072/262144/4194304 -> 读回同名值（11 档全部原样）
TCP 请求 SO_RCVBUF=512 … 4194304                                            -> 读回同名值（同上）
不设置时：UDP 读回 65536，TCP 读回 65536；SO_SNDBUF 默认读回 65536
```

**Windows 不把你要求的值翻倍也不减半**（Linux 会 ×2，这是移植时的经典坑），并且 `setsockopt(SO_RCVBUF)` 之后 `getsockopt` 一定读回原值——第 6 节那条"改参数先读回来核对"在这里同样重要。

## 三、字节序：`htonl` 在 x86 上就是字节反转，但坑不在函数里

```text
  主机值 0x1234 的内存字节 : 34 12
  htons(0x1234)=0x3412     : 12 34
  主机值 0x0100007F 的内存 : 7f 00 00 01
  htonl(0x0100007F)=0x7f000001 的内存 : 01 00 00 7f
  inet_pton("127.0.0.1") r=1  字节=7f 00 00 01
  inet_addr("127.0.0.1")   =0x0100007f  (和网络字节序一致，不能当主机序用)
  误用：把主机序整数 0x7f000001 直接塞进 sin_addr.s_addr -> inet_ntoa 读出 1.0.0.127
  ntohs(80)=端口字段应为 0x0050：实际 sin_port=0x5000
  inet_pton("1.2.3.4") 0x04030201 -> ntohl = 1.2.3.4 若把它当主机序读则是 67305985
```

三件事按顺序记住：**①** 本机是小端，`inet_pton("127.0.0.1")` 写进内存的字节是 `7f 00 00 01`，与 `inet_addr` 的返回值 `0x0100007f` **是同一串字节、两种读法**；把人类习惯的 `0x7f000001` 当成"网络序"填进 `sin_addr.s_addr`，`inet_ntoa` 就告诉你它连的是 **1.0.0.127** —— 于是出现"代码看着没错、包发到别处去了"。**②** 端口字段同理：`htons(80)` 在内存里的 16 位值是 `0x5000`，所以直接 `printf("%d", sin_port)` 得到 20480 是正常的，**读端口要 `ntohs`**。**③** `inet_pton` 的返回值是 **1 表示成功、0 表示"不是合法地址"、-1 表示 AF 不支持**，写成 `if(inet_pton(...))` 恰好反了（成功才是 1，这个坑只有在拼错地址时才炸）。

还有一条不在输出里但必须提醒：**`inet_ntoa` 返回静态缓冲区**，同一条 `printf` 里调用它两次就会共用一块内存 —— `conn.c` 里就留了注释记录这个坑（把 `inet_ntoa` 和其它取 `WSAGetLastError()` 的表达式塞进同一个参数表，`last error` 会被同表内其它调用覆盖）。正确写法是**紧跟调用把两个值分别取到局部变量**再打印。新代码直接用 `WSAAddressToString` 或 `inet_ntop`（后者要传调用方缓冲区，见第四节）。

## 四、getaddrinfo：把"解析成功"和"能连上"分成两件事

`sk.exe gai`，七种输入，全部只走本机解析器（不主动打外网）：

```text
getaddrinfo(host=localhost svc=80   flags=0x0   fam=AF_INET) = 0  用时 21.97 ms
  ai_family=2 socktype=1 proto=0 addrlen=16 地址=127.0.0.1:80 canon=- flags=0x0
  同上但 ai_family=AF_UNSPEC -> r=0 链= v6 v4
getaddrinfo(host=localhost svc=(NULL) flags=0x1 AI_PASSIVE) = 0  用时 0.18 ms   地址=127.0.0.1
getaddrinfo(host=(NULL) svc=19777 flags=0x1 AI_PASSIVE)      = 0  用时 0.00 ms   地址=0.0.0.0:19777
getaddrinfo(host=127.0.0.1 svc=www flags=0x0)                = 0  用时 7.14 ms   地址=127.0.0.1:80 flags=0x4
getaddrinfo(host=no-such-host.invalid svc=80)                = 0  用时 1.68 ms   地址=198.18.2.172:80
getaddrinfo(host=localhost svc=0)                             = 0  用时 0.34 ms
getaddrinfo(host=localhost svc=notanumber)                    = 10109  用时 1.61 ms  -> 错误串:(空)
GetHostName=TERMINAL
```

四条实用结论：

- **服务端要用 `AI_PASSIVE` + `host=NULL`**：返回的是 `0.0.0.0:19777`，正是第二节讲的通配绑定；`addrlen=16` 就是 `sizeof(struct sockaddr_in)`，可以直接喂给 `bind`，**不要自己填 `sin_len`/`sa_family`**。
- **`AF_UNSPEC` 的链是 `v6 v4` —— IPv6 在前**。客户端骨架必须"按链顺序逐个试 `socket/connect`，失败就下一个"，不能只取 `res->ai_next==NULL` 的那一个；上面 `svc=80` 那行第一次返回 `127.0.0.1:80`（因为 hints 里钉死了 `AF_INET`），去掉钉死后链里就有两个候选。
- **服务名会查 services 数据库**：`svc="www"` 直接给出端口 80，并且返回的 `ai_flags=0x4`（`AI_NUMERICSERV`）；传 `"notanumber"` 得 **10109**，而 `gai_strerrorA(10109)` 在本机**返回空串** —— 排错时**必须把数字码一起打出来**，否则日志里只有一段空白。
- **解析成功 ≠ 域名存在**。`no-such-host.invalid` 这种按 RFC 6761 保证不可解析的名字，本机 `getaddrinfo` **返回 0 且给出 `198.18.2.172`**。原因在本机的接口与路由表里：

  ```text
  netsh interface show interface：7 个接口，已连接的有 VMnet1 / VMnet8 / 以太网 / cherry
  route print：两条默认路由，网关分别是 198.18.0.2（接口 198.18.0.1）和 192.168.103.254（接口 192.168.103.24）
  ```

  `198.18.0.0/16` 是那块代理网卡的 fake-IP 段（第 6 节广播实验里源地址也是 `198.18.0.1`）。所以**在有代理/劫持解析的机器上，"getaddrinfo 失败"不是唯一故障信号，要把连接结果（`SO_ERROR`）一起看**；第一次解析 21.97 ms、后续 0.0–1.7 ms 也说明**首次调用含加载解析链的固定开销，别拿它当 DNS 延迟**。

## 五、阻塞与超时：三种"等"，各自的错误码不一样

`sk.exe blk 19900`（三次重复的时间写在一起）：

```text
SO_RCVTIMEO=700ms 的空连接 recv -> ret=-1 err=10060 实际等了 703.0ms   (WSAETIMEDOUT=10060 WSAEWOULDBLOCK=10035)
  关掉超时后读回 tv_sec=0
非阻塞 connect(127.0.0.1:19901 无人监听) ret=-1 err=10035 (WSAEWOULDBLOCK)
  非阻塞 connect 后轮询 select：2016.8ms 后就绪，写集=0 异常集=1 SO_ERROR=10061 (WSAECONNREFUSED)
SO_SNDTIMEO=200ms 的阻塞 connect(死端口) ret=-1 err=10061 用时 2029.9ms
  第 8 次 send(65536) ret=-1 err=10060 这次调用阻塞了 2007.0ms
对端 accept 但不 recv，SO_SNDTIMEO=2000ms：SO_SNDBUF 请求 131072 读回 131072；写出 458752 字节/7 次，累计阻塞 0.2ms err=10060
```

**读超时**：`SO_RCVTIMEO` 生效，返回 `ret=-1` 且 `err=10060 WSAETIMEDOUT`（**不是** 10035 WSAEWOULDBLOCK），三次实测 **703.0 / 705.7 / 710.4 ms → 中位 705.7（区间 703.0–710.4）**，比设定的 700 ms 多 3–10 ms。注意 `tv_sec=0 且 tv_usec=0` 是"关超时"（读回也是 0），别把 0 当"立即返回"。

**连接超时**：两条同时成立且反直觉的实测 —— **(a) `SO_SNDTIMEO=200ms` 管不住 `connect()`**：设了 200 ms，阻塞 `connect` 到死端口还是花了 **2029.9 / 2022.1 ms（两次）** 才返回 10061；**(b) 非阻塞 connect 的失败在 Windows 上要从"异常集"读**：`select` 的**写集=0、异常集=1**，然后 `getsockopt(SO_ERROR)=10061`。要可移植就同时把句柄放进 write 集和 except 集（Linux 上失败是通过 write 集 + `SO_ERROR` 报告的，两边正好互补）。

那个约 **2 秒**不是随便来的，抓包给出了形状（`dump.exe loopback "tcp port 19961"`，5 秒窗口，18 条全抓到）：

```text
[        0] TCP 8387->19961 .S.... seq=1155741428 win=65535 [MSS=65495] [wscale=8] [sackok]
[       19] TCP 19961->8387 ..R.A. seq=0 ack=1155741429 win=0            ← RST 在 19µs 后就到了
[   505201] TCP 8387->19961 .S.... seq=1155741428 ... chk=8c56           ← 同一个 seq/chk 的 SYN 重发
[  1011595] TCP 8387->19961 .S.... ...
[  1515203] TCP 8387->19961 .S.... ...
captured 18 packets                                                      ← 9 次 SYN + 9 次 RST
```

**RST 19µs 就到了，但 `connect` 要 2.0 s 才把 10061 交给应用**；这期间 SYN 按 **505.2 / 506.4 / 503.6 ms（中位 505.2）** 的节拍重发（与第 5 节 `netsh` 读回的"最小 RTO 300ms"同量级，但本机重传节拍是 ~505ms），序号与校验和完全相同（`seq=1155741428 chk=8c56`）—— 这就是"重传"的字节级形状。应用层拿不到 19µs 那个快速否定，只能等内核按自己的节拍放弃，**所以"连接超时"必须由应用自己用非阻塞 + select 实现，别指望任何 `SO_*TIMEO`**。

**写阻塞**：对端 `accept` 之后一个字节都不读，本机把数据全吞进缓冲区：

```text
不设 SO_SNDTIMEO（blk2 模式，前 4 次 send 瞬间返回）：
   #1 累计 65536 字节 t=0.0ms
   #2 累计 131072 字节 t=0.1ms
   #3 累计 196608 字节 t=0.1ms
   #4 累计 262144 字节 t=0.1ms
   （第 5 次 send 之后再无任何输出）exit=124  ← 被 timeout 20/22 强杀，即阻塞 ≥ 20 秒未返回
设 SO_SNDTIMEO=2000ms（blk 模式，SO_SNDBUF 先设成 131072）：
   前 7 次全部返回，共 458752 字节；第 8 次阻塞 2007.0ms 后 ret=-1 err=10060
```

两组的差别只在"被吞掉的字节数"：裸 send 组吞了 262144 字节（`SO_SNDBUF` 是本机默认 65536）后卡死，先设 `SO_SNDBUF=131072` 的那组吞了 458752 字节才开始阻塞、第 8 次调用在 2007.0 ms 后返回 10060。**这两个数是"本端发送缓冲 + 在途 + 对端接收缓冲"的合计，本机没有把它逐层拆开（未实测）**，所以不要按"SO_SNDBUF 多了 65536 所以多写 65536"去算。要点只有一句：**阻塞 socket 上的 `send` 可以永远不返回，进程就那样挂着；`SO_SNDTIMEO` 是它唯一的解药**（而它管不了 `connect`）。反压、超时、丢弃策略都得自己写（第 10 节）。

## 六、粘包与拆包：TCP 是字节流，UDP 是整包 —— 四组实测对照

`sk.exe pack 19930`，每个子测试都用一条**新连接**（第一版让四个子测试共用一条连接，上一段留在接收缓冲区里的字节被下一段当成帧头读走，`recv` 随后一直等不到那么多字节、程序直接卡死 —— 这个 bug 本身就是"没有消息边界"的代价）：

```text
A 三次 send(10)（"ABCDEFGHIJ"/"KLMNOPQRST"/"UVWXYZ0123"），服务端一次 recv(1024)：
  #1 ret=30 [ABCDEFGHIJKLMNOPQRSTUVWXYZ0123] 等了 152.1ms
  第 2 次 recv 前 select 说不可读 ret=0（30 字节已被第一条 recv 一次取光，这里绝不能裸 recv）
B 一次 send(60)，接收端每次只 recv(4)：
   recv#1 ret=4 [abcd]   recv#2 ret=4 [efgh]   recv#3 ret=4 [ijkl]   共 15 次 recv 收到 60 字节
C 逐字节 send 20 次，接收端 recv(16)：
   ret=16 [ABCDEFGHIJKLMNOP]        还剩 4 字节在缓冲区里 [QRST]
D 长度前缀帧（4 字节头 + 7 字节正文），发送端每写 1 字节接收端就立刻试读：
    已发第  1 字节：recv(还差 4) -> ret=1 累计帧头 1/4
    已发第  2 字节：recv(还差 3) -> ret=1 累计帧头 2/4
    已发第  3 字节：recv(还差 2) -> ret=1 累计帧头 3/4
    已发第  4 字节：recv(还差 1) -> ret=1 累计帧头 4/4
   帧头 4 字节解析出长度=7      正文收 7 字节 [MSG7777]
   帧已消费干净：select 不可读 —— 这里绝不能裸调 MSG_PEEK，那会一直阻塞
UDP 对照：sendto(50) 两次，接收端先 recvfrom(8)：
  recvfrom(8) ret=-1 err=10040 (WSAEMSGSIZE=10040)
  再 recvfrom(8) ret=-1 err=10040
  select 看到 u2 可读=0     换 64 字节缓冲的机会没有了：两个数据报都已作废
```

同一场连 Npcap 一起抓（`dump.exe loopback "tcp port 19945"`），**核对完再下结论**：

```text
captured 98 packets     载荷分布：63 段 payload=0、31 段 payload=1、3 段 payload=10、1 段 payload=60
抓到载荷字节合计 = 121        应用侧发出 = 30 + 60 + 20 + 11 = 121        ← 两侧完全相等，本场抓包完整
带 PSH 的段 35 条 = 3 + 1 + 20 + 11                                        ← 与四次子测试一一对上
```

于是"粘包"这个词被实测拆成两件事：

1. **A 场景里线上并没有粘**：3 次 `send(10)` 在抓包里就是 **3 段 payload=10**（Nagle 在回环上不合并，与第 5 节"8 次单字节写 = 8 段"同一个结果）。是**接收端一条 `recv(1024)` 把 30 字节一次读走**才"粘"的 —— **粘在读法上，不在网络上**。
2. **B/C 场景里线上也没有拆**：1 次 `send(60)` 就是 **1 段 payload=60**，接收端 `recv(4)` 十五次才读完，是内核缓冲区按调用者要求的量交付。C 更直接：20 段 payload=1 上线，接收端一次 `recv(16)` 拿走 16 字节、剩 4 字节 `[QRST]` 留在缓冲区。
3. 所以 **TCP 只提供"有序字节流"，不保留消息边界**：`recv` 返回 1、4、16、30 都合法。**唯一可靠的办法是自己定帧**（长度前缀 / 定长 / 分隔符），并且**写累加循环**：D 场景里 `recv(还差 4)` 真的只给 1 字节，四次才凑满一个 4 字节头 —— 任何"读一次头就够了"的代码在这台机器上都会解出错误的长度然后卡死。帧格式的设计口径见第 12 节。
4. **UDP 是反面教材的对照组**：小缓冲 `recvfrom(8)` 撞上一个 50 字节数据报，返回 `-1 / 10040 WSAEMSGSIZE`，而且**两个数据报一起作废**（随后 `select` 说不可读）。TCP 会把你要求的那 8 字节给你、剩下的留着；UDP 直接把整包丢掉（`MSG_PARTIAL` / 允许截断的行为本机未测）。这既是"UDP 不会粘包"的真相，也是"UDP 上随便给个小缓冲区更危险"的代价。

## 七、select 的容量与两个常数

`sk.exe sel 50`（默认编译）与 `skbig.exe sel 200`（`gcc -DFD_SETSIZE=1024` 重编，必须在包含 `winsock2.h` **之前**定义，命令行 `-D` 正是最省事的办法）：

```text
编译期 FD_SETSIZE=64   sizeof(fd_set)=520   fd_count 类型大小=4  sizeof(fd_set.fd_array[0])=8
编译期 FD_SETSIZE=1024 sizeof(fd_set)=8200  …同上
FD_SET 50 个后 fd_count=50      FD_SET 200 个后 fd_count=200
select(0,...) 空集等待 ret=0     ← nfds 传 0 在 Windows 是合法的，它被完全忽略
往最后一个 socket 灌 1 个数据报后 select ret=1，FD_ISSET(最后一个)=1
WSAPoll(50 个,100ms) ret=1 ；WSAPoll(200 个,100ms) ret=1
```

- `sizeof(fd_set) = 4 + FD_SETSIZE×8`（520 与 8200 精确吻合），因为 x64 上 `SOCKET` 是 8 字节。**FD_SETSIZE 是编译期常量**，默认 64；要同时管 200 个 socket 就必须重编，代价是每个 `fd_set` 8 KB、每次调用还要 `FD_ZERO`+200 次 `FD_SET`。
- **超过 `FD_SETSIZE` 再 `FD_SET` 是数组越界**，属于未定义行为。本机探针刻意把 `FD_SET` 的数量夹在 `min(n, FD_SETSIZE)` 以内，所以**没有**测出"越界会怎样"（负面结果也照实说：不确定的事不在自己机器上试）。
- `select` 每次调用都要重新 `FD_ZERO`+`FD_SET` 全量集合（它会改写传入的集合），这是 `O(n)` 每轮的根源；`WSAPoll` 用数组、`WSAEventSelect`/IOCP 用完成，才是第 10 节高并发的路子（本机只做了一次 `WSAPoll` 计数验证，性能未测）。

## 八、本节未在本机实测，原因写清楚

- **`listen()` 第二参数（backlog）的真实效果、半连接队列溢出与 SYN 重传的关系**：需要压满队列或制造 SYN 洪水，属于不允许的压测；本节所有 `listen(srv,4)` 只用来保证能 accept。第 4 节有状态机与 `TIME_WAIT` 的实测。
- **跨机 / 跨网段的 `bind`、`SO_REUSEADDR`、连接超时**：本机没有第二台机器；`route print` 里那两条默认路由都指向本地虚拟网关。第五节那个 ~2.0 s 是**死端口 RST 场景**，不能当"SYN 被防火墙静默丢弃后的 connect 超时"用。
- **IOCP、`WSAAsyncSelect`、`WSAIoctl` 的完成例程路径**：本节只用了 `WSAIoctl(SIO_UDP_CONNRESET)`（在第 6 节）与只读的 `SIO_TCP_INFO`（在第 5 节），事件模型与完成模型一概未测，归第 10 节。
- **IPv6 端到端**：`gai` 模式证明 `AF_UNSPEC` 的链是 `v6 v4`、`localhost` 能给出 v6 候选，但本节所有连接都打在 `127.0.0.1` 上，**v6 路径一次都没真正 connect 过**，双栈回退逻辑属于"写了但没跑"。
- **Linux 侧对应行为**（`SO_RCVTIMEO` 返回 `EAGAIN` 还是 `ETIMEDOUT`、`SO_RCVBUF` 的 ×2、`connect` 用 write 集报告失败）：本机没有 Linux，本节只报 Windows 读数，不做跨平台推断。

## 九、小结

- **骨架三件事**：`WSAStartup` 先行；`WSADATA` 里 `iMaxUdpDg=0 iMaxSockets=0` 是遗留字段不是上限；`closesocket`/`WSAGetLastError` 而非 `close`/`errno`，`SOCKET` 是 64 位内核句柄（实测值 236/240/244/248…）。
- **绑定**：重复 bind 自己=10022；撞别人 LISTEN=10048；**带 `SO_REUSEADDR` 去抢同一地址=10013，不是成功**；`bind(0.0.0.0)` 与已存在的 `127.0.0.1` 可无选项共存（SO_REUSEADDR 在此没起作用）；要独占用 `SO_EXCLUSIVEADDRUSE`；`SO_RCVBUF` 512…4194304 全部原样读回，默认 65536。
- **字节序**：`inet_pton("127.0.0.1")` 的内存是 `7f 00 00 01`，`inet_addr` 返回 `0x0100007f`；把 `0x7f000001` 当网络序填会得到 **1.0.0.127**；`htons(80)` 的字段值是 `0x5000`；`inet_pton` 成功返回 **1**；`inet_ntoa` 是静态缓冲区，一次 `printf` 里别用两次。
- **getaddrinfo**：服务端 `AI_PASSIVE`+`NULL` → `0.0.0.0:19777`；`AF_UNSPEC` 链 **v6 在前**；`svc="www"`→80 且 `ai_flags=0x4`；`"notanumber"`→**10109** 且 `gai_strerrorA` 是空串；不存在的域名被本机代理解析成 `198.18.2.172` —— **解析成功不等于能连上**。
- **超时**：`SO_RCVTIMEO` → **-1/10060**（705.7ms 中位，设定 700ms）；`SO_SNDTIMEO` 对 `connect` **无效**（2029.9ms vs 设定 200ms）；非阻塞 connect 失败在**异常集**里、要 `getsockopt(SO_ERROR)`；RST 19µs 就回来而 `connect` 2.0s 才失败，期间 SYN 每 ~505ms 重发；裸 `send` 在对端不读时**阻塞 ≥20 秒**（前 4 次共 262144 字节瞬间返回）。
- **粘包**：抓包 98 条、载荷 **121 字节 = 应用侧 121 字节**（本场完整）；3 次 `send(10)` 在线上仍是 3 段，一次 `recv(1024)` 拿回 30 —— **粘在读法**；一次 `send(60)` 用 15 次 `recv(4)` 读完 —— **拆在读法**；逐字节推帧头时 `recv` 真的只给 1 字节，**累加循环必须**；UDP 上小缓冲 `recvfrom(8)` → **-1/10040 且整包作废**。
- **select**：`FD_SETSIZE` 是编译期常量（64 → `sizeof(fd_set)=520`；`-DFD_SETSIZE=1024` → 8200，元素 8 字节），`nfds` 传 0 合法且被忽略，超界 `FD_SET` 是越界（本机未测后果）；`WSAPoll` 同场景可用。
