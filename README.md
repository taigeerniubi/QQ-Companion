# QQ-Companion

自托管的 QQ AI 伙伴。管理页使用环境变量密码登录，支持会话和正常停止服务。

## 启动

需要 Node.js 24.13+。启动前将 .env.example 复制为 .env，并填写 QQ_ADMIN_PASSWORD。

    npm install
    npm run build
    npm start

打开管理页 http://127.0.0.1:3210/qq-companion/。接入 QQ 时配置伙伴账号、授权会话、模型密钥和外部网关地址。网关连接使用 HTTP API 和正向 WebSocket。[OneBot 11 官方 GitHub 仓库](https://github.com/botuniverse/onebot-11)

## 许可证

[MIT](LICENSE)
