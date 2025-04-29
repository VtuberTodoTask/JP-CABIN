// langTranslator.js
// deepl-node ライブラリをインポート
const deepl = require('deepl-node');

class LangTranslate {
    // DeepL Translatorインスタンスを保持するプライベートプロパティ
    #deeplTranslator = null;

    /**
     * @param {string} apiKey DeepL APIキー
     * @param {string} targetLang 翻訳先の言語コード (例: 'JA', 'EN-US', 'DE')
     * @param {string} [sourceLang] 翻訳元の言語コード (オプション、nullで自動検出)
     * @param {number} [requestDelayMs=150] リクエスト間の待機時間(ms)。0で使用しない。レート制限対策。
     */
    constructor(apiKey, targetLang = 'JA', sourceLang = null, requestDelayMs = 150) {
        if (!apiKey) {
            throw new Error('DeepL API Key is required.');
        }

        this.targetLang = targetLang;
        // deepl-node では sourceLang は null を許容するため、そのまま代入
        this.sourceLang = sourceLang;
        // 待機時間 (ミリ秒) を設定。負の値は0にする。
        this.requestDelayMs = requestDelayMs >= 0 ? requestDelayMs : 0;

        // deepl-node の Translator インスタンスを作成
        try {
            // new deepl.Translator(authKey, options) optionsでプロキシ等も設定可能
            this.#deeplTranslator = new deepl.Translator(apiKey);
            console.log("DeepL Translator initialized successfully.");
            // 必要であればここで疎通確認 (例: 非同期で this.#deeplTranslator.getUsage() を呼び出すなど)
        } catch (error) {
            console.error("Failed to initialize DeepL Translator:", error);
            // 初期化失敗時はエラーをスローして、インスタンス生成が失敗したことを明確にする
            throw new Error(`Failed to initialize DeepL Translator: ${error.message}`);
        }
    }

    /**
     * 単一のテキストを deepl-node を使用して翻訳します。(内部メソッド)
     * @param {string} text 翻訳するテキスト
     * @returns {Promise<string>} 翻訳後のテキスト、またはエラー時は元のテキスト
     * @private
     */
    async _translateText(text) {
        // 文字列でない場合や空文字の場合はそのまま返す
        if (typeof text !== 'string' || text.trim() === '') {
            return text;
        }

        // Translatorが正しく初期化されているか確認 (コンストラクタでエラー処理済みだが念のため)
        if (!this.#deeplTranslator) {
             throw new Error("DeepL Translator not initialized correctly.");
        }

        try {
            // deepl-node の translateText メソッドを使用
            // 第2引数は sourceLang (null可), 第3引数は targetLang
            // 第4引数にオプションオブジェクトを渡せる (例: { formality: 'less', tagHandling: 'xml' })
            const result = await this.#deeplTranslator.translateText(
                text,
                this.sourceLang, // nullを渡すと自動検出
                this.targetLang
                // --- 必要ならオプションを追加 ---
                // {
                //    // Minecraftの書式 (%s など) を保護したい場合は、事前にカスタムタグで囲み、
                //    // 以下のオプションを使うことを検討 (例: <keep>%s</keep>)
                //    // tagHandling: 'xml',
                //    // ignoreTags: ['keep']

                //    // 文体を指定する場合 (一部言語のみ対応)
                //    // formality: 'default' | 'more' | 'less' | 'prefer_more' | 'prefer_less'
                // }
                // -----------------------------
            );

            // result オブジェクトの text プロパティに翻訳結果が入っている
            return result.text;

        } catch (error) {
             // deepl-node が投げるエラーをハンドリング
            if (error instanceof deepl.QuotaExceededError) {
                // API利用上限超過エラー
                console.error("DeepL API quota exceeded. Translation stopped.");
                // Quota超過は回復不能なため、エラーを再スローして処理を中断させる
                throw new Error("DeepL Quota Exceeded");
            } else if (error instanceof deepl.AuthorizationError) {
                 // 認証エラー (APIキー間違いなど)
                 console.error("DeepL Authorization Error. Check your API Key.");
                 // 認証エラーも致命的なのでエラーを再スロー
                 throw new Error("DeepL Authorization Failed. Check API Key.");
            } else if (error instanceof deepl.RateLimitExceededError || error instanceof deepl.TooManyRequestsError) {
                 // レート制限超過エラー (429 Too Many Requests 含む)
                 console.warn("DeepL rate limit exceeded. Consider increasing requestDelayMs.");
                 // エラーはスローせず、元のテキストを返して処理を続行させる
                 // (呼び出し側でリトライするなどの対策が必要な場合がある)
                 return text;
            } else if (error instanceof deepl.ConnectionError) {
                 // 接続エラー (タイムアウト、DNS解決失敗など)
                 console.error(`DeepL Connection Error translating "${text}": ${error.message}`);
                 // 接続エラーの場合も元のテキストを返す (一時的な問題の可能性があるため)
                 return text;
            } else if (error instanceof deepl.DeepLError) {
                 // その他のDeepL関連エラー (API側の問題など)
                 console.error(`DeepL API Error translating "${text}": ${error.message}`, error);
                 // 元のテキストを返す
                 return text;
            } else {
                 // DeepL以外の予期せぬエラー (コード内のバグなど)
                 console.error(`Unexpected error translating "${text}":`, error);
                 // 予期せぬエラーは調査が必要なため、再スローする方が良い場合もある
                 // throw error;
                 // ここでは安全策として元のテキストを返す
                 return text;
            }
        }
    }

    /**
     * .local ファイルの内容を解析します。 (内部メソッド)
     * コメント (`#`), 空行, `キー=値` 形式を認識します。
     * @param {string} localContent .local ファイルの全内容
     * @returns {Array<object>} 解析結果の配列。各要素は行を表すオブジェクト
     * (type: 'empty'|'comment'|'kv'|'other', originalLine, lineNumber, key?, value?)
     * @private
     */
    _parseLocal(localContent) {
        const lines = localContent.split(/\r?\n/); // Windows(CRLF)とUnix(LF)の改行に対応
        const parsed = [];
        lines.forEach((line, index) => {
            const trimmedLine = line.trim();
            const lineNumber = index + 1; // 1始まりの行番号

            if (trimmedLine === '') {
                // 空行
                parsed.push({ type: 'empty', originalLine: line, lineNumber: lineNumber });
            } else if (trimmedLine.startsWith('#')) {
                // コメント行
                parsed.push({ type: 'comment', originalLine: line, lineNumber: lineNumber });
            } else {
                const separatorIndex = line.indexOf('=');
                // '='があり、かつ行頭ではない場合のみ key=value として認識
                if (separatorIndex > 0) {
                    const key = line.substring(0, separatorIndex).trimEnd(); // キーの後方空白削除
                    const value = line.substring(separatorIndex + 1); // 値はそのまま
                    // キーが空白文字のみでないことを確認
                    if (key.trim() !== '') {
                       parsed.push({ type: 'kv', key: key, value: value, originalLine: line, lineNumber: lineNumber });
                    } else {
                        // キーが空または空白文字のみの場合は無効な行として扱う
                        console.warn(`Skipping line ${lineNumber} with empty key: "${line}"`);
                        parsed.push({ type: 'other', originalLine: line, lineNumber: lineNumber });
                    }
                } else {
                    // '='がない、または行頭にある行は 'other' としてそのまま保持
                     console.warn(`Skipping line ${lineNumber} without valid 'key=value' format: "${line}"`);
                    parsed.push({ type: 'other', originalLine: line, lineNumber: lineNumber });
                }
            }
        });
        return parsed;
    }

    /**
     * 解析/翻訳されたデータから .local ファイル形式の文字列を再構築します。(内部メソッド)
     * @param {Array<object>} parsedData `_parseLocal` で解析され、翻訳処理が適用されたデータ配列
     * @returns {string} 再構築された .local ファイルの内容文字列
     * @private
     */
    _reconstructLocal(parsedData) {
         return parsedData.map(item => {
            // キー・バリューペアの場合
            if (item.type === 'kv') {
                // 翻訳された値 (translatedValue) があればそれを使用し、
                // なければ (エラー発生時など) 元の値 (value) を使用する
                const valueToUse = item.translatedValue !== undefined ? item.translatedValue : item.value;
                return `${item.key}=${valueToUse}`; // キーと値を結合
            } else {
                // コメント、空行、その他の行は originalLine をそのまま返す
                return item.originalLine;
            }
        }).join('\n'); // 改行コードは LF (\n) に統一して出力
    }

    /**
     * JSONデータを翻訳します。
     * @param {object} jsonData 翻訳対象のJSONオブジェクト (キーが文字列、値が文字列のものを翻訳)
     * @returns {Promise<object>} 翻訳後のJSONオブジェクト (キー構造は維持)
     */
    async execJSON(jsonData) {
        // 入力値の基本的な型チェック
        if (typeof jsonData !== 'object' || jsonData === null) {
            throw new Error('Input jsonData must be a non-null object for execJSON().');
        }

        const keys = Object.keys(jsonData);
        const totalKeys = keys.length;
        console.log(`Executing JSON translation for ${totalKeys} keys to ${this.targetLang}...`);
        const translatedData = {}; // 翻訳結果を格納する新しいオブジェクト
        let processedKeys = 0;

        // オブジェクトのキーを順番に処理 (逐次処理)
        for (const key of keys) {
            const originalValue = jsonData[key];
            // 値が翻訳対象となる文字列 (空でない) の場合のみ翻訳を実行
            if (typeof originalValue === 'string' && originalValue.trim() !== '') {
                try {
                    // 内部の翻訳メソッドを呼び出し
                    translatedData[key] = await this._translateText(originalValue);
                    // リクエスト間の待機 (レート制限対策)
                    if (this.requestDelayMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
                    }
                } catch (error) {
                    // _translateText内でQuota超過/認証エラーがthrowされた場合、ここでキャッチして再throw
                    if (error.message === "DeepL Quota Exceeded" || error.message === "DeepL Authorization Failed. Check API Key.") {
                        throw error;
                    }
                    // その他のエラー (_translateTextが元の値を返した場合など) はログは内部で出力済み
                    // ここでは元の値をそのまま結果オブジェクトに入れる
                    translatedData[key] = originalValue;
                }
            } else {
                // 文字列でない、または空の文字列はそのままコピー
                translatedData[key] = originalValue;
            }
            processedKeys++;
            // 定期的に進捗状況をコンソールに出力
            if (processedKeys % 50 === 0 || processedKeys === totalKeys) {
                 console.log(`Processed ${processedKeys}/${totalKeys} JSON keys...`);
            }
        }
        console.log('JSON translation finished.');
        return translatedData; // 翻訳結果のオブジェクトを返す
    }

    /**
     * .local ファイルの内容文字列を翻訳します。
     * @param {string} localContent 翻訳対象の .local ファイルの内容全体 (単一の文字列)
     * @returns {Promise<string>} 翻訳後の .local ファイルの内容文字列
     */
    async execLOCAL(localContent) {
        // 入力値の型チェック
        if (typeof localContent !== 'string') {
            throw new Error('Input localContent must be a string for execLOCAL().');
        }

        console.log("Parsing .local content...");
        // まず .local ファイルの内容を解析して、行ごとのオブジェクト配列に変換
        const parsedData = this._parseLocal(localContent);

        // 翻訳対象となるキー・バリューペアの数をカウント
        const itemsToTranslate = parsedData.filter(item => item.type === 'kv' && typeof item.value === 'string' && item.value.trim() !== '');
        const totalItems = itemsToTranslate.length;
        console.log(`Starting translation of ${totalItems} key-value pairs from .local content to ${this.targetLang}...`);
        let processedItems = 0;

        // 解析されたデータ (行オブジェクトの配列) を順番に処理
        for (const item of parsedData) {
            // item.type が 'kv' で、value が翻訳可能な文字列の場合のみ処理
            if (item.type === 'kv' && typeof item.value === 'string' && item.value.trim() !== '') {
                try {
                    // 内部の翻訳メソッドを呼び出し、結果を item オブジェクトに新しいプロパティとして格納
                    item.translatedValue = await this._translateText(item.value);
                    processedItems++;
                    // 定期的に進捗状況をコンソールに出力
                    if (processedItems % 50 === 0 || processedItems === totalItems) {
                        console.log(`Processed ${processedItems}/${totalItems} .local items...`);
                    }
                     // リクエスト間の待機 (レート制限対策)
                     if (this.requestDelayMs > 0) {
                         await new Promise(resolve => setTimeout(resolve, this.requestDelayMs));
                     }
                } catch (error) {
                     // _translateText内でQuota超過/認証エラーがthrowされた場合、ここでキャッチして再throw
                    if (error.message === "DeepL Quota Exceeded" || error.message === "DeepL Authorization Failed. Check API Key.") {
                        throw error;
                    }
                    // その他のエラー (_translateTextが元の値を返した場合など) はログは内部で出力済み
                    // item.translatedValue は未定義のままとなり、_reconstructLocalで元の値が使われる
                    console.error(`Skipping translation for key "${item.key}" on line ${item.lineNumber} due to error.`);
                }
            }
             // kvタイプでない行や、valueが空文字などの場合は、このループでは何もしない
        }

        console.log("Reconstructing translated .local content...");
        // 翻訳結果を含む解析データから、最終的な .local ファイルの内容文字列を再構築
        const translatedLocalContent = this._reconstructLocal(parsedData);
        console.log('.local content translation finished.');
        return translatedLocalContent; // 翻訳後の文字列を返す
    }
}

// CommonJS形式でクラスをエクスポート
module.exports = LangTranslate;