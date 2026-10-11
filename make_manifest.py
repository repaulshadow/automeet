#!/usr/bin/env python3
"""Створює manifest.json з контрольними сумами файлів, які оновлюються автоматично.
Запускається сам у GitHub Actions (див. update-manifest.yml); вручну: python make_manifest.py"""
import hashlib
import json
from pathlib import Path

FILES = ["schedule.json", "dashboard.html", "auto_meet.py"]
here = Path(__file__).resolve().parent
manifest = {"files": {n: hashlib.sha256((here / n).read_bytes()).hexdigest()
                      for n in FILES if (here / n).exists()}}
(here / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(json.dumps(manifest, indent=2))
