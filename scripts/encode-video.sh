#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Перекодирует исходное видео в вариант, пригодный для перемотки скроллом.
# Ключевой момент: -g 1 делает каждый кадр ключевым, поэтому браузер может
# мгновенно показать любую секунду. Без этого скролл будет дёргаться.
#
#   ./scripts/encode-video.sh assets/video/source/my-video.mov
#
# Результат: assets/video/main.mp4 (1080p) и assets/video/main-mobile.mp4 (720p)
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="${1:-}"
OUT_DIR="assets/video"
CRF="${CRF:-23}"

if [[ -z "$SRC" ]]; then
  echo "Использование: $0 <путь-к-исходному-видео>"
  echo "Например:      $0 assets/video/source/my-video.mp4"
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "Файл не найден: $SRC" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg не установлен. macOS: brew install ffmpeg" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "→ Исходник:"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,duration,nb_frames \
  -of default=noprint_wrappers=1 "$SRC" || true
echo

encode () {
  local height="$1" out="$2"
  echo "→ Кодирую ${height}p → ${out}"
  ffmpeg -hide_banner -loglevel warning -stats -y -i "$SRC" \
    -vf "scale=-2:${height}" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -crf "$CRF" -preset slow \
    -g 1 -keyint_min 1 -sc_threshold 0 \
    -movflags +faststart \
    -an \
    "$out"
}

encode 1080 "$OUT_DIR/main.mp4"
encode 720  "$OUT_DIR/main-mobile.mp4"

echo
echo "Готово:"
ls -lh "$OUT_DIR"/main*.mp4
echo
echo "Проверь размер файлов. Если 1080p получился тяжелее ~60 МБ —"
echo "перезапусти с большим CRF, например:  CRF=27 $0 $SRC"
