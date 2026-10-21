# Changelog

## 2026-10-21

### 额度

`cfocus account list --usage` 和 `cfocus account usage` 增加 5 小时窗口和 7 天窗口的剩余时间。列名是「5小时剩余」和「周剩余」。

剩余时间按当前时刻计算，只显示最大的单位：满 1 天为 `剩余 1天`，不满 1 天为 `剩余 2小时`，不满 1 小时为 `剩余 30分钟`。已经到点显示 `已重置`。没有数据时显示 `—`。英文对应 `1 day left`、`2 hours left`、`30 min left`、`reset`。

### 切换

`cfocus switch` 先看 Claude Desktop 原来开没开。原来关着的，切换后保持关闭，并提示「Claude Desktop 保持关闭」。原来开着的，仍然先退出、换上目标账号的数据目录，再打开一次。`account init` 和 `account add` 仍会打开 Desktop。

### 会话列表

`cfocus list` 默认每个组织只列出最新的 20 条。`--limit <条数>` 修改条数，只接受正整数。会话按最近活动时间排序。没有列全时，标题写成 `20 / 86 条`（英文 `20 of 86`）。

### 会话复制

`cfocus switch --session`、`cfocus sync` 和交互复制会带上主会话索引里记录的子会话，包括 `sideSessionNotes` 和 `queuedSideSessionNotes`，以及这些子会话再拉起的会话。只复制子会话时，不会反过来复制它的父会话。

不加 `--overwrite` 时，目标里已有的主会话或子会话仍然各自跳过。加上 `--overwrite` 时，主会话和这些关联子会话都会覆盖。来源里找不到的子会话会提示，其余会话照常复制。对话正文仍在 `~/.claude/projects`，两边共用，不另存一份。
