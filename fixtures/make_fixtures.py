"""Synthetic drawings with planted defects, for omakase-cadkit's tests.

    uv run --with ezdxf python fixtures/make_fixtures.py fixtures

Writes:
  sewer_clean.dxf   a small labelled sewer network on an A1 sheet at 1:500, no defects
  sewer_bad.dxf     the same network with one planted defect per rule (see PLANTED)
  scale_wrong.dxf   the clean sheet with its scale label changed to 1:100
  raster_underlay.dxf  the clean sheet with a linked, clipped raster underlay and the same
                       raster inside a block placed by two inserts
  raster.png        the raster used by raster_underlay.dxf
  hatch_text.dxf    nested hatch islands, overlapping text exclusions and rotated blocks
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


def hatch_text_fixture():
    """Hatch islands and overlapping text boxes; no private drawing geometry."""
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    def rect(x, y, w, h):
        return [(x, y), (x+w, y), (x+w, y+h), (x, y+h)]
    for variant in range(3):
        x = variant * 40
        hatch = msp.add_hatch(color=7)
        hatch.paths.add_polyline_path(rect(x, 0, 30, 12), is_closed=True, flags=1)
        if variant < 2:
            hatch.paths.add_polyline_path(rect(x+1, 1, 28, 10), is_closed=True, flags=16)
        if variant == 0:
            hatch.paths.add_polyline_path(rect(x+4, 3, 22, 6), is_closed=True, flags=0)
        # Text exclusions cross the inner island and overlap each other.
        hatch.paths.add_polyline_path(rect(x+8, -1, 10, 14), is_closed=True, flags=9)
        hatch.paths.add_polyline_path(rect(x+14, -1, 8, 14), is_closed=True, flags=8)
        msp.add_text("I&D", height=3, dxfattribs={"insert": (x+9, 4)})
        # Geometry beneath a text box must survive (no background overpainting).
        msp.add_line((x+7, 2), (x+23, 2), dxfattribs={"color": 1})
    # Two independent hatches overlap: batching must not XOR away their overlap.
    for x in [0, 8]:
        hatch = msp.add_hatch(color=3)
        hatch.paths.add_polyline_path(rect(x, 25, 16, 10), is_closed=True, flags=1)
    stamp = doc.blocks.new("HATCH_LABEL")
    hatch = stamp.add_hatch(color=7)
    hatch.paths.add_polyline_path(rect(0, 0, 30, 12), is_closed=True, flags=1)
    hatch.paths.add_polyline_path(rect(8, -1, 14, 14), is_closed=True, flags=9)
    stamp.add_text("I&D", height=3, dxfattribs={"insert": (9, 4)})
    msp.add_blockref("HATCH_LABEL", (80, 30), dxfattribs={"rotation": 30, "xscale": 1.5, "yscale": 1.5})
    doc.saveas(OUT / "hatch_text.dxf")


def fidelity_fixture():
    """Redistributable details: wrapped runs, wide bands, leaders, pattern islands, OLE table/logo."""
    from ezdxf.lldxf.tags import Tags
    from ezdxf.lldxf.types import DXFTag, DXFVertex, DXFBinaryTag
    from ezdxf.math import Vec2
    from ezdxf.render.mleader import ConnectionSide
    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    doc.styles.new("CAD_SANS", dxfattribs={"font": "arial.ttf"})
    doc.styles.new("CAD_SHX", dxfattribs={"font": "romans.shx"})
    msp.add_mtext(r"{\fTimes New Roman|b1|i0;PROJECT TITLE}\P{\H0.7x;ALPHA BETA GAMMA DELTA EPSILON ZETA}",
                  dxfattribs={"insert": (0, 60), "char_height": 3, "width": 30, "style": "CAD_SANS"})
    msp.add_text("%%uNOTE%%u 90%%d", dxfattribs={"insert": (40, 55), "height": 3, "style": "CAD_SANS"})
    msp.add_text("STROKE FONT", dxfattribs={"insert": (40, 62), "height": 3, "style": "CAD_SHX"})
    msp.add_text("FITTED", dxfattribs={"height": 3, "style": "CAD_SANS", "insert": (40, 48), "align_point": (70, 48), "halign": 5})
    msp.add_lwpolyline([(0, 30), (20, 30), (20, 40)], dxfattribs={"const_width": 4, "color": 1})
    doc.linetypes.new("DETAIL_DASH", dxfattribs={"pattern": [6, 4, -2]})
    msp.add_line((0, 25), (30, 25), dxfattribs={"linetype": "DETAIL_DASH", "ltscale": 2})
    hatch = msp.add_hatch(color=3)
    hatch.paths.add_polyline_path([(0, 0), (30, 0), (30, 20), (0, 20)], is_closed=True, flags=1)
    hatch.paths.add_polyline_path([(10, 5), (20, 5), (20, 15), (10, 15)], is_closed=True, flags=16)
    hatch.set_pattern_fill("ANSI31", scale=0.5, color=3)
    msp.add_leader([(40, 0), (45, 8), (55, 8)], override={"dimasz": 3}, dxfattribs={"has_arrowhead": 1})
    leader = msp.add_multileader_mtext()
    leader.set_content("CALLOUT", char_height=3, style="CAD_SANS")
    leader.set_arrow_properties(size=3)
    leader.set_connection_properties(landing_gap=1, dogleg_length=4)
    leader.add_leader_line(ConnectionSide.left, [Vec2(40, 20), Vec2(45, 28)])
    leader.build(Vec2(55, 28))

    # A minimal compound file containing one ordinary (>=4096 byte) CONTENTS stream.
    # It is generated here, with synthetic EMF records; no client bytes are copied.
    def compound(contents):
        contents = contents.ljust(max(4096, (len(contents)+511)//512*512), b"\0")
        n = len(contents)//512
        header = bytearray(512)
        header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
        struct.pack_into("<HHHHH", header, 24, 0x3e, 3, 0xfffe, 9, 6)
        struct.pack_into("<IIIIIIIII", header, 40, 0, 1, n, 0, 4096, 0xfffffffe, 0, 0xfffffffe, 0)
        struct.pack_into("<109I", header, 76, n+1, *([0xffffffff]*108))
        directory = bytearray(512)
        for off, name, kind, child, start, size in [(0, "Root Entry", 5, 1, 0xfffffffe, 0), (128, "CONTENTS", 2, 0xffffffff, 0, len(contents))]:
            label=(name+"\0").encode("utf-16le")
            directory[off:off+len(label)] = label
            struct.pack_into("<HBBIII", directory, off+64, len(label), kind, 1, 0xffffffff, 0xffffffff, child)
            struct.pack_into("<IQ", directory, off+116, start, size)
        fat = list(range(1,n)) + [0xfffffffe, 0xfffffffe, 0xfffffffd]
        return bytes(header)+contents+bytes(directory)+struct.pack("<128I", *fat, *([0xffffffff]*(128-len(fat))))

    def record(kind, body):
        body += b"\0"*((-len(body))%4)
        return struct.pack("<II", kind, 8+len(body))+body
    def emf(records):
        h=bytearray(88)
        struct.pack_into("<II4i4iIIIIHHIII4i", h, 0, 1, 88, 0, 0, 100, 100, 0, 0, 10000, 10000,
                         0x464d4520, 0x10000, 88+sum(map(len, records))+20, len(records)+2, 8, 0, 0, 0, 0, 100, 100, 100, 100)
        return bytes(h)+b"".join(records)+record(14, struct.pack("<III",0,0,20))
    def ole(picture, x):
        # AutoCAD's OLE binary prefix repeats the four frame corners before the CFB.
        prefix=bytearray(128)
        struct.pack_into("<H",prefix,0,0x5581)
        for i, point in enumerate([(x,20,0),(x+20,20,0),(x+20,0,0),(x,0,0)]):
            struct.pack_into("<3d",prefix,2+i*24,*point)
        raw=bytes(prefix)+compound(picture)
        entity=msp.new_entity("OLE2FRAME", dxfattribs={})
        entity.acdb_ole2frame=Tags([DXFTag(100,"AcDbOle2Frame"), DXFTag(70,2),
            DXFVertex(10,(x,20,0)), DXFVertex(11,(x+20,0,0)), DXFTag(71,2), DXFTag(72,0), DXFTag(73,0), DXFTag(90,len(raw))]
            +[DXFBinaryTag(310,raw[i:i+127]) for i in range(0,len(raw),127)]+[DXFTag(1,"OLE")])
    # Vector table with three rules and one text run fitted using per-character advances.
    font=bytearray(96)
    struct.pack_into("<Ii",font,0,1,-12)
    struct.pack_into("<i",font,20,400)
    font[32:42]="Arial".encode("utf-16le")
    text="A1 B2".encode("utf-16le")
    tx=bytearray(68)
    struct.pack_into("<IffiiIII4iI",tx,16,1,1,1,5,20,5,76,0,0,0,100,100,88)
    ole(emf([record(82,bytes(font)), record(37,struct.pack("<I",1)),
        record(27,struct.pack("<ii",0,0)), record(54,struct.pack("<ii",100,0)),
        record(27,struct.pack("<ii",0,50)), record(54,struct.pack("<ii",100,50)),
        record(27,struct.pack("<ii",50,0)), record(54,struct.pack("<ii",50,100)),
        record(84,bytes(tx)+text+b"\0\0"+struct.pack("<5i",8,8,8,8,8))]),80)
    # Two-pass logo: left pixel is opaque blue; right pixel preserves the destination.
    def bitmap(rop, pixels):
        info=struct.pack("<IiiHHIIIIII",40,2,1,1,24,0,8,0,0,0,0)
        body=struct.pack("<4i6i6I2i",0,0,100,100,0,0,0,0,2,1,80,40,120,8,0,rop,100,100)
        return record(81,body+info+pixels+b"\0\0")
    ole(emf([bitmap(0x00ee0086,bytes([255,255,255,0,0,0])), bitmap(0x008800c6,bytes([220,70,10,255,255,255]))]),110)
    image=doc.add_image_def(filename="missing-logo.png",size_in_pixel=(8,8))
    msp.add_image(image,insert=(135,0),size_in_units=(20,20))
    # Explicit defaults exercise the supported LEADER flag, rather than ACadSharp's
    # incorrect default when DXF group 71 is absent (tracked as a remaining reader limit).
    doc.saveas(OUT / "fidelity.dxf")
    from ezdxf.lldxf.tagwriter import TagWriter
    with (OUT / "fidelity.dxf").open("w", encoding="utf-8") as stream:
        writer = TagWriter(stream, dxfversion=doc.dxfversion)
        writer.force_optional = True
        doc.export_sections(writer)


def continuous_hatch_fixture():
    doc = ezdxf.new("R2013")
    msp = doc.modelspace()
    # Survey coordinates, nested islands, vertices shared by adjacent edges, and two
    # continuous families. Both polyline and individual-edge boundary encodings.
    for variant in range(2):
        x, y = 500000 + variant * 20, 2700000
        hatch = msp.add_hatch()
        hatch.set_pattern_fill("USER", scale=1)
        hatch.set_pattern_definition([(0, (x, y + .5), (0, 1), []),
                                      (90, (x + .5, y), (1, 0), [])])
        for k, (a, b, c, d) in enumerate([(0, 0, 12, 10), (2, 2, 10, 8), (4, 4, 8, 6)]):
            pts = [(x+a, y+b), (x+c, y+b), (x+c, y+d), (x+a, y+d)]
            if variant == 0:
                hatch.paths.add_polyline_path(pts, is_closed=True, flags=1 if k == 0 else 0)
            else:
                edges = hatch.paths.add_edge_path(flags=1 if k == 0 else 0)
                for i in range(4):
                    edges.add_line(pts[i], pts[(i+1) % 4])
    doc.saveas(OUT / "continuous_hatch.dxf")


def pattern_pipeline_fixture():
    doc = ezdxf.new("R2013")
    msp = doc.modelspace()
    block = doc.blocks.new("SHARED_PATTERN")
    hatch = block.add_hatch()
    hatch.set_pattern_fill("USER", scale=1)
    hatch.set_pattern_definition([(0, (0, .5), (0, 1), []),
                                  (90, (.5, 0), (1, 0), [])])
    for k, (a, b, c, d) in enumerate([(0, 0, 12, 10), (2, 2, 10, 8), (4, 4, 8, 6)]):
        hatch.paths.add_polyline_path([(a, b), (c, b), (c, d), (a, d)], is_closed=True, flags=1 if k == 0 else 0)
    msp.add_blockref("SHARED_PATTERN", (0, 0))
    msp.add_blockref("SHARED_PATTERN", (20, 0))
    # Look-ahead must apply the density guard too, rather than starting billions
    # of rows on a future hatch that serial emission will reject immediately.
    dense = msp.add_hatch()
    dense.set_pattern_fill("USER", scale=1)
    dense.set_pattern_definition([(0, (50, 0), (0, 1e-9), [])])
    dense.paths.add_polyline_path([(50, 0), (62, 0), (62, 10), (50, 10)], is_closed=True)
    dashed = msp.add_hatch()
    dashed.set_pattern_fill("USER", scale=1)
    dashed.set_pattern_definition([(0, (70, .5), (0, 1), [1, -1])])
    dashed.paths.add_polyline_path([(70, 0), (82, 0), (82, 10), (70, 10)], is_closed=True)
    doc.saveas(OUT / "pattern_pipeline.dxf")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    continuous_hatch_fixture()
    pattern_pipeline_fixture()
    hatch_text_fixture()
    fidelity_fixture()
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
