---
title: 权限与用户
description: 未实测（本机无 Linux）：rwx 三组与 umask 的计算、setuid/setgid/sticky 三特权的真实语义、capability 的最小权限实践、ACL 与 chattr 属性，以及"提权失败"的排查树。
date: 2026-10-16
tags: [Linux, 权限, setuid, capability, ACL]
category: linux
section: linux-permission
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级知识框架。Windows 对侧的本机实测见 win-registry-config（HKLM 写入一律 rc=5 的权限失败实测）。

## 一、rwx 与 umask：九位字的计算

权限位分三组（属主/属组/其他）× 三位（读/写/执行）：

```
r = 4  w = 2  x = 1
-rwxr-xr--  = 754：属主全权，组可读可执行，其他只读
```

**目录的 x 是"可进入"不是"可执行"**：有 r 没 x 能列出文件名但进不去/打不开文件；有 x 没 r 知道文件名就能访问——**"目录 755 文件 644"是最小安全默认**。

**umask 是创建时的掩码**：新文件权限 = 请求模式 & ~umask。默认 umask 022 → 新文件 644、新目录 755；umask 077 → 600/700（私密）。服务账户的 umask 别用 000——**"同组用户能读我刚建的配置文件"事故的第一现场**。`open` 的 mode 参数也过 umask（linux-fd 提过），这是 umask 常被忘的原因：代码里 `open(..., 0666)` 实际拿到的是 0644。

## 二、三个特权位：setuid / setgid / sticky

```
-rwsr-xr-x  setuid：执行时 euid = 文件属主（passwd 改 /etc/shadow 的原理）
-rwxr-sr-x  setgid：执行时 egid = 文件属组；对目录：新文件继承目录属组
drwxrwxrwt  sticky：目录里只能删/改名自己的文件（/tmp 的原理）
```

安全语义：

1. **setuid 是双刃剑**：程序以属主权限运行，任何输入漏洞都是提权。**shell 脚本忽略 setuid**（`#!` 解释器不继承），别依赖；setuid root 的二进制要审。
2. **目录 setgid 是协作目录的正规做法**：团队共享目录设它，新文件自动归组，省得每人 `chgrp`。
3. **sticky 只约束删除/改名，不约束读**：/tmp 人人可写但互相删不掉，靠的就是它。
4. **`find / -perm -4000`**：定期审计 setuid 二进制清单，多出来的就是可疑的。

## 三、capability：把 root 的权限拆开用

root 的实质是**拥有一组 capability**（`CAP_NET_BIND_SERVICE` 绑低端口、`CAP_SYS_TIME` 改时钟、`CAP_DAC_OVERRIDE`  bypass 文件权限……）。现代实践是**不给程序 root，只给需要的 capability**：

```bash
setcap cap_net_bind_service=+ep ./server    # 只给绑 80/443 的能力
getcap ./server                             # 查看
```

三条纪律：

1. **capability 存在文件的 xattr 里**，复制文件不一定带走（`cp` 丢、`tar` 看选项）——**CI 产物重新设 cap 是部署清单的一项**。
2. **`cap_net_raw` 一类危险能力约等于 root**（能嗅探、能伪造包），最小权限时优先砍它。
3. **容器里 capability 集是镜像元数据**（docker 的 `--cap-add/--drop`），跑 `capsh --print` 看当前集——linux-ns 那节容器部分会回到这。

## 四、ACL 与文件属性

标准 rwx 表达不了"给额外某用户某权限"——**POSIX ACL** 补这个：

```bash
setfacl -m u:alice:rw file      # 给 alice 读写
setfacl -m g:devs:rx dir        # 给组
getfacl file                    # 查看（注意 mask 项：它限制命名用户/组的实际上限）
```

`chmod` 会重算 mask 从而**意外削弱 ACL**——先 getfacl 再 chmod 是安全操作顺序。文件系统挂载时可能默认没开 ACL（`mount -o remount,acl`）。

**chattr 属性**是权限之上的另一层：`+i` 不可变（连 root 都改不了，日志防篡改）、`+a` 只能追加（write-once 日志的标准做法）、`+e`（ext4 的 extent 格式，`lsattr` 能看）。**`rm` 不掉 `+i` 的文件**，先 `chattr -i`。

## 五、sudo 与提权失败排查树

"明明有 root 为什么还不行"的排查顺序：

1. **是不是真的 root**：`id` 看 uid（`sudo -i` 拿真 root shell，别用 `sudo su` 老习惯）。
2. **sudoers 规则**：`sudo -l` 列当前用户被允许的命令；`visudo` 改配置（**语法错会把所有 sudo 锁死，visudo 的校验就是防这个**）；NOPASSWD 与默认需要密码的规则顺序。
3. **capability 够不够**：非 root 但需要特权操作时，`getcap`/`capsh` 看缺哪个能力——比"干脆 sudo"更符合最小权限。
4. **SELinux/AppArmor**：权限位全对还被拒，看 `ausearch -m AVC` / `dmesg | grep audit`——**强制访问控制是 rwx 之外的独立一层**，容器里尤其常见。
5. **只读文件系统/immutable**：`lsattr` 看 `i` 位，`mount | grep ro` 看挂载选项——"root 都改不了"的最后一站。

## 六、未实测清单

- 本文所有权限/capability/ACL 行为——无 Linux 环境，未测。
- SELinux/AppArmor 的策略调试——未部署。
- 容器里的 user namespace 映射（root 在容器里可能映射成宿主的高 UID）——linux-ns 概念层提及，未测。
- PAM 模块链——未涉及。
