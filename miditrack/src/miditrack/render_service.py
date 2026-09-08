"""Webセッションのレンダーキャッシュと音源世代を所有する内部サービス。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
import time

from . import midi
from .tooling import has_wave_audio


@dataclass(frozen=True)
class CachedAudio:
    """全尺レンダーLRUに保持するWAVとサイズ。"""

    path: Path
    size_bytes: int


@dataclass(frozen=True)
class PreviewAudio:
    """短区間プレビューLRUに保持するWAVと曲上の範囲。"""

    path: Path
    size_bytes: int
    window: midi.MidiWindow


@dataclass(frozen=True)
class CachedRenderRequest:
    """全尺WAVを生成するためにWeb層が組み立てる内部要求。"""

    cache_key: str
    output_kind: str
    output_key: str
    render_to: Callable[[Path, int], None]


@dataclass(frozen=True)
class CachedRender:
    """キャッシュ再利用または安定状態で完了した全尺レンダーの結果。"""

    path: Path
    cache_key: str
    cache_hit: bool
    work_id: int | None


@dataclass(frozen=True)
class PreviewRenderRequest:
    """短区間WAVを生成するためにWeb層が組み立てる内部要求。"""

    cache_key: str
    output_path_for: Callable[[int], Path]
    render_to: Callable[[Path, int], midi.MidiWindow]


@dataclass(frozen=True)
class CachedPreview:
    """キャッシュ再利用または安定状態で完了した短区間プレビューの結果。"""

    entry: PreviewAudio
    cache_hit: bool


class RenderService:
    """WebSessionのWAVキャッシュ、音源履歴、世代番号を一元管理する。"""

    def __init__(
        self,
        session: Any,
        *,
        render_cache_max_entries: int,
        render_cache_max_bytes: int,
        preview_cache_max_entries: int,
        preview_cache_max_bytes: int,
        audio_source_history_limit: int,
    ) -> None:
        self._session = session
        self._render_cache_max_entries = render_cache_max_entries
        self._render_cache_max_bytes = render_cache_max_bytes
        self._preview_cache_max_entries = preview_cache_max_entries
        self._preview_cache_max_bytes = preview_cache_max_bytes
        self._audio_source_history_limit = audio_source_history_limit

    def cache_lookup(self, cache_key: str) -> Path | None:
        """全尺LRUから有効なWAVを返し、参照順を更新する。"""
        with self._session.state_lock:
            entry = self._session.render_cache.get(cache_key)
            if entry is None:
                return None
            if not has_wave_audio(entry.path):
                self._session.render_cache.pop(cache_key, None)
                self._session.render_cache_bytes -= entry.size_bytes
                return None
            self._session.render_cache.move_to_end(cache_key)
            return entry.path

    def cache_store(
        self, cache_key: str, path: Path, protected_paths: set[Path] | None = None
    ) -> Path:
        """完成WAVを全尺LRUへ登録し、保護中音源以外を必要時に追い出す。"""
        with self._session.state_lock:
            old_entry = self._session.render_cache.pop(cache_key, None)
            if old_entry is not None:
                self._session.render_cache_bytes -= old_entry.size_bytes
                if old_entry.path != path:
                    old_entry.path.unlink(missing_ok=True)
            entry = CachedAudio(path, path.stat().st_size)
            self._session.render_cache[cache_key] = entry
            self._session.render_cache_bytes += entry.size_bytes
            protected = set(protected_paths or ())
            protected.add(path)
            if self._session.audio_path is not None:
                protected.add(self._session.audio_path)
            protected.update(self._session.audio_sources.values())
            self._evict_render_cache(protected)
            return path

    def preview_cache_lookup(self, cache_key: str) -> PreviewAudio | None:
        """短区間プレビューLRUから有効なWAVを返す。"""
        with self._session.state_lock:
            entry = self._session.preview_cache.get(cache_key)
            if entry is None:
                return None
            if not has_wave_audio(entry.path):
                self._session.preview_cache.pop(cache_key, None)
                self._session.preview_cache_bytes -= entry.size_bytes
                return None
            self._session.preview_cache.move_to_end(cache_key)
            return entry

    def preview_cache_store(self, cache_key: str, path: Path, window: midi.MidiWindow) -> PreviewAudio:
        """完成短区間WAVを専用LRUへ登録する。"""
        with self._session.state_lock:
            old_entry = self._session.preview_cache.pop(cache_key, None)
            if old_entry is not None:
                self._session.preview_cache_bytes -= old_entry.size_bytes
                if old_entry.path != path:
                    old_entry.path.unlink(missing_ok=True)
            entry = PreviewAudio(path, path.stat().st_size, window)
            self._session.preview_cache[cache_key] = entry
            self._session.preview_cache_bytes += entry.size_bytes
            protected = set(self._session.audio_sources.values())
            while (
                len(self._session.preview_cache) > self._preview_cache_max_entries
                or self._session.preview_cache_bytes > self._preview_cache_max_bytes
            ):
                for old_key, candidate in list(self._session.preview_cache.items()):
                    if candidate.path in protected:
                        continue
                    self._session.preview_cache.pop(old_key)
                    self._session.preview_cache_bytes -= candidate.size_bytes
                    candidate.path.unlink(missing_ok=True)
                    break
                else:
                    break
            return entry

    def next_render_id(self) -> int:
        """スレッド間で衝突しない音源世代番号を払い出す。"""
        with self._session.state_lock:
            self._session.render_id += 1
            return self._session.render_id

    def register_audio_source(self, render_id: int, path: Path) -> None:
        """世代番号とWAVを結び、クロスフェード用の履歴上限を維持する。"""
        with self._session.state_lock:
            self._session.audio_sources[render_id] = path
            self._session.audio_sources.move_to_end(render_id)
            while len(self._session.audio_sources) > self._audio_source_history_limit:
                self._session.audio_sources.popitem(last=False)

    def activate_full_render(
        self,
        cache_key: str,
        path: Path,
        mode: str,
        work_id: int | None,
        cache_hit: bool,
    ) -> int:
        """全尺WAVを現在の再生音源にし、必要なら新しい音源世代を割り当てる。"""
        with self._session.state_lock:
            is_new_source = (
                self._session.current_render_key != cache_key
                or self._session.audio_path != path
            )
            active_render_id = work_id
            if active_render_id is None and is_new_source and cache_hit:
                active_render_id = self.next_render_id()
            self._session.audio_path = path
            self._session.current_render_key = cache_key
            self._session.current_render_mode = mode
            if active_render_id is not None:
                self.register_audio_source(active_render_id, path)
                self._session.current_render_id = active_render_id
                return active_render_id
            return self._session.current_render_id

    def cache_output_path(self, kind: str, cache_key: str) -> Path:
        """セッションキャッシュ内の衝突しないWAVパスを返す。"""
        assert self._session.root is not None
        cache_dir = self._session.root / "render-cache"
        cache_dir.mkdir(exist_ok=True)
        return cache_dir / f"{kind}-{cache_key[:24]}.wav"

    def ensure_applied(
        self,
        apply_to: Callable[[Path, float, int], dict[str, int | float]],
        missing_error: Callable[[], Exception],
        retry_error: Callable[[], Exception],
    ) -> tuple[Path, dict[str, int | float], int]:
        """現在の編集をMIDIへ適用し、状態世代が安定した結果だけを確定する。"""
        if self._session.root is None or self._session.original_path is None:
            raise missing_error()
        for _attempt in range(3):
            if self._session.applied_path is not None:
                return self._session.applied_path, self._session.apply_summary or {}, 0
            state_revision = self._session.state_revision
            applied_path = self._session.root / "miditrack_edited.mid"
            started_at = time.perf_counter()
            summary = apply_to(
                applied_path,
                self._session.speed_ratio,
                self._session.transpose_semitones,
            )
            elapsed_ms = round((time.perf_counter() - started_at) * 1000)
            if state_revision != self._session.state_revision:
                continue
            self._session.apply_summary = summary
            self._session.applied_duration_seconds = float(summary["durationSeconds"])
            self._session.applied_path = applied_path
            return applied_path, summary, elapsed_ms
        raise retry_error()

    def ensure_cached_render(
        self,
        build_request: Callable[[], CachedRenderRequest],
        retry_error: Callable[[], Exception],
    ) -> CachedRender:
        """全尺WAVを状態世代が安定するまで生成または再利用する。

        要求組み立てと実際の音声レンダーはドメイン知識を持つWeb層へ委ねる。ここは
        キャッシュ、生成物の後始末、世代再試行だけを所有する。
        """
        for _attempt in range(3):
            state_revision = self._session.state_revision
            request = build_request()
            cached_path = self.cache_lookup(request.cache_key)
            if cached_path is not None:
                if state_revision == self._session.state_revision:
                    return CachedRender(cached_path, request.cache_key, True, None)
                continue

            work_id = self.next_render_id()
            output_path = self.cache_output_path(request.output_kind, request.output_key)
            try:
                request.render_to(output_path, work_id)
            except Exception:
                output_path.unlink(missing_ok=True)
                raise
            if state_revision != self._session.state_revision:
                output_path.unlink(missing_ok=True)
                continue
            self.cache_store(request.cache_key, output_path)
            return CachedRender(output_path, request.cache_key, False, work_id)
        raise retry_error()

    def ensure_cached_preview(
        self,
        request: PreviewRenderRequest,
        retry_error: Callable[[], Exception],
    ) -> CachedPreview:
        """短区間WAVを状態世代が安定するまで生成または再利用する。"""
        cached_entry = self.preview_cache_lookup(request.cache_key)
        if cached_entry is not None:
            return CachedPreview(cached_entry, True)
        for _attempt in range(3):
            state_revision = self._session.state_revision
            work_id = self.next_render_id()
            output_path = request.output_path_for(work_id)
            try:
                window = request.render_to(output_path, work_id)
            except Exception:
                output_path.unlink(missing_ok=True)
                raise
            if state_revision != self._session.state_revision:
                output_path.unlink(missing_ok=True)
                continue
            entry = self.preview_cache_store(request.cache_key, output_path, window)
            return CachedPreview(entry, False)
        raise retry_error()

    def _evict_render_cache(self, protected_paths: set[Path]) -> None:
        while (
            len(self._session.render_cache) > self._render_cache_max_entries
            or self._session.render_cache_bytes > self._render_cache_max_bytes
        ):
            for cache_key, entry in list(self._session.render_cache.items()):
                if entry.path in protected_paths:
                    continue
                self._session.render_cache.pop(cache_key)
                self._session.render_cache_bytes -= entry.size_bytes
                entry.path.unlink(missing_ok=True)
                break
            else:
                return
