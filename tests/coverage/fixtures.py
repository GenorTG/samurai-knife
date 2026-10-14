"""Tiny stdlib/PIL fixture builders for coverage cases. Content is returned as bytes; use b64() to put it in a prompt."""
import base64
import io
import zlib


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def make_pdf(pages: list[str]) -> bytes:
    """Minimal valid text PDF, one line of text per page."""
    objs: list[bytes] = []
    n = len(pages)
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(n))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_id = 3 + n * 2
    for i, text in enumerate(pages):
        content = f"BT /F1 18 Tf 72 700 Td ({text}) Tj ET".encode()
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + i * 2} 0 R /Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def make_png(width: int, height: int, rgb: tuple[int, int, int] = (200, 40, 40)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), rgb).save(buf, "PNG")
    return buf.getvalue()


def make_gzip(text: str) -> bytes:
    import gzip

    return gzip.compress(text.encode())


def make_zip(files: dict[str, bytes]) -> bytes:
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF
