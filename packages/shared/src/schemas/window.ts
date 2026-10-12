// window.ts：Window 域 IPC 契约单一真源（界面缩放的 window:applyZoom 请求-响应形状）
// 消费方：IPC 定义表（packages/shared/src/ipc/definitions.ts）引用这些 schema，注册层
// （src/main/ipc/register.ts）据此校验入参与 handler 返回值（resSchema 必填，缺失即启动抛错）。
// 边界：只定义形状；档位值域、归一与 overlay 高度换算在 packages/shared/src/constants/zoom.ts，
// 缩放的实际应用（setZoomFactor + Windows titleBarOverlay 联动）在 src/main/ipc/window.handler.ts。
// 设计依据 docs/implementation/35-ui-zoom-spec.md。

import { z } from 'zod';

import { ZOOM_LEVELS } from '../constants/zoom';

/**
 * window:applyZoom 入参 zod schema
 *
 * 不限定档位枚举：越界/损坏值不在本层拒收，由下游 clampZoom 归一到最近档位
 * （发送侧两道兜底——渲染层出口 src/renderer/lib/zoom.ts 与主进程 handler）。
 */
export const ApplyZoomReqSchema = z.object({
  /**
   * 目标缩放系数（DIP 缩放系数，1 = 100%）；合法值域见
   * packages/shared/src/constants/zoom.ts 的 ZOOM_LEVELS
   */
  zoom: z.number(),
});

/** window:applyZoom 入参类型（由 schema 推导，勿手写同形 interface 造成漂移） */
export type ApplyZoomReq = z.infer<typeof ApplyZoomReqSchema>;

/**
 * window:applyZoom 响应 payload（定义表的类型标记；运行时校验由下方 ApplyZoomResSchema 承担）
 *
 * ok 恒为 true：handler 没有失败回传路径——单窗口应用失败（销毁竞态等）只记 warn 并跳过，
 * 失败不经 ok:false 表达，渲染层调用方无须据它分支（src/renderer/lib/zoom.ts 亦不判它）。
 */
export interface ApplyZoomRes {
  /** 恒为 true（见接口说明） */
  readonly ok: boolean;
}

/** window:applyZoom 响应 zod schema——注册层在回渲染层前据它校验响应形状（防手写 Res 接口与实现漂移） */
export const ApplyZoomResSchema = z.object({
  /** 恒为 true（语义见上方 ApplyZoomRes） */
  ok: z.boolean(),
});

/**
 * 合法缩放档位重导出（真源：packages/shared/src/constants/zoom.ts）
 *
 * 让 window 域契约的取用方一并拿到 zoom 的值域常量；渲染层用的是 @code-agent/shared/renderer
 * 出口（从常量模块直接导出同一常量，不经含 zod 的 schema 模块）。
 */
export { ZOOM_LEVELS };
