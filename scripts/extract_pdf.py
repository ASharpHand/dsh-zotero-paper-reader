"""Extract text from a paper PDF with PyMuPDF (runs in the skill venv)."""
import argparse
import json
import re
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    import fitz  # PyMuPDF

    doc = fitz.open(args.pdf)
    pages = []
    for index, page in enumerate(doc):
        text = page.get_text('text')
        pages.append({'page': index + 1, 'text': text})

    meta = doc.metadata or {}
    first = pages[0]['text'] if pages else ''
    headings = []
    for index, page in enumerate(doc):
        for line in page.get_text('dict')['blocks']:
            if line.get('type') != 0:
                continue
            for span in line.get('lines', []):
                for piece in span.get('spans', []):
                    size = round(float(piece.get('size', 0)), 1)
                    body = (piece.get('text') or '').strip()
                    if not body or len(body) > 90:
                        continue
                    numbered = re.match(r'^(\d+(?:\.\d+)*)\s+\S', body)
                    if numbered and size >= 9:
                        headings.append({'page': index + 1, 'title': body, 'number': numbered.group(1)})

    data = {
        'meta': {
            'title': meta.get('title', ''),
            'author': meta.get('author', ''),
            'subject': meta.get('subject', ''),
            'pages': doc.page_count,
            'firstPage': first,
        },
        'pages': pages,
        'headings': headings[:80],
    }
    with open(args.out, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False)
    print(json.dumps({'ok': True, 'pages': doc.page_count}))


if __name__ == '__main__':
    sys.exit(main())
