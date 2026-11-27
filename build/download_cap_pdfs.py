"""Download 115-111 CAP (國中教育會考) question, answer, and explanation PDFs from reallygood.com.tw Google Drive links."""
import os
import re
import time
import urllib.request
import http.cookiejar
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "pdf" / "cap"

# Extracted from https://www.reallygood.com.tw/newExam/inside?str=F7229F6ADD9F230A5FB41A782B73F2A0
FILES = {
    115: {
        "ans_all": "1fxfOLQPMdCEMSuziD1qsQZg3vVOGt8df",
        "chinese": {"q": "1FQtq4_a4GTsTKURdzPhDkKmONKRXtTJ9", "exp": "1QVP7-AFAQSNrxdEsLGPCIKuAwBlE3kzI"},
        "english": {"q": "1pzRZpkZEBg4x7GNTAIrdfGJCxNSKgok-", "exp": "1gf3ypybVtnbXyAtDvh0oeojMI_8aNhvA"},
        "math":    {"q": "1G-grfVw1NldMD3TRG-7Lco-yOuaoTKoK", "exp": "1wZoopGbr2YvFP8ck4ZYzwK7Fox8w2Clr"},
        "social":  {"q": "1ITxBlFhNSIbg1u1C7FrU2ODk951wt-RT", "exp": "1ObUkM3ghB_wu8Dw36S8vhLJfUEOMln-I"},
        "science": {"q": "1ZJNPG9Wz3zuI8UkPGUY50URejxxZYmQ8", "exp": "1d-bHHKgn8eukVSQ6MyXbQq6bglRVpRYE"},
    },
    114: {
        "chinese": {"q": "102j8F3hoCvGgMCVP6x6oHN9cCd0R6_Ii", "exp": "1pDKrfkhtVkg7GY9-0JAaM6bOXvxlC10q"},
        "english": {"q": "1nV4sFP26Ad31T6cs2ev2cj7Yd_bkXhAk", "exp": "1RxS6qgm35J3xPt4QUIswfn_3JfmpAGdv"},
        "math":    {"q": "1Tddv1P9Tp8wsbl9UK_mxNWM8VaEpNmLq", "exp": "18uom381UKJs34cBDaMPRJJftUfIwRtCw"},
        "social":  {"q": "1lOdE9WpQLTgQ-CmaB4edX_x4-PNHW3dg", "exp": "1EWw23BwcG0aP5GX35KJRQ6LE48_mb4H7"},
        "science": {"q": "14gflSo4XL9MUytR3TcbMzY8gMfTBsYjS", "exp": "1mq9tgaytkic1MAwx9b3oceyqitT1VB9h"},
    },
    113: {
        "chinese": {"q": "1JYe-eRqRSHVZvn38xBO_z7qUqZLiR-TA", "exp": "1Llg5IgXeOdjhXBAh4GCzTO4YBm03BYsX"},
        "english": {"q": "1Z6txf5kvAVdqjG2REb83TPmh-XcHg0VM", "exp": "1bTYv4Zg6mpPMbdsQ8yuAn4XijPLAWGQf"},
        "math":    {"q": "1XPAp6v35pNX2eI6Nl0JVxlvwdlR-ww9u", "exp": "1k9XH48pr9vg5h9pY-tWn4OtdVBn-s25m"},
        "social":  {"q": "1HY_Crk3t_lzx-9wWHkS71imtsZAG6mJA", "exp": "118-nN2zlLpa8h8-MwxwdMzj7nme-E6ML"},
        "science": {"q": "1vFlldo3WYc_SZTwtl_RXHnGkihpv3c3t", "exp": "1WTF-LlUxvBo81JLAxPgQ8vLcmxo3_B52"},
    },
    112: {
        "chinese": {"q": "1f8gStyUMtfS9QtgulnJqA6m3xG6IUeO_", "exp": "1dxpLuVA8X-9wMv5iK_K2c8AmfZ0Pgz9D"},
        "english": {"q": "1X7o394z-QGumgzyrxC5FM2IBblNWmnyc", "exp": "1SDTOVNmX3UqJIXiRZiKxh7Pl9f0me5Fg"},
        "math":    {"q": "1AQrpE446qb3DfNg7l122G0CXftdXl1Sq", "exp": "1oO4j39xfMMracV5jT4HNmXTsZEpW7XGU"},
        "social":  {"q": "14iOkc9qnnnq75U6XozIaRVnWQiERS6Np", "exp": "1QSjEnBstAA2fCZ7u9wdICHw7FvhgywkB"},
        "science": {"q": "19H-HjK_MD99yADNiqiWHa_hwgtxBUuPm", "exp": "1jcAH0HTMyvSH9QXSyANq6upNuU-AdGBh"},
    },
    111: {
        "chinese": {"q": "1jKLX5hzJXG0GnGYudOuHA8G8H7eRx5BB", "exp": "1qGmjBWSxQcjRqGZIlXMiAbL2eiShu8HI"},
        "english": {"q": "1P8-M94FUR47EfSC0vk3hTn87OloyLoGW", "exp": "1RhT8r6WawHhklc_PImjX2kRj3eff_lmJ"},
        "math":    {"q": "1gUrUTelecxBONhFYJ4KYMPe_157b941A", "exp": "1Yh1fJPQNdZdvZqQsdYPzexpQsd4jBVvy"},
        "social":  {"q": "1P_rin2RqcIhFHHs_UW0I-radyAgwT_J4", "exp": "1N74NAlgBYnBZ-GRNk4iHe9WhU2F2Qoco"},
        "science": {"q": "1QGf3iZrWFou-qXqLlakK7FmaFFUXrGFN", "exp": "1LzzcQmsWLlZG1t5v7m8e30bpm-YnVmfv"},
    },
}

# Official CAP answer PDFs from cap.rcpet.edu.tw for cross-checking 114-111
OFFICIAL_ANS = {
    114: "https://cap.rcpet.edu.tw/exam/114/114P_Answer.pdf",
    113: "https://cap.rcpet.edu.tw/exam/113/113P_Answer.pdf",
    112: "https://cap.rcpet.edu.tw/exam/112/112P_Answer.pdf",
    111: "https://cap.rcpet.edu.tw/exam/111/111P_Answer.pdf",
}

def download_gdrive(file_id: str, dest: Path) -> tuple[str, bool, str]:
    if dest.exists() and dest.stat().st_size > 1000:
        with open(dest, "rb") as f:
            if f.read(4) == b"%PDF":
                return (dest.name, True, "cached")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.addheaders = [("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")]

    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    try:
        resp = opener.open(url, timeout=60)
        data = resp.read()
        if data[:4] != b"%PDF":
            # Handle Google Drive virus scan confirmation form
            text = data.decode("utf-8", errors="ignore")
            m_action = re.search(r'action="([^"]+)"', text)
            m_confirm = re.search(r'name="confirm"\s+value="([^"]+)"', text)
            m_uuid = re.search(r'name="uuid"\s+value="([^"]+)"', text)
            if m_action and m_uuid:
                confirm = m_confirm.group(1) if m_confirm else "t"
                url2 = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm={confirm}&uuid={m_uuid.group(1)}"
            else:
                url2 = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
            resp2 = opener.open(url2, timeout=120)
            data = resp2.read()
        if data[:4] != b"%PDF":
            return (dest.name, False, f"not PDF (len={len(data)}, head={data[:60]!r})")
        dest.write_bytes(data)
        return (dest.name, True, f"{len(data)//1024} KB")
    except Exception as e:
        return (dest.name, False, str(e))

def download_direct(url: str, dest: Path) -> tuple[str, bool, str]:
    if dest.exists() and dest.stat().st_size > 1000:
        with open(dest, "rb") as f:
            if f.read(4) == b"%PDF":
                return (dest.name, True, "cached")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        if data[:4] != b"%PDF":
            return (dest.name, False, f"not PDF ({len(data)} bytes)")
        dest.write_bytes(data)
        return (dest.name, True, f"{len(data)//1024} KB")
    except Exception as e:
        return (dest.name, False, str(e))

def main():
    tasks = []
    for year, items in FILES.items():
        ydir = OUT_DIR / str(year)
        if "ans_all" in items:
            tasks.append(("gdrive", items["ans_all"], ydir / f"{year}-ans.pdf"))
        for subj in ("chinese", "english", "math", "social", "science"):
            tasks.append(("gdrive", items[subj]["q"], ydir / f"{year}-{subj}-q.pdf"))
            tasks.append(("gdrive", items[subj]["exp"], ydir / f"{year}-{subj}-exp.pdf"))
    for year, url in OFFICIAL_ANS.items():
        tasks.append(("direct", url, OUT_DIR / str(year) / f"{year}-ans.pdf"))

    ok = 0
    fail = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {}
        for kind, src, dest in tasks:
            fn = download_gdrive if kind == "gdrive" else download_direct
            futs[ex.submit(fn, src, dest)] = dest
        for fut in as_completed(futs):
            name, success, msg = fut.result()
            status = "OK" if success else "FAIL"
            print(f"[{status}] {name}: {msg}")
            if success:
                ok += 1
            else:
                fail.append((name, msg))
    print(f"\nDone: {ok}/{len(tasks)} succeeded, {len(fail)} failed.")
    if fail:
        print("Failures:")
        for n, m in fail:
            print(f"  {n}: {m}")

if __name__ == "__main__":
    main()
