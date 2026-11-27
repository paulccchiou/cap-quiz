"""Parse 115-111 CAP (國中教育會考) 5 subjects (choice questions only) into:
  - src/CapQuiz/wwwroot/data/questions.json
  - src/CapQuiz/wwwroot/data/explanations_zh.json
  - src/CapQuiz/wwwroot/images/q{id}.png
  - src/CapQuiz/wwwroot/images/p_{year}_{subj}_{start}_{end}.png (shared group passage images)

Run from repo root or build/:
  python build/parse_cap_pdfs.py
"""
from __future__ import annotations

import io
import json
import re
import unicodedata
from pathlib import Path
from PIL import Image
import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "pdf" / "cap"
WWWROOT = ROOT / "src" / "CapQuiz" / "wwwroot"
DATA_DIR = WWWROOT / "data"
IMG_DIR = WWWROOT / "images"

YEARS = [115, 114, 113, 112, 111]
SUBJECTS = ["chinese", "english", "math", "social", "science"]

SUBJ_LABELS = {
    "chinese": "國文",
    "english": "英文",
    "math": "數學",
    "social": "社會",
    "science": "自然",
}

PUA_MAP = {
    "\uf02b": "+", "\uf02d": "-", "\uf03d": "=", "\uf03c": "<", "\uf03e": ">",
    "\uf0a3": "≤", "\uf0b3": "≥", "\uf0b9": "≠", "\uf0b1": "±", "\uf0b4": "×",
    "\uf0b8": "÷", "\uf0bb": "≈", "\uf0ae": "→", "\uf0ab": "↔", "\uf0d0": "∠",
    "\uf044": "△", "\uf05f": "_", "\uf06d": "μ", "\uf073": "σ", "\uf070": "π",
    "\uf067": "γ", "\uf071": "θ", "\uf061": "α", "\uf062": "β", "\uf06c": "λ",
    "\uf053": "Σ", "\uf0b0": "°", "\uf0d7": "·", "\uf020": " ",
}

def clean_text(s: str) -> str:
    for k, v in PUA_MAP.items():
        s = s.replace(k, v)
    s = re.sub(r"[\ue000-\uf8ff]", "", s)
    # Replace thin/em spaces around punctuation with normal space
    s = s.replace("\u2006", " ").replace("\u2005", " ").replace("\u2004", " ").replace("\u2009", " ").replace("\u00a0", " ")
    # Normalize doubled mathematical italic letters from Word->PDF math exports (e.g. 𝑥𝑥 -> x)
    def _norm_math(m):
        ch = unicodedata.normalize("NFKC", m.group(1))
        return ch
    s = re.sub(r"([\U0001D400-\U0001D7FF])\1", _norm_math, s)
    s = re.sub(r"([\U0001D400-\U0001D7FF])", _norm_math, s)
    return s


# ===== 1. Parse Official Answer PDFs =====
def parse_cap_ans_pdf(ans_pdf: Path) -> dict[str, dict[int, str]]:
    """Parse 2-page official CAP answer table. Returns subject -> {qno: 'A'|'B'|'C'|'D'}."""
    doc = fitz.open(ans_pdf)
    result: dict[str, dict[int, str]] = {s: {} for s in SUBJECTS}

    for page in doc:
        d = page.get_text("dict")
        # Find column x-centers from header labels on this page
        col_x: dict[str, float] = {}
        items: list[tuple[float, float, str]] = []
        for b in d["blocks"]:
            if b.get("type", 0) != 0:
                continue
            for l in b["lines"]:
                txt = "".join(sp["text"] for sp in l["spans"]).strip()
                if not txt:
                    continue
                x0, y0, x1, y1 = l["bbox"]
                xc = (x0 + x1) / 2.0
                if y0 < 170:
                    if txt == "國文": col_x["chinese"] = xc
                    elif txt == "閱讀": col_x["english"] = xc
                    elif txt == "聽力": col_x["listening"] = xc
                    elif txt == "數學": col_x["math"] = xc
                    elif txt == "社會": col_x["social"] = xc
                    elif txt == "自然": col_x["science"] = xc
                else:
                    items.append((y0, xc, txt))

        # Group items by row (y within 6pt)
        items.sort(key=lambda t: (t[0], t[1]))
        rows: list[list[tuple[float, float, str]]] = []
        for it in items:
            if not rows or abs(it[0] - rows[-1][0][0]) > 6.5:
                rows.append([it])
            else:
                rows[-1].append(it)

        for row in rows:
            row.sort(key=lambda t: t[1])
            qno = None
            for y0, xc, txt in row:
                if xc < 120 and re.match(r"^\d{1,2}$", txt):
                    qno = int(txt)
                    break
            if qno is None:
                continue
            for y0, xc, txt in row:
                if xc < 120:
                    continue
                val = txt.strip()
                if not re.match(r"^[A-D](?:[、,或/][A-D])*$|^送分$", val):
                    continue
                # Find nearest column
                best_col = min(col_x.keys(), key=lambda c: abs(col_x[c] - xc))
                if best_col in result:
                    result[best_col][qno] = val

    return result


# ===== 2. Crop Helper =====
def crop_region_to_png(
    doc: fitz.Document,
    start_page: int,
    start_y: float,
    end_page: int,
    end_y: float,
    out_path: Path,
    zoom: float = 1.6,
) -> None:
    if out_path.exists() and out_path.stat().st_size > 1000:
        return
    mat = fitz.Matrix(zoom, zoom)
    imgs: list[Image.Image] = []
    for p in range(start_page, end_page + 1):
        page = doc[p]
        rect = page.rect
        y0 = max(48.0, start_y - 8.0) if p == start_page else 48.0
        y1 = min(rect.height - 52.0, end_y - 4.0) if p == end_page else (rect.height - 52.0)
        if y1 <= y0 + 12:
            continue
        clip = fitz.Rect(36.0, y0, rect.width - 36.0, y1)
        pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
        imgs.append(Image.open(io.BytesIO(pix.tobytes("png"))))

    if not imgs:
        pix = doc[start_page].get_pixmap(matrix=mat, alpha=False)
        Image.open(io.BytesIO(pix.tobytes("png"))).save(out_path, optimize=True)
        return

    if len(imgs) == 1:
        imgs[0].save(out_path, optimize=True)
    else:
        total_w = max(im.width for im in imgs)
        total_h = sum(im.height for im in imgs) + 6 * (len(imgs) - 1)
        canvas = Image.new("RGB", (total_w, total_h), (255, 255, 255))
        cur_y = 0
        for im in imgs:
            canvas.paste(im, (0, cur_y))
            cur_y += im.height + 6
        canvas.save(out_path, optimize=True)


# ===== 3. Parse Question PDFs =====
GROUP_RE_LIST = [
    re.compile(r"(?:請閱讀|閱讀).{0,25}?第\s*(\d{1,2})\s*[～~\-－–至到]\s*(\d{1,2})\s*題"),
    re.compile(r"第\s*(\d{1,2})\s*[～~\-－–至到]\s*(\d{1,2})\s*題為題組"),
    re.compile(r"回答第?\s*(\d{1,2})\s*[～~\-－–至到]\s*(\d{1,2})\s*題"),
    re.compile(r"^\(\s*(\d{1,2})\s*[-–－~～]\s*(\d{1,2})\s*\)$"),
    re.compile(r"questions?\s*(\d{1,2})\s*(?:to|[-–~])\s*(\d{1,2})", re.I),
]

STOP_RE = re.compile(r"^(第二部分[：:]\s*非選擇題|試題結束)")
NOISE_LINE_RE = re.compile(r"^(請翻頁繼續作答|背面尚有試題|-\s*\d+\s*-|\d{1,2})$")


def detect_group_header(txt: str, next_q: int, max_q: int) -> tuple[int, int] | None:
    for rx in GROUP_RE_LIST:
        m = rx.search(txt)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a == next_q and a < b <= max_q:
                return (a, b)
    return None


def parse_options_from_lines(q_lines: list[str]) -> tuple[str, dict[str, str]]:
    """Split question text into stem and {A, B, C, D} options."""
    full = "\n".join(q_lines)
    # Find all (A)..(D) markers
    opt_pat = re.compile(r"\(\s*([A-D])\s*\)")
    matches = list(opt_pat.finditer(full))
    if not matches:
        return full.strip(), {k: "（請見原卷截圖）" for k in ("A", "B", "C", "D")}

    # Find the last sequence starting with A (to avoid "(A)" mentioned inside stem text)
    start_idx = None
    for idx in range(len(matches) - 1, -1, -1):
        if matches[idx].group(1) == "A":
            # Check if B, C, D appear after it
            letters_after = [m.group(1) for m in matches[idx:]]
            if "B" in letters_after and "C" in letters_after and "D" in letters_after:
                start_idx = idx
                break
    if start_idx is None:
        # Fallback: first A
        for idx, m in enumerate(matches):
            if m.group(1) == "A":
                start_idx = idx
                break
    if start_idx is None:
        return full.strip(), {k: "（請見原卷截圖）" for k in ("A", "B", "C", "D")}

    opt_matches = matches[start_idx:]
    # Keep first occurrence of A, B, C, D in order
    picked: list[tuple[str, int, int]] = []
    want = ["A", "B", "C", "D"]
    wi = 0
    for m in opt_matches:
        if wi < 4 and m.group(1) == want[wi]:
            picked.append((m.group(1), m.start(), m.end()))
            wi += 1

    stem = full[:picked[0][1]].strip()
    options: dict[str, str] = {}
    for i, (letter, s_pos, e_pos) in enumerate(picked):
        nxt_pos = picked[i + 1][1] if i + 1 < len(picked) else len(full)
        val = full[e_pos:nxt_pos].strip()
        # Clean internal newlines within option
        val = re.sub(r"\s*\n\s*", " ", val).strip()
        options[letter] = val if val else "（請見原卷截圖）"
    for k in ("A", "B", "C", "D"):
        if k not in options:
            options[k] = "（請見原卷截圖）"
    return stem, options


def parse_subject_pdf(
    year: int,
    subj: str,
    pdf_path: Path,
    ans_map: dict[int, str],
    start_id: int,
) -> list[dict]:
    doc = fitz.open(pdf_path)
    max_q = max(ans_map.keys())
    source_key = f"cap{year}-{subj}"

    # Collect lines (page_idx, y0, y1, x0, text)
    lines: list[tuple[int, float, float, float, str]] = []
    stopped = False
    for pi, page in enumerate(doc):
        if pi == 0:
            continue
        if stopped:
            break
        rect = page.rect
        d = page.get_text("dict")
        page_items = []
        for b in d["blocks"]:
            if b.get("type", 0) != 0:
                continue
            for l in b["lines"]:
                raw = "".join(sp["text"] for sp in l["spans"])
                txt = clean_text(raw).strip()
                if not txt:
                    continue
                x0, y0, x1, y1 = l["bbox"]
                if y0 < 52 or y0 > rect.height - 55:
                    continue
                if NOISE_LINE_RE.match(txt):
                    continue
                page_items.append((y0, y1, x0, txt))
        page_items.sort(key=lambda t: (round(t[0] / 3.5) * 3.5, t[2]))
        for y0, y1, x0, txt in page_items:
            if STOP_RE.search(txt):
                lines.append((pi, y0, y1, x0, "__STOP__"))
                stopped = True
                break
            lines.append((pi, y0, y1, x0, txt))

    # Locate question starts sequentially 1..max_q and group passage starts
    q_starts: dict[int, int] = {}      # qno -> index in lines
    group_starts: list[tuple[int, int, int]] = []  # (line_idx, g_start, g_end)
    next_q = 1
    current_group_end = 0

    for idx, (pi, y0, y1, x0, txt) in enumerate(lines):
        if txt == "__STOP__":
            break
        if next_q > max_q:
            break
        # Check group header
        gh = detect_group_header(txt, next_q, max_q)
        if gh and (not group_starts or group_starts[-1][1] != gh[0]):
            group_starts.append((idx, gh[0], gh[1]))
            current_group_end = gh[1]

        # Check question number start on left margin
        m = re.match(rf"^{next_q}\s*[\.．](?:\s+(.*))?$", txt)
        if m and x0 < 240:
            q_starts[next_q] = idx
            next_q += 1

    # Map each group to its passage text and passage image
    group_info: dict[int, tuple[str, str]] = {}  # qno -> (passage_text, passage_img_rel)
    for g_idx, g_start, g_end in group_starts:
        if g_start not in q_starts:
            continue
        q1_idx = q_starts[g_start]
        if q1_idx <= g_idx:
            continue
        p_lines = [lines[i][4] for i in range(g_idx, q1_idx) if lines[i][4] != "__STOP__"]
        passage_text = "\n".join(p_lines).strip()
        p_start_page, p_start_y = lines[g_idx][0], lines[g_idx][1]
        p_end_page, p_end_y = lines[q1_idx][0], lines[q1_idx][1]
        img_name = f"p_{year}_{subj}_{g_start}_{g_end}.png"
        crop_region_to_png(doc, p_start_page, p_start_y, p_end_page, p_end_y, IMG_DIR / img_name)
        for qn in range(g_start, g_end + 1):
            group_info[qn] = (passage_text, f"images/{img_name}")

    # Find stop index
    stop_idx = len(lines)
    for idx, it in enumerate(lines):
        if it[4] == "__STOP__":
            stop_idx = idx
            break

    # Map group start indices so previous question doesn't bleed into next group's passage
    g_start_by_q: dict[int, int] = {gs: gi for gi, gs, ge in group_starts}

    records: list[dict] = []
    cur_id = start_id
    for qno in range(1, max_q + 1):
        raw_ans = ans_map[qno]
        if raw_ans == "送分":
            ans_list = ["A", "B", "C", "D"]
        else:
            ans_list = re.findall(r"[A-D]", raw_ans)

        passage_text, passage_img = group_info.get(qno, ("", ""))

        if qno not in q_starts:
            records.append({
                "id": cur_id,
                "year": year,
                "subject": subj,
                "source": source_key,
                "srcNo": str(qno),
                "type": "single",
                "category": f"{year} {SUBJ_LABELS[subj]}",
                "passage": passage_text,
                "passageImage": passage_img,
                "question": f"第 {qno} 題（請見原卷截圖）",
                "options": {k: "（請見原卷截圖）" for k in ("A", "B", "C", "D")},
                "answer": ans_list,
                "image": None,
            })
            cur_id += 1
            continue

        s_idx = q_starts[qno]
        # End index is next question start or next group start or stop_idx
        e_idx = stop_idx
        if (qno + 1) in g_start_by_q and g_start_by_q[qno + 1] > s_idx:
            e_idx = g_start_by_q[qno + 1]
        elif (qno + 1) in q_starts and q_starts[qno + 1] > s_idx:
            e_idx = q_starts[qno + 1]
        else:
            # Find next existing q_start > qno
            for fq in range(qno + 1, max_q + 1):
                if fq in g_start_by_q and g_start_by_q[fq] > s_idx:
                    e_idx = g_start_by_q[fq]
                    break
                if fq in q_starts and q_starts[fq] > s_idx:
                    e_idx = q_starts[fq]
                    break

        # Extract question text lines
        raw_qlines = []
        for i in range(s_idx, e_idx):
            t = lines[i][4]
            if t == "__STOP__":
                break
            if i == s_idx:
                t = re.sub(rf"^{qno}\s*[\.．]\s*", "", t)
            if t:
                raw_qlines.append(t)

        stem, options = parse_options_from_lines(raw_qlines)
        if not stem:
            stem = f"第 {qno} 題（請見原卷截圖）"

        # Crop question image
        sp, sy = lines[s_idx][0], lines[s_idx][1]
        if e_idx < len(lines):
            ep, ey = lines[e_idx][0], lines[e_idx][1]
            # If e_idx is on next page at top, use end of previous line's page
            if ep > sp and e_idx > s_idx and lines[e_idx - 1][0] < ep:
                ep = lines[e_idx - 1][0]
                ey = lines[e_idx - 1][2] + 18.0
        else:
            last_i = max(s_idx, e_idx - 1)
            ep, ey = lines[last_i][0], lines[last_i][2] + 18.0

        img_name = f"q{cur_id}.png"
        crop_region_to_png(doc, sp, sy, ep, ey, IMG_DIR / img_name)

        records.append({
            "id": cur_id,
            "year": year,
            "subject": subj,
            "source": source_key,
            "srcNo": str(qno),
            "type": "single",
            "category": f"{year} {SUBJ_LABELS[subj]}" + (" · 題組" if passage_text else ""),
            "passage": passage_text,
            "passageImage": passage_img,
            "question": stem,
            "options": options,
            "answer": ans_list,
            "image": f"images/{img_name}",
        })
        cur_id += 1

    doc.close()
    return records


# ===== 4. Parse Explanation PDFs =====
EXP_NOISE_RE = re.compile(
    r"^(甄戰一點通|未來學校學會|版權所有|All Rights Reserved|\d{3}年會考.*詳解|選擇題部分[：:]?|題號|參考|答案|解析|詳解|-\s*\d+\s*-)$"
)

def parse_exp_pdf(exp_pdf: Path, max_q: int) -> dict[int, str]:
    """Extract per-question explanation text from a text-based explanation PDF."""
    doc = fitz.open(exp_pdf)
    full_lines: list[str] = []
    for page in doc:
        for line in page.get_text("text").splitlines():
            t = clean_text(line).strip()
            if not t:
                continue
            if "甄戰一點通" in t or "All Rights Reserved" in t or "未來學校學會" in t:
                continue
            if re.match(r"^\d{3}年會考[\(（].*詳解[\)）]$", t):
                continue
            if "非選擇題" in t and len(t) < 20:
                # Stop before math non-choice explanations
                full_lines.append("__STOP__")
                break
            full_lines.append(t)
        if full_lines and full_lines[-1] == "__STOP__":
            break
    doc.close()

    total_chars = sum(len(l) for l in full_lines if l != "__STOP__")
    if total_chars < 1000:
        # Image-only PDF (e.g., 114-math, 113-english, 113-math)
        return {}

    # Detect whether this is a table-style PDF (like 115-science / 113-science: standalone "1" then "A")
    # vs numbered-dot style ("1. ..." or "1.(A)")
    is_table_style = False
    for i in range(min(20, len(full_lines) - 1)):
        if full_lines[i] == "1" and re.match(r"^[A-D]$", full_lines[i + 1]):
            is_table_style = True
            break

    exps: dict[int, list[str]] = {}
    cur_q: int | None = None
    next_q = 1

    i = 0
    while i < len(full_lines):
        line = full_lines[i]
        if line == "__STOP__":
            break

        matched_q = False
        if is_table_style:
            if line == str(next_q) and i + 1 < len(full_lines) and re.match(r"^[A-D](?:[、,][A-D])?$", full_lines[i + 1]):
                cur_q = next_q
                next_q += 1
                exps[cur_q] = []
                i += 2  # skip qno and answer letter
                continue
        else:
            # Match any qno 1..max_q with strong header (handles out-of-order PDF blocks like 18 before 17)
            m_any = re.match(r"^(\d{1,2})\s*[\.．]\s*(.*)$", line)
            if m_any:
                cand = int(m_any.group(1))
                rest = m_any.group(2).strip()
                is_strong = (
                    re.match(r"^(?:參考答案|參考解答|答案|[\(（][A-D][\)）])", rest) is not None
                    or (rest == "" and cand == next_q)
                    or (re.match(r"^[A-D](?:\s|$)", rest) is not None and cand <= max_q)
                )
                if 1 <= cand <= max_q and (is_strong or (cand == next_q and cur_q is None)):
                    # Avoid overwriting an already-parsed question unless it's empty
                    if cand not in exps or not exps[cand]:
                        cur_q = cand
                        if cand >= next_q:
                            next_q = cand + 1
                        exps[cur_q] = []
                        rest_clean = re.sub(r"^(?:參考答案|參考解答|答案)[：:\s]*[\(（]?[A-D][\)）]?\s*", "", rest)
                        rest_clean = re.sub(r"^[\(（][A-D][\)）]\s*", "", rest_clean)
                        if rest_clean and not re.match(r"^[A-D]$", rest_clean):
                            exps[cur_q].append(rest_clean)
                        i += 1
                        continue

        if cur_q is not None:
            # Skip standalone page numbers
            if re.match(r"^\d{1,2}$", line) and int(line) <= 20:
                i += 1
                continue
            # Skip redundant "參考答案：B" lines
            if re.match(r"^(?:參考答案|答案)[：:\s]*[\(（]?[A-D][\)）]?$", line):
                i += 1
                continue
            exps[cur_q].append(line)
        i += 1

    out: dict[int, str] = {}
    for qno, parts in exps.items():
        if qno > max_q:
            continue
        text = "\n".join(parts).strip()
        if text:
            out[qno] = text
    return out


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMG_DIR.mkdir(parents=True, exist_ok=True)

    all_questions: list[dict] = []
    all_explanations: dict[str, dict] = {}
    next_id = 1
    missing_exp_count = 0

    for year in YEARS:
        ans_pdf = PDF_DIR / str(year) / f"{year}-ans.pdf"
        ans_all = parse_cap_ans_pdf(ans_pdf)
        print(f"\n=== {year} 年 ===")
        for subj in SUBJECTS:
            ans_map = ans_all[subj]
            q_pdf = PDF_DIR / str(year) / f"{year}-{subj}-q.pdf"
            exp_pdf = PDF_DIR / str(year) / f"{year}-{subj}-exp.pdf"

            recs = parse_subject_pdf(year, subj, q_pdf, ans_map, next_id)
            exps = parse_exp_pdf(exp_pdf, max(ans_map.keys()))

            got_exp = 0
            for r in recs:
                qno = int(r["srcNo"])
                if qno in exps:
                    all_explanations[str(r["id"])] = {"explanation_zh": exps[qno]}
                    got_exp += 1
                else:
                    missing_exp_count += 1

            all_questions.extend(recs)
            next_id += len(recs)
            no_img = sum(1 for r in recs if not r["image"])
            print(f"  {year}-{subj:7s}: {len(recs):2d} 題 | 詳解 {got_exp:2d}/{len(recs):2d} | 缺圖 {no_img}")

    (DATA_DIR / "questions.json").write_text(
        json.dumps(all_questions, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_DIR / "explanations_zh.json").write_text(
        json.dumps(all_explanations, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nTOTAL: {len(all_questions)} questions, {len(all_explanations)} explanations ({missing_exp_count} missing).")


if __name__ == "__main__":
    main()
