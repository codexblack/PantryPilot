from __future__ import annotations

import asyncio
import math
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from fastapi import HTTPException, UploadFile

_DEFAULT_VIDEO_SUFFIX = ".mp4"
_VIDEO_SUFFIXES = frozenset({".avi", ".m4v", ".mov", ".mp4", ".webm"})
_JPEG_START_OF_FRAME_MARKERS = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)
_MAX_DECODED_IMAGE_PIXELS = 20_000_000
_MAX_PARALLEL_IMAGE_DECODES = 2
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_IMAGE_DECODE_EXECUTOR = ThreadPoolExecutor(
    max_workers=_MAX_PARALLEL_IMAGE_DECODES,
    thread_name_prefix="pantry-image-decode",
)
_MAX_VIDEO_FRAME_PIXELS = 9_000_000
_MAX_VIDEO_DECODED_FRAMES = 2_400
_MAX_VIDEO_DECODE_WALL_SECONDS = 12.0
_VIDEO_DECODE_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="pantry-video-decode",
)


def has_expected_media_type(upload: UploadFile, prefix: str) -> bool:
    """Accept a declared media type or an opaque mobile multipart type."""
    return (
        not upload.content_type
        or upload.content_type.startswith(prefix)
        or upload.content_type == "application/octet-stream"
    )


async def persist_upload(video: UploadFile, max_bytes: int) -> Path:
    """Stream an upload to a temporary file while enforcing its size limit."""
    suffix = Path(video.filename or _DEFAULT_VIDEO_SUFFIX).suffix.lower()
    if suffix not in _VIDEO_SUFFIXES:
        suffix = _DEFAULT_VIDEO_SUFFIX

    total = 0
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as destination:
            path = Path(destination.name)
            while chunk := await video.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail="Video is larger than the upload limit.",
                    )
                destination.write(chunk)
        if total == 0:
            raise HTTPException(status_code=422, detail="The selected video was empty.")
        return path
    except Exception:
        if path is not None:
            path.unlink(missing_ok=True)
        raise


async def prepare_image_uploads(
    images: list[UploadFile],
    max_images: int,
    max_total_bytes: int,
    max_image_bytes: int,
) -> list[bytes]:
    """Validate and normalize still photos without blocking the async server loop."""
    if not 1 <= len(images) <= max_images:
        raise HTTPException(status_code=422, detail=f"Choose between 1 and {max_images} photos.")

    total = 0
    raw_images: list[bytes] = []
    for image in images:
        if not has_expected_media_type(image, "image/"):
            raise HTTPException(status_code=415, detail="Please upload standard image files.")
        raw = bytearray()
        while chunk := await image.read(1024 * 1024):
            total += len(chunk)
            if len(raw) + len(chunk) > max_image_bytes:
                raise HTTPException(
                    status_code=413, detail="Each photo must be within the image upload limit."
                )
            if total > max_total_bytes:
                raise HTTPException(
                    status_code=413, detail="The selected photos exceed the total upload limit."
                )
            raw.extend(chunk)
        if not raw:
            raise HTTPException(status_code=422, detail="One of the selected photos was empty.")
        raw_images.append(bytes(raw))

    async def normalize(raw: bytes) -> bytes:
        return await asyncio.get_running_loop().run_in_executor(
            _IMAGE_DECODE_EXECUTOR,
            _normalize_image,
            raw,
        )

    return list(await asyncio.gather(*(normalize(raw) for raw in raw_images)))


def _normalize_image(raw: bytes) -> bytes:
    """Decode, resize, and encode one image for the vision request."""
    dimensions = _image_dimensions(raw)
    if dimensions is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "We could not read one of those photos. "
                "Please use a supported JPEG, PNG, or WebP image."
            ),
        )
    width, height = dimensions
    if width * height > _MAX_DECODED_IMAGE_PIXELS:
        raise HTTPException(
            status_code=413,
            detail="One of the selected photos has dimensions that are too large.",
        )

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "We could not read one of those photos. "
                "Please use a supported JPEG, PNG, or WebP image."
            ),
        )
    decoded_height, decoded_width = image.shape[:2]
    if (decoded_width, decoded_height) != dimensions:
        raise HTTPException(
            status_code=422,
            detail="One of the selected photos has inconsistent image metadata.",
        )
    scale = min(1, 1280 / max(decoded_height, decoded_width))
    if scale < 1:
        image = cv2.resize(
            image,
            (round(decoded_width * scale), round(decoded_height * scale)),
            interpolation=cv2.INTER_AREA,
        )
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise HTTPException(
            status_code=422, detail="We could not prepare one of those photos for analysis."
        )
    return encoded.tobytes()


def _image_dimensions(raw: bytes) -> tuple[int, int] | None:
    """Read trusted dimensions from supported image headers without decoding pixels."""
    if raw.startswith(_PNG_SIGNATURE):
        return _png_dimensions(raw)
    if raw.startswith(b"\xff\xd8"):
        return _jpeg_dimensions(raw)
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return _webp_dimensions(raw)
    return None


def _png_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        return None
    width = int.from_bytes(raw[16:20], "big")
    height = int.from_bytes(raw[20:24], "big")
    return (width, height) if width and height else None


def _jpeg_dimensions(raw: bytes) -> tuple[int, int] | None:
    offset = 2
    while offset < len(raw):
        while offset < len(raw) and raw[offset] != 0xFF:
            offset += 1
        while offset < len(raw) and raw[offset] == 0xFF:
            offset += 1
        if offset >= len(raw):
            return None
        marker = raw[offset]
        offset += 1
        if marker in {0x01, 0xD8} or 0xD0 <= marker <= 0xD7:
            continue
        if marker in {0xD9, 0xDA} or offset + 2 > len(raw):
            return None
        segment_length = int.from_bytes(raw[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(raw):
            return None
        if marker in _JPEG_START_OF_FRAME_MARKERS:
            if segment_length < 7:
                return None
            height = int.from_bytes(raw[offset + 3 : offset + 5], "big")
            width = int.from_bytes(raw[offset + 5 : offset + 7], "big")
            return (width, height) if width and height else None
        offset += segment_length
    return None


def _webp_dimensions(raw: bytes) -> tuple[int, int] | None:
    offset = 12
    while offset + 8 <= len(raw):
        chunk_type = raw[offset : offset + 4]
        chunk_size = int.from_bytes(raw[offset + 4 : offset + 8], "little")
        payload_start = offset + 8
        payload_end = payload_start + chunk_size
        if payload_end > len(raw):
            return None
        payload = raw[payload_start:payload_end]
        dimensions = _webp_chunk_dimensions(chunk_type, payload)
        if dimensions is not None:
            return dimensions
        offset = payload_end + (chunk_size % 2)
    return None


def _webp_chunk_dimensions(
    chunk_type: bytes,
    payload: bytes,
) -> tuple[int, int] | None:
    if chunk_type == b"VP8X" and len(payload) >= 10:
        width = int.from_bytes(payload[4:7], "little") + 1
        height = int.from_bytes(payload[7:10], "little") + 1
        return width, height
    if chunk_type == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
        width = int.from_bytes(payload[6:8], "little") & 0x3FFF
        height = int.from_bytes(payload[8:10], "little") & 0x3FFF
        return (width, height) if width and height else None
    if chunk_type == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
        packed = int.from_bytes(payload[1:5], "little")
        width = (packed & 0x3FFF) + 1
        height = ((packed >> 14) & 0x3FFF) + 1
        return width, height
    return None


def _frame_fingerprint(frame: np.ndarray) -> bytes:
    """Return a perceptual bit fingerprint for a video frame."""
    small = cv2.resize(frame, (16, 16), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, int(gray.mean()), 255, cv2.THRESH_BINARY)
    return binary.tobytes()


def _is_distinct(fingerprint: bytes, existing: list[bytes]) -> bool:
    """Return whether a frame differs enough from all selected frames."""
    return all(
        sum((left ^ right).bit_count() for left, right in zip(fingerprint, other, strict=True)) > 26
        for other in existing
    )


def _evenly_spaced_frame_indices(frame_count: int, max_frames: int) -> frozenset[int]:
    """Choose bounded frame positions spanning the complete reported duration."""
    target_count = min(max(0, frame_count), max(0, max_frames))
    if target_count == 0:
        return frozenset()
    if target_count == 1:
        return frozenset({0})
    final_index = frame_count - 1
    return frozenset(
        round(position * final_index / (target_count - 1)) for position in range(target_count)
    )


def extract_keyframes(path: Path, max_frames: int, max_seconds: int) -> list[bytes]:
    """Extract distinct, resized frames from a bounded video."""
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise HTTPException(
            status_code=422,
            detail="We could not read that video. Please choose a standard MP4 or MOV file.",
        )

    reported_width = capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0
    reported_height = capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0
    if reported_width * reported_height > _MAX_VIDEO_FRAME_PIXELS:
        capture.release()
        raise HTTPException(
            status_code=422,
            detail="The selected video resolution is too large. Video up to 4K is supported.",
        )

    reported_fps = capture.get(cv2.CAP_PROP_FPS) or 0
    fps = reported_fps if math.isfinite(reported_fps) and 1 <= reported_fps <= 240 else 30
    frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    if not math.isfinite(frame_count) or frame_count < 0:
        frame_count = 0
    duration = frame_count / fps if fps else 0
    if duration > max_seconds:
        capture.release()
        raise HTTPException(
            status_code=422, detail=f"Please use a video under {max_seconds} seconds."
        )

    known_frame_indices = _evenly_spaced_frame_indices(int(frame_count), max_frames)
    fallback_step = max(1, round(fps))  # one candidate each second without frame metadata
    selected: list[bytes] = []
    fingerprints: list[bytes] = []
    decoded_frames = 0
    frame_budget = min(
        _MAX_VIDEO_DECODED_FRAMES,
        max(120, max_seconds * 60),
    )
    deadline = time.monotonic() + _MAX_VIDEO_DECODE_WALL_SECONDS
    try:
        while len(selected) < max_frames:
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status_code=422,
                    detail="Video decoding exceeded the processing time limit.",
                )
            ok, frame = capture.read()
            if not ok:
                break
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status_code=422,
                    detail="Video decoding exceeded the processing time limit.",
                )
            decoded_frames += 1
            if decoded_frames > frame_budget:
                raise HTTPException(
                    status_code=422,
                    detail="Video decoding exceeded the frame limit.",
                )
            height, width = frame.shape[:2]
            if width * height > _MAX_VIDEO_FRAME_PIXELS:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "The selected video resolution is too large. Video up to 4K is supported."
                    ),
                )
            frame_index = decoded_frames - 1
            is_candidate = (
                frame_index in known_frame_indices
                if known_frame_indices
                else frame_index % fallback_step == 0
            )
            if is_candidate:
                fingerprint = _frame_fingerprint(frame)
                if _is_distinct(fingerprint, fingerprints):
                    scale = min(1, 1280 / max(height, width))
                    if scale < 1:
                        frame = cv2.resize(
                            frame,
                            (round(width * scale), round(height * scale)),
                            interpolation=cv2.INTER_AREA,
                        )
                    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
                    if ok:
                        selected.append(encoded.tobytes())
                        fingerprints.append(fingerprint)
    finally:
        capture.release()
    if not selected:
        raise HTTPException(
            status_code=422,
            detail="No usable frames were found. Try filming the shelves with more light.",
        )
    return selected


async def extract_keyframes_async(
    path: Path,
    max_frames: int,
    max_seconds: int,
) -> list[bytes]:
    """Run video decoding through the process-wide single-worker executor."""
    return await asyncio.get_running_loop().run_in_executor(
        _VIDEO_DECODE_EXECUTOR,
        extract_keyframes,
        path,
        max_frames,
        max_seconds,
    )
