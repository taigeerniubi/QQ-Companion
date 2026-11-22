# QQ-Companion

自托管的 QQ AI 伙伴。用 DeepSeek 对话，用 Qwen 听说，把对话和可追溯的记忆保存在自己的设备上。

[![MIT License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node.js 24.13+](https://img.shields.io/badge/Node.js-24.13%2B-339933)](https://nodejs.org/)

[快速开始](#快速开始) · [接入 QQ](#接入-qq) · [本地数据](#本地数据) · [开发](#开发)

## 功能

- **私聊与群聊** — 对授权会话回复文字、图片或语音，支持主动问候、免打扰时段和频率限制。
- **版本化记忆** — 用 SQLite 保存记忆内容、来源消息和关联，支持查看历史版本以及按需检索。
- **语音交互** — Qwen 负责语音识别和合成。可选的 Music 3 服务在后台生成歌曲，完成后发回原会话。
- **Web 管理** — 设置角色、模型和会话白名单，查看运行状态、管理记忆及本地素材，并暂停或恢复回复。

## 快速开始

需要 Node.js 24.13 或更高版本，支持 Windows 和 Linux。通过 GitHub 的 **Code** 菜单克隆仓库，进入项目目录后安装依赖。

```sh
npm ci
npm run build
```

首次启动时将 `.env.example` 复制为 `.env`。PowerShell 用 `Copy-Item .env.example .env`，Linux 用 `cp .env.example .env`。在 `.env` 中为 `QQ_ADMIN_PASSWORD` 设置至少 8 个字符的密码，然后启动服务。

```sh
npm start
```

打开 [管理页](http://127.0.0.1:3210/qq-companion/)，用刚设置的密码登录。QQ 功能默认关闭，管理页可独立启动。前台运行时用 Ctrl+C 停止。需要后台运行时，用 `node scripts/start.mjs --background` 启动，用 `npm stop` 正常停止。

## 接入 QQ

QQ 消息通过 **OneBot 11** 的 HTTP API 和正向 WebSocket 收发。先在外部网关登录伙伴账号并开启这两种连接，再填写管理页的「连接与偏好」。[OneBot 11 官方 GitHub 仓库](https://github.com/botuniverse/onebot-11)

| 配置项 | 用途 |
| --- | --- |
| `selfId`、`ownerId` | 网关登录的伙伴 QQ 和你的 QQ。两者须不同。 |
| `httpUrl`、`wsUrl` | 网关的 HTTP API 地址和正向 WebSocket 地址。 |
| `ONEBOT_TOKEN` | 网关启用鉴权时写入 `.env`。通过 `onebotTokenEnv` 可指定其他变量名。 |
| `DEEPSEEK_API_KEY` | 对话和记忆提取使用的 API 密钥，写入 `.env`。 |
| `DASHSCOPE_API_KEY`、`voice` | 可选的 Qwen 语音密钥和音色。音色留空时使用文字回复。 |
| `friends`、`groups` | 额外授权的好友和群，默认留空。 |

保存后启用 QQ 伙伴。网关的收藏表情、语音和图片能力取决于网关实现。也可以从 `config.example.json` 创建 `config.local.json`，再编辑配置。进程环境变量优先于 `.env.local`，后者优先于 `.env`。修改密码、密钥或监听地址后重启服务。

**跨设备访问**可通过 `listenHost` 和 `port` 配置。默认监听 `0.0.0.0:3210`，可改为 `127.0.0.1` 限制在本机。使用自定义域名或 HTTPS 反向代理时，将管理页的协议、主机名和端口填入 `adminOrigins`，例如 `https://companion.example.com`。

**可选唱歌**需要一个提供 Music 3 `/synth` 和 `/job` 接口的外部服务。在「连接与偏好」中开启唱歌并配置 `musicBase`。服务要求 Bearer 认证时，将令牌写入 `.env` 的 `MUSIC3_TOKEN`。生成任务会与聊天并行运行，结果发送至发起会话。

## 本地数据

聊天、记忆和任务保存在项目的 `data/` 目录。停机后可以备份整个目录。服务会把处理对话和提取记忆所需的内容发给 DeepSeek，将待识别语音和待合成文本发给 Qwen。歌曲服务会收到用于生成的歌词及风格提示。请在授权的会话中使用。

## 开发

```sh
npm test        # 自动化测试
npm run check   # TypeScript 类型检查
npm run build   # 构建到 dist/
npm run doctor  # 检查环境和本地配置
npm run demo    # 在内存数据库中演示记忆与检索
```

欢迎通过 Issue 提交可复现的问题，或通过 Pull Request 提交改进。分享日志时请先清除账号、消息和密钥。

## 许可证

项目源码及文档采用 [MIT 许可证](LICENSE)。
