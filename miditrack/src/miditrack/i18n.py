"""日英ローカライズの中核モジュール。

新しいメッセージIDを発明するのではなく、**既存の日本語文字列そのものを
msgidとして使う**gettext方式を採る。英語カタログ（`web_assets/i18n/en.json`）
に該当キーが無ければ日本語のまま返す — 未翻訳が安全側（＝表示が消えたり
`missing.key`のような文字列が出たりしない）に倒れるようにするため。

現在言語の保持には`threading.local`ではなく`contextvars.ContextVar`を使う。
Flaskの`before_request`が毎リクエスト設定するだけで、`midi.py`/`convert.py`/
`project.py`/`preferences.py`のようにFlaskをimportしないモジュールからも
そのまま`t()`を呼べるようにするため（`contextvars`は非同期・スレッド境界を
またいでも安全にコピーされる標準ライブラリで、`web.py`側の追加依存が要らない）。
"""

from __future__ import annotations

import html as html_module
import json
from contextvars import ContextVar
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

# HTML5のvoid要素（終了タグを持たない）。self-closing相当として出力する。
_VOID_ELEMENTS = frozenset(
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }
)

SUPPORTED_LANGUAGES = ("ja", "en")
# "system"はクライアント（ブラウザのAccept-Language、またはネイティブアプリの
# Locale.preferredLanguages）に解決を委ねる指定であり、カタログの言語そのもの
# ではない。preferences.pyのTHEME_MODES（system/light/dark）と同じ3値パターン。
LANGUAGE_MODES = frozenset({"system", "ja", "en"})

_DEFAULT_LANGUAGE = "ja"
_current_language: ContextVar[str] = ContextVar("miditrack_language", default=_DEFAULT_LANGUAGE)


def _catalog_path() -> Path:
    return Path(__file__).with_name("web_assets") / "i18n" / "en.json"


@lru_cache(maxsize=1)
def _load_catalog() -> dict[str, str]:
    """英語カタログを読み込む。存在しない・壊れている場合は空辞書（=全件未翻訳）。

    起動のたびにファイルI/Oを繰り返さないようlru_cacheで一度だけ読む。
    テストがカタログを差し替えたい場合は`_load_catalog.cache_clear()`を呼ぶ。
    """
    try:
        raw = _catalog_path().read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value) for key, value in data.items()}


def set_language(language: str) -> None:
    """現在のリクエスト（コンテキスト）で使う言語を設定する。

    "system"はここでは受け付けない — 呼び出し側（web.pyのbefore_request）が
    resolve_language()で具体的な"ja"/"en"へ解決してから渡す。
    """
    if language not in SUPPORTED_LANGUAGES:
        language = _DEFAULT_LANGUAGE
    _current_language.set(language)


def get_language() -> str:
    return _current_language.get()


def resolve_language(
    stored: str | None,
    accept_language_header: str | None = None,
) -> str:
    """設定値とAccept-Languageヘッダーから、具体的な"ja"/"en"を決定する。

    決定順:
    1. storedが"ja"/"en"の明示指定ならそれを最優先する。
    2. storedが"system"（または未設定）ならAccept-Languageの最優先言語を見る。
    3. どちらも決まらなければ既定の"ja"。
    """
    if stored in ("ja", "en"):
        return stored
    if accept_language_header:
        primary = accept_language_header.split(",")[0].strip().split("-")[0].lower()
        if primary in SUPPORTED_LANGUAGES:
            return primary
    return _DEFAULT_LANGUAGE


def t(message: str, /, **params: Any) -> str:
    """日本語原文messageをmsgidとして、現在言語の訳文を返す。

    現在言語が日本語、またはカタログにキーが無い場合はmessage自身を使う
    （未翻訳は日本語のまま出る＝安全側）。paramsはstr.format()と同じ
    プレースホルダ（`{name}`）で埋め込む。
    """
    if get_language() == "en":
        message = _load_catalog().get(message, message)
    if params:
        return message.format(**params)
    return message


def reload_catalog_for_tests() -> None:
    """テストがen.jsonを差し替えた後にキャッシュを破棄するための補助関数。"""
    _load_catalog.cache_clear()


class _StaticHtmlTranslator(HTMLParser):
    """`index.html`の静的テキスト・属性を、data-i18n系マーカーに従って翻訳する。

    翻訳対象は`data-i18n`（要素直下のテキストをmsgidとして使う）と
    `data-i18n-attr="aria-label placeholder"`（スペース区切りで列挙した属性の
    現在値をmsgidとして使う）の2種類のマーカーのみ。マーカー自体は出力にも
    残す（無害なdata-*属性なので、ブラウザ・app.jsとも無視するだけ）。

    このクラスは`localize_html()`が`lang != "ja"`のときにだけ使う。`ja`は
    早期returnで完全にスキップされるため、既定経路のリスクはゼロ。
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._translate_depth: list[bool] = []

    def _render_attrs(self, attrs: list[tuple[str, str | None]]) -> str:
        translate_names: set[str] = set()
        for name, value in attrs:
            if name == "data-i18n-attr" and value:
                translate_names.update(value.split())
        pieces = []
        for name, value in attrs:
            if value is None:
                pieces.append(f" {name}")
                continue
            if name in translate_names:
                value = t(value)
            pieces.append(f' {name}="{html_module.escape(value, quote=True)}"')
        return "".join(pieces)

    def _open(self, tag: str, attrs: list[tuple[str, str | None]]) -> str:
        should_translate = any(name == "data-i18n" for name, _ in attrs)
        self._translate_depth.append(should_translate)
        return f"<{tag}{self._render_attrs(attrs)}>"

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        opened = self._open(tag, attrs)
        if tag in _VOID_ELEMENTS:
            self._translate_depth.pop()
            opened = opened[:-1] + " />"
        self.out.append(opened)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        opened = self._open(tag, attrs)
        self._translate_depth.pop()
        self.out.append(opened[:-1] + " />")

    def handle_endtag(self, tag: str) -> None:
        if self._translate_depth:
            self._translate_depth.pop()
        self.out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self._translate_depth and self._translate_depth[-1]:
            core = data.strip()
            if core:
                leading = data[: len(data) - len(data.lstrip())]
                trailing = data[len(data.rstrip()):]
                data = leading + html_module.escape(t(core), quote=False) + trailing
                self.out.append(data)
                return
        self.out.append(html_module.escape(data, quote=False))

    def handle_comment(self, data: str) -> None:
        self.out.append(f"<!--{data}-->")

    def handle_decl(self, decl: str) -> None:
        self.out.append(f"<!{decl}>")

    def unknown_decl(self, data: str) -> None:
        self.out.append(f"<![{data}]>")

    def result(self) -> str:
        return "".join(self.out)


def localize_html(html: str, language: str) -> str:
    """`index.html`のうち`data-i18n`/`data-i18n-attr`でマークした箇所を
    languageの言語へサーバー側で置換する。

    `app.js`は`<script defer>`で読み込まれるため、初回ペイントより後にしか
    実行できない（CSPが`script-src 'self'`でインラインscriptを禁止しており、
    JS側での「初回ペイント前に決定」も不可能 — CLAUDE.mdのダークモード
    白フラッシュの節が記録した制約と同型）。日本語版が一瞬見えるフラッシュを
    避けるため、静的テキストはこの関数でHTML文字列の時点で確定させる。

    languageが"ja"のときは完全なno-op（元の文字列を1バイトも変更せず返す）
    — 既定経路に新しいパース処理を挟まないことで、機能追加によるリスクを
    日本語ユーザーには一切及ぼさない。

    内部で使う`t()`は現在のContextVar（`set_language()`で設定した値）を
    参照するため、呼び出し前のアンビエントな言語設定が引数`language`と
    食い違っていると誤動作する。それを避けるため、ここで明示的に
    `set_language(language)`してから翻訳し、直前の値へ必ず戻す
    （呼び出し側の言語設定を汚さない）。
    """
    if language == "ja":
        return html
    previous = get_language()
    set_language(language)
    try:
        parser = _StaticHtmlTranslator()
        parser.feed(html)
        parser.close()
        return parser.result()
    finally:
        set_language(previous)
