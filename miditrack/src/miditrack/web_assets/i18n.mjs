/** 動的UI文字列の翻訳カタログを所有する。 */
export function createTranslator(uiLang, fetchCatalog = fetch) {
  let catalog = {};

  /** 日本語msgidを表示言語と置換値へ展開する。 */
  function translate(message, params) {
    let text = uiLang === "en" ? catalog[message] || message : message;
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        text = text.replaceAll(`{${key}}`, value);
      }
    }
    return text;
  }

  /** 英語表示時だけカタログを読み、失敗時は日本語msgidへフォールバックする。 */
  async function loadCatalog() {
    if (uiLang !== "en") return;
    try {
      const response = await fetchCatalog("/assets/i18n/en.json");
      catalog = await response.json();
    } catch (_error) {
      catalog = {};
    }
  }

  return { translate, loadCatalog };
}
