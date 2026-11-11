"""Extract figure crops from a paper PDF (runs in the skill venv).

A caption matching "Fig. N" / "Figure N" anchors the figure. The crop is the
union of the embedded image blocks (or large vector drawing rects) directly
above or below that caption. Results are written as JSON:

    {"figures": [{number, page, caption, file, width, height, vector}]}
"""
import argparse
import json
import os
import re
import sys

CAPTION_RE = re.compile(r'^(Fig\.?|Figure|FIGURE)\s*(\d{1,3})\b')


def normalize(text):
    return re.sub(r'\s+', ' ', text or '').strip()


def cluster_above(caption_box, images, drawings):
    """Collect the image/drawing blocks stacked directly above the caption."""
    top = caption_box[1]
    picked = []
    # Embedded images first: walk upward, allowing a small gap between panels.
    current = top
    remaining = [b for b in images if b[3] <= current + 4 and (b[2] - b[0]) * (b[3] - b[1]) > 4000]
    while True:
        candidate = None
        for box in remaining:
            if box not in picked and current - box[3] < 90:
                if candidate is None or box[3] > candidate[3]:
                    candidate = box
        if candidate is None:
            break
        picked.append(candidate)
        current = candidate[1]
    if picked:
        return union(picked), False
    # Vector figures: the largest drawing rect that sits above the caption.
    best = None
    best_area = 0
    for box in drawings:
        area = (box[2] - box[0]) * (box[3] - box[1])
        if box[3] <= top + 6 and top - box[3] < 420 and area > best_area and (box[2] - box[0]) > 120:
            best = box
            best_area = area
    if best is not None:
        return best, True
    return None, False


def cluster_below(caption_box, images, drawings):
    bottom = caption_box[3]
    picked = []
    current = bottom
    remaining = [b for b in images if b[1] >= current - 4 and (b[2] - b[0]) * (b[3] - b[1]) > 4000]
    while True:
        candidate = None
        for box in remaining:
            if box not in picked and box[1] - current < 90:
                if candidate is None or box[1] < candidate[1]:
                    candidate = box
        if candidate is None:
            break
        picked.append(candidate)
        current = candidate[3]
    if picked:
        return union(picked), False
    best = None
    best_area = 0
    for box in drawings:
        area = (box[2] - box[0]) * (box[3] - box[1])
        if box[1] >= bottom - 6 and box[1] - bottom < 420 and area > best_area and (box[2] - box[0]) > 120:
            best = box
            best_area = area
    if best is not None:
        return best, True
    return None, False


def union(boxes):
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return (x0, y0, x1, y1)


def slug(text, limit=28):
    cleaned = re.sub(r'[^a-z0-9]+', '-', (text or '').lower()).strip('-')
    return cleaned[:limit].strip('-') or 'figure'


def image_stats(pix):
    """Rough brightness/blankness check without extra dependencies."""
    data = pix.samples
    if not data:
        return {'mean': 0.0, 'white': 1.0}
    total = len(data)
    stride = max(3, (total // 30000 // 3) * 3)
    pixels = 0
    white = 0
    brightness = 0
    for index in range(0, total - 2, stride):
        r, g, b = data[index], data[index + 1], data[index + 2]
        pixels += 1
        brightness += (r + g + b) / 3
        if r > 246 and g > 246 and b > 246:
            white += 1
    return {'mean': brightness / max(1, pixels), 'white': white / max(1, pixels)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--dir', required=True)
    parser.add_argument('--dpi', type=int, default=200)
    args = parser.parse_args()

    import fitz

    os.makedirs(args.dir, exist_ok=True)
    doc = fitz.open(args.pdf)
    figures = []
    for page_index in range(doc.page_count):
        page = doc[page_index]
        page_area = page.rect.width * page.rect.height
        text_blocks = page.get_text('dict')['blocks']
        images = []
        captions = []
        for block in text_blocks:
            if block.get('type') == 1:
                images.append(tuple(block['bbox']))
                continue
            text = normalize(' '.join(
                span['text'] for line in block.get('lines', []) for span in line.get('spans', [])
            ))
            match = CAPTION_RE.match(text)
            if match and len(text) > 12:
                captions.append((block['bbox'], int(match.group(2)), text))
        if not captions:
            continue
        drawings = [tuple(item['rect']) for item in page.get_drawings()]
        for box, number, caption in captions:
            region, vector = cluster_above(box, images, drawings)
            if region is None:
                region, vector = cluster_below(box, images, drawings)
            if region is None:
                continue
            if (region[2] - region[0]) < 90 or (region[3] - region[1]) < 60:
                continue
            area = (region[2] - region[0]) * (region[3] - region[1])
            if area < page_area * 0.03:
                continue
            # Trim to page bounds plus a small margin.
            clip = fitz.Rect(
                max(0, region[0] - 2), max(0, region[1] - 2),
                min(page.rect.width, region[2] + 2), min(page.rect.height, region[3] + 2),
            )
            name = f"fig{number}_{slug(caption.split(' ', 3)[-1] if len(caption.split()) > 3 else caption)}.png"
            target = os.path.join(args.dir, name)
            pix = page.get_pixmap(clip=clip, dpi=args.dpi, alpha=False)
            stats = image_stats(pix)
            # Reject blank crops and inverted/dark renders; both mean the region
            # did not capture the figure itself.
            if stats['white'] > 0.985 or stats['mean'] < 45:
                continue
            pix.save(target)
            figures.append({
                'number': number,
                'page': page_index + 1,
                'caption': caption[:160],
                'file': name,
                'width': pix.width,
                'height': pix.height,
                'vector': bool(vector),
            })

    with open(args.out, 'w', encoding='utf-8') as handle:
        json.dump({'figures': figures}, handle, ensure_ascii=False)
    print(json.dumps({'ok': True, 'figures': len(figures)}))


if __name__ == '__main__':
    sys.exit(main())
