import { z } from 'zod';

import { ZOOM_LEVELS } from '../constants/zoom';

/** window:applyZoom 入参（zoom 为合法档位；handler 内不二次防御——渲染层 clamp 后写入） */
export const ApplyZoomReqSchema = z.object({
  zoom: z.number(),
});

export type ApplyZoomReq = z.infer<typeof ApplyZoomReqSchema>;

/** window:applyZoom 响应 */
export interface ApplyZoomRes {
  readonly ok: boolean;
}

export const ApplyZoomResSchema = z.object({
  ok: z.boolean(),
});

export { ZOOM_LEVELS };
