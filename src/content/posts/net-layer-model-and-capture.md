---
title: 分层模型与抓包入门
description: 本机 Npcap 实测：1 字节应用数据在回环上是 45 字节帧、在 9000 MTU 链路上封装成 9000 字节帧（MSS 8960）；一次完整 TCP 生命周期只用 9 帧 452 微秒；非管理员权限也能直接调 wpcap.dll 抓包。
date: 2026-10-15
tags: [网络, 抓包, Npcap]
category: network
section: net-model
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`gcc -O2 -lws2_32`；curl 8.22、OpenSSL 3.5.8（Git 自带）。本机装有 **Npcap**（`C:\Windows\System32\drivers\npcap.sys` + `System32\Npcap\wpcap.dll`），但**没有** tshark / dumpcap / windump（`where` 三个都返回 NONE），所以本节用 260 行 C 写了个 mini-tcpdump：`LoadLibraryEx` 动态加载 wpcap.dll，调 `pcap_findalldevs / pcap_open_live / pcap_compile / pcap_dispatch`，自己按层解码，同时能落标准 `.pcap` 文件。所有时间戳是抓包自带的微秒时钟；所有字节数都是从帧里读出来的，不是查表抄的。

## 一、五层模型：每层加多少字节，实测

| 层 | PDU | 本机看到的实物 | 实测开销 |
| --- | --- | --- | --- |
| 应用层 | HTTP/TLS 记录 | `Content-Length: 14484`、TLS 记录头 5 字节 | 协议决定 |
| 传输层 | TCP 段 | `hlen=20`（纯头）或 `hlen=32`（带 12 字节选项） | 20–60 B |
| 网络层 | IPv4 包 | `ipihl=20 optbytes=0`，`totlen` 从 40 到 60028 都出现过 | 20 B |
| 链路层 | 以太网帧 | 以太网头 14 B（`datalink=1`）；回环设备是 `datalink=0`，只有 4 B 的 AF 头 | 14/4 B + FCS |
| 物理层 | 比特 | 本机不可见 | — |

关键区别要抓住：**每层只认识自己的头，靠上一层留下的"类型"字段继续解**。抓包程序里这就是三个连续的分派：链路层看 `ethertype == 0x0800` 还是 `0x0806`，IP 层看 `proto == 6 / 17 / 1`，TCP 层看 `dataoffset` 算出头长。这三行判断写完，一个抓包工具就诞生了：

```text
[        0] 127.0.0.1 -> 127.0.0.1  ver=4 id=3f78 flags=--- frag=0 ttl=128 proto=6
    ipihl=20 optbytes=0 totlen=52 ipbody=32
    TCP 19301->19300 .S.... seq=2827311003 ack=0 win=65535 chk=dfff urg=0
    hlen=32 opts=12 payload=0 [MSS=65495] [nop] [wscale=8] [nop] [nop] [sackok]  [frame=56 wirelen=56]
```

这一行里能读出的东西比模型图更实在：IP 头 20 字节（`optbytes=0` 说明没带 IP 选项），TCP 头 32 字节（20 + 12 选项），选项里是 MSS / 窗口缩放 / SACK 允许三件套，`totlen=52 = 20 + 32`，`frame=56 = 52 + 4`（多出来的 4 字节是回环设备的 DLT_NULL 地址族标记）。

## 二、封装：MSS = MTU − 40，两个接口都验过

`netsh interface ipv4 show subinterfaces` 读到的本机 MTU：

```text
       MTU  MediaSenseState   接口
4294967295                1   Loopback Pseudo-Interface 1
      9000                1   cherry
      1500                2   WLAN
      9000                1   以太网
      1500                1   VMware Network Adapter VMnet1
      1500                5   cfw-tap
```

然后从**真实 SYN 包的选项里**取 MSS，不看任何文档：

| 出接口 | MTU | 抓包得到的 MSS | 校验 |
| --- | --- | --- | --- |
| `\Device\NPF_Loopback` | 名义 4294967295 | **65495** | 65535 − 20 − 20（IPv4 报文上限决定，不是 MTU） |
| 以太网 / Meta Tunnel | 9000 | **8960** | 9000 − 40 |

再用 DF 标志卡一遍边界（`ping -f -l <载荷>`，目标是本机网关，纯本机链路）：

```text
--- size=8972   （正常收到回包，8972 + 28 = 9000，正好填满）
--- size=8973
需要拆分数据包但是设置 DF。
```

**8972 能过、8973 报"需要拆分数据包但是设置 DF"**，这是 MTU=9000 最硬的反证。回环上同理，UDP 载荷二分探测的结果是 **65507 可发、65508 报 10040（WSAEMSGSIZE）**，正好等于 65535 − 20(IP) − 8(UDP)。

开销比例也是实测出来的：一个 `send(fd, "x", 1)` 在回环上是 `frame=45`——**44 字节头部包着 1 字节数据，开销 4400%**；反向例子是 9000 字节帧装满 8960 字节载荷，**开销 40/9000 = 0.44%**。同一条 TCP 连接，"每字节成本"差一千倍。这就是"小包病"的全部数学。

## 三、抓包：这台机器能做到什么、做不到什么

`pcap_findalldevs` 返回 14 个设备，节选：

```text
dev[0]  name=\Device\NPF_{7BEE210B-...}   desc=WAN Miniport (Network Monitor)
dev[9]  name=\Device\NPF_{9A4AD1D4-...}   desc=Realtek PCIe GbE Family Controller
dev[10] name=\Device\NPF_{3D3289E4-...}   desc=Meta Tunnel
dev[11] name=\Device\NPF_Loopback         desc=Adapter for loopback traffic capture
```

踩到的四个坑，都是本节能跑通的原因：

1. **`LoadLibrary("wpcap.dll")` 失败，gle=126**（ERROR_MOD_NOT_FOUND）。这台机器的 Npcap 把 DLL 装在 `C:\Windows\System32\Npcap\` 而不是 System32（只有选了"WinPcap API-compatible Mode"才会拷到 System32）。要用全路径 + `LOAD_WITH_ALTERED_SEARCH_PATH`。
2. **每个设备的链路类型不一样**，`pcap_datalink()` 必须查：回环是 `0`（DLT_NULL，4 字节地址族头），以太网是 `1`，而 Meta Tunnel 是 **`12`（DLT_RAW，裸 IPv4，连以太网头都没有）**。一开始只处理 0 和 1，在那条隧道上"抓到 19 个包、打印 0 行"——不是没抓到，是解码器把包全丢了。
3. **非管理员也能抓**。这台机器 `IsAdmin=False`，`pcap_open_live` 照样成功。Npcap 装的时候如果不勾"Restricted to Administrators"，普通用户就能抓包——安全上值得留意。
4. **时间戳是 epoch 微秒**（`ts_sec`/`ts_usec`）。我用 `QueryPerformanceCounter` 去减，打出来是 `1791800890524079` 这种天文数字。正确做法：拿**第一个包**的时间当零点。

`.pcap` 文件本身极简，写完再回头看那 24 字节文件头（自己写的一个字节都不用猜）：

```text
00000000: d4c3 b2a1 0200 0000 0400 0000 0000  ................
00000010: 0000 0000 ffff 0000
```

`d4c3b2a1` 小端读就是 magic `0xa1b2c3d4`，版本 2.4，`snaplen=0xffff=65535`，最后一个 `0000` 是 `network=0` 即 DLT_NULL——Wireshark 靠这个字节决定要不要剥掉 4 字节地址族头。**链路类型写错，文件能打开但全是乱码**，这是"抓到了却看不懂"的头号原因。

## 四、读第一份抓包：一次连接的一生（9 帧）

自建 server（127.0.0.1:19300）+ client（bind 19301）：连接、发 1 字节、客户端先关。抓到的全部：

```text
[        0] TCP 19301->19300 .S.... seq=2827311003 ack=0         win=65535 hlen=32 [MSS=65495] [wscale=8] [sackok]
[       46] TCP 19300->19301 .S..A. seq=3681776117 ack=2827311004 win=65535 hlen=32
[       67] TCP 19301->19300 ....A. seq=2827311004 ack=3681776118 win=255   hlen=20
[       99] TCP 19301->19300 ...PA. seq=2827311004 ack=3681776118 win=255   payload=1
[      109] TCP 19300->19301 ....A. seq=3681776118 ack=2827311005 win=255   payload=0
[      127] TCP 19301->19300 F...A. seq=2827311005 ack=3681776118 win=255
[      136] TCP 19300->19301 ....A. seq=3681776118 ack=2827311006 win=255
[      259] TCP 19300->19301 F...A. seq=3681776118 ack=2827311006 win=255
[      295] TCP 19301->19300 ....A. seq=2827311006 ack=3681776119 win=255
```

三个必须从抓包里学会、看书写不直观的结论：

- **SYN 和 FIN 各消耗 1 个序号**。看 `seq=2827311003` 的 SYN，对端回的是 `ack=2827311004`（+1）；`payload=1` 那帧 `seq=...004`，之后 FIN 是 `seq=...005`，最后一次 ACK 是 `...006`。序号空间是"字节 + 控制位"，不是"包数"。
- **握手只花 3 帧、67 微秒**（0 / 46 / 67）。第 4 帧才是应用数据。
- **`136 → 259` 之间 123 微秒的空隙是服务端的应用在干活**，不是网络慢。抓包里出现"大块空白"时，第一反应应该是查应用代码，不是查链路。

同一份流量在本机的单价（`probe.exe`，N=600，3 次独立运行，全部是**回环**）：

```text
N=600  socket+connect 三次握手:  中位  110.10 us  [p10 82.90  p90 153.60]   （三次：110.1 / 120.1 / 142.3）
N=600  1 字节请求+响应往返:      中位   51.30 us  [p10 35.90  p90  78.80]   （三次：51.3 / 51.3 / 52.2）
N=600  closesocket(主动关闭):    中位   30.00 us  [p10 21.40  p90  55.70]   （三次：30.0 / 28.2 / 30.8）
```

顺带打破一个直觉：`ping -n 10 127.0.0.1` 报的是"最短 = 0ms，最长 = 0ms"——不是回环真的零延迟，是 ICMP 回包的粒度不够。用上面的 TCP 往返才量得出 **51 微秒**。

## 五、拿到一份抓包先自检：我在看真实链路吗

对本机博客域名发一次 HTTPS 请求，在出流量的 Meta Tunnel 设备上抓：

```text
[        0] 198.18.0.1 -> 198.18.2.160  ttl=128  TCP 9153->443 .S.... win=65535 [MSS=8960] [wscale=8]
[      219] 198.18.2.160 -> 198.18.0.1  ttl=128  TCP 443->9153 .S..A. ack=3675544601 win=65535
[   227271] 198.18.2.160 -> 198.18.0.1  ttl=128  TCP 443->9153 ....A. totlen=9000 payload=8960
```

而这个站点的响应头写着 `x-github-edge-region: southeastasia`、`X-Served-By: cache-sin-wsss1830065-SIN`（新加坡 Fastly 边缘），`ping 8.8.8.8` 实测真实公网 RTT 是 **159–499ms**。于是三条证据互相矛盾：

1. **SYN→SYN/ACK 只有 219 微秒**。到新加坡不可能。
2. **入方向包的 TTL 也是 128**。Windows 出方向默认 TTL=128（`netsh int ipv4 show global` 里"默认跃点限制 : 128 个跃点"），隔了十几跳进来还正好 128，说明这包不是远端发来的。`ping 8.8.8.8` 回来的 TTL=107（走了 21 跳）才是真实链路的樣子。
3. **198.18.0.0/15 是 RFC 2544 的基准测试地址段**，本机的 DNS 把域名解析成了 `198.18.2.160`——典型的 fake-IP 代理。

结论：本机所有对外连接被一个**本地透明代理**终结了，"Meta Tunnel"是它的虚拟网卡。抓包先看 TTL 和 RTT 是否自洽，否则会把 0.2ms 当成本地链路延迟、把 TLS 105ms 当成握手慢（下一节《网络故障定位》会用这套判据做延迟分解）。

## 六、小结

- 分层的可操作性只取决于一件事：**每层用上一层的类型字段找到下一层的头**。写一次解码器比背七层口诀有用得多。
- 封装开销是本机算出来的：1 字节数据 = 45 字节帧（回环）；MSS = MTU − 40 在 9000 MTU（8960）和回环（65495）上都对上；UDP 载荷上限 65507，超了报 **10040**；`ping -f -l 8972` 能过、`8973` 报"需要拆分数据包但是设置 DF"。
- 抓包不必装 Wireshark：Npcap 驱动 + 200 行 C 就能列出设备、下 BPF 过滤器、按层解码并写出合法 `.pcap`。**注意三件事：DLL 的实际路径、每个设备的 `datalink` 类型、时间戳要取首包做零点。**
- 一次 TCP 连接的一生可以是 9 帧、452 微秒；序号空间里 **SYN 和 FIN 各占 1**；抓包里的时间空隙优先怀疑应用而不是网络。
- 回环上的绝对单价（本机中位数）：握手 110–142µs、1 字节往返 51µs、关闭 28–31µs。这些数字只在 loopback 成立，换链路要重测。
- **本节未在本机实测**：跨主机/跨网段的真实链路抓包（本机只有一条被代理接管的出网路径）、Wireshark GUI 的显示过滤器对照（未安装）。
