#!/usr/bin/env bash
# Повний набір перевірок. Локально: bash test/run-all.sh   (потрібні xvfb і Chromium; шлях можна задати AUTOMEET_BROWSER_PATH)
set -u
cd "$(dirname "$0")/.."
export TZ=Europe/Kyiv
if [ -z "${AUTOMEET_BROWSER_PATH:-}" ]; then
  AUTOMEET_BROWSER_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())")
  if [ ! -x "$AUTOMEET_BROWSER_PATH" ]; then # інша збірка Chromium (наприклад, пісочниця): шукаємо будь-яку
    alt=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1); [ -n "$alt" ] && AUTOMEET_BROWSER_PATH=$alt
  fi
  export AUTOMEET_BROWSER_PATH
fi
fail=0
run() { echo; echo "=== $1"; shift; "$@" || { echo "!!! ПРОВАЛ: $*"; fail=1; }; }
XV=""; command -v xvfb-run >/dev/null && XV="xvfb-run -a"
run "юніт-тести та симуляція" npm test
run "рушій: звичайний вхід" $XV node test/engine-smoke.js
run "рушій: сценарії збоїв і затримка виходу" $XV node test/engine-scenarios.js
run "Classroom: перший вхід, вкладки" $XV node test/scrape-smoke.js
run "довідкова сторінка браузера" $XV node test/home-smoke.js
run "UI: студент (звичайний)" $XV node test/ui-smoke.js --seeded
run "UI: вибір викладача" $XV node test/ui-smoke.js --teacher
run "UI: кілька облікових записів" $XV node test/ui-multi.js
if [ -n "${PKG_EXE:-}" ]; then run "пакетована програма" $XV node test/pkg-smoke.js "$PKG_EXE"; fi
echo; [ $fail = 0 ] && echo "ВСЕ ЗЕЛЕНЕ" || echo "ЄСТЬ ПРОВАЛИ"
exit $fail
