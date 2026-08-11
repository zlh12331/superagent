# 24. IM 渠道集成规范

> 基于项目实际 IM 体系（im-service + IChannelAdapter + 8 个渠道适配器：飞书/企微/微信/QQ/钉钉/Telegram/webhook）。
> 最后同步：2026-08-11

---

## 一、架构分层

```
im-service（编排：start/stop/list/send/restore/stopAll）
  → IChannelAdapter 接口（渠道无关）
    → 各渠道 adapter（认证/消息映射）
      → stream（长连接/轮询：feishu-stream/weixin-stream 等）
```

- **渠道无关**：im-service 不感知具体协议；新渠道 = 新 adapter 实现 IChannelAdapter
- **桥接**：ImAgentBridge 将入站消息接入 Agent（懒执行）

## 二、IChannelAdapter 契约

| 方法 | 职责 |
|---|---|
| `start(token?)` | 建立连接/鉴权（失败抛 AppError，重试策略见 §三） |
| `stop()` | 优雅断开 |
| `send(chatId, text)` | 出站消息（失败可预期返回错误，不抛裸异常） |
| `onMessage(handler)` | 入站订阅（返回 unsubscribe） |

## 三、可靠性约定

1. **重连策略**：长连接断线指数退避重连（最多 3 次，16-error-logging §2.3）；会话过期（如微信 -14）暂停等待重新配置
2. **消息格式**：入站统一 `ChannelIncomingMessage`（channelId/chatId/text/source）；出站 text 截断（如微信 2000 字符）
3. **并发**：同渠道单实例；多订阅者（onMessage 支持多 handler——im-service 兼容）
4. **测试**：adapter 测试用真实 HTTP server（weixin-stream.test.ts 模式）；协议封装函数（fetchWeixinUpdates 等）独立可测

## 四、安全与配置

- token 走 safeStorage（17-security）；渠道配置由 settings 管理
- 出站消息审计：im 消息进会话记录（agent 桥接）

## 五、检查清单

- [ ] 新渠道实现 IChannelAdapter 全方法
- [ ] 重连退避 + 会话过期处理
- [ ] 入站/出站格式统一（ChannelIncomingMessage）
- [ ] token 加密存储
- [ ] 协议函数测试覆盖
