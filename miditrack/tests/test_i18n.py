"""miditrack.i18n と日英ローカライズ全体の整合性テスト。

`t()`はgettext方式（既存の日本語文字列そのものをmsgidにする）を採るため、
最大のリスクは「ソースの日本語原文を書き換えたのにen.jsonが追従していない」
静かな訳抜けと、「英訳にプレースホルダが欠けていてstr.format()がKeyErrorで
落ちる」実行時エラー。この2つを静的解析で検出するのが本テストの主目的。
"""

from __future__ import annotations

import ast
import json
import os
import re
import tempfile
import unittest
from pathlib import Path

from miditrack import i18n, preferences

SRC_DIR = Path(__file__).resolve().parent.parent / "src" / "miditrack"
CATALOG_PATH = SRC_DIR / "web_assets" / "i18n" / "en.json"
INDEX_HTML_PATH = SRC_DIR / "web_assets" / "index.html"
APP_JS_PATH = SRC_DIR / "web_assets" / "app.js"

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)")
_JP_RE = re.compile(r"[ぁ-んァ-ヶ一-龠]")


def _extract_python_msgids() -> set[str]:
    """`src/miditrack/*.py`内の`t("...")`/`i18n.t("...")`呼び出しの第1引数を集める。

    ASTベースで抽出する — 正規表現だとPythonの暗黙の文字列連結
    （`t("A" "B")`）を1つのmsgidとして結合できず、断片化した誤ったキーを
    拾ってしまうため（convert.pyのoption_schema()ヘルプ文で実際に発生した）。
    """
    msgids: set[str] = set()

    class Visitor(ast.NodeVisitor):
        def visit_Call(self, node: ast.Call) -> None:
            func = node.func
            is_t_call = (isinstance(func, ast.Name) and func.id == "t") or (
                isinstance(func, ast.Attribute) and func.attr == "t"
            )
            if is_t_call and node.args:
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    msgids.add(first.value)
            self.generic_visit(node)

    for path in SRC_DIR.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        Visitor().visit(tree)
    return msgids


def _extract_js_msgids() -> set[str]:
    """`app.js`内の`t("...")`呼び出しの第1引数（ダブルクオート文字列）を集める。

    app.jsは全てのt()呼び出しが単一の文字列リテラル（連結なし）なので、
    正規表現で十分。
    """
    text = APP_JS_PATH.read_text(encoding="utf-8")
    pattern = re.compile(r'\bt\(\s*\n?\s*"((?:[^"\\]|\\.)*)"')
    return set(pattern.findall(text))


class _HtmlMsgidExtractor:
    """`index.html`の`data-i18n`/`data-i18n-attr`が指すmsgidを集める。

    i18n.py内の`_StaticHtmlTranslator`と同じ「data-i18n=要素直下テキスト、
    data-i18n-attr=指定属性の現在値」というルールで抽出する（実装が変わって
    もテストが同じ規則で追従できるよう、ロジックをここで独立に再実装せず
    i18n.localize_html()を実際に"en"で走らせ、翻訳漏れを見つける方式は
    別テストに譲り、ここでは静的なmsgid一覧の抽出だけを担う）。
    """

    def __init__(self) -> None:
        from html.parser import HTMLParser

        extractor = self

        class _Parser(HTMLParser):
            def __init__(self) -> None:
                super().__init__(convert_charrefs=True)
                self.msgids: set[str] = set()
                self._depth: list[bool] = []

            def handle_starttag(self, tag: str, attrs: list) -> None:
                attr_map = dict(attrs)
                self._depth.append("data-i18n" in attr_map)
                targets = attr_map.get("data-i18n-attr")
                if targets:
                    for name in targets.split():
                        value = attr_map.get(name)
                        if value:
                            self.msgids.add(value)

            def handle_startendtag(self, tag: str, attrs: list) -> None:
                self.handle_starttag(tag, attrs)
                self._depth.pop()

            def handle_endtag(self, tag: str) -> None:
                if self._depth:
                    self._depth.pop()

            def handle_data(self, data: str) -> None:
                if self._depth and self._depth[-1]:
                    core = data.strip()
                    if core:
                        self.msgids.add(core)

        self._parser = _Parser()

    def extract(self, html: str) -> set[str]:
        self._parser.feed(html)
        return self._parser.msgids


def _extract_html_msgids() -> set[str]:
    html = INDEX_HTML_PATH.read_text(encoding="utf-8")
    return _HtmlMsgidExtractor().extract(html)


def _extract_ensemble_preset_name_msgids() -> set[str]:
    """組み込み編成プリセット名（`ゲームリード`等）もmsgid扱いにする。

    `preferences.localize_preferences_payload()`は`i18n.t(default_name)`を
    変数呼び出しで行うため、`t("...")`のリテラル引数だけを拾うASTベースの
    抽出では見つからない — 実機のChrome DevTools確認で英語UIでもこれらの
    プリセット名だけ日本語のまま出ているのを見つけて追加した経緯がある
    （en.jsonへの追加を忘れても、この関数が無いと本テストは無言で
    見逃し続ける）。
    """
    return {preset["name"] for preset in preferences.DEFAULT_ENSEMBLE_PRESETS}


class TestCatalogCompleteness(unittest.TestCase):
    """en.jsonがソース上の全msgidを網羅しているか（訳抜け検出）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog: dict[str, str] = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        cls.all_msgids = (
            _extract_python_msgids()
            | _extract_js_msgids()
            | _extract_html_msgids()
            | _extract_ensemble_preset_name_msgids()
        )

    def test_every_source_msgid_has_a_translation(self) -> None:
        missing = sorted(self.all_msgids - set(self.catalog))
        self.assertEqual(
            missing, [], f"{len(missing)}件のmsgidがen.jsonに存在しません: {missing[:10]}..."
        )

    def test_catalog_has_no_stale_entries(self) -> None:
        """en.jsonに、もうソースのどこからも参照されないキーが残っていないか。

        日本語原文をリファクタリングして文言を変えたとき、古いキーを消し忘れる
        ケースを検出する（実害は無いが、カタログが肥大化し続けるのを防ぐ）。
        """
        stale = sorted(set(self.catalog) - self.all_msgids)
        self.assertEqual(stale, [], f"{len(stale)}件の未使用キーがen.jsonに残っています: {stale[:10]}...")

    def test_catalog_values_contain_no_japanese(self) -> None:
        """英訳の値に日本語が紛れ込んでいないか（訳し忘れ・コピペミスの検出）。"""
        offenders = [k for k, v in self.catalog.items() if _JP_RE.search(v)]
        self.assertEqual(offenders, [], f"日本語が残っている訳文: {offenders}")

    def test_placeholders_match_between_msgid_and_translation(self) -> None:
        """`{name}`プレースホルダの集合がmsgidと訳文で一致するか。

        ずれているとt()のstr.format()がKeyErrorで落ちる（英語UIでのみ再現する
        バグになるため、単体テストで機械的に潰しておく価値が特に高い）。
        """
        mismatches = []
        for msgid, translation in self.catalog.items():
            src = set(_PLACEHOLDER_RE.findall(msgid))
            dst = set(_PLACEHOLDER_RE.findall(translation))
            if src != dst:
                mismatches.append((msgid, translation, src, dst))
        self.assertEqual(mismatches, [], f"プレースホルダ不一致: {mismatches}")

    def test_format_succeeds_for_every_entry(self) -> None:
        """全エントリでmsgid・訳文ともにstr.format()が例外なく通ること。"""
        for msgid, translation in self.catalog.items():
            names = set(_PLACEHOLDER_RE.findall(msgid)) | set(_PLACEHOLDER_RE.findall(translation))
            kwargs = {name: "X" for name in names}
            with self.subTest(msgid=msgid):
                msgid.format(**kwargs)
                translation.format(**kwargs)


class TestTranslateFunction(unittest.TestCase):
    def tearDown(self) -> None:
        i18n.set_language("ja")

    def test_japanese_is_passthrough_regardless_of_catalog(self) -> None:
        i18n.set_language("ja")
        self.assertEqual(i18n.t("開く"), "開く")
        # カタログに存在しないキーでも日本語ならそのまま返る。
        self.assertEqual(i18n.t("存在しないキー"), "存在しないキー")

    def test_english_uses_catalog(self) -> None:
        i18n.set_language("en")
        self.assertEqual(i18n.t("開く"), "Open")

    def test_english_falls_back_to_japanese_for_missing_key(self) -> None:
        i18n.set_language("en")
        self.assertEqual(i18n.t("カタログに存在しないはずのキー"), "カタログに存在しないはずのキー")

    def test_params_are_formatted_after_translation(self) -> None:
        i18n.set_language("en")
        self.assertEqual(i18n.t("{name}の音量", name="Lead"), "Volume for Lead")

    def test_resolve_language_prefers_explicit_stored_value(self) -> None:
        self.assertEqual(i18n.resolve_language("en", "ja-JP,ja;q=0.9"), "en")
        self.assertEqual(i18n.resolve_language("ja", "en-US"), "ja")

    def test_resolve_language_system_falls_back_to_accept_language(self) -> None:
        self.assertEqual(i18n.resolve_language("system", "en-US,en;q=0.9"), "en")
        self.assertEqual(i18n.resolve_language(None, "en"), "en")

    def test_resolve_language_defaults_to_japanese(self) -> None:
        self.assertEqual(i18n.resolve_language("system", None), "ja")
        self.assertEqual(i18n.resolve_language(None, None), "ja")
        self.assertEqual(i18n.resolve_language("system", "fr-FR"), "ja")


class TestLocalizeHtml(unittest.TestCase):
    def test_japanese_is_a_complete_noop(self) -> None:
        html = INDEX_HTML_PATH.read_text(encoding="utf-8")
        self.assertEqual(i18n.localize_html(html, "ja"), html)

    def test_english_translates_marked_text_and_attributes(self) -> None:
        html = (
            '<html lang="ja"><body>'
            '<h2 data-i18n>環境設定</h2>'
            '<button aria-label="環境設定" data-i18n-attr="aria-label">gear</button>'
            "</body></html>"
        )
        result = i18n.localize_html(html, "en")
        self.assertIn(">Preferences</h2>", result)
        self.assertIn('aria-label="Preferences"', result)
        # data-i18nの無いテキスト（ボタンのラベル"gear"）は変更しない。
        self.assertIn(">gear</button>", result)

    def test_english_leaves_untranslated_marked_text_as_japanese(self) -> None:
        """カタログに無いキーはenでも安全に日本語のまま出る。"""
        html = "<p data-i18n>これは翻訳表に無い架空の文言です</p>"
        result = i18n.localize_html(html, "en")
        self.assertIn("これは翻訳表に無い架空の文言です", result)


class TestPreferencesAppLanguage(unittest.TestCase):
    """`appLanguage`設定フィールド（preferences.py）の検証。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_backup = os.environ.get("MIDITRACK_PREFERENCES_PATH")
        os.environ["MIDITRACK_PREFERENCES_PATH"] = str(Path(self.tmp.name) / "preferences.json")
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("MIDITRACK_PREFERENCES_PATH", None)
        else:
            os.environ["MIDITRACK_PREFERENCES_PATH"] = self._env_backup

    def test_default_is_system(self) -> None:
        self.assertEqual(preferences.load_preferences()["appLanguage"], "system")

    def test_accepts_ja_and_en(self) -> None:
        for value in ("ja", "en", "system"):
            saved = preferences.save_preferences({"appLanguage": value})
            self.assertEqual(saved["appLanguage"], value)

    def test_rejects_invalid_value(self) -> None:
        from miditrack.errors import WebValidationError

        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"appLanguage": "fr"})


class TestLocalizePreferencesPayload(unittest.TestCase):
    """`preferences.localize_preferences_payload()`の組み込みプリセット名翻訳。

    実機（Chrome DevTools）で英語UIを確認したときに、この関数の翻訳が
    実際には効いておらず「ゲームリード」等が日本語のまま出ていたバグを
    見つけて追加したテスト — `i18n.t(default_name)`が変数呼び出しのため
    静的なmsgid網羅テストでは検出できない種類の訳抜けだった。
    """

    def tearDown(self) -> None:
        i18n.set_language("ja")

    def test_builtin_preset_names_are_translated_in_english(self) -> None:
        i18n.set_language("en")
        data = {"ensemblePresets": preferences.build_default_ensemble_presets()}
        localized = preferences.localize_preferences_payload(data)
        names = {preset["name"] for preset in localized["ensemblePresets"]}
        self.assertEqual(names, {"Game Lead", "Acoustic", "Jazz Quartet"})

    def test_builtin_preset_names_stay_japanese_by_default(self) -> None:
        data = {"ensemblePresets": preferences.build_default_ensemble_presets()}
        localized = preferences.localize_preferences_payload(data)
        names = {preset["name"] for preset in localized["ensemblePresets"]}
        self.assertEqual(names, {"ゲームリード", "アコースティック", "ジャズカルテット"})

    def test_user_renamed_preset_is_left_untranslated(self) -> None:
        i18n.set_language("en")
        data = {
            "ensemblePresets": [
                {"id": "game-leads", "name": "My Custom Name", "programs": {}},
            ]
        }
        localized = preferences.localize_preferences_payload(data)
        self.assertEqual(localized["ensemblePresets"][0]["name"], "My Custom Name")


if __name__ == "__main__":
    unittest.main()
