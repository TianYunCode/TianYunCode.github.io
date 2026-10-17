---
title: DNS、HTTP 与常见应用层
description: 实测：本机名解析经本地代理完成（curl 的 time_namelookup 是假象）；keep-alive 让第二请求 TTFB 从 58ms 降到 12ms；本站响应头 HTTP/1.1 + max-age=600。
date: 2026-10-16
tags: [网络, DNS, HTTP, keep-alive, curl]
category: network
section: net-dns-http
---

> 环境：Windows 11 x64，curl 8.21.0（libcurl/8.21.0 **Schannel** 后端），OpenSSL 3.5.7。**测量口径先说清**：本机环境变量里有 `HTTP_PROXY=http://127.0.0.1:1334`，所有 curl 请求默认走本地代理——这改变了对计时的解释（第一节）。本文计时是 3 次中位，协议类结论（响应头、keep-alive 行为）不受代理影响。**本机 libcurl 不带 nghttp2**（`--http2` 直接报不支持），HTTP/2 部分未实测；DoH 实测可用。

## 一、先拆穿一个计时假象：代理环境里的 time_namelookup

curl 的 `-w` 计时把一次请求拆成几段：`time_namelookup`（DNS）→ `time_connect`（TCP）→ `time_appconnect`（TLS）→ `time_starttransfer`（首字节）→ `time_total`。**这些数字在代理环境下会骗人**：

- 本机 `nslookup wty.blogs.abrdns.com` 直查：服务器是 `fdfe:dcba:9876::2`（文档段地址，黑洞），**No response from server**。
- 同一域名 curl 默认路径：`time_namelookup=0.045ms`——**这不是 DNS 快了，是 curl 只解析了代理地址 `127.0.0.1`**（字面量，本就不查），真实域名解析发生在代理那侧，curl 看不见。
- 绕过代理直连（`--noproxy '*'`）：`time_namelookup=18.8ms`——**这才是真实 DNS 的样子**。

**方法论结论：测 DNS 前先确认路径**。`env | grep -i proxy`、`curl -v` 看第一行是不是 `Trying 127.0.0.1`。 proxied 环境里 `time_connect` 量的是"到代理的 TCP"（本机回环，恒定 0.9ms 左右），`time_appconnect` 量的是"经 CONNECT 隧道到目标的 TLS"。三组实测对照（3 次中位）：
| 路径 | DNS | TCP | TLS | TTFB | total |
| --- | --- | --- | --- | --- | --- |
| 本站经代理 | 0.07 ms | 0.98 ms | 167 ms | 272 ms | 274 ms |
| 百度经代理 | 0.05 ms | 0.94 ms | 48 ms | 61 ms | 62 ms |
| 本站直连 | 18.8 ms | 34 ms | 189 ms | 309 ms | 371 ms |

读法：代理路径下"TCP 1ms"是回环假的，TLS 和 TTFB 是端到端真的；直连路径下 DNS 18.8ms 是真的（但取决于系统解析器和缓存，第二次同域名查询会低得多——本机没测缓存命中路径，因为是黑洞解析器）。**本站（GitHub Pages）比百度慢 4 倍多（274 vs 62ms）**，差距主要在 TLS（167 vs 48ms）——跨境链路 + GitHub 的证书链，这个绝对值只对本网络环境有意义，**报告绝对值时先交代链路**。

还有一个更狠的口径问题：本机 `ping wty.blogs.abrdns.com` 解析到的是 **198.18.0.239**——RFC 2544 的基准测试段（198.18.0.0/15），`tracert` 只有一跳、`<1ms` 到达。也就是说这个环境里**连"直连"都是被本地拦截器代答的**，第三节的"直连"计时量的也是到拦截器的路。**看到测试段地址、一跳可达、零延迟，就该知道测量对象不是公网**——net-debug 那节把这个识别方法展开。

## 二、keep-alive：第二个请求便宜多少（实测）

HTTP/1.1 默认 `Connection: keep-alive`（本文第四节的本站响应头原文里就有）。同一个 curl 进程给两个 URL 时，第二个请求复用连接：

```
单 URL:            tcp=1.2ms  tls=47ms  ttfb=58ms  total=58ms
同连接第一个 URL:  tcp=0.9ms  tls=52ms  ttfb=70ms  total=70ms
同连接第二个 URL:  tcp=0.0ms  tls=0.0ms  ttfb=12ms  total=12ms
```

**第二个请求的 TCP 和 TLS 归零，TTFB 从 58ms 降到 12ms（省 79%）**。这就是浏览器/客户端坚持连接池的原因：TLS 握手（两次 RTT + 证书验证）是重复成本，keep-alive 把它摊薄。三个实践点：

1. **HTTP 客户端库默认行为要确认**：有的库默认每次新连接（老代码常见），显式开 keep-alive + 连接池是白送的收益。
2. **服务端的 keep-alive 有 idle 超时**（nginx 默认 75s，本站响应头没写但 GitHub Pages 有自己的策略）：客户端池子的 idle 时间要短于服务端，否则用到一条已被服务端关掉的连接，第一次请求必失败——症状是"偶发 connection reset，重试就好"。
3. **连接不是越多越好**：每连接有内存和文件描述符成本，池大小按并发估算，不是按 QPS（net-highperf 那节细说）。

## 三、响应头：本站实例逐行读

`curl -sI https://wty.blogs.abrdns.com/` 原文（经代理 CONNECT，两段 200：代理的 `Connection Established` + 目标的 `200 OK`）：

```
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 22160
Server: GitHub.com
Content-Type: text/html; charset=utf-8
Last-Modified: Thu, 15 Oct 2026 21:39:55 GMT
Access-Control-Allow-Origin: *
ETag: "6ad1482b-5690"
Cache-Control: max-age=600
```

七个字段的工程读法：

1. **`Connection: keep-alive`**：服务端支持连接复用（第二节的收益可拿）。
2. **`Content-Length: 22160`**：响应体 22 KB，静态页面——本站首页的准确大小。**没有 Transfer-Encoding: chunked** 说明服务端一次成型（静态文件，非流式生成）。
3. **`Server: GitHub.com`**：确认托管方（Pages 的特征头）。
4. **`Last-Modified` + `ETag`**：条件请求的基础。客户端带 `If-Modified-Since`/`If-None-Match` 再问，没变服务端回 **304 且不带 body**——静态站的缓存验证成本接近零。
5. **`Cache-Control: max-age=600`**：**10 分钟**。这是 GitHub Pages 的默认值：浏览器/CDN 缓存 10 分钟，意味着刚 push 的文章**最多 10 分钟后所有访客可见**（本文作者每次 push 后"怎么还没更新"的答案）。
6. **`Access-Control-Allow-Origin: *`**：Pages 对所有资源开放跨域（RSS、图片都可被别站直接引用）。
7. **`HTTP/1.1`**：本站**没有上 HTTP/2**（GitHub Pages 对自定义域名支持 h2，本站响应是 1.1——可能未启用或 CDN 节点策略；本机 libcurl 不带 nghttp2 无法独立验证 h2 协商）。

## 四、DNS 记录与解析链（概念 + 本机限制）

DNS 的记录类型和解析链是文档级知识：A/AAAA（地址）、CNAME（别名，**解析时替换继续查**，一条 CNAME 链有成本）、NS（权威服务器）、MX/TXT/SOA（邮件/验证/区信息）。一次完整解析：**浏览器缓存 → 系统缓存 → hosts → 递归解析器 → 根 → TLD → 权威**，每层都是潜在的故障点。

本机限制：递归解析器是黑洞（第一节），所以**解析链的逐级实测（dig +trace 一类）本机做不了**，未实测。可确认的是：本环境所有应用层名解析都经由本地代理完成，代理侧行为不可见。

排障口诀（对应"网站打不开"的三类）：**解析失败**（DNS 层，`nslookup` 直查对比代理路径）、**连不上**（TCP 层，ping/tracert 看在哪一跳断）、**连上了慢/错**（TLS/HTTP 层，curl `-v` 看握手和响应头）——net-debug 那节按这个次序展开。

## 五、HTTP 版本与常见应用层（未实测部分声明）

- **HTTP/2**：多路复用（一个连接并发多请求，解决队头阻塞）、HPACK 头压缩、服务端推送（已废弃）。本机 libcurl 不支持 `--http2`，**未实测**；本站响应头显示 HTTP/1.1。
- **HTTP/3/QUIC**：基于 UDP，绕过 TCP 的队头阻塞和慢启动。本站未见 `Alt-Svc: h3` 头，未实测。
- **管线化（pipelining）**：HTTP/1.1 可以不等待响应连发多个请求，但**浏览器全部禁用**（代理兼容性灾难），被 h2 的多路复用取代——历史知识点，别用。
- **其他应用层协议**（概念层）：SMTP/IMAP（邮件）、FTP（遗留）、WebSocket（HTTP 升级握手后的全双工，`Upgrade: websocket` + 101 响应）、gRPC（HTTP/2 之上的 RPC，protobuf 二进制帧）——本文不展开，用到时查各自 RFC。

## 六、未实测清单

- HTTP/2 协商与多路复用的实测（本机 libcurl 无 nghttp2）——未测。
- DoH 的完整对比（`--doh-url` 可用且 time_namelookup 归零，但解析在 DoH 服务侧，端到端差异未系统测）——只验证了开关有效。
- DNS 逐级解析（dig +trace）——本机递归器黑洞，未测。
- HTTPS 证书链细节（SNI、证书透明度）——放 net-tls 那节。
- CDN 行为（边缘节点分布、就近调度）——本站与百度都经代理，看不到真实边缘节点，未测。
