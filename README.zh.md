# cfocus

[English](README.md) | 中文

在一台 Mac 上切换多个 Claude Desktop 订阅账号，并在这些账号之间复制 Code 会话索引。

Claude Desktop 只读取 `~/Library/Application Support/Claude`。每个账号的登录状态各自保存；缓存和会话目录用符号链接共用，避免每一份配置都复制一遍大约 1GB 的运行时数据。对话正文在 `~/.claude/projects`，所有账号共用，命令不会复制它。

只支持 macOS。需要 Node.js `>= 22.18`。

## 语言

界面语言默认跟随系统。`LC_ALL`、`LC_MESSAGES` 或 `LANG` 以 `zh` 开头时用中文，否则用英文。

```bash
cfocus --lang en account list
CFOCUS_LANG=zh cfocus account list
```

`CFOCUS_LANG` 为 `en` 或 `zh` 时优先于系统语言。档位名称 Free、Pro、Max、Max 5x、Max 20x、Team、Enterprise、API、API Team 两种语言相同。

## 安装

```bash
cd claude-focus
npm install
npm link
```

可执行文件名是 `cfocus`。也可以不安装，直接在仓库里运行 `node src/cli.ts`。

## 切换 Desktop 账号

先在 Claude Desktop 登录要保存的账号，然后记下它：

```bash
cfocus account init --yes
```

这条命令会退出 Desktop，把当前数据目录完整备份到 `~/Library/Application Support/cfocus/backup/initial`，把缓存和会话目录改成共享链接，识别当前账号的邮箱，再重新打开。打开后仍是刚才那个账号。备份大约 1GB，中间会安静一会儿。看到「当前账号」才算完成。

添加下一个账号：

```bash
cfocus account add --yes
```

Desktop 会打开一个空白登录。登录完成后，命令从本机配置识别账号 UUID 和邮箱。10 分钟内没检测到新账号时：

```bash
cfocus account adopt          # 登录已经完成，补记这个账号
cfocus account cancel --yes   # 放弃这次登录，恢复上一个账号
```

之后切换：

```bash
cfocus account list
cfocus switch --to <邮箱> --yes
```

切换会退出 Desktop，换上目标账号的整份数据目录，然后重新打开一次。退出不成功时不会移动文件。

切换时可以顺便复制会话索引。目标里已有同名文件则跳过；要覆盖时加 `--overwrite`。

```bash
cfocus switch --to <邮箱> --session <会话 ID> --yes
```

`--session` 可以重复。会话 ID 可以是裸 UUID，也可以带 `local_` 前缀。一个账号下有多个含会话的组织时，用 `--source-org` 和 `--dest-org` 指定。

退出、备份、添加和切换在非交互环境下必须带 `--yes`。

## 查看账号和额度

```bash
cfocus account list
cfocus account list --usage
cfocus account usage
cfocus account usage <邮箱>
```

`account list` 是一张表。列是状态、邮箱、档位、登录到期。带 `--usage` 时再加 5 小时、7 天、Sonnet 三列。终端里当前账号为绿色，邮箱为青色，登录到期为蓝色。备用账号的状态会变暗。设置 `NO_COLOR` 时只保留对齐。

`cfocus account list --usage` 的输出类似：

```text
Desktop 账号  2 个

状态  邮箱               档位  登录到期          5 小时  7 天  Sonnet
─────────────────────────────────────────────────────────────────────
当前  ada@example.com    Pro   2026-11-16 09:50  8%      13%   —
      11111111-1111-4111-8111-111111111111   组织 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
备用  blake@example.com  Pro   2026-11-16 16:10  0%      100%  —
      22222222-2222-4222-8222-222222222222   组织 bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

百分比是已经用掉的比例。Sonnet 这一列没有数据时显示 —。第二行是账号 UUID 和组织 UUID。

档位是该账号在 claude.ai 上的订阅，记在 `state.json` 的 `plan` 字段里。显示名称是：

| 档位 | 含义 |
| --- | --- |
| Free | 免费 |
| Pro | Pro |
| Max | Max，接口没有给出 5x / 20x |
| Max 5x | Max 5 倍用量 |
| Max 20x | Max 20 倍用量 |
| Team | Team |
| Enterprise | Enterprise |
| API | 个人 API |
| API Team | 团队 API |

个人订阅里没有 Plus。还没查到时这一列是 —。Pro 为青色，Max、Max 5x、Max 20x 为紫色，Team 和 Enterprise 为黄色，Free 变暗。

`account init` 和 `account add` 会在识别邮箱时记下档位。已经保存、但 `state.json` 里还没有档位的账号，下一次 `account list` 会读钥匙串并向 claude.ai 查一次，然后记住。之后的 `account list` 直接显示记住的档位，不再请求网络。换了套餐后执行 `cfocus account list --usage`，或 `cfocus account usage`，会在查额度的同时刷新档位。

`--usage` 和 `account usage` 会在执行时向 claude.ai 查询额度，包括当前没有登录在 Desktop 里的已保存账号。百分比是该时间窗里已经用掉的比例。低于 70% 为绿色，70% 到 89% 为黄色，90% 及以上为红色。

查询会读取钥匙串项「Claude Safe Storage」。macOS 第一次会询问权限。解密后的密码和 cookie 只留在内存里，不写入磁盘，也不打印。本地不保存上次的额度数字；订阅档位会保存。登录失效时，该行显示错误，而不是旧的额度。已记住的档位仍会留在表里，直到一次成功的查询把它换掉。

暂存的登录不会自己续期。会话密钥过期或被撤销后，重新在 Desktop 登录该账号，再执行 `cfocus account add` 或对当前账号执行 `cfocus account adopt`。

## 复制会话索引

不切换登录时，也可以只复制侧边栏索引：

```bash
cfocus                              # 交互选择
cfocus init                         # 按本机会话目录生成邮箱映射
cfocus accounts
cfocus list [邮箱]
cfocus sync --from <邮箱> --to <邮箱> --session <id> [--dry-run] [--overwrite]
```

复制的文件是：

```text
~/Library/Application Support/Claude/claude-code-sessions/<账号 UUID>/<组织 UUID>/local_*.json
```

组织目录会自动选择唯一含有 `local_*.json` 的那一个。目标已存在同名文件时默认跳过。Claude Desktop 正在运行时，`sync` 拒绝写入。

`cfocus init` 和 `cfocus account init` 不是同一件事。前者只写会话用的邮箱映射；后者才保存 Desktop 登录。

邮箱映射在 `~/.config/claude-focus/accounts.json`。账号切换不依赖这个文件；识别到邮箱后，会把邮箱补进映射，方便 `cfocus list` 使用。

## 数据位置

| 路径 | 内容 |
| --- | --- |
| `~/Library/Application Support/Claude` | 当前登录的 Desktop 数据 |
| `~/Library/Application Support/cfocus/backup/initial` | 第一次 `account init` 前的完整备份，只做一次 |
| `~/Library/Application Support/cfocus/shared` | 共用的缓存、运行时和会话目录 |
| `~/Library/Application Support/cfocus/profiles/<账号 UUID>` | 未登录账号的数据 |
| `~/Library/Application Support/cfocus/state.json` | 邮箱、组织、当前账号、订阅档位。权限 `0600`，不含 cookie 或 token |
| `~/.config/claude-focus/accounts.json` | 会话列表用的邮箱和账号 UUID |
| `~/.claude/projects` | 对话正文，所有账号共用 |

共用目录包括 `claude-code`、`claude-code-sessions`、`Cache`、`Code Cache`、各类 GPU 缓存、`Crashpad` 和 `VideoDecodeStats`。Cookies、`config.json` 以及其他登录和界面状态按账号分开保存。某一项如果在账号目录和共享目录里都已有实体，命令会停下来，不会合并。

## 开发

```bash
npm test
npm run check
```

`npm test` 使用 Node.js 自带的测试运行器，不接触本机的 Claude 数据目录。
