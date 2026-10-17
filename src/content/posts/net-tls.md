---
title: TLS 与证书链
description: 实测：本站证书链 3 级（Let's Encrypt、90 天、SAN 精确匹配）、TLS 1.3 + AES-128-GCM、PSK 恢复显示 Reused；本机 openssl 无 CA 包致校验返回 20。
date: 2026-10-16
tags: [网络, TLS, 证书, HTTPS, Let's Encrypt]
category: network
section: net-tls
---

> 环境：Windows 11 x64，OpenSSL 3.5.7（PortableGit 自带），测量对象是本站 `wty.blogs.abrdns.com:443`（GitHub Pages）。**注意本机 openssl 不带 CA 根证书包**，所以 `Verify return code: 20 (unable to get local issuer certificate)` 是本地缺失而不是链有问题——本文用 `-showcerts` 数链条、用协商结果说话。探针命令可复现：`openssl s_client -connect wty.blogs.abrdns.com:443 -servername wty.blogs.abrdns.com`。

## 一、一次握手中发生的事情（TLS 1.3 版）

TLS 1.3（RFC 8446）把握手从两个 RTT 压到一个：

```
Client                                            Server
  ClientHello (支持的套件、密钥共享、SNI)  ──▶
                        ◀──  ServerHello (选定套件、它的密钥共享)
                        ◀──  {EncryptedExtensions}
                        ◀──  {Certificate}          ← 证书链在这里
                        ◀──  {CertificateVerify}    ← 服务端用私钥签名证明持有
                        ◀──  {Finished}
  {Finished}               ──▶
  应用数据（全加密）         ◀──▶  应用数据
```

本站实测协商结果：

```
New, TLSv1.3, Cipher is TLS_AES_128_GCM_SHA256
Server public key is 2048 bit
```

四个要点：

1. **密钥交换用 x25519（ECHD）不是 RSA**：服务器的 2048 位 RSA 只用于**签名身份**（CertificateVerify），**不是加密流量**——前向保密（PFS）就来自这里：私钥泄露不殃及历史会话。
2. **`TLS_AES_128_GCM_SHA256`**：AES-128-GCM 是 AEAD（认证加密一体，带重放保护的序列号在 nonce 里）。1.3 只允许 AEAD 套件，CBC 时代的填充oracle、BEAST/Lucky13 一类攻击面整体消失。
3. **1-RTT（甚至 0-RTT）**：上面流程一次往返完成。0-RTT 是"上次的 PSK 直接带着应用数据发"，快但有重放风险——**支付类请求永远不要 0-RTT**。
4. **除了 ClientHello/ServerHello，1.3 的其余握手消息全部加密**——中间设备看不到 SNI 之外的任何协商细节（1.2 里证书是明文飞的，ESNI/ECH 就是为了补 SNI 这个洞）。

## 二、证书链：本站的三级实证

`-showcerts` 数出 **3 张证书**，从叶到根：

| 级 | 实测内容 |
| --- | --- |
| 叶证书 | `subject=CN=wty.blogs.abrdns.com` |
| | `issuer=C=US, O=Let's Encrypt, CN=YR1`（中间 CA） |
| | `notBefore=Oct 15 06:34:22 2026 GMT` → `notAfter=Jan 13 06:34:21 2027 GMT`（**整 90 天**） |
| | `X509v3 Subject Alternative Name: DNS:wty.blogs.abrdns.com`（**只有这一个名字**） |
| 中间证书 | Let's Encrypt YR1（RSA 中间 CA） |
| 根证书 | ISRG Root X1（在本地信任库里，所以"链到根"靠的是信任锚而不是传输） |

三个工程读法：

1. **SAN 是唯一权威，CN 已废弃**。浏览器只看 SAN；`DNS:wty.blogs.abrdns.com` 意味着 `wty.blogs.abrdns.com` 匹配、`*.blogs.abrdns.com` 不匹配（没有通配条目）。**证书不覆盖子域是"NET::ERR_CERT_COMMON_NAME_INVALID"的第一原因**。
2. **90 天是 Let's Encrypt 的刻意设计**：短周期逼你自动化续期（certbot 的 timer 或 GitHub Actions 的定时任务）。**过期事故几乎都来自"手动续期"**——把续期当成 CI 作业，别当成年检。本站是 GitHub Pages 自动签自动续，用户侧无感。
3. **服务端只发叶 + 中间**，根证书必须在客户端信任库里（Windows 证书存储 / OpenSSL 的 ca-certificates）。**"链不完整"报错（校验返回 20/21）的修法是在服务端补发中间证书**，不是让用户装根——本站经 GitHub Pages 部署，中间证书由 GitHub 的 CDN 补齐。

## 三、会话恢复：Reused 的实测

TLS 1.3 的恢复靠 **PSK（预共享密钥）**：首次握手的密钥 material 存一个票据，重连时带上，省掉证书传输和密钥交换。实测（同一连接参数，先 `-sess_out` 存票据再 `-sess_in` 恢复）：

```
首次: New, TLSv1.3, Cipher is TLS_AES_128_GCM_SHA256
恢复: Reused, TLSv1.3, Cipher is TLS_AES_128256...
```

**`Reused` 字样即恢复成功**。恢复后的握手：客户端 ClientHello 带 `pre_shared_key` 扩展 → 服务端认票 → **0-RTT 或 1-RTT 完成**，省掉整张证书链的传输（本站链 3 张，恢复省的就是这部分 + 一次密钥交换 RTT）。

客户端侧注意：PSK 票据有有效期（服务端定，常见几小时到几天）且**可能被服务端单方面作废**（票据是服务端签发的，它可以选择不认）。所以"恢复失败"不是错误——退化成完整握手而已，客户端别把它当故障告警。

## 四、校验失败的四种长相与排障

| 现象 | 含义 | 修法 |
| --- | --- | --- |
| `certificate has expired` | 过了 notAfter | 续期；查服务端 NTP（时钟错会让"有效"证书显示过期） |
| `unable to get local issuer certificate`（本文本机 openssl 的返回 20） | 客户端缺中间/根 | **服务端补中间证书**；客户端更新 CA 包 |
| `Hostname mismatch` | SAN 不含访问的域名 | 换覆盖该域名的证书；检查 CDN/反代是否替换了证书 |
| `self signed certificate` | 叶证书的签发者是自己 | 测试环境别把自签证书推到生产；内网分发根要配合组策 |

本机 openssl 的返回 20 正是第二行：PortableGit 的 openssl 没带 `ca-certificates`，**它验不了任何公网证书**。这提醒一件事：**"openssl 报校验失败"先分清是链的问题还是本地信任库的问题**——用 `-CApath`/`-CAfile` 指系统证书再验一次即可分辨（本文用数链条 + 看协商结果绕过）。

## 五、SNI 与一个实测

**SNI（Server Name Indication）**是 ClientHello 里的明文目标域名——没有它，一个 IP 上的多个 HTTPS 站点无法选证书。实测两张：

```
带 -servername:  subject=CN=wty.blogs.abrdns.com   ← 本站证书
不带 SNI:        subject=CN=wty.blogs.abrdns.com   ← 同一张（该 IP 的默认证书恰好是它）
```

不带 SNI 也拿到本站证书，是因为这个 IP（GitHub Pages 边缘）的默认证书恰好就是它——**换个 Pages 站点连同一 IP 不带 SNI，拿到的就是别人的证书然后 hostname mismatch**。所以：客户端永远发 SNI（所有现代库默认都发）；自研客户端如果手写 TLS，忘发 SNI 的 bug 只在"目标 IP 上证书不唯一"时才暴露，属经典偶发。

明文 SNI 是隐私缺口（路径上的设备看得到你要访问哪个域名），ESNI/ECH（加密 SNI）在推进中——1.3 里 ECH 走 `encrypted_client_hello` 扩展，需要 DNS 里的 HTTPS 记录（`ech=` 参数）配合，本文未实测（本站未见 ECH 记录）。

## 六、未实测清单

- 0-RTT 数据与重放行为——未测（GitHub Pages 未见 0-RTT 广告）。
- ECH/ESNI——本站无记录，未测。
- mTLS（双向认证、客户端证书）——未测。
- 各密码套件的逐个协商（`-cipher` 指定）——只测了默认协商结果。
- Windows Schannel 侧的证书存储行为（curl 用的就是 Schannel）——未单独测；本文用 openssl 独立观测。
