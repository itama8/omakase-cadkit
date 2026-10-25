"""Synthetic drawings with planted defects, for omakase-cadkit's tests.

    uv run --with ezdxf python fixtures/make_fixtures.py fixtures

Writes:
  sewer_clean.dxf   a small labelled sewer network on an A1 sheet at 1:500, no defects
  sewer_bad.dxf     the same network with one planted defect per rule (see PLANTED)
  scale_wrong.dxf   the clean sheet with its scale label changed to 1:100
  raster_underlay.dxf  the clean sheet with a linked, clipped raster underlay and the same
                       raster inside a block placed by two inserts
  raster.png        the raster used by raster_underlay.dxf
"""

import struct
import sys
import zlib
from pathlib import Path

import ezdxf

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# A1 at 1:500: 841 x 594 mm of paper = 420.5 x 297 m of drawing
FRAME = (0.0, 0.0, 420.5, 297.0)
MANHOLES = [  # id, x, y, GL, IL
    (1, 100, 150, 22.00, 20.80),
    (2, 130, 150, 22.10, 20.60),
    (3, 160, 150, 22.20, 20.40),
    (4, 190, 150, 22.15, 20.20),
    (5, 220, 150, 22.05, 20.00),
]

PLANTED = {
    "sewer-levels": "MH 3 depth label 1.00 m but GL - IL = 1.80 m",
    "sewer-pipe-label": "P- 4 labelled L-25.0 m, drawn 30 m",
    "sewer-stacked-manholes": "second MH symbol on MH 2",
    "sewer-gradient": "MH 4 invert raised above MH 3: P- 3 flows uphill",
    "sewer-connectivity": "MH 9 has no pipe",
    "text-height-paper": "a note 0.3 m high plots at 0.6 mm",
    "dimension-override": "dimension text 5.00 over a 4.0 m line",
    "duplicate-entities": "the stacked MH 2 symbol is an exact copy",
}


def base(scale_label: str = "1:500"):
    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 6  # metres
    for name in ("FRAME", "TITLE", "NODE", "PIPE", "NOTES", "DIM"):
        doc.layers.add(name)
    mh = doc.blocks.new("MH")
    mh.add_circle((0, 0), 0.6)
    mh.add_circle((0, 0), 0.35)
    arrow = doc.blocks.new("FLOWARROW")  # points along +X
    arrow.add_lwpolyline([(-0.8, 0.4), (0.8, 0), (-0.8, -0.4)], close=True)
    out = doc.blocks.new("OUTFALL")
    out.add_lwpolyline([(-0.7, -0.5), (0.7, -0.5), (0, 0.7)], close=True)
    msp = doc.modelspace()
    x0, y0, x1, y1 = FRAME
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": "FRAME"})
    # title block, text 2.5 mm on paper = 1.25 m
    tb = (x1 - 120, y0 + 5)
    msp.add_lwpolyline([(tb[0], tb[1]), (x1 - 5, tb[1]), (x1 - 5, tb[1] + 30), (tb[0], tb[1] + 30)], close=True, dxfattribs={"layer": "TITLE"})
    msp.add_text("SCALE :", height=1.25, dxfattribs={"layer": "TITLE", "insert": (tb[0] + 3, tb[1] + 20)})
    msp.add_text(scale_label, height=1.25, dxfattribs={"layer": "TITLE", "insert": (tb[0] + 20, tb[1] + 20)})
    msp.add_text("DRAWING NO:", height=1.25, dxfattribs={"layer": "TITLE", "insert": (tb[0] + 3, tb[1] + 10)})
    msp.add_text("TEST/SEWER/D1", height=1.25, dxfattribs={"layer": "TITLE", "insert": (tb[0] + 30, tb[1] + 10)})
    return doc, msp


def manhole(msp, mid, x, y, gl, il, depth=None):
    msp.add_blockref("MH", (x, y), dxfattribs={"layer": "NODE"})
    lx, ly = x + 2.0, y + 6.0
    lines = [f"MH- {mid}", f"GL: {gl:.2f} m", f"IL: {il:.2f} m", f"D: {(gl - il if depth is None else depth):.2f} m"]
    for k, s in enumerate(lines):
        msp.add_text(s, height=1.0, dxfattribs={"layer": "NODE", "insert": (lx, ly - 1.8 * k)})


def pipe(msp, pid, a, b, length_label=None, dia=150):
    (xa, ya), (xb, yb) = a, b
    msp.add_lwpolyline([(xa, ya), (xb, yb)], dxfattribs={"layer": "PIPE"})
    mx = (xa + xb) / 2
    L = ((xb - xa) ** 2 + (yb - ya) ** 2) ** 0.5
    for k, s in enumerate([f"P- {pid}", f"L-{(L if length_label is None else length_label):.1f} m", f"D: {dia:.2f} mm"]):
        msp.add_text(s, height=1.0, dxfattribs={"layer": "PIPE", "insert": (mx - 4, ya - 3.0 + 1.8 * k)})
    msp.add_blockref("FLOWARROW", (mx + 6, ya), dxfattribs={"layer": "PIPE"})


def network(msp, bad: bool):
    pts = {}
    for mid, x, y, gl, il in MANHOLES:
        if bad and mid == 4:
            il = 20.55  # above MH 3 (20.40): P- 3 runs uphill
        depth = 1.00 if (bad and mid == 3) else None
        manhole(msp, mid, x, y, gl, il, depth)
        pts[mid] = (x, y)
    msp.add_blockref("OUTFALL", pts[5], dxfattribs={"layer": "NODE"})
    for i in range(1, 5):
        pipe(msp, i, pts[i], pts[i + 1], length_label=25.0 if (bad and i == 4) else None)
    if bad:
        msp.add_blockref("MH", pts[2], dxfattribs={"layer": "NODE"})  # stacked copy
        manhole(msp, 9, 300, 220, 23.0, 21.5)  # orphan
        msp.add_text("NOTE: ALL LEVELS IN METRES", height=0.3, dxfattribs={"layer": "NOTES", "insert": (40, 60)})
        d = msp.add_linear_dim(base=(100, 100), p1=(100, 95), p2=(104, 95), text="5.00", dxfattribs={"layer": "DIM"})
        d.render()
    else:
        msp.add_text("NOTE: ALL LEVELS IN METRES", height=1.25, dxfattribs={"layer": "NOTES", "insert": (40, 60)})


def write_png(path: Path, size: int = 8):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row += bytes((255 if (x + y) % 2 else 20, 120, 40))
        rows.append(bytes(row))
    def chunk(kind: bytes, data: bytes):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows)))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    doc, msp = base()
    network(msp, bad=False)
    doc.saveas(OUT / "sewer_clean.dxf")
    doc, msp = base()
    network(msp, bad=True)
    doc.saveas(OUT / "sewer_bad.dxf")
    doc, msp = base("1:100")
    network(msp, bad=False)
    doc.saveas(OUT / "scale_wrong.dxf")
    write_png(OUT / "raster.png")
    doc, msp = base()
    network(msp, bad=False)
    image_def = doc.add_image_def(filename="./raster.png", size_in_pixel=(8, 8))
    image = msp.add_image(image_def, insert=(20, 20), size_in_units=(40, 40), dxfattribs={"layer": "NOTES"})
    image.set_boundary_path([(2, 2), (6, 6)])
    # The same raster inside a block, placed plainly and rotated/scaled: images reach the
    # viewer through inserts too, at the insert's transform.
    stamp = doc.blocks.new("RASTER_STAMP", base_point=(0, 0))
    stamp.add_image(image_def, insert=(0, 0), size_in_units=(8, 8))
    msp.add_blockref("RASTER_STAMP", (100, 20), dxfattribs={"layer": "NOTES"})
    msp.add_blockref("RASTER_STAMP", (150, 20), dxfattribs={"layer": "NOTES", "rotation": 90, "xscale": 2, "yscale": 2})
    doc.saveas(OUT / "raster_underlay.dxf")
    print("wrote", ", ".join(p.name for p in sorted([*OUT.glob("*.dxf"), *OUT.glob("*.png")])))


if __name__ == "__main__":
    main()
