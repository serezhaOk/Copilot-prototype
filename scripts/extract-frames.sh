#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Запасной вариант, если перемотка видео всё равно тормозит (частая история
# на iOS): раскладываем ролик в последовательность JPEG и рисуем их в canvas.
#
#   ./scripts/extract-frames.sh assets/video/source/my-video.mov 25
#
# Второй аргумент — частота кадров (25 обычно достаточно, 30 плавнее и тяжелее).
# Результат: assets/frames/0001.jpg, 0002.jpg, ...
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="${1:-}"
FPS="${2:-25}"
WIDTH="${WIDTH:-1600}"
QUALITY="${QUALITY:-4}"   # 2 = лучше, 8 = легче
OUT_DIR="assets/frames"

if [[ -z "$SRC" ]]; then
  echo "Использование: $0 <путь-к-видео> [fps]"
  exit 1
fi

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg не установлен" >&2; exit 1; }

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

ffmpeg -hide_banner -loglevel warning -stats -y -i "$SRC" \
  -vf "fps=${FPS},scale=${WIDTH}:-2" \
  -q:v "$QUALITY" \
  "$OUT_DIR/%04d.jpg"

COUNT=$(find "$OUT_DIR" -name '*.jpg' | wc -l | tr -d ' ')
echo
echo "Кадров: $COUNT"
du -sh "$OUT_DIR"
