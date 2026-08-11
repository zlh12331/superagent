# 21. 前端状态管理规范（四层架构）

> 基于项目实际状态体系（React Compiler + Zustand 5 + TanStack Query 5 + IPC 事件流）制定分层与判定标准。
> 最后同步：2026-08-11

---

## 一、四层架构（强制分层）

| 层 | 工具 | 职责 | 示例 |
|---|---|---|---|
| L1 | useState / useRef | 组件内瞬态 | 输入框内容、折叠态、编辑态 |
| L2 | Zustand（persistent + transient） | 跨组件共享状态 | settings/sessions + file-tree/tool-store/approvals |
| L3 | TanStack Query 5 | IPC 请求-响应数据（查询类） | 会话列表、git diff、用量统计、回合统计 |
| L4 | IPC 事件订阅 | 主进程持续推送 → 直接写 transient store | agent:stream:* / terminal:event:* / update:event:* |

**核心原则**：服务端数据与客户端状态分离；配置型数据必须走后端单一真源（禁止渲染层手写兜底表）。

## 二、判定标准（数据该进哪层）

1. **IPC invoke 拉取型**（查询类）→ 必须 L3（缓存/去重/重试/失效/竞态）
   - 例外：一次性低频查询可维持 useEffect（如设置页打开才拉取的模型列表）
2. **IPC on 持续推送**（事件类）→ L4 订阅直写 transient store（页面卸载 unsubscribe，防泄漏）
3. **跨组件共享但非服务端数据**（UI 状态）→ L2
4. **组件独享** → L1（禁止为单组件状态引入 store）

## 三、工程化约束（已强制）

- **L3 类型安全**：queryKey 与 IPC 定义表联动（invoke 入参/返回类型推导）
- **L2 selector 稳定性**：selector 返回新数组/对象触发 useSyncExternalStore 无限循环——必须 useMemo 缓存派生值（TerminalPanel 教训）
- **L4 清理义务**：subscribe 返回的 unsubscribe 必须在卸载时调用（useEffect cleanup）
- **回合结束统一处理**：use-agent-bridge（AppShell 挂载）→ invalidate 会话缓存 + 清理 L2 缓冲 + usage 累积

## 四、检查清单

- [ ] 查询类数据走 L3（TanStack Query），非手写 useEffect fetch
- [ ] 事件订阅 L4 且卸载清理
- [ ] 跨组件 UI 状态进 L2，组件独享留 L1
- [ ] selector 派生值 useMemo 缓存
- [ ] 配置型数据不写渲染层兜底表
