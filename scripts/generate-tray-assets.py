# scripts/generate-tray-assets.py
# 托盘图标资产生成（一次性工具，icon.png 更新后重跑）
# ──────────────────────────────────────────────────────────────
# 输入：resources/icons/icon.png（白底 + 靛蓝圆角方块 + 白色终端符号）
# 输出（同目录）：
# - trayTemplate.png / trayTemplate@2x.png   macOS template：黑色剪影 + alpha
# - tray16.png / tray24.png / tray32.png     Win/Linux 彩色多尺寸（透明圆角）
#
# 原理：以靛蓝底色亮度为 0、白色为 1 做线性 alpha 映射（保留抗锯齿）；
#       从裁剪边缘泛洪「非底色」像素，剔除页底白、阴影晕与方块边缘过渡带，
#       避免模板出现方形描边。水印（灰字）随裁剪与泛洪一并剔除。
# 依赖：Pillow（本机 py -c "import PIL" 可用）
# ──────────────────────────────────────────────────────────────

from collections import deque

from PIL import Image

SRC = "resources/icons/icon.png"
OUT_DIR = "resources/icons"


def sample_background(px) -> tuple[int, int, int]:
    """取靛蓝底色：方块几何中心附近多数派采样（避免依赖固定坐标）"""
    # 方块约占画布 68-956，取中心 64px 邻域均值
    rs = gs = bs = n = 0
    for y in range(480, 545, 4):
        for x in range(300, 364, 4):  # 左侧空白区（避开中央符号）
            r, g, b = px[x, y][:3]
            rs += r
            gs += g
            bs += b
            n += 1
    return (rs // n, gs // n, bs // n)


def luminance(rgb: tuple[int, int, int]) -> float:
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def find_square_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    px = im.load()
    w, h = im.size
    bg = sample_background(px)
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            d = sum(abs(px[x, y][i] - bg[i]) for i in range(3))
            if d < 90:
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
    return (minx, miny, maxx + 1, maxy + 1)


def extract(im_crop: Image.Image, bg_lum: float) -> Image.Image:
    """泛洪剔除边缘连通的非底色像素，返回 RGBA：
    - macOS template（black=True）：符号转黑色，alpha=白度
    - 彩色（black=False）：保留原色，alpha=底色度"""
    px = im_crop.load()
    w, h = im_crop.size
    # 与底色的颜色距离（用于判定「实底」）
    def dist_to_bg(x: int, y: int) -> int:
        p = px[x, y][:3]
        return int(abs(p[0] - BG[0]) + abs(p[1] - BG[1]) + abs(p[2] - BG[2]))

    edge_reachable = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            q.append((x, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or edge_reachable[y][x]:
            continue
        if dist_to_bg(x, y) < 90:
            continue  # 实底：泛洪止步
        edge_reachable[y][x] = True
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            p = px[x, y][:3]
            lum = luminance(p)
            if edge_reachable[y][x]:
                t = 0.0
            else:
                t = max(0.0, min(1.0, (lum - bg_lum) / (255.0 - bg_lum)))
            op[x, y] = (0, 0, 0, round(t * 255))
    return out


def extract_color(im_crop: Image.Image, bg_lum: float) -> Image.Image:
    """彩色多尺寸：底色不透明、页底透明、过渡带线性 alpha（柔边圆角）"""
    px = im_crop.load()
    w, h = im_crop.size
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            p = px[x, y][:3]
            lum = luminance(p)
            a = max(0.0, min(1.0, (bg_lum + 40 - lum) / 40.0))
            # 底色度：亮度低于 bg_lum+40 全不透明，接近白色全透明
            op[x, y] = (p[0], p[1], p[2], round(a * 255))
    return out


def save_template(glyph: Image.Image) -> None:
    # 有效像素（alpha>96）取包围盒，防弱噪声撑大画布稀释笔画；从大画布单步
    # LANCZOS 直达目标尺寸（中间档二次缩放会把对角笔画摊灰）；缩后 alpha 重
    # 映射——核心推回实心、抗锯齿收窄成窄环，16px 下菜单栏里才够实
    a_full = glyph.getchannel("A")
    strict = a_full.point(lambda v: 255 if v > 96 else 0)
    bbox = strict.getbbox()
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = max(gw, gh) // 12
    side = max(gw, gh) + 2 * pad
    canvas = Image.new("L", (side, side), 0)
    canvas.paste(
        a_full.crop(bbox),
        (pad + (side - 2 * pad - gw) // 2, pad + (side - 2 * pad - gh) // 2),
    )

    def sharpen(v: int) -> int:
        if v < 45:  # ~0.18 以下视为背景
            return 0
        if v > 190:  # ~0.75 以上推到实心
            return 255
        return round((v - 45) / (190 - 45) * 255)

    for size, name in ((16, "trayTemplate.png"), (32, "trayTemplate@2x.png")):
        a = canvas.resize((size, size), Image.LANCZOS).point(sharpen)
        # template 要求黑色 + alpha 通道；重映射后的 L 图作为 alpha 组合
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        img.putalpha(a)
        img.save(f"{OUT_DIR}/{name}")


def save_color(square: Image.Image) -> None:
    for size in (16, 24, 32):
        square.resize((size, size), Image.LANCZOS).save(f"{OUT_DIR}/tray{size}.png")


im = Image.open(SRC).convert("RGBA")
px = im.load()
BG = sample_background(px)
BG_LUM = luminance(BG)
crop = im.crop(find_square_bbox(im))
save_template(extract(crop, BG_LUM))
save_color(extract_color(crop, BG_LUM))
print("generated: trayTemplate{,@2x}.png + tray{16,24,32}.png under", OUT_DIR)
