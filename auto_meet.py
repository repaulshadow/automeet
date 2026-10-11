#!/usr/bin/env python3
"""
Auto Meet для Google Chrome. Работает на macOS и Windows — система определяется
автоматически (platform.system()), выбирать её вручную не нужно.

  python3 auto_meet.py --setup     # выбор роли/группы + привязка предметов к курсам Classroom (1 раз)
  python3 auto_meet.py --reset     # стереть сохранённые выборы

Ежедневный запуск:
  macOS:    caffeinate -i python3 auto_meet.py   # держит Mac от сна, пока скрипт работает
  Windows:  python auto_meet.py                  # скрипт сам не даёт Windows уснуть

Установка:
  pip install playwright
"""
import asyncio
import hashlib
import json
import os
import platform
import shutil
import re
import subprocess
import sys
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path

from playwright.async_api import async_playwright

if getattr(sys, "frozen", False):
    # Собрано в .exe через PyInstaller — файлы лежат рядом с самим .exe,
    # а не внутри временной папки распаковки.
    HERE = Path(sys.executable).resolve().parent
else:
    HERE = Path(__file__).resolve().parent
SCHEDULE_FILE = HERE / "schedule.json"
STATE_FILE = HERE / "state.json"
DASHBOARD_FILE = HERE / "dashboard.html"
PROFILE_DIR = Path.home() / ".auto_meet_profile"


def _default_browsers_path():
    if platform.system() == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "ms-playwright"
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Caches" / "ms-playwright"
    return Path.home() / ".cache" / "ms-playwright"


# У зібраному .exe Playwright за замовчуванням шукає браузер усередині тимчасової папки
# розпакування, а завантажує — в іншу. Фіксуємо одну спільну папку для обох дій.
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(_default_browsers_path())

DURATION_MIN = 80      # сколько сидеть на паре
ASK_BEFORE_MIN = 10    # за сколько минут до пары показывать вопрос (если есть варианты)
JOIN_BEFORE_MIN = 1    # за сколько минут заходить
DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"]
STOP = {"за", "пс", "і", "та", "й", "в", "на", "по"}
# Горячие клавиши Google Meet для выключения микрофона/камеры зависят от ОС:
# на macOS это Cmd+D/Cmd+E, на Windows и Linux — Ctrl+D/Ctrl+E.
MOD_KEY = "Meta" if platform.system() == "Darwin" else "Control"


# ---------- утилиты ----------
def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


IS_MAC = platform.system() == "Darwin"
IS_WINDOWS = platform.system() == "Windows"


_PS_TOAST = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode('Auto Meet')) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:AM_TEXT)) | Out-Null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))
"""


def notify(text):
    """Системное уведомление: через osascript на macOS, через toast на Windows,
    через notify-send на Linux (если он есть). Если ничего не сработало — просто
    выводим в консоль, чтобы сообщение не потерялось."""
    try:
        if IS_MAC:
            subprocess.run(["osascript", "-e", f'display notification "{text}" with title "Auto Meet"'])
            return
        if IS_WINDOWS:
            try:
                # Власний тост через PowerShell: працює без сторонніх бібліотек
                # (win10toast ламається всередині зібраного .exe).
                print(f"[сповіщення] {text}")
                subprocess.Popen(
                    ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                     "-Command", _PS_TOAST],
                    env={**os.environ, "AM_TEXT": text}, creationflags=0x08000000,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except Exception:
                pass
        else:
            subprocess.run(["notify-send", "Auto Meet", text], timeout=3)
            return
    except Exception:
        pass
    print(f"[уведомление] {text}")


def gui_choose(prompt, items, default=None, timeout=600):
    """Всплывающее окно с выбором варианта: диалог macOS (osascript) на Mac,
    окошко Tkinter (входит в стандартный Python) на Windows/Linux."""
    if IS_MAC:
        esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')
        lst = ", ".join(f'"{esc(i)}"' for i in items)
        d = default if default in items else items[0]
        script = (f'choose from list {{{lst}}} with prompt "{esc(prompt)}" '
                  f'default items {{"{esc(d)}"}} with title "Auto Meet"')
        try:
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True,
                                timeout=max(timeout, 30))
        except subprocess.TimeoutExpired:
            return None
        out = r.stdout.strip()
        return None if out in ("", "false") else out

    # Windows / Linux — простое окно на Tkinter (стандартная библиотека Python)
    import tkinter as tk

    result = {"value": None}
    root = tk.Tk()
    root.title("Auto Meet")
    root.attributes("-topmost", True)
    tk.Label(root, text=prompt, wraplength=380, justify="left", padx=12, pady=10).pack()
    listbox = tk.Listbox(root, height=min(len(items), 8), width=50)
    for i, item in enumerate(items):
        listbox.insert(tk.END, item)
        if item == default:
            listbox.selection_set(i)
    listbox.pack(padx=12, pady=6)

    def confirm():
        sel = listbox.curselection()
        result["value"] = items[sel[0]] if sel else default
        root.destroy()

    tk.Button(root, text="OK", command=confirm, width=14).pack(pady=10)
    root.after(int(timeout * 1000), root.destroy)  # автозакрытие по таймауту
    root.mainloop()
    return result["value"]


mac_choose = gui_choose  # сохранено для обратной совместимости имени


def gui_ask_text(prompt, default=""):
    """Простое окошко для ввода текста (например, фамилии) — без консоли."""
    if IS_MAC:
        esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')
        script = (f'display dialog "{esc(prompt)}" default answer "{esc(default)}" '
                  f'with title "Auto Meet"')
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            return None
        m = re.search(r"text returned:(.*)$", r.stdout.strip())
        return m.group(1) if m else None

    import tkinter as tk
    result = {"value": None}
    root = tk.Tk()
    root.title("Auto Meet")
    root.attributes("-topmost", True)
    tk.Label(root, text=prompt, wraplength=380, justify="left", padx=12, pady=10).pack()
    entry = tk.Entry(root, width=40)
    entry.insert(0, default)
    entry.pack(padx=12, pady=6)
    entry.focus_set()

    def confirm(event=None):
        result["value"] = entry.get().strip()
        root.destroy()

    entry.bind("<Return>", confirm)
    tk.Button(root, text="OK", command=confirm, width=14).pack(pady=10)
    root.mainloop()
    return result["value"]


def ask_terminal(prompt, options):
    print(f"\n{prompt}")
    for i, o in enumerate(options, 1):
        print(f"  {i}. {o}")
    print("  0. пропустить")
    while True:
        s = input("Номер: ").strip()
        if s.isdigit() and 0 <= int(s) <= len(options):
            return int(s) - 1
        print("Введи число из списка.")


# ---------- нечёткое сравнение ----------
def norm(s):
    s = s.lower().replace("'", "").replace("’", "").replace("ʼ", "").replace("`", "")
    return re.sub(r"[^\w\s]", " ", s).split()


def tok_sim(a, b):
    if a == b:
        return 1.0
    if len(a) >= 3 and len(b) >= 3 and (b.startswith(a) or a.startswith(b)):
        return 0.9
    r = SequenceMatcher(None, a, b).ratio()
    return r if r >= 0.75 else 0.0


def subject_score(subject, title):
    st = [t for t in norm(subject) if t not in STOP]
    ct = [t for t in norm(title)]
    if not st or not ct:
        return 0.0
    acr = "".join(c[0] for c in ct if c not in STOP)
    scores = []
    for t in st:
        best = max(tok_sim(t, c) for c in ct)
        if len(t) >= 2 and len(acr) >= 2 and (acr.startswith(t) or t.startswith(acr)):
            best = max(best, 0.8)  # аббревиатура: БЖД ~ Безпека Життєдіяльності
        scores.append(best)
    return sum(scores) / len(scores)


def teacher_bonus(teacher, text):
    hay = "".join(norm(text))
    for part in re.split(r"[/,]", teacher):
        stem = "".join(norm(part))[:5]
        if len(stem) >= 4 and stem in hay:
            return 0.2
    return 0.0


def parse_option(opt):
    opt = opt.lstrip("?").strip()
    subj, _, teacher = opt.partition("|")
    return subj.strip(), teacher.strip()


def rank(option, courses):
    subj, teacher = parse_option(option)
    res = []
    for c in courses:
        s = min(1.0, subject_score(subj, c["title"]) + teacher_bonus(teacher, c["text"]))
        res.append((s, c))
    res.sort(key=lambda x: -x[0])
    return res


# ---------- браузер ----------
NO_TRANSLATE_JS = """
(() => {
  const apply = () => {
    const h = document.documentElement;
    if (h) { h.setAttribute('translate', 'no'); h.classList.add('notranslate'); }
    if (document.head && !document.querySelector('meta[name="google"]')) {
      const m = document.createElement('meta');
      m.name = 'google'; m.content = 'notranslate';
      document.head.appendChild(m);
    }
  };
  apply();
  new MutationObserver(apply).observe(document, { childList: true, subtree: false });
})();
"""


def browser_candidates():
    """Список (channel, папка_профілю) у порядку спроб: Google Chrome, Microsoft Edge
    (якщо встановлені) і наприкінці власний Chromium від Playwright, який
    за потреби завантажується автоматично."""
    out = []
    if IS_WINDOWS:
        roots = [os.environ.get(k) for k in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")]
        chrome = [Path(r) / "Google" / "Chrome" / "Application" / "chrome.exe" for r in roots if r]
        edge = [Path(r) / "Microsoft" / "Edge" / "Application" / "msedge.exe" for r in roots if r]
    elif IS_MAC:
        chrome = [Path("/Applications/Google Chrome.app"),
                  Path.home() / "Applications" / "Google Chrome.app"]
        edge = [Path("/Applications/Microsoft Edge.app")]
    else:
        chrome, edge = [Path("/")], []
    if any(p.exists() for p in chrome):
        out.append(("chrome", PROFILE_DIR))
    if any(p.exists() for p in edge):
        out.append(("msedge", PROFILE_DIR.with_name(PROFILE_DIR.name + "_edge")))
    out.append((None, PROFILE_DIR.with_name(PROFILE_DIR.name + "_chromium")))
    return out


def install_playwright_chromium():
    """Одноразово завантажує Chromium від Playwright (~150 МБ), якщо інші браузери не підійшли."""
    from playwright._impl._driver import compute_driver_executable, get_driver_env
    node, cli = compute_driver_executable()
    notify("Завантажую браузер (одноразово, кілька хвилин)…")
    print("Завантажую Chromium (одноразово, ~150 МБ)…")
    subprocess.run([str(node), str(cli), "install", "chromium"],
                   env=get_driver_env(), check=True)


def disable_translate_in_profile(profile_dir=None):
    """Прописываем в профиле Chrome: переводчик выключен, украинский/русский/английский не переводить."""
    prefs_path = (profile_dir or PROFILE_DIR) / "Default" / "Preferences"
    prefs_path.parent.mkdir(parents=True, exist_ok=True)
    prefs = load_json(prefs_path, {})
    prefs.setdefault("translate", {})["enabled"] = False
    prefs["translate_blocked_languages"] = ["uk", "ru", "en"]
    prefs.setdefault("intl", {})["accept_languages"] = "uk-UA,uk,ru,en-US,en"
    prefs.pop("translate_site_blacklist", None)
    prefs.pop("translate_allowlists", None)
    save_json(prefs_path, prefs)


async def _launch_once(p, channel, profile_dir):
    disable_translate_in_profile(profile_dir)
    return await p.chromium.launch_persistent_context(
        user_data_dir=str(profile_dir), channel=channel, headless=False,
        locale="uk-UA",
        args=["--use-fake-ui-for-media-stream", "--disable-blink-features=AutomationControlled",
              "--lang=uk-UA", "--accept-lang=uk-UA,uk"],
        ignore_default_args=["--enable-automation"],
        permissions=[],
    )


async def launch(p):
    ctx = None
    last_err = None
    for channel, profile_dir in browser_candidates():
        name = {"chrome": "Google Chrome", "msedge": "Microsoft Edge"}.get(channel, "Chromium")
        try:
            try:
                ctx = await _launch_once(p, channel, profile_dir)
            except Exception as e:
                if channel is None and "Executable doesn't exist" in str(e):
                    await asyncio.to_thread(install_playwright_chromium)
                    ctx = await _launch_once(p, channel, profile_dir)
                else:
                    raise
            if channel != "chrome":
                print(f"Використовую {name}.")
            break
        except Exception as e:
            last_err = e
            print(f"Не вдалося запустити {name}: {str(e).splitlines()[0]}")
    if ctx is None:
        notify("Не вдалося запустити браузер.")
        raise RuntimeError(f"Не вдалося запустити жоден браузер: {last_err}")
    # Явно выдаём доступ к камере/микрофону для Meet и Classroom, чтобы в настройках сайта
    # был виден статус "Allow", а не "Block" (само выключение камеры/микрофона делает attend()).
    for origin in ("https://meet.google.com", "https://classroom.google.com"):
        await ctx.grant_permissions(["camera", "microphone"], origin=origin)
    await ctx.add_init_script(NO_TRANSLATE_JS)
    return ctx


async def scrape_courses(ctx, strip_group_prefix=True):
    page = await ctx.new_page()
    await page.goto("https://classroom.google.com/u/0/h")
    print("Если попросит — войди в Google-аккаунт в открывшемся окне (жду до 3 минут)…")
    await page.wait_for_selector('a[href*="/c/"]', timeout=180000)
    await page.wait_for_timeout(2500)
    raw = await page.evaluate("""() => {
        const m = {};
        document.querySelectorAll('a[href*="/c/"]').forEach(a => {
            const t = a.innerText.trim(); const h = a.href.split('?')[0];
            if (t && (!m[h] || t.length > m[h].length)) m[h] = t;
        });
        return m;
    }""")
    await page.close()
    courses = []
    for url, text in raw.items():
        if not re.search(r"/c/[^/]+/?$", url):
            continue
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        # пропускаем буквы-аватарки («K») и берём первую нормальную строку
        title = next((l for l in lines if len(l) > 2), lines[0])
        if strip_group_prefix:
            # убираем префикс группы: «КІ-31», «КІ - 31» и т.п. (не нужно для режима преподавателя,
            # где один и тот же предмет может встречаться сразу у нескольких групп)
            title = re.sub(r"^\s*[A-Za-zА-Яа-яІіЇїЄєҐґ]{1,4}\s*-?\s*\d+\s*", "", title).strip() or title
        courses.append({"title": title, "text": " ".join(lines), "url": url})
    print("Курсы из Classroom:")
    for c in courses:
        print("  •", c["title"])
    if courses and not any(re.search(r"[А-Яа-яІіЇїЄє]", c["title"]) for c in courses):
        sys.exit("\nChrome всё равно перевёл страницу на английский. Закрой окно Chrome, "
                 "нажми значок перевода в адресной строке → «Никогда не переводить», "
                 "и запусти --setup ещё раз.")
    return courses


def norm_code(s):
    """Огрубляет код группы для сравнения: «КІ-31», «кі - 31» → «кі31»."""
    return re.sub(r"[^0-9a-zA-Zа-яА-ЯіІїЇєЄ]", "", s).lower()


def filter_by_group(courses, group):
    code = norm_code(group)
    hits = [c for c in courses if code in norm_code(c["title"])]
    return hits or courses  # если префикса группы в названии нет — не сужаем список


# Латинские и украинские буквы, которые выглядят одинаково, но для компьютера разные
# символы (например, латинская "i" и украинская "і") — частая причина того, что
# фамилия, введённая с обычной клавиатуры, не находится в расписании.
_HOMOGLYPHS = str.maketrans({
    "a": "а", "e": "е", "i": "і", "o": "о", "p": "р", "c": "с", "x": "х",
})


def norm_name(s):
    return (s.lower().translate(_HOMOGLYPHS)
            .replace("'", "").replace("’", "").replace("ʼ", "")
            .replace("`", "").replace("-", " ").strip())


def surname_matches(target, teacher_field_part):
    """Сравнивает фамилии как отдельные слова, а не по вхождению подстроки —
    иначе «Іванов» засчитывался бы как совпадение и для «Іванова» (например,
    когда в расписании мать и сын с похожими фамилиями через «ов»/«ова»)."""
    t = norm_name(target).split()
    p = norm_name(teacher_field_part).split()
    if not t or not p:
        return False
    return t[0] == p[0]


def teacher_schedule(sched, surname):
    """Собирает персональное расписание преподавателя: для каждого дня/пары —
    список «ГРУППА: Предмет | Викладач» по всем группам, где в поле викладача
    встречается фамилия. Опции, помеченные «?» в исходном расписании, остаются
    помеченными и здесь."""
    out = {}
    for group, days in sched["groups"].items():
        for day, periods in days.items():
            for period, opts in periods.items():
                for opt in opts:
                    maybe = opt.startswith("?")
                    subj, teacher = parse_option(opt)
                    if not teacher:
                        continue
                    parts = re.split(r"[/,]", teacher)
                    if not any(surname_matches(surname, p) for p in parts):
                        continue
                    label = f"{'?' if maybe else ''}{group}: {subj} | {teacher}"
                    out.setdefault(day, {}).setdefault(period, [])
                    if label not in out[day][period]:
                        out[day][period].append(label)
    return out


STATE_REF = {}  # ссылка на загруженное состояние (для субботних замен)
SAT_FILE = HERE / "saturdays.json"  # необязательно: {"2026-10-17": "пн", ...}


def saturday_value(d):
    """Що відомо про суботу d: назва дня («пн»…«пт»), «нема» або None, якщо ще не знаємо."""
    explicit = dict(STATE_REF.get("saturdays", {}))
    explicit.update(load_json(SAT_FILE, {}))
    key = d.isoformat()
    if explicit.get(key):
        return explicit[key]
    # Далі суботи йдуть по колу: пт → пн → вт → ср → чт → пт …
    # Відштовхуємось від найближчої попередньої відомої суботи з конкретним днем.
    best = None
    for k, v in explicit.items():
        try:
            kd = datetime.strptime(k, "%Y-%m-%d").date()
        except ValueError:
            continue
        if v in DAYS[:5] and kd < d and (best is None or kd > best[0]):
            best = (kd, v)
    if best is None:
        return None
    weeks = (d - best[0]).days // 7
    return DAYS[(DAYS.index(best[1]) + weeks) % 5]


def effective_day(d):
    """За розкладом якого дня тижня навчаємось у дату d (None — пар нема/невідомо).
    У суботу береться день, указаний у saturdays.json або обраний у діалозі."""
    wd = d.weekday()
    if wd < 5:
        return DAYS[wd]
    if wd == 5:
        v = saturday_value(d)
        return v if v in DAYS[:5] else None
    return None


def compute_status(sched, my_sched, now):
    """Находит ближайшее по времени событие: либо «до начала следующей пары»,
    либо, если пара уже идёт, «до её конца». Смотрит на неделю вперёд, если
    сегодня пар больше не осталось."""
    bells = sched["bells"]
    ends = sched.get("ends", {})
    for offset in range(0, 8):
        day_dt = (now + timedelta(days=offset)).replace(hour=0, minute=0, second=0, microsecond=0)
        day = effective_day(day_dt.date())
        periods = my_sched.get(day, {})
        for pair in sorted(periods.keys(), key=int):
            opts = periods[pair]
            if not opts:
                continue
            h, m = map(int, bells[pair].split(":"))
            start = day_dt.replace(hour=h, minute=m)
            label = " / ".join(o.lstrip("?").strip() for o in opts if o.lstrip("?").strip())
            if not label:
                continue
            if offset == 0:
                fixed_end = ends.get(pair)
                if fixed_end:
                    eh, em = map(int, fixed_end.split(":"))
                    end = start.replace(hour=eh, minute=em)
                else:
                    end = start + timedelta(minutes=DURATION_MIN)
                if now < start:
                    return {"phase": "before", "target": start.timestamp() * 1000,
                            "pair": pair, "label": label}
                if now < end:
                    return {"phase": "during", "target": end.timestamp() * 1000,
                            "pair": pair, "label": label}
                continue  # эта пара уже закончилась — смотрим дальше
            else:
                return {"phase": "before", "target": start.timestamp() * 1000,
                        "pair": pair, "label": label}
    return {"phase": "none", "target": None, "pair": None, "label": ""}


async def push_dashboard(dashboard_page, sched, my_sched, identity):
    if dashboard_page is None:
        return
    status = compute_status(sched, my_sched, datetime.now())
    status["identity"] = identity
    try:
        await dashboard_page.evaluate("data => window.updateDashboard && window.updateDashboard(data)",
                                       status)
    except Exception:
        pass  # вкладку могли закрыть вручную — не критично


async def click_first(page, selectors, timeout=3000, poll_ms=150):
    """Проверяет все варианты сразу и кликает по первому, что появился —
    вместо того чтобы ждать полный timeout на каждый неподходящий вариант по очереди."""
    deadline = asyncio.get_event_loop().time() + timeout / 1000
    while True:
        for sel in selectors:
            try:
                el = page.locator(sel).first
                if await el.is_visible():
                    await el.click()
                    return True
            except Exception:
                continue
        if asyncio.get_event_loop().time() >= deadline:
            return False
        await page.wait_for_timeout(poll_ms)


async def _is_any_visible(page, labels):
    for l in labels:
        try:
            if await page.locator(f'[aria-label*="{l}" i]').first.is_visible():
                return True
        except Exception:
            continue
    return False


async def attend(ctx, name, course_url, end_time):
    page = await ctx.new_page()
    print(f"[{datetime.now():%H:%M}] Захожу: {name}")
    try:
        await page.goto(course_url)
        # Ссылка на Meet в Classroom часто лежит в скрытом (пока не открытом) блоке —
        # не ждём видимости элемента, а просто ищем href в разметке страницы.
        meet_href = None
        for _ in range(20):
            meet_href = await page.evaluate(
                '() => document.querySelector(\'a[href*="meet.google.com/"]\')?.href || null'
            )
            if meet_href:
                break
            await page.wait_for_timeout(1000)
        if not meet_href:
            raise RuntimeError("Не нашёл ссылку на Meet на странице курса")
        await page.goto(meet_href)

        ON_LABELS_MIC = ["Turn off microphone", "Вимкнути мікрофон", "Отключить микрофон",
                         "Выключить микрофон"]
        ON_LABELS_CAM = ["Turn off camera", "Вимкнути камеру", "Отключить камеру",
                          "Выключить камеру"]

        async def is_on(labels):
            sel = ",".join(f'[aria-label*="{l}" i]' for l in labels)
            try:
                return await page.locator(sel).first.is_visible()
            except Exception:
                return False

        async def toggle_off(labels, shortcut, attempts=3, pause_ms=500):
            """Сначала пробуем локаль-независимую горячую клавишу Meet
            (Cmd+D/Cmd+E на macOS, Ctrl+D/Ctrl+E на Windows/Linux),
            а название кнопки используем только для проверки и как запасной вариант — и то
            лишь пока кнопка «Вимкнути…» ещё видна, чтобы не включить обратно уже выключенное."""
            for _ in range(attempts):
                if not await is_on(labels):
                    return True
                await page.keyboard.press(shortcut)
                await page.wait_for_timeout(pause_ms)
                if not await is_on(labels):
                    return True
                # запасной вариант — клик по кнопке, только если она ещё точно видна как "включено"
                await click_first(page, [f'[aria-label*="{l}" i]' for l in labels], 1000)
                await page.wait_for_timeout(pause_ms)
            return not await is_on(labels)

        # даём странице немного времени на инициализацию устройств перед первой попыткой
        await page.wait_for_timeout(800)
        try:
            await page.locator("body").click(position={"x": 5, "y": 5}, timeout=1500)
        except Exception:
            pass  # фокус для горячих клавиш — не критично, если не получилось
        mic_off = await toggle_off(ON_LABELS_MIC, f"{MOD_KEY}+d")
        cam_off = await toggle_off(ON_LABELS_CAM, f"{MOD_KEY}+e")
        if not mic_off:
            notify(f"Не удалось выключить микрофон: {name}")
        if not cam_off:
            notify(f"Не удалось выключить камеру: {name}")

        ok = await click_first(page, [
            'button:has-text("Join now")', 'button:has-text("Ask to join")',
            'button:has-text("Приєднатися")', 'button:has-text("Попросити приєднатися")',
            'button:has-text("Присоединиться")', 'button:has-text("Попросить войти")'], 15000)
        if not ok:
            notify(f"Не нашёл кнопку входа: {name}")

        await asyncio.sleep(max(0, (end_time - datetime.now()).total_seconds()))
        await click_first(page, ['[aria-label*="Leave call" i]', '[aria-label*="Вийти з дзвінка" i]',
                                 '[aria-label*="Покинуть" i]'], 3000)
    except Exception as e:
        print("  Ошибка:", e)
        notify(f"Не удалось зайти: {name}")
    finally:
        await page.close()
        print(f"[{datetime.now():%H:%M}] Вышел: {name}")


# ---------- настройка ----------
def build_options(my_sched, is_teacher):
    """Список (рядок_пари, група_або_None) для всіх унікальних пар розкладу."""
    options = []
    for day, periods in my_sched.items():
        for opts in periods.values():
            for o in opts:
                o = o.lstrip("?").strip()
                if not o:
                    continue
                if is_teacher:
                    group_part, _, rest = o.partition(":")
                    key = (o, group_part.strip())
                else:
                    key = (o, None)
                if key not in options:
                    options.append(key)
    return options


async def map_options(state, my_sched, is_teacher, only_missing):
    """Зіставляє пари розкладу з курсами Classroom. При only_missing=True обробляє лише
    ті пари, для яких ще немає збереженого курсу (потрібно після оновлення розкладу)."""
    state.setdefault("map", {})
    state.setdefault("unmatched", [])
    options = build_options(my_sched, is_teacher)
    if only_missing:
        options = [(o, g) for o, g in options
                   if o not in state["map"] and o not in state["unmatched"]]
        if not options:
            return
    notify("Шукаю курси в Classroom… відкриється Chrome.")
    async with async_playwright() as p:
        ctx = await launch(p)
        courses = await scrape_courses(ctx, strip_group_prefix=not is_teacher)
        await ctx.close()
    print(f"\nНайдено курсов в Classroom: {len(courses)}")

    for o, grp in options:
        # для преподавателя сначала сужаем список курсов до нужной группы
        pool = filter_by_group(courses, grp) if grp else courses
        ranked = [(s, c) for s, c in rank(o, pool) if s >= 0.35][:5]
        if not ranked:
            print(f"\n«{o}»: похожих курсов не найдено, пропускаю.")
            if o not in state["unmatched"]:
                state["unmatched"].append(o)
            continue
        top = ranked[0][0]
        if top >= 0.85 and (len(ranked) == 1 or ranked[1][0] <= top - 0.15):
            state["map"][o] = ranked[0][1]["url"]
            print(f"✓ {o}  →  {ranked[0][1]['title']}")
            continue
        labels = [f"{c['title']}  ({int(s * 100)}%)" for s, c in ranked]
        picked = await asyncio.to_thread(gui_choose, f"Куди заходити на «{o}»?", labels)
        if picked:
            i = labels.index(picked)
            state["map"][o] = ranked[i][1]["url"]
    save_json(STATE_FILE, state)


async def setup():
    sched = load_json(SCHEDULE_FILE, None)
    if not sched:
        notify("Не найден файл schedule.json рядом с программой.")
        sys.exit("Нет schedule.json рядом со скриптом.")

    role = await asyncio.to_thread(gui_choose, "Ви студент чи викладач?", ["Студент", "Викладач"])
    if role is None:
        sys.exit("Роль не выбрана.")
    is_teacher = role == "Викладач"

    state = load_json(STATE_FILE, {})
    state["map"] = state.get("map", {})
    state["last"] = state.get("last", {})

    if is_teacher:
        surname = await asyncio.to_thread(
            gui_ask_text, "Введіть своє прізвище так, як воно написано в розкладі:")
        surname = (surname or "").strip()
        if not surname:
            sys.exit("Фамилия не введена.")
        state["mode"] = "teacher"
        state["surname"] = surname
        state["teacher_name"] = surname
        my_sched = teacher_schedule(sched, surname)
        if not any(my_sched.values()):
            notify(f"По прізвищу «{surname}» в розкладі нічого не знайдено.")
            sys.exit(f"По фамилии «{surname}» в расписании ничего не найдено. Проверь написание.")
        print(f"\nНайдено пар с фамилией «{surname}»:")
        for day in DAYS[:5]:
            for pair, opts in sorted(my_sched.get(day, {}).items()):
                for o in opts:
                    print(f"  {day} №{pair}: {o.lstrip('?')}")
    else:
        groups = list(sched["groups"].keys())
        group = await asyncio.to_thread(gui_choose, "Виберіть свою групу:", groups)
        if not group:
            sys.exit("Группа не выбрана.")
        state["mode"] = "student"
        state["group"] = group
        my_sched = sched["groups"][group]

    await map_options(state, my_sched, is_teacher, only_missing=False)
    if (IS_MAC or IS_WINDOWS) and not autostart_enabled():
        ans = await asyncio.to_thread(
            gui_choose,
            "Запитувати при кожному вході в комп'ютер, чи запускати Auto Meet? "
            "(Нічого не запуститься без вашої згоди; змінити можна в будь-який момент.)",
            ["Так, запитувати", "Ні"], "Так, запитувати")
        if ans == "Так, запитувати" and enable_autostart():
            notify("Автозапуск увімкнено.")
    notify("Налаштування завершено. Програма починає стежити за розкладом.")
    print("\nГотово.")


# ---------- ежедневная работа ----------
def week_parity(date):
    """Чётность календарной недели — простой способ различать «цей» и «той»
    тиждень для пар, что чергуються через тиждень (діагональ у розкладі)."""
    return str(date.isocalendar()[1] % 2)


async def handle_pair(ctx, state, sched, pair, options, start):
    eff = effective_day(start.date())
    group_day_key = f"{DAYS.index(eff) if eff in DAYS else start.weekday()}-{pair}"
    chosen = None
    needs_ask = len(options) > 1 or any(o.startswith("?") for o in options)
    if needs_ask:
        real_items = [o.lstrip("?").strip() for o in options if o.lstrip("?").strip()]
        parity = week_parity(start)
        patterns = state.setdefault("week_pattern", {})
        learned = patterns.get(group_day_key, {})

        if learned.get(parity) in real_items:
            # паттерн уже выучен для этой чётности недели — спрашивать не нужно
            chosen = learned[parity]
        else:
            dont_know = "Не знаю (питати щотижня)"
            none_label = "— пари нема —"
            items = real_items + [dont_know, none_label]
            default = state["last"].get(group_day_key)
            # если пара уже началась (скрипт запустили с опозданием), не ждём — спрашиваем сразу
            wait_left = max(0, (start - datetime.now()).total_seconds())
            timeout = int(wait_left) + 120
            ans = await asyncio.to_thread(
                mac_choose, f"Пара №{pair} ({start:%H:%M}). Яка пара цього тижня?",
                items, default, timeout)
            if ans is None:  # не ответил — берём прошлый выбор, если был
                ans = default
            if not ans or ans == none_label:
                print(f"Пара {pair}: пропуск")
                return
            if ans == dont_know:
                # явно «не знаю» — забываем ранее выученный паттерн (если был) и
                # продолжаем спрашивать каждую неделю
                patterns.pop(group_day_key, None)
            elif ans in real_items:
                learned[parity] = ans
                # если вариантов ровно два — второй автоматически относим
                # к противоположной чётности недели, спрашивать больше не нужно
                if len(real_items) == 2:
                    other = [o for o in real_items if o != ans][0]
                    other_parity = "0" if parity == "1" else "1"
                    learned.setdefault(other_parity, other)
                patterns[group_day_key] = learned
            state["last"][group_day_key] = ans
            save_json(STATE_FILE, state)
            chosen = ans
    else:
        chosen = options[0].strip() if options else ""
    if not chosen:
        return
    url = state["map"].get(chosen)
    if not url:
        notify(f"Нет курса для «{chosen}». Запусти --setup")
        return
    await asyncio.sleep(max(0, (start - timedelta(minutes=JOIN_BEFORE_MIN) - datetime.now()).total_seconds()))
    end = start + timedelta(minutes=DURATION_MIN)
    fixed_end = sched.get("ends", {}).get(pair)  # необязательное фиксированное время выхода
    if fixed_end:
        eh, em = map(int, fixed_end.split(":"))
        end = start.replace(hour=eh, minute=em)
    await attend(ctx, chosen, url, end)


def keep_awake_windows():
    """Аналог macOS-команды caffeinate: не даёт Windows уснуть, пока скрипт работает.
    На Mac для этого используется `caffeinate -i python3 auto_meet.py` при запуске."""
    if not IS_WINDOWS:
        return
    import ctypes
    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    ES_DISPLAY_REQUIRED = 0x00000002
    ctypes.windll.kernel32.SetThreadExecutionState(
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)


# ---------- автозапуск при вході в систему ----------
AUTOSTART_NAME = "AutoMeet"
MAC_PLIST = Path.home() / "Library" / "LaunchAgents" / "com.automeet.startup.plist"


def _launch_cmd():
    """Команда, якою запускається сама програма (.exe або python + скрипт)."""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, str(Path(__file__).resolve())]


def autostart_enabled():
    try:
        if IS_WINDOWS:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Run") as k:
                winreg.QueryValueEx(k, AUTOSTART_NAME)
            return True
        if IS_MAC:
            return MAC_PLIST.exists()
    except Exception:
        pass
    return False


def enable_autostart():
    """Додає програму в автозавантаження поточного користувача (права адміністратора
    не потрібні). При вході в систему вона запускається з ключем --startup і
    спершу питає, чи справді запускати."""
    try:
        if IS_WINDOWS:
            import winreg
            cmd = " ".join(f'"{c}"' for c in _launch_cmd()) + " --startup"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Run",
                                0, winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, AUTOSTART_NAME, 0, winreg.REG_SZ, cmd)
            return True
        if IS_MAC:
            import plistlib
            MAC_PLIST.parent.mkdir(parents=True, exist_ok=True)
            plist = {
                "Label": "com.automeet.startup",
                # caffeinate не дає Mac заснути, поки програма працює
                "ProgramArguments": ["/usr/bin/caffeinate", "-i"] + _launch_cmd() + ["--startup"],
                "RunAtLoad": True,
                "WorkingDirectory": str(HERE),
                "StandardOutPath": str(HERE / "auto_meet.log"),
                "StandardErrorPath": str(HERE / "auto_meet.log"),
            }
            with open(MAC_PLIST, "wb") as f:
                plistlib.dump(plist, f)
            return True
    except Exception as e:
        print("Автозапуск не вдалося налаштувати:", e)
    return False


def disable_autostart():
    try:
        if IS_WINDOWS:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Run",
                                0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, AUTOSTART_NAME)
        elif IS_MAC:
            MAC_PLIST.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def get_my_sched(state, sched):
    if state["mode"] == "teacher":
        return teacher_schedule(sched, state["surname"])
    return sched["groups"][state["group"]]


def pairs_left_today(my_sched, sched, now):
    """Чи лишилися сьогодні ще пари (щоб не турбувати питанням у вихідний/після занять)."""
    if now.weekday() == 5 and saturday_value(now.date()) is None:
        return True  # субота без відомого дня — краще спитати
    day = effective_day(now.date())
    for pair, opts in my_sched.get(day, {}).items():
        if not any(o.lstrip("?").strip() for o in opts):
            continue
        h, m = map(int, sched["bells"][pair].split(":"))
        start = now.replace(hour=h, minute=m, second=0, microsecond=0)
        fixed_end = sched.get("ends", {}).get(pair)
        if fixed_end:
            eh, em = map(int, fixed_end.split(":"))
            end = start.replace(hour=eh, minute=em)
        else:
            end = start + timedelta(minutes=DURATION_MIN)
        if now < end:
            return True
    return False


async def startup_prompt():
    """Викликається при автозапуску: питає, чи запускати. Повертає True, якщо запускати."""
    state = load_json(STATE_FILE, None)
    sched = load_json(SCHEDULE_FILE, None)
    if not state or "mode" not in state or not sched:
        return False
    global STATE_REF
    STATE_REF = state
    try:
        if not pairs_left_today(get_my_sched(state, sched), sched, datetime.now()):
            return False  # сьогодні пар більше нема — мовчки виходимо
    except Exception:
        pass  # якщо не вдалося визначити — краще спитати
    yes, no, never = "Так, запустити", "Ні, не зараз", "Більше не питати"
    ans = await asyncio.to_thread(
        gui_choose, "Запустити Auto Meet на сьогоднішні пари?", [yes, no, never], yes, 120)
    if ans == never:
        disable_autostart()
        notify("Автозапуск вимкнено. Запускайте програму вручну.")
        return False
    return ans == yes


# ---------- автооновлення з GitHub ----------
# Впишіть сюди свій репозиторій (публічний). Файли лежать у корені гілки main.
UPDATE_URL = "https://raw.githubusercontent.com/repaulshadow/automeet/main/"
UPDATABLE = ["schedule.json", "dashboard.html", "auto_meet.py"]
UPDATE_CHECK_HOURS = 6


def check_for_updates():
    """Звіряє контрольні суми файлів із manifest.json у репозиторії й завантажує змінені.
    Мовчки нічого не робить, якщо немає інтернету або репозиторій не налаштований.
    Код перед заміною перевіряється на синтаксичні помилки; стара версія зберігається як .bak.
    Повертає список оновлених файлів."""
    if "YOUR_USER" in UPDATE_URL:
        return []
    import urllib.request
    updated = []

    def fetch(name):
        try:
            req = urllib.request.Request(UPDATE_URL + name, headers={
                "Cache-Control": "no-cache", "User-Agent": "AutoMeet-updater"})
            with urllib.request.urlopen(req, timeout=8) as r:
                return r.read()
        except Exception:
            # Python з python.org на macOS часто не має кореневих сертифікатів
            # (помилка SSL) — тоді качаємо через системний curl, який їх має.
            r = subprocess.run(["curl", "-fsSL", "--max-time", "15", UPDATE_URL + name],
                               capture_output=True, timeout=30)
            if r.returncode != 0:
                raise RuntimeError(f"curl: код {r.returncode}")
            return r.stdout

    try:
        manifest = json.loads(fetch("manifest.json").decode("utf-8"))
        for name, want in manifest.get("files", {}).items():
            if name not in UPDATABLE:
                continue
            if getattr(sys, "frozen", False) and name == "auto_meet.py":
                continue  # у зібраному .exe код не підміняється
            target = HERE / name
            have = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
            if have == want:
                continue
            data = fetch(name)
            if hashlib.sha256(data).hexdigest() != want:
                continue  # файл пошкоджено або кеш ще не оновився
            if name.endswith(".py"):
                compile(data, name, "exec")
            elif name.endswith(".json"):
                json.loads(data.decode("utf-8"))
            if target.exists():
                shutil.copy2(target, target.with_name(name + ".bak"))
            tmp = target.with_name(name + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
            updated.append(name)
    except Exception as e:
        print("Перевірка оновлень не вдалася:", e)
    return updated


async def offer_autostart(state):
    """Один раз пропонує ввімкнути автозапуск тим, хто налаштувався раніше."""
    if not (IS_MAC or IS_WINDOWS) or autostart_enabled() or state.get("autostart_asked"):
        return
    state["autostart_asked"] = True
    save_json(STATE_FILE, state)
    ans = await asyncio.to_thread(
        gui_choose,
        "Запитувати при кожному вході в комп'ютер, чи запускати Auto Meet? "
        "(Нічого не запуститься без вашої згоди.)",
        ["Так, запитувати", "Ні"], "Так, запитувати")
    if ans == "Так, запитувати" and enable_autostart():
        notify("Автозапуск увімкнено.")


async def run():
    state = load_json(STATE_FILE, None)
    sched = load_json(SCHEDULE_FILE, None)
    if not state or "mode" not in state:
        sys.exit("Сначала: python3 auto_meet.py --setup")
    keep_awake_windows()
    if state["mode"] == "teacher":
        my_sched = teacher_schedule(sched, state["surname"])
        identity = state.get("teacher_name") or state["surname"]
        print(f"Викладач «{state['surname']}». Слежу за расписанием. Не закрывай окно.")
    else:
        my_sched = sched["groups"][state["group"]]
        identity = state["group"]
        print(f"Группа {state['group']}. Слежу за расписанием. Не закрывай окно.")
    started = set()
    asked_sat = set()
    global STATE_REF
    STATE_REF = state
    async with async_playwright() as p:
        ctx = await launch(p)
        dashboard_page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await dashboard_page.goto(DASHBOARD_FILE.as_uri())
        except Exception:
            dashboard_page = None  # без панели скрипт всё равно продолжит работать
        last_update_check = datetime.now()
        while True:
            now = datetime.now()
            if now - last_update_check > timedelta(hours=UPDATE_CHECK_HOURS):
                last_update_check = now
                upd = await asyncio.to_thread(check_for_updates)
                if upd:
                    notify("Завантажено оновлення. Застосується при наступному запуску.")
            await push_dashboard(dashboard_page, sched, my_sched, identity)
            if now.weekday() == 5 and saturday_value(now.date()) is None \
                    and now.date() not in asked_sat:
                asked_sat.add(now.date())
                ans = await asyncio.to_thread(
                    gui_choose, "Сьогодні субота. За розкладом якого дня навчаємось?",
                    ["пн", "вт", "ср", "чт", "пт", "Сьогодні пар нема"], "Сьогодні пар нема", 600)
                if ans:
                    state.setdefault("saturdays", {})[now.date().isoformat()] = \
                        ans if ans in DAYS[:5] else "нема"
                    save_json(STATE_FILE, state)
            day = effective_day(now.date())
            for pair, options in my_sched.get(day, {}).items():
                h, m = map(int, sched["bells"][pair].split(":"))
                start = now.replace(hour=h, minute=m, second=0, microsecond=0)
                key = f"{now.date()}-{pair}"
                if key in started:
                    continue
                fixed_end = sched.get("ends", {}).get(pair)
                if fixed_end:
                    eh, em = map(int, fixed_end.split(":"))
                    pair_end = start.replace(hour=eh, minute=em)
                else:
                    pair_end = start + timedelta(minutes=DURATION_MIN)
                # окно входа: с ASK_BEFORE_MIN до начала и до самого конца пары —
                # если скрипт запустили, когда пара уже идёт, он всё равно зайдёт
                if start - timedelta(minutes=ASK_BEFORE_MIN) <= now < pair_end:
                    started.add(key)
                    asyncio.create_task(handle_pair(ctx, state, sched, pair, options, start))
            await asyncio.sleep(20)


async def main():
    if "--reset" in sys.argv:
        STATE_FILE.unlink(missing_ok=True)
        notify("Налаштування скинуто.")
        print("Сброшено.")
        return
    if "--autostart-off" in sys.argv:
        print("Автозапуск вимкнено." if disable_autostart() else "Не вдалося вимкнути автозапуск.")
        return
    if "--autostart-on" in sys.argv:
        print("Автозапуск увімкнено." if enable_autostart() else "Не вдалося увімкнути автозапуск.")
        return
    updated = await asyncio.to_thread(check_for_updates)
    if "auto_meet.py" in updated:
        # новий код — перезапускаємо себе вже з оновленою версією
        if IS_WINDOWS:  # os.execv на Windows некоректно працює зі шляхами з пробілами
            subprocess.Popen([sys.executable] + sys.argv)
            return
        os.execv(sys.executable, [sys.executable] + sys.argv)
    if updated:
        print("Оновлено:", ", ".join(updated))
    if "--startup" in sys.argv:
        if not await startup_prompt():
            return
    state = load_json(STATE_FILE, None)
    if not state or "mode" not in state:
        await setup()  # первый запуск — диалоги настройки, без консоли
    else:
        await offer_autostart(state)  # для тех, у кого настройка была сделана до появления автозапуска
        try:  # після оновлення розкладу — підтягнути курси лише для нових пар
            sched = load_json(SCHEDULE_FILE, None)
            if sched:
                await map_options(state, get_my_sched(state, sched), state["mode"] == "teacher",
                                  only_missing=True)
        except SystemExit:
            raise
        except Exception as e:
            print("Не вдалося оновити зіставлення курсів:", e)
    await run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        notify(f"Auto Meet зупинився через помилку: {e}")
        print("Ошибка:", e)
        input("Натисніть Enter, щоб закрити…")
