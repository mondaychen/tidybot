#!/usr/bin/env python3
"""
Build a realistic, messy "Downloads" folder for tidybot end-to-end tests.

Every person, account, number and secret in the generated files is fake
(John Doe, Acme Robotics, SSN 123-45-6789, AWS's documented example key, ...).
Optionally copies a handful of public, non-personal documents (specs, books,
media) from a real Downloads folder so extraction is tested on real-world files.

Writes a ground-truth manifest (expected category, sensitivity, duplicates,
edge-case tags) next to this script, outside the fixture, so tidybot never
scans it.

    python3 test/e2e/make_downloads_test.py ~/Downloads-test --real-from ~/Downloads
    python3 test/e2e/make_downloads_test.py ~/Downloads-test --force   # rebuild

Requires: reportlab, Pillow, python-docx, openpyxl, python-pptx.
Optional: ffmpeg (video/audio), ssh-keygen (throwaway key).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import random
import shutil
import string
import subprocess
import sys
import tarfile
import unicodedata
import uuid
import wave
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

MARKER = ".tidybot-fixture"  # hidden: tidybot skips dotfiles; guards --force
RNG = random.Random(20260929)  # repeatable names and values; dates are relative to NOW, and
                               # Office files embed their creation time, so hashes differ per run
NOW = datetime.now()
RECENT = timedelta(days=14)  # matches `tidybot scan --older-than 14d`
MANIFEST: list[dict] = []
ROOT: Path


# ---------------------------------------------------------------- helpers

def days_ago(d: float) -> datetime:
    return NOW - timedelta(days=d)


def record(rel: str, category: str, *, when: datetime, sensitive: str | None = None,
           tags: list[str] | None = None, origin: str = "generated", note: str | None = None,
           kind: str = "file") -> Path:
    """Register a path in the manifest and return its absolute path (parents created)."""
    p = ROOT / rel
    (p if kind == "dir" else p.parent).mkdir(parents=True, exist_ok=True)
    MANIFEST.append({
        "path": rel, "kind": kind, "category": category, "sensitive": sensitive,
        "tags": tags or [], "origin": origin, "note": note, "_when": when.isoformat(),
    })
    return p


def font(size: int, mono: bool = False) -> ImageFont.FreeTypeFont:
    names = (["DejaVuSansMono.ttf", "Menlo.ttc", "Courier New.ttf"] if mono
             else ["DejaVuSans.ttf", "Helvetica.ttc", "Arial.ttf"])
    dirs = ["/usr/share/fonts/truetype/dejavu", "/System/Library/Fonts",
            "/System/Library/Fonts/Supplemental", "/Library/Fonts"]
    for d in dirs:
        for n in names:
            f = Path(d) / n
            if f.exists():
                return ImageFont.truetype(str(f), size)
    return ImageFont.load_default(size=size)


_CJK = False


def cjk_font() -> str:
    global _CJK
    if not _CJK:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        _CJK = True
    return "STSong-Light"


def pdf(path: Path, title: str, pages: list[list[str]] | list[str], *, author: str = "",
        font_name: str = "Helvetica", header: str | None = None) -> None:
    if pages and isinstance(pages[0], str):
        pages = [pages]  # type: ignore[list-item]
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    c.setTitle(title)
    c.setAuthor(author)
    c.setCreator("tidybot-fixture")
    w, h = letter
    for lines in pages:  # type: ignore[assignment]
        y = h - 72
        if header:
            c.setFont("Helvetica-Bold" if font_name == "Helvetica" else font_name, 9)
            c.drawString(72, h - 40, header)
        c.setFont("Helvetica-Bold" if font_name == "Helvetica" else font_name, 15)
        c.drawString(72, y, title)
        y -= 28
        c.setFont(font_name, 10.5)
        for line in lines:
            for chunk in wrap(line, 95 if font_name == "Helvetica" else 42):
                if y < 72:
                    c.showPage(); c.setFont(font_name, 10.5); y = h - 72
                c.drawString(72, y, chunk)
                y -= 15
            if not line:
                y -= 6
        c.showPage()
    c.save()


def wrap(line: str, width: int) -> list[str]:
    if len(line) <= width:
        return [line]
    out, cur = [], ""
    for word in line.split(" "):
        if len(cur) + len(word) + 1 > width and cur:
            out.append(cur); cur = word
        else:
            cur = f"{cur} {word}".strip()
    out.append(cur)
    return out


def text_image(lines: list[str], *, size=(1240, 1754), bg="white", fg="black", fsize=30,
               mono=False, rotate=0.0, noise=False, title: str | None = None) -> Image.Image:
    img = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(img)
    y = 90
    if title:
        d.text((90, y), title, fill=fg, font=font(int(fsize * 1.5)))
        y += int(fsize * 2.6)
    f = font(fsize, mono)
    for line in lines:
        d.text((90, y), line, fill=fg, font=f)
        y += int(fsize * 1.45)
    if noise:
        px = img.load()
        for _ in range(size[0] * size[1] // 60):
            x, yy = RNG.randrange(size[0]), RNG.randrange(size[1])
            g = RNG.randrange(150, 235)
            px[x, yy] = (g, g, g)
    if rotate:
        img = img.rotate(rotate, expand=True, fillcolor=(90, 80, 70))
    return img


def scanned_pdf(path: Path, title: str, lines: list[str]) -> None:
    """Image-only PDF: no text layer, so excerpt extraction returns nothing."""
    img = text_image(lines, title=title, noise=True, rotate=0.7)
    img.convert("L").save(path, "PDF", resolution=150)


def save_jpg(path: Path, img: Image.Image, when: datetime, camera=True) -> None:
    exif = Image.Exif()
    if camera:
        exif[0x010F] = "Apple"  # Make
        exif[0x0110] = "iPhone 15 Pro"
        exif[0x0132] = when.strftime("%Y:%m:%d %H:%M:%S")
    img.convert("RGB").save(path, "JPEG", quality=85, exif=exif)


def docx(path: Path, title: str, paras: list[str], author: str = "") -> None:
    d = Document()
    d.core_properties.author = author
    d.core_properties.title = title
    d.add_heading(title, 1)
    for p in paras:
        d.add_paragraph(p)
    d.save(path)


def xlsx(path: Path, sheets: dict[str, list[list]]) -> None:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    wb.save(path)


def pptx(path: Path, slides: list[tuple[str, list[str]]]) -> None:
    prs = Presentation()
    for title, bullets in slides:
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = title
        tf = s.placeholders[1].text_frame
        tf.text = bullets[0]
        for b in bullets[1:]:
            tf.add_paragraph().text = b
    prs.save(path)


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def random_bytes(path: Path, n: int, head: bytes = b"") -> None:
    with open(path, "wb") as f:
        f.write(head)
        left = n - len(head)
        seed = hashlib.sha256(path.name.encode()).digest()
        block = b"".join(hashlib.sha256(seed + i.to_bytes(4, "big")).digest() for i in range(2048))  # 64 KiB
        while left > 0:
            f.write(block[:left]); left -= len(block)


def sparse_disk(path: Path, size: int, middle: bytes = b"") -> None:
    """A sparse disk image: random first and last MiB, zeros between (except `middle`).
    Same size and ends give the same sampled tidybot hash; only `middle` tells copies apart."""
    mib = 1024 * 1024
    seed = hashlib.sha256(b"disk").digest()
    block = b"".join(hashlib.sha256(seed + i.to_bytes(4, "big")).digest() for i in range(mib // 32))
    with open(path, "wb") as f:
        f.write(block)
        if middle:
            f.seek(size // 2); f.write(middle)
        f.seek(size - mib); f.write(block[::-1])
        f.truncate(size)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def copy(path: Path, other: Path) -> None:
    shutil.copyfile(other, path)


def tone_wav(path: Path, secs=2.0, hz=440) -> None:
    import math
    rate = 16000
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        frames = b"".join(int(8000 * math.sin(2 * math.pi * hz * i / rate)).to_bytes(2, "little", signed=True)
                          for i in range(int(rate * secs)))
        w.writeframes(frames)


def ffmpeg(args: list[str]) -> bool:
    if not shutil.which("ffmpeg"):
        return False
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args]).returncode == 0


def fake_token(prefix: str, n: int, alphabet=string.ascii_letters + string.digits) -> str:
    # Built at runtime so this script never contains a literal that secret scanners flag.
    return prefix + "".join(RNG.choice(alphabet) for _ in range(n))


def fake_jwt(claims: dict) -> str:
    """A JWT-shaped token (header.payload.signature), like a Kubernetes service-account token."""
    part = lambda obj: base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=").decode()
    return f"{part({'alg': 'RS256', 'typ': 'JWT'})}.{part(claims)}.{fake_token('', 86, string.ascii_letters + string.digits + '-_')}"


# ---------------------------------------------------------------- people & constants

JOHN = "John Doe"
ADDR = "123 Main St, Apt 4B, Springfield, IL 62701"
SSN = "123-45-6789"
EMPLOYER = "Acme Robotics Inc."


# ---------------------------------------------------------------- content

def build_finance():
    p = record("2025-W2.pdf", "Finance & Tax", when=days_ago(240), sensitive="pii", tags=["ssn"])
    pdf(p, "Form W-2 Wage and Tax Statement 2025", [
        f"a Employee's social security number: {SSN}",
        f"b Employer identification number (EIN): 12-3456789",
        f"c Employer: {EMPLOYER}, 500 Innovation Way, Springfield, IL 62704",
        f"e Employee: {JOHN}", f"f Address: {ADDR}",
        "1 Wages, tips, other compensation: 148,250.00",
        "2 Federal income tax withheld: 27,904.12",
        "3 Social security wages: 148,250.00   4 Social security tax withheld: 9,191.50",
        "5 Medicare wages: 148,250.00   6 Medicare tax withheld: 2,149.63",
        "16 State wages: 148,250.00   17 State income tax: 7,338.38 (IL)"],
        author="ADP", header="Copy B - To Be Filed With Employee's FEDERAL Tax Return")

    p = record("Paycheck 8812345.pdf", "Finance & Tax", when=days_ago(18))
    pdf(p, f"{EMPLOYER} - Earnings Statement", [
        f"Employee: {JOHN}   Employee ID: 004417   Pay date: {days_ago(18):%m/%d/%Y}",
        "Pay period: 08/16/2026 - 08/31/2026", "",
        "Regular 86.67 hrs  6,176.92", "Federal Income Tax  -1,162.40", "Social Security  -382.97",
        "Medicare  -89.57", "IL State Tax  -305.76", "401(k)  -617.69", "",
        "Net Pay: 3,618.53   Deposited to checking ****4821"])

    p = record("2025 Tax Return.pdf", "Finance & Tax", when=days_ago(165), sensitive="pii", tags=["ssn"])
    pdf(p, "Form 1040 U.S. Individual Income Tax Return 2025", [[
        f"Filing status: Married filing jointly", f"Your name: {JOHN}   SSN: {SSN}",
        "Spouse: Jane Doe   SSN: 987-65-4320", f"Home address: {ADDR}",
        "Dependents: Emma Doe (daughter)", "",
        "1a Total wages: 231,410", "2b Taxable interest: 1,208", "11 Adjusted gross income: 229,904",
        "24 Total tax: 38,771", "33 Total payments: 41,020", "34 Overpaid / Refund: 2,249"],
        ["Schedule B - Interest and Ordinary Dividends", "Springfield Credit Union  812",
         "Ally Bank  396", "", "Prepared by: Lin & Park CPA LLC, PTIN P01234567"]], author="Lin & Park CPA")

    p = record("Form 1099-INT 2025.pdf", "Finance & Tax", when=days_ago(230))
    pdf(p, "Form 1099-INT Interest Income 2025", [
        "PAYER: Ally Bank, P.O. Box 951, Horsham, PA 19044",
        f"RECIPIENT: {JOHN}   Account ****7732", "1 Interest income: $396.14"])

    p = record("Chase Account Activity Sep 1 2026.CSV", "Finance & Tax", when=days_ago(28),
               tags=["uppercase-ext"])
    rows = ["Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #"]
    bal = 8421.33
    for i in range(40):
        d = days_ago(60 - i)
        desc, amt = RNG.choice([("WHOLE FOODS MKT #10233", -RNG.uniform(20, 180)),
                                ("SHELL OIL 57442", -RNG.uniform(30, 70)),
                                ("NETFLIX.COM", -15.49), ("COMED PAYMENT", -RNG.uniform(80, 140)),
                                ("ACME ROBOTICS PAYROLL", 3618.53), ("VENMO CASHOUT", RNG.uniform(10, 200)),
                                ("TRADER JOE S #552", -RNG.uniform(15, 90))])
        bal += amt
        rows.append(f"{'CREDIT' if amt > 0 else 'DEBIT'},{d:%m/%d/%Y},{desc},{amt:.2f},ACH_DEBIT,{bal:.2f},")
    write(p, "\n".join(rows) + "\n")

    p = record("Fidelity Statement 06302026.pdf", "Finance & Tax", when=days_ago(88))
    pdf(p, "Fidelity Investments - Quarterly Statement", [
        f"{JOHN}  Account X81-204417 (Individual - TOD)", "Period: April 1, 2026 - June 30, 2026",
        "Beginning value: $84,120.55   Ending value: $91,702.18", "",
        "FXAIX Fidelity 500 Index  212.441 sh  $44,806.20",
        "FTIHX Fidelity Total Intl  1,504.2 sh  $21,946.28",
        "SPAXX Money Market  $24,949.70"], author="Fidelity")

    # Bad name, needs content to classify: auto insurance card
    p = record("Document.pdf", "Finance & Tax", when=days_ago(47), tags=["bad-name", "needs-content"],
               note="auto insurance ID card")
    pdf(p, "Evergreen Mutual - Auto Insurance ID Card", [
        f"Named insured: {JOHN}", "Policy number: EVM-4417-2291-03",
        "Effective: 07/01/2026   Expires: 01/01/2027",
        "Vehicle: 2021 Subaru Outback  VIN 4S4BTANC5M3100000",
        "Keep this card in your vehicle."])


def build_home():
    p = record("Lease Agreement 123 Main St Apt 4B.pdf", "Home", when=days_ago(330))
    lease = [
        "RESIDENTIAL LEASE AGREEMENT",
        f"Landlord: Maple Property Management LLC   Tenant(s): {JOHN}, Jane Doe",
        f"Premises: {ADDR}", "Term: 12 months beginning October 1, 2025", "Monthly rent: $2,450.00 due on the 1st",
        "Security deposit: $2,450.00", "Pets: one cat permitted with $300 pet deposit.",
        "Signature (Tenant): ____________________   Signature (Landlord): ____________________"]
    pdf(p, "Lease Agreement - 123 Main St Apt 4B", lease, author="Maple Property Management")
    p = record("Lease Agreement 123 Main St Apt 4B (1).pdf", "Home", when=days_ago(326),
               tags=["numbered-copy-not-duplicate"], note="signed version; differs from the unsigned one")
    pdf(p, "Lease Agreement - 123 Main St Apt 4B", lease[:-1] + [
        "Signature (Tenant): /s/ John Doe  09/28/2025   Signature (Landlord): /s/ R. Patel  09/29/2025"],
        author="Maple Property Management")

    p = record("ConEd Bill Aug 2026.pdf", "Home", when=days_ago(40))
    pdf(p, "Springfield Electric & Gas - Monthly Statement", [
        f"Account 55-1029-3344-0001   Service address: {ADDR}", "Billing period: Jul 12 - Aug 10, 2026",
        "Electric usage: 612 kWh   Gas usage: 14 therms", "Amount due: $142.87 by 09/05/2026"])

    p = record("3f2a9c1e-77b0-4d1a-9b1e-2c7d1f0a8e55.pdf", "Home", when=days_ago(9),
               tags=["bad-name", "uuid-name", "needs-content"], note="internet bill")
    pdf(p, "Spectrum-like Internet - Your bill is ready", [
        f"Account holder: {JOHN}   Account 8347 1100 2233 4455", "Statement date: September 20, 2026",
        "Internet Ultra 500 Mbps  $80.00", "WiFi router rental  $5.00", "Total due Oct 14: $85.00"])

    p = record("Renters Insurance Policy.pdf", "Home", when=days_ago(300))
    pdf(p, "Evergreen Mutual - Renters Policy Declarations", [
        f"Insured: {JOHN}, Jane Doe  Location: {ADDR}", "Personal property: $40,000  Liability: $300,000",
        "Deductible: $500   Annual premium: $186.00"])

    base = record("Rental Agreement (1).docx", "Home", when=days_ago(95), tags=["duplicate"])
    docx(base, "Short-Term Rental Agreement", [
        "Guest: John Doe. Property: Lakeside Cabin, 88 Birch Rd, Door County, WI.",
        "Dates: July 3 - July 7, 2026. Rate: $210/night. Cleaning fee: $95.",
        "Check-in 4pm, checkout 11am. No smoking."], author="John Doe")
    dup = record("Rental Agreement (2).docx", "Home", when=days_ago(95), tags=["duplicate"])
    copy(dup, base)
    MANIFEST[-1]["duplicate_of"] = "Rental Agreement (1).docx"

    p = record("property-tax-bill-2025.pdf", "Home", when=days_ago(290))
    pdf(p, "Sangamon County Property Tax Bill 2025 (sample)", [
        "Parcel 14-22-301-017   Owner: Doe Family Trust", "Assessed value: $118,400",
        "First installment due 06/05/2026: $2,114.18", "Second installment due 09/05/2026: $2,114.18"])


def build_health():
    rec = [
        f"Patient: {JOHN}   DOB: 04/12/1988   MRN: 00-7781-2291",
        "Visit: Annual physical, Springfield Family Medicine, Dr. A. Mensah", "",
        "Vitals: BP 118/76, HR 64, BMI 24.1",
        "Labs: LDL 104 mg/dL, HDL 58 mg/dL, A1c 5.3%, TSH 1.9",
        "Assessment: healthy adult; mild seasonal allergies.",
        "Plan: continue cetirizine 10 mg as needed; return in 12 months."]
    a = record("John_Doe_health_record.pdf", "Health", when=days_ago(400), sensitive="pii", tags=["phi", "duplicate"])
    pdf(a, "Clinical Summary", rec, author="Springfield Family Medicine")
    b = record("john-doe-health-report.pdf", "Health", when=days_ago(60), sensitive="pii",
               tags=["phi", "duplicate", "different-name"])
    copy(b, a)
    MANIFEST[-1]["duplicate_of"] = "John_Doe_health_record.pdf"

    p = record("Vaccine History - Emma Doe.pdf", "Health", when=days_ago(500), sensitive="pii", tags=["phi", "child"])
    pdf(p, "Immunization Record", [
        "Patient: Emma Doe   DOB: 02/03/2020", "DTaP: 04/2020, 06/2020, 08/2020, 05/2021, 03/2024",
        "MMR: 02/2021, 03/2024", "Varicella: 02/2021, 03/2024", "Influenza: 10/2025"])

    p = record("Outpatient Visit Apr 1 2026.PDF", "Health", when=days_ago(181), sensitive="pii",
               tags=["phi", "uppercase-ext"])
    pdf(p, "After Visit Summary", [
        f"{JOHN} was seen on 04/01/2026 at Riverside Urgent Care.",
        "Reason: sprained left ankle (playing soccer).", "X-ray: no fracture.",
        "Instructions: RICE, ibuprofen 400 mg every 6 hours as needed, follow up if not improved in 2 weeks."])

    p = record("Eyeglass Prescription.pdf", "Health", when=days_ago(22), sensitive="pii", tags=["phi"])
    pdf(p, "Eyeglass Prescription", [f"Patient: {JOHN}", "OD: -2.25 -0.50 x 180", "OS: -2.00 -0.75 x 175",
                                     "PD: 63   Expires: 09/2028"])

    p = record("Dental Claim EOB.pdf", "Health", when=days_ago(70), tags=["phi"])
    pdf(p, "Explanation of Benefits - This is not a bill", [
        "Member: Jane Doe   Group: ACME-7781", "Service: periodic exam + cleaning, 07/15/2026",
        "Billed $240.00   Allowed $168.00   Plan paid $168.00   You owe $0.00"])


def build_immigration():
    p = record("scan0001.pdf", "Immigration & Visas", when=days_ago(12),
               tags=["bad-name", "image-only-pdf", "needs-vision"], sensitive="pii",
               note="scanned I-797C receipt notice; no text layer")
    scanned_pdf(p, "I-797C, Notice of Action", [
        "THE UNITED STATES OF AMERICA", "Receipt Number: IOE0123456789",
        "Case Type: I-485, Application to Register Permanent", "Residence or Adjust Status",
        f"Applicant: DOE, JOHN", "A-Number: A000-000-000",
        "Received Date: 08/30/2026   Notice Date: 09/10/2026", "",
        "This notice confirms that USCIS received your", "application. Keep this notice for your records."])

    p = record("B-2 Visa Invitation Letter - Wei Zhang.docx", "Immigration & Visas", when=days_ago(120))
    docx(p, "Invitation Letter", [
        "To the Consular Officer, U.S. Embassy Beijing:",
        f"I, {JOHN}, residing at {ADDR}, invite my mother-in-law, Ms. Wei Zhang (passport E00000000), "
        "to visit us from December 10, 2026 to February 20, 2027 to help care for our daughter.",
        "I will cover all expenses during her stay. Enclosed: employment verification letter, "
        "bank statement, and a copy of my green card.", "Sincerely, John Doe"], author=JOHN)

    p = record("解释信 Letter of Explanation.pdf", "Immigration & Visas", when=days_ago(310),
               tags=["cjk-name", "cjk-content"])
    pdf(p, "解释信 / Letter of Explanation", [
        "致签证官：", "本人张伟，此次赴美探望女儿一家，停留约七十天。",
        "我已退休，每月领取养老金，在国内有房产，会按时回国。",
        "随附：退休证、房产证、银行存款证明。", "此致 敬礼", "张伟  2025年11月20日"],
        font_name=cjk_font())

    p = record("EVUS Enrollment Confirmation.pdf", "Immigration & Visas", when=days_ago(300))
    pdf(p, "EVUS Enrollment - Approved (sample)", [
        "Name: ZHANG, WEI   Passport: E00000000", "Enrollment status: Enrollment Successful",
        "Valid until: 11/2027"])

    p = record("Untitled.jpg", "Immigration & Visas", when=days_ago(35), sensitive="pii",
               tags=["bad-name", "needs-vision", "passport"], note="photo of a (fake) passport data page")
    img = text_image([
        "PASSPORT   UNITED STATES OF AMERICA", "", "Type P   Code USA   Passport No. 000000000",
        "Surname: DOE", "Given names: JOHN", "Nationality: UNITED STATES OF AMERICA",
        "Date of birth: 12 APR 1988", "Place of birth: ILLINOIS, U.S.A.", "Date of issue: 03 MAR 2022",
        "Date of expiration: 02 MAR 2032", "",
        "P<USADOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<",
        "0000000000USA8804125M3203023<<<<<<<<<<<<<<04"],
        size=(1400, 980), bg=(226, 232, 240), fsize=34, mono=True, rotate=-2.5, noise=True)
    save_jpg(p, img, days_ago(35))


def build_kids():
    p = record("Emma Kindergarten Offer Letter.pdf", "Kids & School", when=days_ago(520))
    pdf(p, "Lincoln Elementary - Kindergarten Placement", [
        "Dear Parent/Guardian of Emma Doe,",
        "We are pleased to offer Emma a seat in Kindergarten, Room 104, for the 2025-26 school year.",
        "Please return the enrollment packet by April 15."], author="Lincoln Elementary")

    p = record("Field Trip Permission Slip 2B.pdf", "Kids & School", when=days_ago(6))
    pdf(p, "Class 2B Field Trip - Springfield Zoo", [
        "Date: October 9, 2026, 9:00am - 2:00pm. Cost: $12 (covers admission and bus).",
        "Student name: ______________  Parent signature: ______________",
        "Please pack a nut-free lunch."])

    p = record("download (3).pdf", "Kids & School", when=days_ago(25), tags=["bad-name", "needs-content"],
               note="school lunch menu")
    pdf(p, "Lincoln Elementary - October Lunch Menu", [
        "Mon: chicken tenders, green beans", "Tue: cheese pizza, salad", "Wed: bean & cheese burrito",
        "Thu: pasta with meat sauce", "Fri: fish sticks, sweet potato fries"])

    p = record("Soccer Signup List.csv", "Kids & School", when=days_ago(15))
    write(p, "Child,Grade,Parent,Snack week,T-shirt size\n"
             "Emma Doe,2,Jane Doe,Sep 12,YS\nLiam Chen-Ortiz,2,Maria Ortiz,Sep 19,YM\n"
             "Ava Brooks,2,Tom Brooks,Sep 26,YS\nNoah Kim,1,Grace Kim,Oct 3,YXS\n")

    p = record("Reading Log Week 3.docx", "Kids & School", when=days_ago(11))
    docx(p, "Reading Log - Week 3", ["Mon: Frog and Toad, 15 min", "Tue: Magic Tree House #2, 20 min",
                                     "Wed: library book, 10 min", "Parent initials: JD"])

    p = record("WechatIMG1024.jpg", "Kids & School", when=days_ago(50), tags=["bad-name", "needs-vision"],
               note="child's crayon drawing of a house and sun")
    img = Image.new("RGB", (1080, 1440), (250, 247, 238))
    d = ImageDraw.Draw(img)
    d.rectangle([300, 700, 780, 1100], outline=(200, 40, 40), width=14)
    d.polygon([(260, 710), (540, 430), (820, 710)], outline=(60, 60, 200), width=14)
    d.ellipse([820, 110, 1000, 290], fill=(250, 200, 30))
    d.rectangle([480, 900, 600, 1100], fill=(120, 70, 30))
    d.text((120, 1250), "MY HOUSE  by Emma", fill=(40, 120, 40), font=font(60))
    save_jpg(p, img, days_ago(50))


def build_work():
    resume = [
        "Alex Rivera  |  alex.rivera@example.com  |  (555) 010-4417  |  Seattle, WA",
        "Senior Firmware Engineer", "",
        "Experience", "Lumen Devices (2021-present): DDR5 memory controller bring-up, UVM testbenches, "
        "reduced regression time 40%.", "Northwind Semis (2017-2021): PCIe Gen4 PHY validation.", "",
        "Education: B.S. Electrical Engineering, University of Washington, 2017",
        "Skills: SystemVerilog, UVM, Python, C, JEDEC DDR4/DDR5, AMBA AXI/APB"]
    a = record("Resume - Alex Rivera.pdf", "Work / Hiring", when=days_ago(16), tags=["duplicate"])
    pdf(a, "Alex Rivera - Resume", resume, author="Alex Rivera")
    b = record("Resume - Alex Rivera (1).pdf", "Work / Hiring", when=days_ago(13), tags=["duplicate"])
    copy(b, a)
    MANIFEST[-1]["duplicate_of"] = "Resume - Alex Rivera.pdf"

    p = record("Priya Nair Resume.pdf", "Work / Hiring", when=days_ago(30))
    pdf(p, "Priya Nair", ["priya.nair@example.org | Austin, TX", "Machine Learning Engineer",
                          "Built retrieval pipelines over 2M technical documents; LLM evaluation harnesses.",
                          "M.S. Computer Science, UT Austin"], author="Priya Nair")

    p = record("Sam Okafor CV.docx", "Work / Hiring", when=days_ago(3))
    docx(p, "Sam Okafor - Curriculum Vitae", [
        "Verification engineer, 6 years. Formal verification (JasperGold), SVA, UCIe die-to-die adapters.",
        "Contact: sam.okafor@example.net"], author="Sam Okafor")

    p = record("Job Descriptions Master.docx", "Work / Hiring", when=days_ago(75))
    docx(p, "Acme Robotics - Open Roles", [
        "Senior Design Verification Engineer - memory subsystems (DDR5/LPDDR5).",
        "ML Engineer - document understanding for hardware specs.", "Technical Recruiter (contract)."],
        author="People Team")

    deck = [("Q3 2026 Board Update", ["Acme Robotics", "Confidential - board only"]),
            ("Highlights", ["ARR $4.1M (+22% QoQ)", "Closed 3 design partners", "Hired 6 engineers"]),
            ("Risks", ["Tape-out slip risk: 3 weeks", "Supply of HBM samples"])]
    for i, (name, ago) in enumerate([("Q3 Board Deck.pptx", 21), ("Q3 Board Deck v2.pptx", 19),
                                     ("Q3 Board Deck FINAL.pptx", 17)]):
        p = record(name, "Work / Projects", when=days_ago(ago), tags=["versions"])
        pptx(p, deck + ([("Appendix", ["Hiring plan detail"])] if i else [])
             + ([("Next steps", ["Board vote on Series B terms"])] if i == 2 else []))

    p = record("budget-2026.xlsx", "Work / Projects", when=days_ago(55))
    xlsx(p, {"Summary": [["Dept", "Q1", "Q2", "Q3", "Q4"], ["Engineering", 820000, 860000, 910000, 940000],
                         ["G&A", 140000, 142000, 150000, 151000], ["Sales", 210000, 230000, 260000, 300000]],
             "Headcount": [["Team", "Now", "EOY"], ["DV", 5, 8], ["ML", 4, 6]]})

    p = record("meeting-notes-2026-09-24.md", "Work / Projects", when=days_ago(5), tags=["short-text"])
    write(p, "# DV sync 2026-09-24\n\n- DDR5 refresh-management coverage at 87%\n"
             "- Alex Rivera onsite loop scheduled for Oct 2\n- Action: John to review UCIe adapter test plan\n")

    p = record("Acme Robotics - Certificate of Insurance.pdf", "Work / Projects", when=days_ago(100))
    pdf(p, "Certificate of Liability Insurance (sample)", [
        "Insured: Acme Robotics Inc.", "Certificate holder: Springfield Innovation Center",
        "General liability: $1,000,000 each occurrence", "Policy period: 06/01/2026 - 06/01/2027"])

    p = record("output.pdf", "Work / Projects", when=days_ago(8), tags=["bad-name", "needs-content"],
               note="exported regression dashboard")
    pdf(p, "Nightly Regression Report - ddr5_ctrl", [
        "Run: 2026-09-20 02:00  Seeds: 500  Pass: 488  Fail: 12",
        "Top failure: refresh_mgmt_seq_42 (timing violation tRFC)", "Coverage: 87.4% functional, 93.1% code"])

    p = record("IMG_4822.jpg", "Work / Projects", when=days_ago(16), tags=["bad-name", "needs-vision"],
               note="photo of whiteboard architecture sketch")
    img = Image.new("RGB", (1600, 1200), (238, 240, 236))
    d = ImageDraw.Draw(img)
    f = font(44)
    for x, y, label in [(120, 200, "Host"), (620, 200, "Mem Ctrl"), (1120, 200, "DDR5 PHY"),
                        (620, 700, "Refresh Mgr"), (1120, 700, "DRAM")]:
        d.rectangle([x, y, x + 360, y + 200], outline=(30, 60, 160), width=8)
        d.text((x + 40, y + 70), label, fill=(30, 60, 160), font=f)
    for (x1, y1, x2, y2) in [(480, 300, 620, 300), (980, 300, 1120, 300), (800, 400, 800, 700), (1300, 400, 1300, 700)]:
        d.line([x1, y1, x2, y2], fill=(200, 40, 40), width=8)
    d.text((120, 1000), "Q4: add RFM path  -- JD", fill=(20, 20, 20), font=f)
    save_jpg(p, img.rotate(3, expand=True, fillcolor=(120, 110, 100)), days_ago(16))


def build_travel():
    itin = [f"Traveler: {JOHN}   Confirmation: 3392797414",
            "Oct 12, 2026  UA 857  ORD 10:40 -> SFO 13:12  Seat 23C",
            "Oct 16, 2026  UA 1622 SFO 07:05 -> ORD 13:18  Seat 19A",
            "Hotel: Grand Harbor Hotel, 4 nights, confirmation GH-88213"]
    a = record("Trip itinerary 3392797414 Oct 12, 2026.pdf", "Travel", when=days_ago(4), tags=["duplicate"])
    pdf(a, "Trip itinerary", itin)
    b = record("TripId-3392797414.pdf", "Travel", when=days_ago(4), tags=["duplicate", "different-name"])
    copy(b, a)
    MANIFEST[-1]["duplicate_of"] = "Trip itinerary 3392797414 Oct 12, 2026.pdf"

    p = record("Boarding Pass UA857.pdf", "Travel", when=days_ago(1))
    pdf(p, "Boarding Pass", [f"DOE/JOHN   UA 857   ORD -> SFO   Oct 12   Group 3   Seat 23C",
                             "Gate B9  Boarding 10:05"])

    p = record("UA857.pkpass", "Travel", when=days_ago(1), tags=["zip-container"])
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("pass.json", json.dumps({"formatVersion": 1, "description": "Boarding pass UA 857",
                                            "organizationName": "Example Air", "serialNumber": "3392797414"}))
        z.writestr("manifest.json", "{}")

    p = record("Gmail - Your ride with Rajwinder on Sep 3.pdf", "Travel", when=days_ago(26))
    pdf(p, "Your ride receipt", ["Sep 3, 2026  8:12 AM", "123 Main St -> Springfield Airport (SPI)",
                                 "Fare $31.40  Tip $6.00  Total $37.40", "Paid with Visa ****1111"])

    p = record("Screenshot 2026-09-12 at 10.14.03 AM.png", "Travel", when=days_ago(17),
               tags=["screenshot", "needs-vision"], note="flight booking confirmation screenshot")
    img = text_image(["Booking confirmed!", "", "Chicago (ORD)  ->  San Francisco (SFO)", "Mon, Oct 12 · 10:40 AM",
                      "1 adult · Economy", "Confirmation code: K7QZ2P", "", "Total: $412.60"],
                     size=(1440, 900), bg=(245, 248, 255), fg=(20, 30, 60), fsize=40)
    img.save(p, "PNG")


def build_receipts():
    p = record(f"receipt_{uuid.UUID(int=RNG.getrandbits(128))}.pdf", "Receipts & Shopping", when=days_ago(44),
               tags=["bad-name", "uuid-name"])
    pdf(p, "Receipt from Example Software Co.", ["Receipt #2291-4417", "Pro plan - annual  $96.00",
                                                 "Paid Aug 16, 2026 with Visa ****1111"])

    p = record("Order #113-4455667 confirmation.pdf", "Receipts & Shopping", when=days_ago(10))
    pdf(p, "Your order has shipped", ["Order #113-4455667", "Ergonomic desk chair  $289.99",
                                      "USB-C dock  $139.00", f"Ship to: {JOHN}, {ADDR}"])

    nfd = unicodedata.normalize("NFD", "Café Lumière receipt.pdf")
    p = record(nfd, "Receipts & Shopping", when=days_ago(33), tags=["nfd-unicode-name"])
    pdf(p, "Cafe Lumiere", ["2 x cappuccino  $9.00", "1 x croissant  $4.25", "Total $13.25"])

    p = record("Invoice-1042.pdf", "Receipts & Shopping", when=days_ago(63),
               tags=["case-collision"], note="collides case-insensitively with old downloads/invoice-1042.pdf")
    pdf(p, "Invoice 1042 - Northside Plumbing", ["Replace kitchen faucet  $265.00", "Due on receipt"])

    p = record("IMG_4821.jpg", "Receipts & Shopping", when=days_ago(19), tags=["bad-name", "needs-vision"],
               note="phone photo of a restaurant receipt")
    img = text_image(["THE GOLDEN SPOON", "412 Elm St, Springfield", "", "09/10/2026  7:42 PM  Table 12",
                      "2  Pad Thai            31.00", "1  Green Curry         17.50", "2  Thai Iced Tea       11.00",
                      "", "Subtotal             59.50", "Tax                   5.21", "Tip                  12.00",
                      "TOTAL                76.71", "VISA ****1111"],
                     size=(760, 1300), bg=(252, 250, 244), fsize=30, mono=True, rotate=4, noise=True)
    save_jpg(p, img, days_ago(19))

    p = record("🎉 Birthday party invite.pdf", "Kids & School", when=days_ago(7), tags=["emoji-name"])
    pdf(p, "You're invited!", ["Ava turns 7!", "Saturday Oct 17, 2-4pm at Bounce Zone", "RSVP to Tom Brooks"])


def build_reading():
    p = record("材料瓶颈才是下一轮主线.md", "Reading", when=days_ago(12), tags=["cjk-name", "cjk-content"])
    write(p, "# 材料瓶颈才是下一轮主线\n\n本文讨论半导体供应链中的材料约束：高纯石英、光刻胶与先进封装基板。\n\n"
             "作者认为，未来两年算力扩张的主要瓶颈将从晶圆产能转向材料与封装。\n" * 6)

    long_name = "关于二零二六年度家庭财务规划与子女教育储蓄方案的详细说明以及各项开支预算表和相关补充材料汇总版" \
                "第三次修订稿含附件一至附件五最终确认版本请勿外传谢谢"  # 80 CJK chars = 240 bytes
    p = record(long_name[:80] + ".pdf", "Finance & Tax", when=days_ago(140),
               tags=["long-name", "cjk-name", "near-255-byte-limit"])
    pdf(p, "2026 家庭财务规划", ["教育储蓄：每月 1,500 美元", "房租：2,450 美元", "旅行预算：6,000 美元/年"],
        font_name=cjk_font())


def build_dev():
    p = record("schema_export.sql", "Dev & Data", when=days_ago(180))
    write(p, "-- exported 2026-04-01\nCREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, "
             "created_at TIMESTAMPTZ DEFAULT now());\nCREATE TABLE specs (id SERIAL PRIMARY KEY, "
             "name TEXT, jedec_id TEXT, pages INT);\nCREATE INDEX specs_jedec ON specs(jedec_id);\n")

    p = record("server-2026-09-18.log", "Dev & Data", when=days_ago(11))
    lines = []
    for i in range(3000):
        t = days_ago(11) + timedelta(seconds=i * 7)
        lvl = RNG.choice(["INFO"] * 8 + ["WARN", "ERROR"])
        lines.append(f"{t:%Y-%m-%dT%H:%M:%S} {lvl} api req_id={RNG.getrandbits(32):08x} "
                     f"path=/v1/specs/{RNG.randrange(100)} status={200 if lvl == 'INFO' else 500} ms={RNG.randrange(3, 900)}")
    write(p, "\n".join(lines) + "\n")

    p = record("profiling-data.09-18-2026.17-17-42.json", "Dev & Data", when=days_ago(11))
    write(p, json.dumps({"version": 5, "samples": [{"fn": f"render_{i % 17}", "self_ms": RNG.random() * 12,
                                                     "total_ms": RNG.random() * 40} for i in range(4000)]}))

    p = record("docker-compose.yml", "Dev & Data", when=days_ago(90), tags=["short-text"])
    write(p, "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: example\n"
             "  api:\n    build: .\n    ports: ['8080:8080']\n")

    p = record("README", "Dev & Data", when=days_ago(200), tags=["no-extension", "short-text"])
    write(p, "spec-indexer\n============\nRun `make ingest` to parse JEDEC PDFs into markdown pages.\n")

    p = record("notes.everything", "Dev & Data", when=days_ago(150), tags=["odd-extension"])
    write(p, "random scratch notes\n- try unpdf for extraction\n- ask about UCIe 2.0 section 10\n")

    p = record("Untitled.txt", "Junk / Review", when=days_ago(77), tags=["zero-bytes"])
    p.write_bytes(b"")

    # A small project directory: should move as one unit, not be flattened
    d = "acme-dashboard"
    record(d, "Dev & Data", when=days_ago(45), kind="dir", tags=["directory", "project"])
    for rel, body in {
        "package.json": json.dumps({"name": "acme-dashboard", "version": "0.1.0", "private": True,
                                    "scripts": {"dev": "vite"}, "dependencies": {"react": "^19.0.0"}}, indent=2),
        "README.md": "# acme-dashboard\n\nInternal metrics dashboard prototype.\n",
        "src/App.jsx": "export default function App() {\n  return <h1>Acme metrics</h1>;\n}\n",
        "src/main.jsx": "import { createRoot } from 'react-dom/client';\nimport App from './App';\n"
                        "createRoot(document.getElementById('root')).render(<App />);\n",
        "index.html": "<!doctype html><div id=root></div><script type=module src=/src/main.jsx></script>\n",
    }.items():
        f = ROOT / d / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        write(f, body)

    # Tool/SDK directory (like google-cloud-sdk)
    d = "gcloud-cli"
    record(d, "Installers", when=days_ago(420), kind="dir", tags=["directory", "sdk", "reclaimable"])
    # Distinct contents: files inside a directory aren't in the manifest, so identical ones
    # would be duplicates that duplicate_groups doesn't list.
    for rel, body in {"bin/gcloud": "#!/bin/sh\necho fake gcloud\n", "bin/gsutil": "#!/bin/sh\necho fake gsutil\n",
                      "lib/core/__init__.py": "__version__ = '0.0.0-fixture'\n", "VERSION": "0.0.0-fixture\n"}.items():
        f = ROOT / d / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        write(f, body)
    random_bytes(ROOT / d / "lib" / "bundle.bin", 3 * 1024 * 1024)

    # Zip + already-extracted folder with the same content
    d = "dataset-export-2026-08"
    record(d, "Dev & Data", when=days_ago(38), kind="dir", tags=["directory", "extracted-archive"])
    files = {"customers.csv": "id,company,plan\n" + "".join(f"{i},Company {i},pro\n" for i in range(200)),
             "orders.csv": "id,customer_id,total\n" + "".join(f"{i},{i % 200},{RNG.randrange(20, 900)}\n" for i in range(600)),
             "README.txt": "Export generated 2026-08-22 from staging.\n"}
    for name, body in files.items():
        write(ROOT / d / name, body)
    p = record(d + ".zip", "Archives", when=days_ago(38), tags=["already-extracted", "reclaimable"],
               note=f"same content as {d}/")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            z.writestr(f"{d}/{name}", body)

    p = record("project-assets.zip", "Archives", when=days_ago(130))
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(5):
            buf = io.BytesIO()
            Image.new("RGB", (256, 256), tuple(RNG.randrange(256) for _ in range(3))).save(buf, "PNG")
            z.writestr(f"assets/icon-{i}.png", buf.getvalue())

    p = record("photos-backup-2024.tar.gz", "Archives", when=days_ago(600))
    with tarfile.open(p, "w:gz") as t:
        for i in range(3):
            buf = io.BytesIO()
            Image.new("RGB", (640, 480), (RNG.randrange(256), 90, 140)).save(buf, "JPEG")
            info = tarfile.TarInfo(f"photos/IMG_00{i}.jpg"); info.size = buf.tell(); buf.seek(0)
            t.addfile(info, buf)

    # Nested "old downloads" folder for recursive-scan tests
    d = "old downloads"
    record(d, "Junk / Review", when=days_ago(700), kind="dir", tags=["directory", "nested"])
    p = ROOT / d / "invoice-1042.pdf"
    pdf(p, "Invoice 1042 - Northside Plumbing (draft)", ["Estimate only - not a bill"])
    MANIFEST.append({"path": f"{d}/invoice-1042.pdf", "kind": "file", "category": "Receipts & Shopping",
                     "sensitive": None, "tags": ["case-collision", "nested"], "origin": "generated",
                     "note": "differs from Invoice-1042.pdf", "_when": days_ago(720).isoformat()})
    shutil.copyfile(ROOT / "Resume - Alex Rivera.pdf", ROOT / d / "Resume - Alex Rivera.pdf")
    MANIFEST.append({"path": f"{d}/Resume - Alex Rivera.pdf", "kind": "file", "category": "Work / Hiring",
                     "sensitive": None, "tags": ["duplicate", "nested", "same-name-as-top-level"],
                     "origin": "generated", "duplicate_of": "Resume - Alex Rivera.pdf", "note": None,
                     "_when": days_ago(16).isoformat()})
    img = Image.new("RGB", (800, 600), (70, 130, 180))
    ImageDraw.Draw(img).ellipse([300, 200, 500, 400], fill=(255, 220, 120))
    save_jpg(ROOT / d / "IMG_0012.jpg", img, days_ago(710))
    MANIFEST.append({"path": f"{d}/IMG_0012.jpg", "kind": "file", "category": "Photos", "sensitive": None,
                     "tags": ["nested", "bad-name", "needs-vision"], "origin": "generated", "note": None,
                     "_when": days_ago(710).isoformat()})


def build_media_and_images():
    p = record("IMG_4830.jpg", "Photos", when=days_ago(29), tags=["bad-name", "needs-vision"],
               note="landscape photo (sunset over hills)")
    img = Image.new("RGB", (2016, 1512))
    d = ImageDraw.Draw(img)
    for y in range(1512):
        t = y / 1512
        d.line([(0, y), (2016, y)], fill=(int(250 - 120 * t), int(150 - 60 * t), int(90 + 80 * t)))
    d.ellipse([1300, 500, 1560, 760], fill=(255, 226, 150))
    d.polygon([(0, 1512), (0, 1000), (500, 760), (1000, 1050), (1500, 820), (2016, 1100), (2016, 1512)],
              fill=(40, 50, 70))
    save_jpg(p, img, days_ago(29))

    d = "Photos from Jane"
    record(d, "Photos", when=days_ago(52), kind="dir", tags=["directory"])
    for i, col in enumerate([(200, 80, 80), (80, 160, 90), (90, 110, 210)]):
        img = Image.new("RGB", (1200, 900), col)
        ImageDraw.Draw(img).text((80, 80), f"Picnic {i + 1}", fill="white", font=font(80))
        save_jpg(ROOT / d / f"IMG_77{i}1.jpg", img, days_ago(52))

    p = record("Gemini_Generated_Image_k3j2x9k3j2x9k3j2.png", "Images & Design", when=days_ago(60),
               tags=["ai-generated", "needs-vision"], note="abstract watercolor-style art")
    img = Image.new("RGB", (1024, 1024), (240, 236, 228))
    dd = ImageDraw.Draw(img)
    for _ in range(40):
        x, y, r = RNG.randrange(1024), RNG.randrange(1024), RNG.randrange(40, 200)
        dd.ellipse([x - r, y - r, x + r, y + r], fill=(RNG.randrange(120, 255), RNG.randrange(80, 200), RNG.randrange(120, 255)))
    img.save(p, "PNG")

    p = record("logo-final-final.svg", "Images & Design", when=days_ago(140), tags=["short-text"])
    write(p, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" '
             'fill="#e4572e"/><text x="32" y="40" font-size="24" text-anchor="middle" fill="#fff">A</text></svg>\n')

    p = record("synthesized-tone.wav", "Media", when=days_ago(200))
    tone_wav(p)
    p = record("Screen Recording 2026-09-02 at 3.14.00 PM.mov", "Media", when=days_ago(27),
               tags=["screen-recording"])
    if not ffmpeg(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", str(p)]):
        random_bytes(p, 2_000_000, b"\x00\x00\x00\x14ftypqt  ")
    p = record("Voice Memo 2026-08-30.m4a", "Media", when=days_ago(30))
    if not ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "aac", str(p)]):
        random_bytes(p, 60_000, b"\x00\x00\x00\x20ftypM4A ")


def build_installers():
    for name, mb, ago, head in [("Figma-2026.3.dmg", 90, 70, b"koly"), ("Obsidian-1.9.14.dmg", 12, 350, b"koly"),
                                ("Slack-4.41.dmg", 8, 200, b"koly"), ("Zoom.pkg", 5, 260, b"xar!"),
                                ("node-v22.23.2.pkg", 6, 110, b"xar!")]:
        p = record(name, "Installers", when=days_ago(ago), tags=["installer", "reclaimable"] +
                   (["over-64MiB-quick-hash"] if mb > 64 else []))
        random_bytes(p, mb * 1024 * 1024, head)
    # Over 64 MiB tidybot hashes only the ends, so these exercise its full-file verification:
    # a true duplicate pair, and a copy that differs only in the middle (not a duplicate).
    size = 70 * 1024 * 1024
    tags = ["over-64MiB-quick-hash", "sparse"]
    sparse_disk(record("dev-vm-disk.img", "Dev & Data", when=days_ago(95), tags=tags + ["duplicate"]), size)
    sparse_disk(record("dev-vm-disk copy.img", "Dev & Data", when=days_ago(94), tags=tags + ["duplicate"]), size)
    MANIFEST[-1]["duplicate_of"] = "dev-vm-disk.img"
    sparse_disk(record("dev-vm-disk-snapshot.img", "Dev & Data", when=days_ago(93),
                       tags=tags + ["same-sampled-hash-not-duplicate"], note="differs from dev-vm-disk.img mid-file"),
                size, middle=b"snapshot")
    p = record("ubuntu-24.04.1-desktop-amd64.iso.crdownload", "Junk / Review", when=days_ago(2),
               tags=["partial-download"])
    random_bytes(p, 4 * 1024 * 1024)
    p = record("video.mp4.part", "Junk / Review", when=days_ago(3), tags=["partial-download"])
    random_bytes(p, 1024 * 1024)


def build_sensitive():
    p = record("github-recovery-codes.txt", "Sensitive", when=days_ago(400), sensitive="secret", tags=["recovery-codes"])
    write(p, "\r\n".join(f"{RNG.getrandbits(20):05x}-{RNG.getrandbits(20):05x}" for _ in range(16)) + "\r\n")

    p = record("Carta backup codes.txt", "Sensitive", when=days_ago(900), sensitive="secret", tags=["recovery-codes"])
    write(p, "\n".join("".join(RNG.choice(string.ascii_lowercase + string.digits) for _ in range(8)) for _ in range(10)) + "\n")

    p = record("AWS accessKeys.csv", "Sensitive", when=days_ago(260), sensitive="secret", tags=["cloud-credentials"],
               note="uses AWS's documented example key pair")
    write(p, "Access key ID,Secret access key\nAKIAIOSFODNN7EXAMPLE,wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n")

    p = record("prod.env", "Sensitive", when=days_ago(20), sensitive="secret", tags=["dotenv"])
    write(p, "DATABASE_URL=postgres://app:" + fake_token("", 20) + "@db.internal.example:5432/app\n"
             "STRIPE_SECRET_KEY=" + fake_token("sk_" + "test_", 32) + "\n"
             "GITHUB_TOKEN=" + fake_token("gh" + "p_", 36) + "\n"
             "OPENAI_API_KEY=" + fake_token("sk-" + "proj-", 48) + "\n")

    p = record("client_secret_123456789012-abcdefghijklmnopqrstuv.apps.googleusercontent.com.json", "Sensitive",
               when=days_ago(190), sensitive="secret", tags=["oauth-client-secret", "long-name"])
    write(p, json.dumps({"installed": {"client_id": "123456789012-abcdefghijklmnopqrstuv.apps.googleusercontent.com",
                                       "project_id": "acme-fixture", "client_secret": fake_token("GOC" + "SPX-", 28),
                                       "redirect_uris": ["http://localhost"]}}))

    p = record("kubeconfig-staging.yaml", "Sensitive", when=days_ago(80), sensitive="secret", tags=["cluster-token"])
    write(p, "apiVersion: v1\nkind: Config\nclusters:\n- name: staging\n  cluster:\n    server: https://k8s.staging.example\n"
             "users:\n- name: ci\n  user:\n    token: "
             + fake_jwt({"iss": "kubernetes/serviceaccount", "sub": "system:serviceaccount:ci:deployer"}) + "\n")

    p = record("1Password Emergency Kit - John Doe.pdf", "Sensitive", when=days_ago(1100), sensitive="secret",
               tags=["password-manager"])
    key = "A3-" + "-".join("".join(RNG.choice(string.ascii_uppercase + string.digits) for _ in range(n)) for n in (6, 6, 5, 5, 5, 5))
    pdf(p, "1Password Emergency Kit (fake)", [
        "Created for John Doe on 10/03/2023", "SIGN-IN ADDRESS: https://my.1password.example",
        "EMAIL ADDRESS: john.doe@example.com", f"SECRET KEY: {key}", "MASTER PASSWORD: ____________________"])

    p = record("passwords.xlsx", "Sensitive", when=days_ago(700), sensitive="secret", tags=["password-list"])
    xlsx(p, {"Sheet1": [["Site", "Username", "Password"], ["bank", "jdoe88", fake_token("", 14)],
                        ["email", "john.doe@example.com", fake_token("", 12)], ["wifi", "DoeHome-5G", fake_token("", 10)]]})

    p = record("id_ed25519", "Sensitive", when=days_ago(500), sensitive="secret", tags=["private-key", "no-extension"],
               note="throwaway key generated for this fixture; not authorized anywhere")
    if shutil.which("ssh-keygen"):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "john@fixture", "-f", str(p)], check=True)
    else:
        write(p, "-----BEGIN OPENSSH PRIVATE KEY-----\n" + fake_token("", 280) + "\n-----END OPENSSH PRIVATE KEY-----\n")
        write(p.with_name("id_ed25519.pub"), "ssh-ed25519 " + fake_token("AAAAC3", 62) + " john@fixture\n")
    record("id_ed25519.pub", "Dev & Data", when=days_ago(500), tags=["public-key"], note="public half: not secret")

    words = ["orbit", "maple", "lunar", "copper", "violin", "harbor", "tiger", "velvet", "pencil", "glacier",
             "saddle", "ember", "quartz", "meadow", "rocket", "salt"]
    phrase = RNG.sample(words, 12)
    p = record("wallet-recovery-phrase.png", "Sensitive", when=days_ago(640), sensitive="secret",
               tags=["seed-phrase", "needs-vision"])
    text_image(["Recovery phrase - keep offline!", ""] + [f"{i + 1:2d}. {w}" for i, w in enumerate(phrase)],
               size=(900, 1100), fsize=38).save(p, "PNG")

    p = record("Screenshot 2026-09-20 at 4.02.11 PM.png", "Sensitive", when=days_ago(9), sensitive="secret",
               tags=["screenshot", "recovery-codes", "needs-vision"], note="screenshot of 2FA backup codes")
    codes = [f"{RNG.randrange(10**7, 10**8)}" for _ in range(10)]
    text_image(["Save your backup codes", "Each code can be used once.", ""] +
               [f"{codes[i]}    {codes[i + 1]}" for i in range(0, 10, 2)],
               size=(1200, 820), bg=(250, 250, 252), fg=(30, 30, 30), fsize=40, mono=True).save(p, "PNG")


# ---------------------------------------------------------------- real, non-personal files

REAL = [  # (source name in real Downloads, category, tags)
    ("ARM_AMBA3_APB.pdf", "Work / Specs", ["real-world-pdf"]),
    ("ddr5_sdram_core.pdf", "Work / Specs", ["real-world-pdf", "large-pdf"]),
    ("micron.pdf", "Work / Specs", ["real-world-pdf", "384-pages"]),
    ("RL Book 2020.pdf", "Reading", ["real-world-pdf", "over-64MiB-quick-hash", "548-pages"]),
    ("Context_As_Currency.pdf", "Reading", ["real-world-pdf"]),
    ("billionaires_page.pdf", "Reading", ["real-world-pdf"]),
    ("nvidia_earnings_Q2.pdf", "Reading", ["real-world-pdf"]),
    ("nvidia_earnings_Q2.mmd", "Reading", ["odd-extension", "text-sniff"]),
    ("Spider Web Maze.pdf", "Kids & School", ["real-world-pdf"]),
    ("Rainbow Maze.pdf", "Kids & School", ["real-world-pdf"]),
    ("Hard Mazes Set 3 Tough.pdf", "Kids & School", ["real-world-pdf"]),
    ("OTP_Install_IOS_Eng.pdf", "Work / Projects", ["real-world-pdf"]),
    ("Example COI Template.pdf", "Work / Projects", ["real-world-pdf", "form-template"]),
    ("SuperDoc - Terms of Service.pdf", "Reading", ["real-world-pdf"]),
    ("swe-bench-dev.json", "Dev & Data", ["large-json"]),
    ("accord125_schema.json", "Dev & Data", []),
    ("example deal CRM schema.csv", "Dev & Data", ["short-text"]),
    ("table-with-abnormal-column-head.jpg.xlsx", "Dev & Data", ["double-extension"]),
    ("guided_gpt.py", "Dev & Data", ["code"]),
    ("Self-Care Bingo Card.html", "Reading", ["html"]),
    ("Mount Fuji icon.eps", "Images & Design", ["eps"]),
    ("Page Texture 1199x1799.png", "Images & Design", ["same-image-two-formats", "needs-vision"]),
    ("Page Texture 1199x1799.webp", "Images & Design", ["same-image-two-formats", "needs-vision"]),
    ("Chrome Web Store Icon.png", "Images & Design", ["needs-vision"]),
    ("synthesis.wav", "Media", []),
    ("ElevenLabs_2024-04-09T18_37_04_Jeremy.mp3", "Media", []),
    ("FujiWebCompressed.mp4", "Media", ["video"]),
    ("Autotab Mac Installer.zip", "Installers", ["installer-in-zip", "reclaimable"]),
]


def copy_real(src_dir: Path) -> list[str]:
    missing = []
    for name, cat, tags in REAL:
        src = src_dir / name
        if not src.is_file():
            missing.append(name); continue
        when = datetime.fromtimestamp(src.stat().st_mtime)
        dst = record(name, cat, when=when, tags=tags, origin="copied")
        shutil.copyfile(src, dst)
    return missing


# ---------------------------------------------------------------- main

def finalize(manifest_path: Path) -> None:
    for m in MANIFEST:
        p = ROOT / m["path"]
        when = datetime.fromisoformat(m.pop("_when"))
        # "recent" follows from the date, so the tag can't drift from what --older-than 14d skips.
        # Generated dates stay a day clear of the cutoff so a test run soon after still agrees.
        age = NOW - when
        if m["origin"] == "generated" and abs(age - RECENT) < timedelta(days=1):
            sys.exit(f"{m['path']} is dated too close to the {RECENT.days}-day cutoff")
        m["tags"] = [t for t in m["tags"] if t != "recent"] + (["recent"] if age < RECENT else [])
        ts = when.timestamp()
        if p.is_dir():
            for sub in p.rglob("*"):
                os.utime(sub, (ts, ts))
        if p.exists():
            os.utime(p, (ts, ts))
            if p.is_file():
                m["size"] = p.stat().st_size
                m["sha256"] = sha256_file(p)
        m["modified"] = datetime.fromtimestamp(ts).isoformat(timespec="seconds")
        m.setdefault("duplicate_of", None)

    # Hidden macOS cruft (tidybot should skip these)
    (ROOT / ".DS_Store").write_bytes(b"\x00\x00\x00\x01Bud1" + bytes(2000))
    (ROOT / ".localized").write_bytes(b"")
    # Symlink: listing should not follow or move it blindly
    try:
        (ROOT / "latest-itinerary.pdf").symlink_to("Trip itinerary 3392797414 Oct 12, 2026.pdf")
        MANIFEST.append({"path": "latest-itinerary.pdf", "kind": "symlink", "category": None, "sensitive": None,
                         "tags": ["symlink"], "origin": "generated", "duplicate_of": None,
                         "note": "symlink to the itinerary", "modified": None})
    except OSError:
        pass

    top = sorted({m["path"].split("/")[0] for m in MANIFEST})
    summary = {
        "generated_at": NOW.isoformat(timespec="seconds"),
        "root": str(ROOT),
        "top_level_items": len(top),
        "files": sum(1 for m in MANIFEST if m["kind"] == "file"),
        "categories": sorted({m["category"] for m in MANIFEST if m["category"]}),
        "sensitive": {"secret": [m["path"] for m in MANIFEST if m["sensitive"] == "secret"],
                      "pii": [m["path"] for m in MANIFEST if m["sensitive"] == "pii"]},
        "duplicate_groups": _dupe_groups(),
        "recent_within_14_days": [m["path"] for m in MANIFEST if "recent" in m["tags"]],
        "hidden_files": [".DS_Store", ".localized", MARKER],
    }
    manifest_path.write_text(json.dumps({"summary": summary, "items": MANIFEST}, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")


def _dupe_groups() -> list[list[str]]:
    by: dict[str, list[str]] = {}
    for m in MANIFEST:
        if m.get("sha256"):
            by.setdefault(m["sha256"], []).append(m["path"])
    return [g for g in by.values() if len(g) > 1]


def main() -> None:
    global ROOT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", type=Path, help="folder to fill, e.g. ~/Downloads-test")
    ap.add_argument("--real-from", type=Path, help="copy public, non-personal sample files from this folder")
    ap.add_argument("--manifest", type=Path, default=Path(__file__).with_name("downloads-test.manifest.json"))
    ap.add_argument("--force", action="store_true", help="wipe and rebuild a folder this script created before")
    a = ap.parse_args()
    ROOT = a.target.expanduser().resolve()

    if ROOT.exists() and any(ROOT.iterdir()):
        if not a.force:
            sys.exit(f"{ROOT} is not empty. Use --force to rebuild a fixture folder.")
        if not (ROOT / MARKER).exists():
            sys.exit(f"Refusing to wipe {ROOT}: it has no {MARKER} marker, so it wasn't made by this script.")
        for child in ROOT.iterdir():
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / MARKER).write_text("created by tidybot test/e2e/make_downloads_test.py\n")

    for build in [build_finance, build_home, build_health, build_immigration, build_kids, build_work,
                  build_travel, build_receipts, build_reading, build_dev, build_media_and_images,
                  build_installers, build_sensitive]:
        build()
    missing = copy_real(a.real_from.expanduser()) if a.real_from else []
    finalize(a.manifest.expanduser())

    s = json.loads(a.manifest.expanduser().read_text())["summary"]
    print(f"Built {ROOT}: {s['top_level_items']} top-level items, {s['files']} files")
    print(f"  secrets: {len(s['sensitive']['secret'])}, pii: {len(s['sensitive']['pii'])}, "
          f"duplicate groups: {len(s['duplicate_groups'])}")
    print(f"  manifest: {a.manifest}")
    if missing:
        print(f"  skipped {len(missing)} real files not found: {', '.join(missing)}")


if __name__ == "__main__":
    main()
