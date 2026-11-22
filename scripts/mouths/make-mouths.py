#!/usr/bin/env python3
"""
TomoPet 口型素材生成（开发工具，程序运行时不用它；需要 Python 3 + Pillow）。

为什么（2026-11-21 用户：「只用动嘴就行了」「移植口型给它们」「按 CC 协议署名后直接打包」）：
CrossPet 的立绘是静态图，没有张嘴的帧。hunmer/aboutme-pets 用这些立绘当首帧生成了「碎碎念」视频（嘴在动、头几乎不动），
所以把视频里几帧的嘴对齐到立绘上抠出来，做成和立绘一样大、只有嘴那一块不透明的叠加图；说话时叠在待机图上换着显示。
没有对应视频的皮肤（deepseek 几套、换装）把别的皮肤做好的嘴调色、缩放后移植过去。

  python scripts/mouths/make-mouths.py                  全部皮肤
  python scripts/mouths/make-mouths.py --only crosspet-claude
  python scripts/mouths/make-mouths.py --only crosspet-claude --scan    每帧的对齐误差和张嘴程度（挑帧用）

输入：art/crosspet/characters/<角色>/idle.webp（CrossPet 原图）；hunmer 的精灵图按 mouths.json 里钉死的提交下载到 art/hunmer/，核对 git blob sha。
输出：art/mouths/<皮肤 id>/mouth-*.webp + mouth.json（core/crosspet-import.js 打包皮肤时拷进去），预览图在 art/mouths/_preview/。
art/ 不进 git（受版权保护的素材和代码分开）。素材授权：hunmer/aboutme-pets，CC BY-NC-SA 4.0（见 mouths.json 的 credit）。
"""
import argparse
import hashlib
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat
except ImportError:
    sys.exit('需要 Pillow：pip install pillow')

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).with_name('mouths.json')
CHAR_DIR = ROOT / 'art' / 'crosspet' / 'characters'
SRC_DIR = ROOT / 'art' / 'hunmer'
OUT_DIR = ROOT / 'art' / 'mouths'
LEVELS = ('closed', 'half', 'wide')
CELL_W, CELL_H, COLS = 640, 360, 8


def blob_sha(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def fetch(cfg, src):
    """下载（或复用）一张精灵图，核对 sha。"""
    pack, action, sha = src['pack'], src['action'], src['sha']
    dest = SRC_DIR / pack / f'{action}.webp'
    if dest.exists() and blob_sha(dest.read_bytes()) == sha:
        return dest
    path = f'pets/{pack}/spritesheet/{action}.webp'
    url = f"https://raw.githubusercontent.com/{cfg['repo']}/{cfg['commit']}/{urllib.parse.quote(path)}"
    print(f'  下载 {path}')
    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read()
    if blob_sha(data) != sha:
        sys.exit(f'{path} 的 sha 对不上（期望 {sha}）：上游文件变了，或者下载不完整。')
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


class Sheet:
    def __init__(self, path):
        self.im = Image.open(path).convert('RGBA')
        self.cache = {}

    def cell(self, i):
        if i not in self.cache:
            x, y = (i % COLS) * CELL_W, (i // COLS) * CELL_H
            self.cache[i] = self.im.crop((x, y, x + CELL_W, y + CELL_H))
        return self.cache[i]


def flat(img):
    bg = Image.new('RGBA', img.size, (128, 128, 128, 255))
    bg.alpha_composite(img)
    return bg.convert('L')


def affine(s, deg, cface, csrc, origin, q=1.0):
    """输出像素 (u,v) → 立绘坐标 origin+(u,v)*q → 源坐标 s·R(deg)·(p - cface) + csrc。返回 PIL AFFINE 系数。"""
    t = math.radians(deg)
    a, b = s * math.cos(t), -s * math.sin(t)
    d, e = s * math.sin(t), s * math.cos(t)
    ox, oy = origin[0] - cface[0], origin[1] - cface[1]
    return (a * q, b * q, a * ox + b * oy + csrc[0], d * q, e * q, d * ox + e * oy + csrc[1])


def warp(src, size, coeffs):
    return src.transform(size, Image.AFFINE, coeffs, resample=Image.BICUBIC)


class Aligner:
    """把立绘的脸（face 框）对到精灵图的某一帧上：缩放 s、旋转 deg、脸中心在源里的位置 c。嘴那块不参与比较（嘴本来就不一样）。"""

    def __init__(self, idle, face, box):
        self.face = face
        self._box = box
        self.cface = ((face[0] + face[2]) / 2, (face[1] + face[3]) / 2)
        crop = idle.crop(face)
        self.ref = {1: self._masked(flat(crop), box), 2: self._masked(flat(crop.resize((crop.width // 2, crop.height // 2), Image.LANCZOS)), box, 2)}

    def _masked(self, gray, box, q=1):
        g = gray.copy()
        x0, y0 = (box[0] - self.face[0]) / q, (box[1] - self.face[1]) / q
        x1, y1 = (box[2] - self.face[0]) / q, (box[3] - self.face[1]) / q
        ImageDraw.Draw(g).rectangle((x0 - 2, y0 - 2, x1 + 2, y1 + 2), fill=128)
        return g

    def score(self, cell, s, deg, c, q=1):
        ref = self.ref[q]
        w = warp(cell, ref.size, affine(s, deg, self.cface, c, self.face[:2], q))
        g = self._mask_box(flat(w), q)
        return ImageStat.Stat(ImageChops.difference(g, ref)).mean[0]

    def _mask_box(self, g, q):
        return self._masked(g, self._box, q)

    def search(self, cell, guess, degs, scales, offs, q):
        best = None
        for deg in degs:
            for s in scales:
                for dx in offs:
                    for dy in offs:
                        c = (guess[2][0] + dx, guess[2][1] + dy)
                        d = self.score(cell, s, deg, c, q)
                        if best is None or d < best[0]:
                            best = (d, s, deg, c)
        return best

    def full(self, cell, guess):
        """第一帧：大范围粗搜（半分辨率）再细搜。guess = (s, deg, c)。"""
        s0, d0 = guess[0], guess[1]
        frange = lambda a, b, st: [round(a + i * st, 4) for i in range(int(round((b - a) / st)) + 1)]
        best = self.search(cell, guess, frange(d0 - 12, d0 + 12, 2), frange(s0 * 0.88, s0 * 1.12, 0.01), range(-18, 19, 3), 2)
        g = (best[1], best[2], best[3])
        best = self.search(cell, g, frange(g[1] - 1.5, g[1] + 1.5, 0.5), frange(g[0] - 0.01, g[0] + 0.01, 0.0025), range(-3, 4), 1)
        return best

    def refine(self, cell, g):
        frange = lambda a, b, st: [round(a + i * st, 4) for i in range(int(round((b - a) / st)) + 1)]
        return self.search(cell, (g[1], g[2], g[3]), frange(g[2] - 2, g[2] + 2, 1), frange(g[1] - 0.005, g[1] + 0.005, 0.005), range(-4, 5), 1)


def initial_guess(idle, cell, cface):
    """按人物包围盒粗估：底边对齐、按高度缩放。"""
    ib, cb = idle.getbbox(), cell.getbbox()
    s = (cb[3] - cb[1]) / (ib[3] - ib[1])
    cx = (cb[0] + cb[2]) / 2 + (cface[0] - (ib[0] + ib[2]) / 2) * s
    cy = cb[3] - (ib[3] - cface[1]) * s
    return (s * 0.95, 0.0, (cx, cy))


def mask_for(size, box, kind, feather):
    m = Image.new('L', size, 0)
    inset = 2
    r = (box[0] + inset, box[1] + inset, box[2] - inset - 1, box[3] - inset - 1)
    if kind == 'ellipse':
        ImageDraw.Draw(m).ellipse(r, fill=255)
    else:
        rad = int(min(box[2] - box[0], box[3] - box[1]) / 3)
        ImageDraw.Draw(m).rounded_rectangle(r, radius=rad, fill=255)
    return m.filter(ImageFilter.GaussianBlur(feather)) if feather else m


def sharpened(img, percent, radius):
    """只锐化颜色、不动透明度（整张 RGBA 一起锐化会把羽化边也锐化，嘴外面出一圈白边）。"""
    if not percent:
        return img
    out = img.convert('RGB').filter(ImageFilter.UnsharpMask(radius=radius, percent=int(percent), threshold=1)).convert('RGBA')
    out.putalpha(img.getchannel('A'))
    return out


def tinted(patch, gains):
    if not gains:
        return patch
    r, g, b, a = patch.split()
    ch = [c.point(lambda v, k=k: max(0, min(255, round(v * k)))) for c, k in zip((r, g, b), gains)]
    return Image.merge('RGBA', (*ch, a))


def clamp_gains(ref, got, lo=0.8, hi=1.25):
    if not ref or not got:
        return None
    return [max(lo, min(hi, r / g if g else 1)) for r, g in zip(ref, got)]


def skin_mean(img, mask):
    """遮罩范围里「皮肤」的平均颜色：按亮度排序，去掉最亮的 5%（高光）和偏暗的那一半（嘴里、线条、下巴线）。"""
    bbox = mask.getbbox()
    if not bbox:
        return None
    rgb = img.convert('RGB').crop(bbox).getdata()
    m = mask.crop(bbox).getdata()
    px = [p for p, k in zip(rgb, m) if k > 0]
    if len(px) < 20:
        return None
    px.sort(key=lambda p: -(p[0] * 299 + p[1] * 587 + p[2] * 114))
    sel = px[int(len(px) * 0.05):max(int(len(px) * 0.05) + 1, int(len(px) * 0.55))]
    return [sum(p[i] for p in sel) / len(sel) for i in range(3)]


def tint_to_target(overlay, idle):
    """把叠加图里的皮肤调成紧挨着它外面那一圈立绘皮肤的颜色（每张嘴单独算：视频各帧、各角色的肤色都不一样）。"""
    a = overlay.getchannel('A')
    solid = a.point(lambda v: 255 if v > 200 else 0)
    covered = a.point(lambda v: 255 if v > 0 else 0)
    ring = ImageChops.subtract(covered.filter(ImageFilter.MaxFilter(13)), covered)
    ring = ImageChops.multiply(ring, idle.getchannel('A').point(lambda v: 255 if v > 200 else 0))
    gains = clamp_gains(skin_mean(idle, ring), skin_mean(overlay, solid), 0.85, 1.15)
    return tinted(overlay, gains)


def lum(c):
    return c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114


def ring_skin(overlay, idle):
    """叠加图外面紧挨着的那一圈立绘皮肤的颜色。"""
    covered = overlay.getchannel('A').point(lambda v: 255 if v > 0 else 0)
    ring = ImageChops.subtract(covered.filter(ImageFilter.MaxFilter(13)), covered)
    ring = ImageChops.multiply(ring, idle.getchannel('A').point(lambda v: 255 if v > 200 else 0))
    return skin_mean(idle, ring)


def mouth_palette(img, mask, skin):
    """嘴的两种颜色：描边（最暗的那些）和嘴里（不是皮肤的像素里偏亮的那部分）。找不到就 None。"""
    bbox = mask.getbbox()
    if not bbox or not skin:
        return None
    rgb = img.convert('RGB').crop(bbox).getdata()
    m = mask.crop(bbox).getdata()
    px = [p for p, k in zip(rgb, m) if k > 0 and sum((a - b) ** 2 for a, b in zip(p, skin)) ** 0.5 > 45]
    if len(px) < 15:
        return None
    px.sort(key=lum)
    n = len(px)
    avg = lambda arr: [sum(p[i] for p in arr) / len(arr) for i in range(3)]
    # 分成两堆（嘴里 / 描边）：从最暗和偏亮的两头开始，按离谁近来回分几次。按亮度百分位直接切会把嘴里的渐变切掉一半（嘴里估得偏暗）。
    line, inner = avg(px[:max(3, n // 10)]), avg(px[n // 2:])
    d2 = lambda p, c: sum((a - b) ** 2 for a, b in zip(p, c))
    for _ in range(8):
        a = [p for p in px if d2(p, line) <= d2(p, inner)]
        b = [p for p in px if d2(p, line) > d2(p, inner)]
        if not a or not b:
            break
        line, inner = avg(a), avg(b)
    a = sorted((p for p in px if d2(p, line) <= d2(p, inner)), key=lum)
    if a:
        line = avg(a[:max(1, len(a) * 2 // 3)])  # 描边取那一堆里偏暗的：边上的半透明过渡不算
    return {'line': line, 'inner': inner}


def _seg(c, a, b):
    """c 投到线段 a→b 上：返回 (参数 t∈[0,1], 距离²)。"""
    ab = [y - x for x, y in zip(a, b)]
    L = sum(v * v for v in ab) or 1e-6
    t = max(0.0, min(1.0, sum((ci - ai) * v for ci, ai, v in zip(c, a, ab)) / L))
    q = [ai + t * v for ai, v in zip(a, ab)]
    return t, sum((ci - qi) ** 2 for ci, qi in zip(c, q))


def recolor_mouth(overlay, idle, box, closed=False):
    """
    把贴上去的嘴换成这张立绘自己那张嘴的颜色（2026-11-21 用户：deepseek、kimi、glm 张嘴有色差）。
    视频里的嘴偏玫红、描边又粗又深，外面还有一圈压缩出来的白边；立绘的嘴是柔和的橙粉色、细棕线。
    色板从立绘原来张着的那张嘴上量（box 里）：皮肤 → 嘴里 → 描边。叠加图的每个像素按它在「皮肤→嘴里→描边」
    这条折线上的位置换成立绘色板上同样位置的颜色；比皮肤还亮的白边落在折线外，被拉回皮肤色。闭嘴那张只有线：皮肤 → 描边。
    """
    skin = ring_skin(overlay, idle)
    region = Image.new('L', idle.size, 0)
    ImageDraw.Draw(region).rectangle(box, fill=255)
    dst = mouth_palette(idle, ImageChops.multiply(region, idle.getchannel('A').point(lambda v: 255 if v > 200 else 0)), skin)
    solid = overlay.getchannel('A').point(lambda v: 255 if v > 120 else 0)
    src = mouth_palette(overlay, solid, skin)
    if not dst or not src:
        return overlay
    out = overlay.copy()
    bbox = overlay.getchannel('A').getbbox()
    px = out.load()
    x0, y0, x1, y1 = bbox
    # 先分出描边：离「嘴里→描边」那段近、而且已经走过一小半的算描边。
    kind = {}
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            c = (r, g, b)
            if closed:
                kind[(x, y)] = ('line', _seg(c, skin, src['line'])[0])
                continue
            t1, d1 = _seg(c, skin, src['inner'])
            t2, d2 = _seg(c, src['inner'], src['line'])
            kind[(x, y)] = ('line', t2) if d2 < d1 and t2 > 0.3 else ('inner', t1)
    # 描边围起来的那块整个算嘴里（视频里是「粗深线围一小块浅粉」，立绘是「整块橙粉 + 细线」，只换颜色还是一个淡圈）：
    # 从外框往里灌，灌不到、又不是描边的就是嘴里面。描边有缺口时灌得进去，就退回逐点换色。
    if not closed:
        w, h = x1 - x0 + 2, y1 - y0 + 2
        grid = Image.new('L', (w, h), 0)
        gp = grid.load()
        for (x, y), (k, t) in kind.items():
            if k == 'line':
                gp[x - x0 + 1, y - y0 + 1] = 255
        grid = grid.filter(ImageFilter.MaxFilter(3))  # 描边加粗一像素再灌（只用来判断里外，不改画面）：堵住视频里描边的小缺口
        gp = grid.load()
        ImageDraw.floodfill(grid, (0, 0), 128)
        for (x, y), (k, t) in kind.items():
            if k == 'inner' and gp[x - x0 + 1, y - y0 + 1] == 0:
                kind[(x, y)] = ('fill', t)
        # 视频里的描边比立绘粗一倍（约 4 像素对 2 像素）：从里面削掉两圈（挨着嘴里的描边像素算嘴里）。
        for _ in range(2):
            fills = {xy for xy, (k, _t) in kind.items() if k == 'fill'}
            for (x, y), (k, t) in list(kind.items()):
                if k == 'line' and any((x + dx, y + dy) in fills for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    kind[(x, y)] = ('fill', 1.0)
    for (x, y), (k, t) in kind.items():
        r, g, b, a = px[x, y]
        if k == 'line':
            q = [s_ + t * (d - s_) for s_, d in zip(skin, dst['line'])] if closed else [s_ + t * (d - s_) for s_, d in zip(dst['inner'], dst['line'])]
        elif k == 'fill':
            # 嘴里：立绘的颜色，留一点原来的明暗（舌头、阴影），不至于一块平涂。
            shade = (lum((r, g, b)) - lum(src['inner'])) * 0.35
            q = [d + shade for d in dst['inner']]
        else:
            q = [s_ + t * (d - s_) for s_, d in zip(skin, dst['inner'])]
        px[x, y] = (max(0, min(255, round(q[0]))), max(0, min(255, round(q[1]))), max(0, min(255, round(q[2]))), a)
    return out


def cover_original_mouth(overlay, idle, box):
    """
    立绘本来张着嘴时，把原来那张嘴整个用肤色盖掉，再叠新嘴（2026-11-21 用户：deepseek 嘴没抠干净，下面透出一道弧线）。
    原来的嘴 = 从嘴框中心起、连在一起的「不是皮肤」的像素（下巴线和它不连着，不会被盖）；往外扩两像素、边缘稍微柔一点。
    """
    skin = ring_skin(overlay, idle)
    if not skin:
        return overlay
    x0, y0, x1, y1 = [int(v) for v in box]
    pad = 12
    rx0, ry0, rx1, ry1 = max(0, x0 - pad), max(0, y0 - pad), min(idle.width, x1 + pad), min(idle.height, y1 + pad)
    ip = idle.load()

    def nonskin(x, y):
        r, g, b, a = ip[x, y]
        return a > 200 and ((r - skin[0]) ** 2 + (g - skin[1]) ** 2 + (b - skin[2]) ** 2) ** 0.5 > 28

    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    seed = None
    for rad in range(0, max(x1 - x0, y1 - y0) // 2):
        for dx in range(-rad, rad + 1):
            for dy in (-rad, rad) if abs(dx) != rad else range(-rad, rad + 1):
                x, y = cx + dx, cy + dy
                if rx0 <= x < rx1 and ry0 <= y < ry1 and nonskin(x, y):
                    seed = (x, y)
                    break
            if seed:
                break
        if seed:
            break
    if not seed:
        return overlay
    mask = Image.new('L', idle.size, 0)
    mp = mask.load()
    stack, seen = [seed], {seed}
    while stack:
        x, y = stack.pop()
        mp[x, y] = 255
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) not in seen and rx0 <= nx < rx1 and ry0 <= ny < ry1 and nonskin(nx, ny):
                seen.add((nx, ny))
                stack.append((nx, ny))
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1))
    cover = Image.new('RGBA', idle.size, (round(skin[0]), round(skin[1]), round(skin[2]), 0))
    cover.putalpha(mask)
    cover.alpha_composite(overlay)
    return cover


def overlay_from(full_img, idle, box, spec):
    """full_img：已经对到立绘坐标的整张图（和立绘一样大）。取嘴框那块，羽化，可选调色 / 锐化，返回只有嘴的叠加图。"""
    patch = full_img
    patch = sharpened(patch, spec.get('sharpen'), 1.6)
    m = mask_for(idle.size, box, spec.get('mask', 'ellipse'), spec.get('feather', 3))
    m = ImageChops.multiply(m, patch.getchannel('A'))
    # 只换透明度、不动颜色：用 paste 带遮罩贴到全透明的底上，羽化那一圈的颜色会被黑色压暗（一圈灰边）。
    # 透明处保留原来的颜色，移植时插值也不会把边缘拉黑。
    out = patch.copy()
    out.putalpha(m)
    return tint_to_target(out, idle) if spec.get('tint') else out


def darkness(img, box):
    g = flat(img.crop(box))
    return 255 - ImageStat.Stat(g).mean[0]


def build_aligned(cfg, sid, spec, idle):
    src = spec['source']
    sheet = Sheet(fetch(cfg, src))
    face, box = spec['face'], spec['box']
    al = Aligner(idle, face, box)
    guess = initial_guess(idle, sheet.cell(0), al.cface)
    if 'hint' in spec:
        h = spec['hint']
        guess = (h.get('s', guess[0]), h.get('deg', 0.0), guess[2])
    f0 = al.full(sheet.cell(0), guess)
    print(f'  对齐首帧：误差 {f0[0]:.1f}  缩放 {f0[1]:.3f}  旋转 {f0[2]:+.1f}°')
    return sheet, al, f0


def frame_in_idle(sheet, al, idle, fidx, f0):
    r = al.refine(sheet.cell(fidx), f0)
    full = warp(sheet.cell(fidx), idle.size, affine(r[1], r[2], al.cface, r[3], (0, 0)))
    return full, r


def scan(cfg, sid, spec, idle):
    sheet, al, f0 = build_aligned(cfg, sid, spec, idle)
    box = spec['box']
    base_dark = darkness(idle, box)
    print(f'  立绘嘴框暗度 {base_dark:.0f}（越大张得越开）')
    print('  帧  误差  暗度')
    for i in range(120):
        full, r = frame_in_idle(sheet, al, idle, i, f0)
        print(f'  {i:3d}  {r[0]:5.1f}  {darkness(full, box):5.0f}')


def build(cfg, sid, spec, built):
    folder = sid.removeprefix('crosspet-')
    idle_path = CHAR_DIR / folder / spec.get('idle', 'idle.webp')
    idle = Image.open(idle_path).convert('RGBA')
    levels = {}
    if 'source' in spec:
        sheet, al, f0 = build_aligned(cfg, sid, spec, idle)
        for lv in LEVELS:
            fidx = spec.get('frames', {}).get(lv)
            if fidx is None:
                continue
            full, r = frame_in_idle(sheet, al, idle, fidx, f0)
            print(f'  {lv}: 第 {fidx} 帧  误差 {r[0]:.1f}')
            levels[lv] = overlay_from(full, idle, spec['box'], spec)
        rest = overlay_from(idle, idle, spec['box'], {**spec, 'tint': False, 'sharpen': 0})
        built[sid] = {'idle': idle, 'box': spec['box'], 'center': box_center(spec['box']), 'levels': levels, 'rest': rest, 'restClosed': spec.get('restClosed', True), 'spec': spec}
        credit = {'mode': 'aligned', 'pack': spec['source']['pack'], 'action': spec['source']['action']}
    else:
        donor = built.get(spec['donor'])
        if not donor:
            sys.exit(f'{sid}：要先做 {spec["donor"]}（donor 写在它后面了，或者它没做成）')
        k, deg = spec.get('scale', 1.0), spec.get('deg', 0.0)
        ct = spec['center']
        cd = donor['center']
        # 目标坐标 → 供体坐标：p_d = (1/k)·R(-deg)·(p_t - ct) + cd
        coeffs = affine(1 / k, -deg, ct, cd, (0, 0))
        bw = (donor['box'][2] - donor['box'][0]) * k
        bh = (donor['box'][3] - donor['box'][1]) * k
        box = spec.get('box') or [round(ct[0] - bw / 2), round(ct[1] - bh / 2), round(ct[0] + bw / 2), round(ct[1] + bh / 2)]
        want = spec.get('levels', ['half', 'wide'] + (['closed'] if spec.get('closed') else []))
        closed_from = None
        for lv in LEVELS:
            if lv not in want:
                continue
            srcimg = donor['levels'].get(lv)
            if lv == 'closed' and srcimg is None:
                if not donor['restClosed']:
                    sys.exit(f'{sid}：{spec["donor"]} 没有闭嘴的帧，它自己的立绘嘴也是张着的，换一个 donor')
                srcimg = donor['rest']
                # 这张不是 hunmer 的视频帧，是供体那张 CrossPet 立绘上的嘴：署名要写清楚（复核发现）。
                closed_from = f"{spec['donor'].removeprefix('crosspet-')}/{donor['spec'].get('idle', 'idle.webp')}"
            if srcimg is None:
                continue
            moved = warp(srcimg, idle.size, coeffs)
            moved = sharpened(moved, spec.get('sharpen'), 1.4)
            if spec.get('tint', True):
                moved = tint_to_target(moved, idle)
            levels[lv] = moved
        credit = {'mode': 'transplant', 'donor': spec['donor'], 'pack': donor['spec']['source']['pack'] if 'source' in donor['spec'] else None,
                  'action': donor['spec']['source']['action'] if 'source' in donor['spec'] else None}
        if closed_from:
            credit['closedFromCrossPet'] = closed_from
        built[sid] = {'idle': idle, 'box': box, 'center': ct, 'levels': levels, 'rest': overlay_from(idle, idle, box, {'mask': 'ellipse'}), 'restClosed': spec.get('restClosed', True), 'spec': spec}
    if spec.get('recolor'):
        # 嘴的颜色换成立绘自己那张嘴的（只对立绘本来张着嘴的皮肤有用：色板从原来的嘴上量）。
        for lv in list(levels):
            levels[lv] = recolor_mouth(levels[lv], idle, built[sid]['box'], closed=(lv == 'closed'))
        built[sid]['levels'] = levels
    if not levels.get('half') and not levels.get('wide'):
        sys.exit(f'{sid}：一张张嘴的图都没做出来')
    if spec.get('restClosed', True) is False or spec.get('closed') or spec.get('frames', {}).get('closed') is not None:
        # 立绘本来张着嘴：存出去的每张嘴底下先用肤色盖掉原来的嘴（给别的皮肤当供体的那份不盖，免得把这块肤色也移植过去）。
        levels = {lv: cover_original_mouth(img, idle, built[sid]['box']) for lv, img in levels.items()}
    out = OUT_DIR / sid
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob('mouth-*.webp'):
        old.unlink()
    files = {}
    for lv, img in levels.items():
        name = f'mouth-{lv}.webp'
        img.save(out / name, lossless=True, quality=100, method=6)
        files[lv] = name
    meta = {
        'by': 'scripts/mouths/make-mouths.py',
        'base': 'idle',
        'idle': idle_path.name,
        'idleSha': blob_sha(idle_path.read_bytes()),
        'size': list(idle.size),
        'files': files,
        'source': {'repo': cfg['repo'], 'commit': cfg['commit'], **credit},
    }
    (out / 'mouth.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    preview(sid, idle, levels, built[sid]['box'])
    print(f'  → art/mouths/{sid}/（{", ".join(files)}）')


def box_center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def preview(sid, idle, levels, box):
    """上排：脸部放大（立绘 / 各档嘴）；下排：接近桌面实际大小的全身。"""
    shots = [('idle', idle)]
    for lv in LEVELS:
        if lv in levels:
            img = idle.copy()
            img.alpha_composite(levels[lv])
            shots.append((lv, img))
    cx, cy = box_center(box)
    zw, zh = 200, 130
    zoom = 3
    full_s = 0.45
    fw, fh = round(idle.width * full_s), round(idle.height * full_s)
    W = max(zw * zoom, fw) * len(shots)
    H = zh * zoom + fh + 24
    sheet = Image.new('RGBA', (W, H), (40, 42, 54, 255))
    d = ImageDraw.Draw(sheet)
    col = W // len(shots)
    for i, (label, img) in enumerate(shots):
        crop = img.crop((round(cx - zw / 2), round(cy - zh / 2), round(cx + zw / 2), round(cy + zh / 2))).resize((zw * zoom, zh * zoom), Image.LANCZOS)
        sheet.alpha_composite(crop, (i * col, 0))
        small = img.resize((fw, fh), Image.LANCZOS)
        sheet.alpha_composite(small, (i * col + (col - fw) // 2, zh * zoom + 20))
        d.text((i * col + 6, 4), label, fill=(255, 230, 0, 255))
    (OUT_DIR / '_preview').mkdir(parents=True, exist_ok=True)
    sheet.save(OUT_DIR / '_preview' / f'{sid}.png')


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:
            pass
    ap =argparse.ArgumentParser(description='生成 TomoPet 口型叠加图')
    ap.add_argument('--only', action='append', help='只做这几个皮肤 id（可写多次；transplant 的供体会自动先做）')
    ap.add_argument('--scan', action='store_true', help='只打印每帧的对齐误差和张嘴程度（配合 --only，用来挑帧）')
    ap.add_argument('--config', default=str(CONFIG))
    ap.add_argument('--out', help='输出到别的文件夹（默认 art/mouths；调参试验时用，免得盖掉正式的）')
    args = ap.parse_args()
    if args.out:
        global OUT_DIR
        OUT_DIR = Path(args.out).resolve()
    cfg = json.loads(Path(args.config).read_text(encoding='utf-8'))
    skins = cfg['skins']
    order = list(skins)
    wanted = set(args.only or order)
    for sid in list(wanted):
        if sid not in skins:
            sys.exit(f'mouths.json 里没有 {sid}')
        d = skins[sid].get('donor')
        while d:
            wanted.add(d)
            d = skins[d].get('donor')
    if args.scan:
        for sid in args.only or []:
            spec = skins[sid]
            if 'source' not in spec:
                sys.exit(f'{sid} 是移植的，没有可扫描的视频')
            folder = sid.removeprefix('crosspet-')
            scan(cfg, sid, spec, Image.open(CHAR_DIR / folder / spec.get('idle', 'idle.webp')).convert('RGBA'))
        return
    built = {}
    # 先做有视频的（供体），再做移植的
    for sid in sorted((s for s in order if s in wanted), key=lambda s: 'source' not in skins[s]):
        print(sid)
        build(cfg, sid, skins[sid], built)


if __name__ == '__main__':
    main()
