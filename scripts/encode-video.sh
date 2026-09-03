#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Перекодирует исходное видео в вариант, пригодный для перемотки скроллом.
# Ключевой момент: -g 1 делает каждый кадр ключевым, поэтому браузер может
# мгновенно показать любую секунду. Без этого скролл будет дёргаться.
#
#   ./scripts/encode-video.sh assets/video/source/my-video.mov
#
# Заодно обрезает кадр под макет 1440x900: исходник приходит шире.
#
# Результат: assets/video/main.mp4
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="${1:-}"
OUT_DIR="assets/video"
CRF="${CRF:-22}"
W="${W:-1440}"
H="${H:-900}"
# Потолок Cloudflare Pages на один файл. Если не влезаем — сжимаем сильнее.
MAX_BYTES="${MAX_BYTES:-$((25 * 1024 * 1024))}"
MAX_CRF="${MAX_CRF:-32}"

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

# Кодируем и, если не уложились в лимит хостинга, повторяем с большим CRF.
# Ролик от версии к версии меняется по насыщенности, и подбирать число руками
# каждый раз — лишний шаг, на котором всё встанет.
while true; do
  echo "→ Кодирую ${W}x${H}, CRF ${CRF} → $OUT_DIR/main.mp4"
  ffmpeg -hide_banner -loglevel warning -stats -y -i "$SRC" \
    -vf "scale=-2:${H},crop=${W}:${H}" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -crf "$CRF" -preset slow \
    -g 1 -keyint_min 1 -sc_threshold 0 \
    -movflags +faststart \
    -an \
    "$OUT_DIR/main.mp4"

  SIZE=$(wc -c < "$OUT_DIR/main.mp4")
  if [[ "$SIZE" -le "$MAX_BYTES" ]]; then
    break
  fi

  if [[ "$CRF" -ge "$MAX_CRF" ]]; then
    echo >&2
    echo "Не удалось уложиться в $((MAX_BYTES / 1024 / 1024)) МиБ даже на CRF ${MAX_CRF}." >&2
    echo "Ролик стал заметно длиннее или детальнее. Варианты:" >&2
    echo "  - поднять потолок:   MAX_CRF=36 $0 $SRC" >&2
    echo "  - уменьшить кадр:    H=720 $0 $SRC" >&2
    echo "  - выложить видео отдельно, например в Cloudflare R2" >&2
    exit 1
  fi

  echo "   $(( SIZE / 1024 / 1024 )) МБ — больше лимита, пробую CRF $((CRF + 2))"
  CRF=$((CRF + 2))
done

# Запоминаем, из какого именно исходника собран main.mp4. По этой отметке
# сборка понимает, что видео перекодировать забыли, и не выкладывает старое.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$SRC" | cut -d" " -f1 > "$OUT_DIR/main.source-sha.txt"
else
  shasum -a 256 "$SRC" | cut -d" " -f1 > "$OUT_DIR/main.source-sha.txt"
fi

echo
echo "Готово:"
ls -lh "$OUT_DIR/main.mp4"
echo

echo "Уложились в лимит хостинга на CRF ${CRF}."
