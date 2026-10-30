"""Share image (1200×630) for each blog post: the card LinkedIn, Google and chat apps show for the link.

Same look as the site's docs/og-image.png: dark navy, gradient logo, post title with the last word highlighted.
build.py writes docs/blog/<slug>/og.png with it when Pillow is installed (pip install pillow), and linkedin.py
uploads it as the post's thumbnail. Fonts are in blog/fonts (SIL Open Font License, see the OFL files there).

    python3 blog/og.py blog/posts/2026-11-04-....md out.png   # preview one
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).resolve().parent / 'fonts'
W, H = 1200, 630
PAD = 80
NAVY, NAVY_2 = (14, 22, 52), (17, 27, 66)
BLUE, TEAL = (106, 156, 255), (63, 214, 163)
WHITE, MUTED = (255, 255, 255), (178, 188, 210)


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def gradient(size, a=BLUE, b=TEAL):
    """Left-to-right gradient image of the given size."""
    w, h = size
    row = Image.new('RGB', (max(w, 1), 1))
    for x in range(max(w, 1)):
        t = x / max(w - 1, 1)
        row.putpixel((x, 0), tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    return row.resize((max(w, 1), max(h, 1)))


def background():
    img = Image.new('RGB', (W, H), NAVY)
    shade = Image.linear_gradient('L').resize((W, H))  # darker at the top, a touch lighter below
    img = Image.composite(Image.new('RGB', (W, H), NAVY_2), img, shade)
    # Soft glows: teal top right, blue bottom left, like the site's share image.
    for colour, centre, radius, strength in ((TEAL, (W - 60, -40), 520, 70), ((60, 90, 200), (40, H + 40), 480, 90)):
        mask = Image.new('L', (W, H), 0)
        ImageDraw.Draw(mask).ellipse([centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius], fill=strength)
        mask = mask.filter(ImageFilter.GaussianBlur(radius // 2))
        img = Image.composite(Image.new('RGB', (W, H), colour), img, mask)
    return img


def wrap(words, f, max_w, draw):
    lines, line = [], []
    for word in words:
        trial = ' '.join(line + [word])
        if line and draw.textlength(trial, font=f) > max_w:
            lines.append(line)
            line = [word]
        else:
            line.append(word)
    if line:
        lines.append(line)
    return lines


def pill(draw, xy, text, f, fg, fill=None, outline=None):
    x, y = xy
    tw = draw.textlength(text, font=f)
    box = [x, y, x + tw + 36, y + 46]
    draw.rounded_rectangle(box, radius=23, fill=fill, outline=outline, width=2 if outline else 0)
    draw.text((x + 18, y + 23), text, font=f, fill=fg, anchor='lm')
    return box[2]


def make(post):
    """Return the share image for a post dict from build.parse()."""
    img = background()
    draw = ImageDraw.Draw(img)

    # Brand row
    img.paste(gradient((48, 48)), (PAD, 72), _rounded_mask((48, 48), 12))
    draw.text((PAD + 64, 96), 'Pawan Sinha', font=font('Inter-SemiBold.ttf', 30), fill=WHITE, anchor='lm')
    minutes = max(1, round(post.get('words', 1000) / 220))
    label = f'Performance engineering · {minutes} min read'
    lf = font('Inter-SemiBold.ttf', 22)
    lw = draw.textlength(label, font=lf) + 36
    pill(draw, (W - PAD - lw, 73), label, lf, TEAL, fill=(24, 62, 70))

    # Title: largest size that fits in three lines; last word in the gradient.
    words = post['title'].split()
    for size in (84, 76, 68, 62, 56, 50):
        tf = font('Inter-ExtraBold.ttf', size)
        lines = wrap(words, tf, W - 2 * PAD, draw)
        if len(lines) <= 3:
            break
    line_h = round(size * 1.12)
    block_h = line_h * len(lines)
    y = 190 + (300 - block_h) // 2
    for i, line in enumerate(lines):
        x = PAD
        for j, word in enumerate(line):
            last = i == len(lines) - 1 and j == len(line) - 1
            text = word + ('' if j == len(line) - 1 else ' ')
            if last:
                ww = round(draw.textlength(word, font=tf))
                mask = Image.new('L', (ww + 10, line_h + 20), 0)
                ImageDraw.Draw(mask).text((0, 0), word, font=tf, fill=255)
                img.paste(gradient(mask.size), (x, y), mask)
            else:
                draw.text((x, y), text, font=tf, fill=WHITE)
            x += round(draw.textlength(text, font=tf))
        y += line_h

    # Tags and domain
    mf = font('JetBrainsMono-Medium.ttf', 22)
    x = PAD
    for tag in post.get('tags', [])[:3]:
        x = pill(draw, (x, H - 120), tag, mf, (214, 222, 238), outline=(70, 82, 120)) + 12
    draw.text((W - PAD, H - 97), 'pawansinha.com.au', font=font('Inter-SemiBold.ttf', 28), fill=WHITE, anchor='rm')
    return img


def _rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def save(post, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    make(post).save(path, optimize=True)


if __name__ == '__main__':
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build import parse
    save(parse(Path(sys.argv[1])), sys.argv[2])
    print('wrote', sys.argv[2])
