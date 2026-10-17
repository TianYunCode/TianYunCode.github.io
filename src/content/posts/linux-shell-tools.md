---
title: 命令行与工具链
description: 未实测（本机以 Git Bash 为宿主）：管道与重定向的 fd 语义、grep/sed/awk 的分工、bash 引号展开的四层规则、systemctl/journalctl 的常用操作与排障入口。
date: 2026-10-16
tags: [Linux, shell, bash, grep, awk, systemd]
category: linux
section: linux-shell-tools
---

> **本文性质声明**：本机宿主是 Git Bash（MinGW 环境），**没有 systemd、没有 GNU 用户态全工具链**——systemctl/journalctl 一节为文档级知识，其余各节在 Git Bash 下可对照执行（同为 POSIX sh 语义）。本站同族实测见 engineering-ci-cd（流水线里的假绿，就是在 shell 上量的）。

## 一、管道与重定向：一切皆 fd 的直接红利

shell 的每一条命令都在操作三张表：

```
命令 > 文件      fd 1 指向文件（O_TRUNC 创建）
命令 >> 文件     fd 1 追加
命令 2> 文件     fd 2 指向文件
命令 2>&1        fd 2 复制成 fd 1 当前指向（顺序在 > 之后才对）
a | b            b 的 stdin 是管道读端，a 的 stdout 是管道写端
命令 < 文件      fd 0 指向文件
```

四个高频坑：

1. **`> log 2>&1` 才对，`2>&1 > log` 错**：后者先把 2 指向当前 1（终端），再把 1 指向文件——stderr 还是去终端。
2. **管道的退出码是最后一段的**：`set -o pipefail` 让任一一段失败整体失败（engineering-ci-cd 实测过 `gate | head -1` 把 rc=1 变 rc=0 的假绿）。
3. **`nohup`/`&` 与 SIGHUP**：终端断开时前台进程组收 SIGHUP（linux-process 那节），`nohup` 忽略它、`disown` 把它移出作业表。
4. **重定向的顺序就是 fd 操作的顺序**——把 `2>&1 >file` 想成"先 dup2(1,2) 再 open(file,1)"就不会错。

## 二、grep / sed / awk：三件套的分工

| 工具 | 模型 | 拿手 | 别拿它干 |
| --- | --- | --- | --- |
| grep | 行过滤 | 找行：`-r` 递归、`-n` 行号、`-E` 扩展正则、`-v` 反选、`-l` 只列文件 | 改内容 |
| sed | 行编辑器 | 替换：`s/old/new/g`、删除行 `3d`、地址范围 `10,20p`、就地 `-i` | 跨行状态、算术 |
| awk | 记录处理器 | 按列算：`$1 $3`、`NR FNR`、`sum+=$2`、`END{}` 汇总、关联数组 | 非文本 |

组合的样板（都在本站工程里真用过）：

```bash
grep -rn "TODO" src/ --include="*.md" | wc -l     # 数待办
sed -n '10,20p' file                               # 只看 10-20 行
awk '{sum += $2} END {print sum}' data.txt         # 第二列求和
awk -F: '$3 >= 1000 {print $1}' /etc/passwd        # 冒号分隔筛 UID>=1000
```

**引号纪律**：`grep '$var'`（单引号）里 `$` 不展开——要展开用双引号。`awk` 脚本整体单引号，里面的 shell 变量用 `-v x="$var"` 传，**别拼进 awk 源码**（注入 + 转义地狱）。

## 三、bash 脚本：引号与展开的四层规则

bash 的展开顺序（记住这个顺序能解释 90% 的"变量怎么变成这样"）：

```
大括号展开 → 波浪号展开 → 参数/变量/算术/命令替换 → 词分割 → 路径名展开（通配）
```

逐条的坑：

1. **不加引号的变量会被词分割 + 通配**：`rm $file` 在 file 含空格时炸；`for f in $(ls)` 对含空格文件名是错的（用 `for f in *`）。**一切变量默认加双引号**。
2. **`$()` 优于反引号**：可嵌套、转义直观。
3. **`$@` vs `$*`**：带引号的 `"$@"` 逐参数保留（函数包装转发参数的唯一正确姿势），`"$*"` 合成一个。
4. **`[[ ]]` 优于 `[ ]`**：前者是关键字（不会被空参数坑、支持 `==` 模式匹配和 `&&`）。
5. **`set -euo pipefail` 三件套**：`-e` 错即停、`-u` 未定义变量即错、`pipefail` 管道全对才算对——**但 `-e` 有例外**（条件里的命令、管道非首段），别把它当万灵药，关键路径显式查返回码。
6. **`local` 声明变量**：bash 的变量默认全局，函数里的临时变量不加 `local` 会污染调用方。

## 四、systemctl / journalctl：服务与日志的入口

systemd 系统的服务管理（文档级，本机无 systemd）：

```bash
systemctl status nginx          # 状态 + 最近日志 + cgroup 信息，排障第一命令
systemctl start/stop/restart    # 立即
systemctl enable/disable        # 开机自启（建 symlink，不动 unit 文件）
systemctl reload nginx          # 不发信号给主进程，走 unit 里 ExecReload
systemctl list-units --failed   # 所有失败的单元
journalctl -u nginx -f          # 跟一个服务的日志
journalctl -p err -b            # 本次启动的错误级以上
journalctl --since "1 hour ago" # 时间窗
systemd-analyze blame           # 各单元启动耗时（启动慢看这个）
```

unit 文件排障三件套：`systemctl cat nginx`（看实际生效的配置，含 drop-in 覆盖）、`systemctl show nginx -p Environment`（看环境变量）、`journalctl -u nginx --since today`。**"服务起来了但行为不对"先看 status 里的 Main PID 和 Cgroup**——可能跑的是另一份配置（drop-in 覆盖是隐形大户）。

## 五、排障索引

| 症状 | 入口 |
| --- | --- |
| 命令找不到 | `type -a cmd`（别名/函数/PATH 三段）、`echo $PATH` |
| 脚本行为诡异 | `bash -x script.sh` 跟踪执行 |
| 变量值是空的/带空格的 | 检查没加引号导致的词分割 |
| 服务起不来 | `systemctl status` → `journalctl -u` 按时间窗 |
| 磁盘满了 | `df -h` + `du -x --max-depth=1 / | sort -h` |
| 端口被占 | `ss -tlnp`（比 netstat 新，能看进程） |

## 六、未实测清单

- systemd 全族命令行为——本机无 systemd，未测（以上为文档级）。
- GNU coreutils 各工具版本差异（busybox 嵌入式场景）——未测。
- zsh/fish 的差异语法——未涉及。
- Git Bash 与真 Linux 的细微差异（路径转换、/proc 缺失）——未系统对比。
