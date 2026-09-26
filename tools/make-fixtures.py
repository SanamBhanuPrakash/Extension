#!/usr/bin/env python3
"""
Generates genuine Office and PDF fixtures for the document-extraction tests.

Hand-built with the standard library rather than converted by an office suite,
for two reasons: the structure is explicit and reviewable, and the fixtures are
reproducible on any machine without installing anything.

These are real files — real ZIP containers, real OOXML parts, real
FlateDecode-compressed PDF content streams. A parser that reads these reads the
ones a word processor writes, because the format is the same.

No real credentials: every value is a published documentation example or a
synthetic value that passes its own checksum.
"""
import zipfile, zlib, os, struct

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
os.makedirs(OUT, exist_ok=True)

CT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
{overrides}
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="{type}" Target="{target}"/>
</Relationships>'''

def para(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

# ── DOCX ────────────────────────────────────────────────────────────────
doc_body = ''.join(para(t) for t in [
    'MASTER SERVICES AGREEMENT — PRIVILEGED AND CONFIDENTIAL',
    'This agreement is between Northwind Technologies and the client.',
    'Primary contact: Priya Nair, priya.nair@northwind.co.in, mobile 98765 43210.',
    'Registered address: Flat 3B, 14 Koregaon Park Road, Pune 411001.',
    'GSTIN 27AAPFU0939F1ZV and PAN ABCPD1234E.',
    'Card on file 4242 4242 4242 4242. IBAN GB82WEST12345698765432.',
    'Deployment credential AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'Annual value $4,200,000 with ARR growth of 31 percent.',
])
document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{doc_body}
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>email</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Rohan Mehta</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>rohan@northwind.co.in</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>'''

with zipfile.ZipFile(os.path.join(OUT, 'contract.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT.format(overrides='<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'))
    z.writestr('_rels/.rels', RELS.format(type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target='word/document.xml'))
    z.writestr('word/document.xml', document_xml)
    z.writestr('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Anita Deshpande</dc:creator><dc:title>Master Services Agreement</dc:title></cp:coreProperties>')

# ── XLSX ────────────────────────────────────────────────────────────────
ROWS = [
    ['employee_id', 'full_name', 'email', 'mobile', 'pan', 'salary'],
    ['E1001', 'Rohan Mehta', 'rohan.mehta@northwind.co.in', '98765 43210', 'ABCPD1234E', '4200000'],
    ['E1002', 'Fatima Al-Rashid', 'fatima@northwind.co.in', '98765 43211', 'ABCPE1234F', '3800000'],
    ['E1003', 'Chen Wei', 'chen.wei@northwind.co.in', '98765 43212', 'ABCPF1234G', '4500000'],
    ['E1004', 'Olusegun Adeyemi', 'olusegun@northwind.co.in', '98765 43213', 'ABCPG1234H', '3900000'],
    ['E1005', 'Beatriz Goncalves', 'beatriz@northwind.co.in', '98765 43214', 'ABCPH1234J', '4100000'],
    ['E1006', 'Yuki Tanaka', 'yuki.tanaka@northwind.co.in', '98765 43215', 'ABCPJ1234K', '4300000'],
]
strings, index = [], {}
for row in ROWS:
    for cell in row:
        if cell not in index:
            index[cell] = len(strings); strings.append(cell)

def col_name(i):
    name = ''
    while True:
        name = chr(ord('A') + i % 26) + name
        i = i // 26 - 1
        if i < 0: return name

sheet_rows = []
for r, row in enumerate(ROWS, start=1):
    cells = ''.join(f'<c r="{col_name(c)}{r}" t="s"><v>{index[v]}</v></c>' for c, v in enumerate(row))
    sheet_rows.append(f'<row r="{r}">{cells}</row>')

with zipfile.ZipFile(os.path.join(OUT, 'employees.xlsx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT.format(overrides=
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'))
    z.writestr('_rels/.rels', RELS.format(type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target='xl/workbook.xml'))
    z.writestr('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="People" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels', RELS.format(type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', target='worksheets/sheet1.xml'))
    z.writestr('xl/sharedStrings.xml', '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">%s</sst>' % (
        len(strings), len(strings), ''.join('<si><t xml:space="preserve">%s</t></si>' % s.replace('&', '&amp;').replace('<', '&lt;') for s in strings)))
    z.writestr('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>%s</sheetData></worksheet>' % ''.join(sheet_rows))

# ── PPTX ────────────────────────────────────────────────────────────────
slide = '''<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>Q4 Board Review — CONFIDENTIAL</a:t></a:r></a:p>
<a:p><a:r><a:t>ARR closed at $4.2M, runway 14 months.</a:t></a:r></a:p>
<a:p><a:r><a:t>Term sheet signed with Meridian; data room opens Monday.</a:t></a:r></a:p>
<a:p><a:r><a:t>Material non-public information until the 14th.</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'''
with zipfile.ZipFile(os.path.join(OUT, 'board.pptx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT.format(overrides='<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'))
    z.writestr('_rels/.rels', RELS.format(type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target='ppt/presentation.xml'))
    z.writestr('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
    z.writestr('ppt/slides/slide1.xml', slide)

# ── ODT (OpenDocument) ──────────────────────────────────────────────────
odt_content = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>
<text:p>Patient record — Ananya Krishnan, diagnosed with Type 2 diabetes.</text:p>
<text:p>Prescribed metformin 500mg. Contact 98765 43216.</text:p>
<text:p>Aadhaar 234567890124 on file.</text:p>
</office:text></office:body></office:document-content>'''
with zipfile.ZipFile(os.path.join(OUT, 'notes.odt'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('mimetype', 'application/vnd.oasis.opendocument.text', zipfile.ZIP_STORED)
    z.writestr('content.xml', odt_content)

# ── PDF, with a FlateDecode-compressed content stream ───────────────────
def make_pdf(path, lines, producer='Chhanni fixture', author='Anita Deshpande'):
    content = 'BT /F1 11 Tf 40 760 Td 14 TL\n'
    for line in lines:
        esc = line.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')
        content += f'({esc}) Tj T*\n'
    content += 'ET'
    stream = zlib.compress(content.encode('latin-1'))

    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        b'<< /Length ' + str(len(stream)).encode() + b' /Filter /FlateDecode >>\nstream\n' + stream + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        ('<< /Producer (%s) /Author (%s) /Title (Invoice 2026-0417) >>' % (producer, author)).encode('latin-1'),
    ]
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f'{i} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref_at = len(out)
    out += f'xref\n0 {len(objects) + 1}\n'.encode()
    out += b'0000000000 65535 f \n'
    for off in offsets:
        out += f'{off:010d} 00000 n \n'.encode()
    out += f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n{xref_at}\n%%EOF\n'.encode()
    open(path, 'wb').write(out)

make_pdf(os.path.join(OUT, 'invoice.pdf'), [
    'INVOICE 2026-0417 - CONFIDENTIAL',
    'Bill to: Priya Nair, Flat 3B, 14 Koregaon Park Road, Pune 411001',
    'Email priya.nair@northwind.co.in  Mobile 98765 43210',
    'GSTIN 27AAPFU0939F1ZV   PAN ABCPD1234E',
    'Card on file 4242 4242 4242 4242',
    'Deployment key AKIAIOSFODNN7EXAMPLE',
    'Total due USD 4,200,000',
])

# ── JPEG carrying EXIF with GPS ─────────────────────────────────────────
def make_jpeg_with_exif(path):
    """
    A minimal JPEG whose APP1 segment holds a well-formed EXIF TIFF block with
    GPS, device and owner fields.

    Offsets in TIFF are relative to the start of the TIFF header, and every
    value longer than four bytes lives in a data area after the IFD. Getting
    that arithmetic wrong produces a file that parses as "no metadata", which
    is exactly what the first version of this generator did.
    """
    def entry(tag, typ, count, payload):
        return struct.pack('>HHI', tag, typ, count) + payload

    make = b'NorthwindPhone\x00'
    model = b'NW-Pixel-9\x00'
    artist = b'Priya Nair\x00'
    software = b'InternalCam 2.1\x00'

    # IFD0: 5 entries (4 strings + GPS pointer).
    n0 = 5
    ifd0_at = 8
    data_at = ifd0_at + 2 + n0 * 12 + 4

    strings = b''
    offsets = {}
    for name, blob in [('make', make), ('model', model), ('artist', artist), ('software', software)]:
        offsets[name] = data_at + len(strings)
        strings += blob

    gps_ifd_at = data_at + len(strings)
    # GPS IFD: 4 entries, then two 3-rational values (24 bytes each).
    n_gps = 4
    gps_data_at = gps_ifd_at + 2 + n_gps * 12 + 4

    ifd0 = struct.pack('>H', n0)
    ifd0 += entry(0x010f, 2, len(make), struct.pack('>I', offsets['make']))
    ifd0 += entry(0x0110, 2, len(model), struct.pack('>I', offsets['model']))
    ifd0 += entry(0x013b, 2, len(artist), struct.pack('>I', offsets['artist']))
    ifd0 += entry(0x0131, 2, len(software), struct.pack('>I', offsets['software']))
    ifd0 += entry(0x8825, 4, 1, struct.pack('>I', gps_ifd_at))
    ifd0 += struct.pack('>I', 0)  # no IFD1

    gps = struct.pack('>H', n_gps)
    gps += entry(0x0001, 2, 2, b'N\x00\x00\x00')                      # latitude ref
    gps += entry(0x0002, 5, 3, struct.pack('>I', gps_data_at))          # latitude
    gps += entry(0x0003, 2, 2, b'E\x00\x00\x00')                      # longitude ref
    gps += entry(0x0004, 5, 3, struct.pack('>I', gps_data_at + 24))     # longitude
    gps += struct.pack('>I', 0)
    # 18 deg 31' 12.0" N, 73 deg 51' 18.0" E  — Pune.
    gps += struct.pack('>IIIIII', 18, 1, 31, 1, 120, 10)
    gps += struct.pack('>IIIIII', 73, 1, 51, 1, 180, 10)

    tiff = b'MM\x00\x2a' + struct.pack('>I', ifd0_at) + ifd0 + strings + gps
    app1 = b'Exif\x00\x00' + tiff

    jpeg = (b'\xff\xd8'
            + seg(0xe0, JFIF)
            + seg(0xe1, app1)
            + baseline_gray_image())
    open(path, 'wb').write(jpeg)


def seg(marker, payload):
    """One JPEG marker segment: FF, marker, big-endian length including itself."""
    return bytes([0xff, marker]) + struct.pack('>H', len(payload) + 2) + payload


JFIF = b'JFIF\x00' + bytes([1, 1, 0]) + struct.pack('>HH', 1, 1) + bytes([0, 0])

# ITU T.81 Annex K.3.3 luminance Huffman tables — the ones every baseline
# encoder ships with, so any decoder has already seen them.
DC_BITS = bytes([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
DC_VALS = bytes(range(12))
AC_BITS = bytes([0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d])
AC_VALS = bytes([
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
    0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
    0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
])
assert len(AC_VALS) == sum(AC_BITS) == 162


def baseline_gray_image(size=16):
    """
    A real baseline JPEG body: quantisation table, frame header, both Huffman
    tables, and an entropy-coded scan.

    The fixture used to be SOI + APP1 + EOI, which is enough to read EXIF out
    of but not a decodable image — so a test that strips the metadata and then
    asks whether the result is still a picture had nothing to check. This is a
    decodable picture: `size`/8 squared blocks, each one DC-only.

    The scan bits per block are the DC table's code for category 0 (a zero
    difference from the previous block, so no extra bits follow) and then the
    AC table's end-of-block: '00' + '1010'. Six bits a block, and at 16x16
    four blocks pack into exactly three bytes with no 0xFF to stuff.
    """
    dqt = bytes([0]) + bytes([16]) * 64
    sof = bytes([8]) + struct.pack('>HH', size, size) + bytes([1, 1, 0x11, 0])
    dht_dc = bytes([0x00]) + DC_BITS + DC_VALS
    dht_ac = bytes([0x10]) + AC_BITS + AC_VALS
    sos = bytes([1, 1, 0x00, 0, 63, 0])

    blocks = (size // 8) ** 2
    bits = '00' + '1010'
    stream = bits * blocks
    stream += '1' * (-len(stream) % 8)
    scan = bytes(int(stream[i:i + 8], 2) for i in range(0, len(stream), 8))
    assert 0xff not in scan, 'scan data would need byte stuffing'

    return (seg(0xdb, dqt) + seg(0xc0, sof) + seg(0xc4, dht_dc)
            + seg(0xc4, dht_ac) + seg(0xda, sos) + scan + b'\xff\xd9')

make_jpeg_with_exif(os.path.join(OUT, 'photo.jpg'))


# ── PNG carrying tEXt metadata ──────────────────────────────────────────
def make_png_with_text(path, size=16):
    """
    A real PNG: signature, IHDR, two tEXt chunks, a zlib-compressed IDAT and
    IEND. The tEXt chunks are where a screenshot tool writes the machine name
    and the person who took it, which is the leak nobody expects a screenshot
    to carry.
    """
    def chunk(kind, payload):
        return (struct.pack('>I', len(payload)) + kind + payload
                + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 0, 0, 0, 0)
    raw = b''.join(b'\x00' + bytes([(x * 16) % 256 for x in range(size)]) for _ in range(size))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'tEXt', b'Author\x00Priya Nair')
           + chunk(b'tEXt', b'Software\x00Northwind Screenshot 4.2 on PUNE-LAPTOP-114')
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)

make_png_with_text(os.path.join(OUT, 'screenshot.png'))

for name in sorted(os.listdir(OUT)):
    print(f'  {name:22} {os.path.getsize(os.path.join(OUT, name)):>7} bytes')
