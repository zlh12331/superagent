# MotionLens Benchmark Report

## 测试结果摘要（可直接贴 README）

```text
MotionLens 对 MotionVault 灵感库 72 个动效卡片自动提取：总覆盖率 63.9%（46/72）。
结构化提取（WAAPI/CSS/Transition）动画共 62 条：css=2, transition=7, waapi=53；
采样回放兜底命中 23 张卡（segments 共 27 段，平均拟合残差 0.114）。
```

## 指标

- 运行时间：2026-08-31T08:09:38.051Z，耗时 667.9s
- 采样模式：每分类 6 张卡
- **总覆盖率：63.9%**（46/72，≥1 条结构化动画或 sampled segments 非空）
- 采样拟合平均 error：0.114

### 分来源统计（动画条数）

| source | count |
| --- | ---: |
| css | 2 |
| transition | 7 |
| waapi | 53 |
| sampled(segments) | 27 |

### trigger 分布（动画条数）

| trigger | count |
| --- | ---: |
| load | 45 |
| hover | 9 |
| click | 8 |
| unknown | 0 |

### 分分类覆盖率

| category | route | cards | covered | coverage | no-animation | error |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| text | /text | 6 | 4 | █████████████░░░░░░░ 66.7% | 2 | 0 |
| cards | /cards | 6 | 5 | █████████████████░░░ 83.3% | 1 | 0 |
| layout | /layout | 6 | 6 | ████████████████████ 100.0% | 0 | 0 |
| 3d | /3d | 6 | 0 | ░░░░░░░░░░░░░░░░░░░░ 0.0% | 6 | 0 |
| particles | /particles | 6 | 0 | ░░░░░░░░░░░░░░░░░░░░ 0.0% | 6 | 0 |
| backgrounds | /backgrounds | 6 | 4 | █████████████░░░░░░░ 66.7% | 2 | 0 |
| buttons | /buttons | 6 | 6 | ████████████████████ 100.0% | 0 | 0 |
| scroll | /scroll | 6 | 6 | ████████████████████ 100.0% | 0 | 0 |
| svg | /svg | 6 | 4 | █████████████░░░░░░░ 66.7% | 2 | 0 |
| loaders | /loaders | 6 | 6 | ████████████████████ 100.0% | 0 | 0 |
| spring | /spring | 6 | 5 | █████████████████░░░ 83.3% | 1 | 0 |
| lab | /lab | 6 | 0 | ░░░░░░░░░░░░░░░░░░░░ 0.0% | 6 | 0 |

### 失败清单（26）

| card | category | status | reason |
| --- | --- | --- | --- |
| text-3-乱序解码 | text | no-animation | 结构化提取为空且采样无有效通道 |
| text-4-流光文字 | text | no-animation | 结构化提取为空且采样无有效通道 |
| cards-1-聚光灯卡片 | cards | no-animation | 结构化提取为空且采样无有效通道 |
| 3d-0-浮动几何体群 | 3d | no-animation | 结构化提取为空且采样无有效通道 |
| 3d-1-粒子球体 | 3d | no-animation | 结构化提取为空且采样无有效通道 |
| 3d-2-波浪平面 | 3d | no-animation | 结构化提取为空且采样无有效通道 |
| 3d-3-噪声扭曲球体 | 3d | no-animation | 结构化提取为空且采样无有效通道 |
| 3d-4-旋转圆环组 | 3d | no-animation | 结构化提取为空且采样无有效通道 |
| 3d-5-星空穿梭 | 3d | no-animation | 结构化提取为空且采样无有效通道 |
| particles-0-星座网络 | particles | no-animation | 结构化提取为空且采样无有效通道 |
| particles-1-漂浮粒子场 | particles | no-animation | 结构化提取为空且采样无有效通道 |
| particles-2-粒子文字 | particles | no-animation | 结构化提取为空且采样无有效通道 |
| particles-3-彩带爆发 | particles | no-animation | 结构化提取为空且采样无有效通道 |
| particles-4-流星雨 | particles | no-animation | 结构化提取为空且采样无有效通道 |
| particles-5-烟花绽放 | particles | no-animation | 结构化提取为空且采样无有效通道 |
| backgrounds-4-噪声波纹 | backgrounds | no-animation | 结构化提取为空且采样无有效通道 |
| backgrounds-5-闪烁方格 | backgrounds | no-animation | 结构化提取为空且采样无有效通道 |
| svg-1-图标描绘 | svg | no-animation | 结构化提取为空且采样无有效通道 |
| svg-2-环形进度 | svg | no-animation | 结构化提取为空且采样无有效通道 |
| spring-0-果冻按钮 | spring | no-animation | 结构化提取为空且采样无有效通道 |
| lab-0-织物印字 | lab | no-animation | 结构化提取为空且采样无有效通道 |
| lab-1-暖帘 | lab | no-animation | 结构化提取为空且采样无有效通道 |
| lab-2-生长之树 | lab | no-animation | 结构化提取为空且采样无有效通道 |
| lab-3-球面文字 | lab | no-animation | 结构化提取为空且采样无有效通道 |
| lab-4-液态金属 | lab | no-animation | 结构化提取为空且采样无有效通道 |
| lab-5-雨滴水潭 | lab | no-animation | 结构化提取为空且采样无有效通道 |
