// openaiTranslator.js
const { OpenAI } = require('openai');

class OpenAITranslator {
    #openaiClient = null;
    #modelName = "gpt-4o-mini"; // デフォルトモデル
    #targetLanguage = "Japanese"; // デフォルト言語
    #requestDelayMs = 50; // API呼び出し間の遅延（主にバッチ分割時に使用）
    static #MAX_SPLIT_DEPTH = 2; // バッチ分割の最大再帰深度 (0は分割なし, 1は1回分割で計2回試行, 2は2回分割で計4回試行)

    /**
     * OpenAITranslatorのインスタンスを作成します。
     * @param {string} apiKey - OpenAI APIキー。
     * @param {string} [targetLanguage="Japanese"] - 翻訳先の言語名 (プロンプトで使用)。
     * @param {string} [model="gpt-4o-mini"] - 使用するOpenAIモデル名。
     * @throws {Error} APIキーがない場合やクライアント初期化に失敗した場合。
     */
    constructor(apiKey, targetLanguage = "Japanese", model = "gpt-4o-mini") {
        if (!apiKey) {
            throw new Error('OpenAI API Key is required.');
        }
        try {
            this.#openaiClient = new OpenAI({ apiKey });
            this.#targetLanguage = targetLanguage;
            this.#modelName = model;
        } catch (error) {
            console.error("[Translator] Failed to initialize OpenAI client:", error);
            throw new Error(`Failed to initialize OpenAI client: ${error.message}`);
        }
    }

    /**
     * OpenAIに渡すシステムプロンプトを生成します。
     * @returns {string} システムプロンプト文字列。
     * @private
     */
    #createSystemPrompt() {
        const targetLangEmphasis = this.#targetLanguage.toUpperCase();
        return `You are an expert translation assistant for Minecraft mods. Your **SOLE task** is to translate text accurately into **${targetLangEmphasis}**. You **MUST** translate into **${targetLangEmphasis} ONLY**. Do not use any other language like French, German, etc.

Translate the text values in the provided JSON object according to these KEY RULES:
1.  Maintain the original meaning, style, and tone precisely in the **${targetLangEmphasis}** translation. Do not add extraneous commentary or explanations.
2.  CRITICAL: Preserve any special formatting codes (like %s, %d, %1$s, §0-9, §a-f, §k-o, §r, and Patchouli codes like $(item), $(br), $(li), $(#RRGGBB), $() or any text within $()) exactly as they appear in the original text. **DO NOT** translate them or add/remove spaces around them.
3.  CRITICAL: If a text value looks like a technical identifier, key, placeholder, number, boolean, or a path/resource location (e.g., "item.minecraft.diamond", "naturesaura:ancient_sapling", "key.categories.inventory", "true", "false", "1.5", "config.value.option"), return it **COMPLETELY UNCHANGED**.
4.  Output Format: Return **ONLY** a single valid JSON object mapping the original index keys (provided as strings) to the translated strings (which **MUST be in ${targetLangEmphasis}**, or the unchanged original string if rule 2 or 3 applies). Ensure the output JSON is complete, syntactically correct, and contains entries for all original index keys. Do not wrap the JSON in markdown code blocks or add any text outside the JSON object itself. Ensure all translated strings are correctly encoded for JSON.`;
    }

    /**
     * 外部からシステムプロンプト文字列を取得するための公開メソッド。
     * @returns {string} The system prompt string.
     */
    getSystemPromptString() {
        return this.#createSystemPrompt();
    }

    /**
     * 内部メソッド: OpenAI APIを呼び出して実際のバッチ翻訳を実行します。
     * JSONパースエラー時には再帰的にバッチを分割して再試行します。
     * @param {string[]} textsForThisAPICall - 現在のAPI呼び出し対象のテキスト配列。
     * @param {number[]} promptIndicesForThisAPICall - textsForThisAPICallに対応する、OpenAIプロンプト内でキーとして使用するインデックス（通常は0から始まる連番）。
     * @param {number} [currentSplitDepth=0] - 現在のバッチ分割の再帰深度。
     * @returns {Promise<Map<number, string>>} プロンプトインデックスをキー、翻訳/元テキストを値とするMap。
     * @throws {Error} 致命的なAPIエラー（認証、Quota超過など）または最大分割深度でも解決しないパースエラーの場合。
     * @private
     */
    async translateBatchInternal(textsForThisAPICall, promptIndicesForThisAPICall, currentSplitDepth = 0) {
        if (!this.#openaiClient) throw new Error("OpenAI client not initialized.");
        if (!Array.isArray(textsForThisAPICall) || textsForThisAPICall.length === 0) {
            return new Map();
        }

        const resultsMap = new Map();
        const jsonInput = {};
        promptIndicesForThisAPICall.forEach((promptIndex, i) => {
            jsonInput[promptIndex.toString()] = textsForThisAPICall[i];
        });
        const jsonInputString = JSON.stringify(jsonInput);
        const systemPrompt = this.#createSystemPrompt();
        const userPrompt = `Translate the values in this JSON object according to the rules:\n${jsonInputString}`;

        // 分割再試行時は初回の遅延をスキップする場合もあるが、ここでは一律適用
        if (this.#requestDelayMs > 0) {
             await new Promise(resolve => setTimeout(resolve, this.#requestDelayMs));
        }

        try {
            // console.log(`[Translator DEBUG] Sending batch size ${textsForThisAPICall.length}, depth ${currentSplitDepth}, prompt indices: ${promptIndicesForThisAPICall.join(',')}`);
            const completion = await this.#openaiClient.chat.completions.create({
                 model: this.#modelName,
                 messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                 temperature: 0.1,
                 response_format: { type: "json_object" },
                 // max_tokens: 8000 // 必要に応じて最大出力トークン数を設定
            });
            const responseContent = completion.choices[0]?.message?.content;
            if (!responseContent) throw new Error("OpenAI response content is empty.");

            let translatedJson;
            try {
                 translatedJson = JSON.parse(responseContent);
            } catch (parseError) {
                if (textsForThisAPICall.length > 1 && currentSplitDepth < OpenAITranslator.#MAX_SPLIT_DEPTH &&
                    (parseError.message.includes("Unterminated string") || parseError.message.includes("Unexpected end of JSON input") || parseError.message.toLowerCase().includes("unexpected token"))) {

                    console.warn(`[Translator] OpenAI response JSON parsing failed (likely truncated). Splitting batch (current size: ${textsForThisAPICall.length}, depth: ${currentSplitDepth + 1}).`);
                    const midPoint = Math.ceil(textsForThisAPICall.length / 2);

                    const firstHalfTexts = textsForThisAPICall.slice(0, midPoint);
                    const firstHalfPromptIndices = promptIndicesForThisAPICall.slice(0, midPoint);

                    const secondHalfTexts = textsForThisAPICall.slice(midPoint);
                    const secondHalfPromptIndices = promptIndicesForThisAPICall.slice(midPoint);
                    
                    // 再帰呼び出し
                    // console.log(`[Translator DEBUG] Recursing 1st half, size ${firstHalfTexts.length}, indices ${firstHalfPromptIndices.join(',')}`);
                    const firstHalfResults = await this.translateBatchInternal(firstHalfTexts, firstHalfPromptIndices, currentSplitDepth + 1);
                    
                    if (this.#requestDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.#requestDelayMs)); // 分割後のAPIコール間にも遅延
                    
                    // console.log(`[Translator DEBUG] Recursing 2nd half, size ${secondHalfTexts.length}, indices ${secondHalfPromptIndices.join(',')}`);
                    const secondHalfResults = await this.translateBatchInternal(secondHalfTexts, secondHalfPromptIndices, currentSplitDepth + 1);

                    return new Map([...firstHalfResults, ...secondHalfResults]);
                } else {
                    console.error(`[Translator] Failed to parse OpenAI JSON response (batch size ${textsForThisAPICall.length}, depth ${currentSplitDepth}, cannot split further or not a truncation error):`, responseContent);
                    throw new Error(`Failed to parse OpenAI JSON response after ${currentSplitDepth} splits: ${parseError.message}`);
                }
            }

            promptIndicesForThisAPICall.forEach((promptIndex, i) => {
                const key = promptIndex.toString();
                const originalText = textsForThisAPICall[i];
                if (translatedJson.hasOwnProperty(key) && typeof translatedJson[key] === 'string') {
                    resultsMap.set(promptIndex, translatedJson[key]);
                } else {
                    const maxLogLength = 100;
                    const truncatedOriginalText = originalText.length > maxLogLength ? originalText.substring(0, maxLogLength) + "..." : originalText;
                    console.warn(`[Translator] Missing or invalid translation for prompt index ${promptIndex}. Using original text: "${truncatedOriginalText}"`);
                    resultsMap.set(promptIndex, originalText);
                }
            });
            return resultsMap;

        } catch (error) {
            console.error(`[Translator] Error during OpenAI API call (batch size ${textsForThisAPICall.length}, depth ${currentSplitDepth}): ${error.message}`);
             if (error instanceof OpenAI.APIError) {
                 if (error.status === 401) throw new Error("OpenAI Authorization Failed. Check API Key.");
                 if (error.status === 429) throw new Error("OpenAI Rate Limit or Quota Exceeded.");
             }
             // 致命的でないAPIエラーや上記以外のエラーの場合、このバッチのテキストは元のテキストでフォールバック
             console.warn("[Translator] API error occurred, returning original texts for this batch attempt.");
             promptIndicesForThisAPICall.forEach((promptIndex, i) => {
                 resultsMap.set(promptIndex, textsForThisAPICall[i]);
             });
             return resultsMap;
        }
    }

    /**
     * 公開メソッド: テキストの配列を受け取り、翻訳（または元のテキスト）を含む配列を返します。
     * 内部で空文字列を除外し、translateBatchInternalを呼び出します。
     * @param {string[]} texts - 翻訳する元のテキスト配列（空文字列を含む可能性あり）。
     * @returns {Promise<string[]>} 翻訳結果（または元のテキスト）を含む完全な配列。
     */
     async translateTextsBatch(texts) {
         if (!Array.isArray(texts) || texts.length === 0) return [];

         const originalIndices = [];
         const textsToTranslate = texts.filter((text, index) => {
             if (typeof text === 'string' && text.trim() !== '') {
                 originalIndices.push(index);
                 return true;
             }
             return false;
         });

         const finalResults = [...texts]; // 元の配列のコピーで初期化

         if (textsToTranslate.length > 0) {
             // translateBatchInternal に渡すのは、textsToTranslate 内での 0 から始まるインデックス
             const promptIndicesForApi = textsToTranslate.map((_, idx) => idx);
             const translatedMapFromApi = await this.translateBatchInternal(textsToTranslate, promptIndicesForApi, 0);

             // translateBatchInternal から返された Map (キーは promptIndex) を使って
             // finalResults の正しい位置 (originalIndex) に結果をマッピングする
             translatedMapFromApi.forEach((translatedText, promptIndexFromApi) => {
                 // promptIndexFromApi (0..N-1) から、元の texts 配列でのインデックス (originalIndex) を取得
                 const originalIndexInFullArray = originalIndices[promptIndexFromApi];
                 finalResults[originalIndexInFullArray] = translatedText;
             });
         }
         return finalResults;
     }

    /**
     * PatchouliブックのJSONオブジェクトを受け取り、翻訳可能な文字列を翻訳して新しいオブジェクトを返します。
     * @param {object} bookJsonData - パース済みのPatchouliブックのJSONオブジェクト。
     * @returns {Promise<object>} 翻訳された文字列を含む新しいJSONオブジェクト。
     * @throws {Error} 致命的なAPIエラーの場合。
     */
    async translatePatchouliBookObject(bookJsonData) {
        if (typeof bookJsonData !== 'object' || bookJsonData === null) {
            console.warn("[Translator] translatePatchouliBookObject: Input is not a valid object.");
            return bookJsonData;
        }

        const translatableKeys = ['name', 'title', 'header', 'text', 'advancement_title', 'subtitle', 'description'];
        const extractedItems = []; // { path: string[], originalText: string }

        function extractStrings(obj, currentPath = []) {
            if (typeof obj !== 'object' || obj === null) return;
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const value = obj[key];
                    const newPath = [...currentPath, key];
                    if (translatableKeys.includes(key) && typeof value === 'string' && value.trim() !== '') {
                        extractedItems.push({ path: newPath, originalText: value });
                    } else if (Array.isArray(value)) {
                        value.forEach((item, index) => {
                            extractStrings(item, [...newPath, index.toString()]);
                        });
                    } else if (typeof value === 'object') {
                        extractStrings(value, newPath);
                    }
                }
            }
        }
        extractStrings(bookJsonData);

        if (extractedItems.length === 0) {
            return JSON.parse(JSON.stringify(bookJsonData));
        }

        const originalTextsArray = extractedItems.map(item => item.originalText);
        console.log(`[Translator] translatePatchouliBookObject: Translating ${originalTextsArray.length} strings...`);
        const translatedTextsArray = await this.translateTextsBatch(originalTextsArray); // ここで全体のバッチ処理を呼び出す

        const translatedBookJson = JSON.parse(JSON.stringify(bookJsonData));
        function setValueByPath(obj, pathArray, value) {
            let current = obj;
            for (let i = 0; i < pathArray.length - 1; i++) {
                current = current[pathArray[i]];
                if (typeof current !== 'object' || current === null) return;
            }
            current[pathArray[pathArray.length - 1]] = value;
        }
        extractedItems.forEach((item, index) => {
            setValueByPath(translatedBookJson, item.path, translatedTextsArray[index]);
        });
        return translatedBookJson;
    }

    // --- execJSON (ローカルファイル処理用) ---
    async execJSON(jsonData) {
        if (typeof jsonData !== 'object' || jsonData === null) {
            return jsonData;
        }
        const keysToTranslate = [];
        const textsToTranslate = [];
        Object.keys(jsonData).forEach((key) => {
            const value = jsonData[key];
            if (typeof value === 'string' && value.trim() !== '') {
                textsToTranslate.push(value);
                keysToTranslate.push(key);
            }
        });
        if (textsToTranslate.length === 0) {
            return { ...jsonData };
        }
        const translatedTexts = await this.translateTextsBatch(textsToTranslate);
        const translatedData = { ...jsonData };
        translatedTexts.forEach((translatedText, index) => {
             const originalJsonKey = keysToTranslate[index];
             if (originalJsonKey !== undefined) {
                 translatedData[originalJsonKey] = translatedText;
             }
        });
        return translatedData;
    }

    // --- execLOCAL (ローカルファイル処理用) ---
    // .localファイル解析・再構築ヘルパー (プライベートメソッドにしても良い)
    #parseLocal(localContent) {
        const lines = localContent.split(/\r?\n/); const parsed = [];
        lines.forEach((l, i) => { const t = l.trim(), n = i + 1; if (t === '') parsed.push({ type: 'e', o: l, l: n }); else if (t.startsWith('#')) parsed.push({ type: 'c', o: l, l: n }); else { const s = l.indexOf('='); if (s > 0) { const k = l.substring(0, s).trimEnd(), v = l.substring(s + 1); if (k.trim() !== '') parsed.push({ type: 'kv', k, v, o: l, l: n }); else parsed.push({ type: 'o', o: l, l: n }); } else parsed.push({ type: 'o', o: l, l: n }); } });
        return parsed;
    }
    #reconstructLocal(parsedData) {
        return parsedData.map(i => { if (i.type === 'kv') return `${i.k}=${i.tV !== undefined ? i.tV : i.v}`; return i.o; }).join('\n');
    }

    async execLOCAL(localContent) {
        if (typeof localContent !== 'string') return localContent;
        const parsedData = this.#parseLocal(localContent);
        const textsToTranslate = []; const indicesToUpdate = [];
        parsedData.forEach((item, index) => {
            if (item.type === 'kv' && typeof item.value === 'string' && item.value.trim() !== '') { // 'value'プロパティを参照
                textsToTranslate.push(item.value); // 'value'プロパティを参照
                indicesToUpdate.push(index);
            }
        });
        if (textsToTranslate.length === 0) return localContent;
        const translatedTexts = await this.translateTextsBatch(textsToTranslate);
        translatedTexts.forEach((translatedText, batchIndex) => {
             const originalParsedIndex = indicesToUpdate[batchIndex];
             if (originalParsedIndex !== undefined && parsedData[originalParsedIndex]) {
                 parsedData[originalParsedIndex].translatedValue = translatedText; // 'translatedValue'プロパティに設定
             }
        });
        return this.#reconstructLocal(parsedData);
    }
}

module.exports = OpenAITranslator;