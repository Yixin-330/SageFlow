from pathlib import Path

from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

pages_dir = Path(r"D:\SageFlow用户智能层\tmp\pdfs\sageflow_pages")
output_pdf = Path(r"D:\SageFlow用户智能层\output\pdf\SageFlow国创赛PPT_16页预览版.pdf")
output_pdf.parent.mkdir(parents=True, exist_ok=True)

page_width, page_height = 960, 540
pdf = canvas.Canvas(str(output_pdf), pagesize=(page_width, page_height), pageCompression=1)
page_files = sorted(pages_dir.glob("*.png"))
if len(page_files) != 16:
    raise RuntimeError(f"Expected 16 rendered pages, found {len(page_files)}")

for page_file in page_files:
    pdf.drawImage(ImageReader(str(page_file)), 0, 0, width=page_width, height=page_height)
    pdf.showPage()

pdf.save()
print(f"Created {output_pdf} with {len(page_files)} pages")
