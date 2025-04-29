// openaiTranslator.js
const { OpenAI } = require('openai');

class OpenAITranslator {
    #openaiClient = null;
    #modelName = "gpt-4o-mini";
    #targetLanguage = "Japanese"; // プロンプト生成時に参照される
    #requestDelayMs = 50;

    constructor(apiKey, targetLanguage = "Japanese", model = "gpt-4o-mini") {
        if (!apiKey) {
            throw new Error('OpenAI API Key is required.');
        }
        try {
            this.#openaiClient = new OpenAI({ apiKey });
            this.#targetLanguage = targetLanguage; // コンストラクタで設定された言語名を使用
            this.#modelName = model;
        } catch (error) {
            console.error("[Translator] Failed to initialize OpenAI client:", error);
            throw new Error(`Failed to initialize OpenAI client: ${error.message}`);
        }
    }

    /**
     * OpenAIに渡すシステムプロンプトを生成します。
     * 日本語への翻訳を強調し、プレースホルダー等の保持ルールを明確化。
     * @returns {string} システムプロンプト文字列。
     * @private
     */
    #createSystemPrompt() {
        // ターゲット言語名を強調（例: "Japanese" -> "JAPANESE"）
        const targetLangEmphasis = this.#targetLanguage.toUpperCase();

        return `You are an expert translation assistant for Minecraft mods. Your **SOLE task** is to translate text accurately into **${targetLangEmphasis}**. You **MUST** translate into **${targetLangEmphasis} ONLY**. Do not use any other language like French, German, etc.

Translate the text values in the provided JSON object according to these KEY RULES:
1.  Maintain the original meaning, style, and tone precisely in the **${targetLangEmphasis}** translation. Do not add extraneous commentary or explanations.
2.  CRITICAL: Preserve any special formatting codes (like %s, %d, %1$s, §0-9, §a-f, §k-o, §r) exactly as they appear in the original text. **DO NOT** translate them or add/remove spaces around them.
3.  CRITICAL: If a text value looks like a technical identifier, key, placeholder, number, or boolean (e.g., "item.minecraft.diamond", "key.categories.inventory", "translation.key.missing", "true", "false", "1", "1.5", "config.value.option"), return it **COMPLETELY UNCHANGED**.
4.  Output Format: Return **ONLY** a single valid JSON object mapping the original index keys (provided as strings) to the translated strings (which **MUST be in ${targetLangEmphasis}**, or the unchanged original string if rule 2 or 3 applies). Ensure the output JSON is complete, syntactically correct, and contains entries for all original index keys. Do not wrap the JSON in markdown code blocks or add any text outside the JSON object itself. Ensure all translated strings are correctly encoded for JSON.`;
    }

    // getSystemPromptString は外部からプロンプト内容を確認する場合に便利なので残す
    getSystemPromptString() {
        return this.#createSystemPrompt();
    }

    // 内部メソッド: OpenAI APIを呼び出して実際のバッチ翻訳を実行
    async translateBatchInternal(textsToTranslate, promptIndices) {
        if (!this.#openaiClient) throw new Error("OpenAI client not initialized.");
        if (!Array.isArray(textsToTranslate) || textsToTranslate.length === 0) {
            return new Map();
        }

        const resultsMap = new Map();
        const jsonInput = {};
        promptIndices.forEach((promptIndex, i) => {
            jsonInput[promptIndex.toString()] = textsToTranslate[i];
        });
        const jsonInputString = JSON.stringify(jsonInput);
        const systemPrompt = this.#createSystemPrompt(); // 修正されたプロンプトを使用
        const userPrompt = `Translate the values in this JSON object according to the rules:\n${jsonInputString}`;

        if (this.#requestDelayMs > 0) {
             await new Promise(resolve => setTimeout(resolve, this.#requestDelayMs));
        }

        try {
            const completion = await this.#openaiClient.chat.completions.create({
                 model: this.#modelName,
                 messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                 temperature: 0.1, // 低いTemperatureを維持
                 response_format: { type: "json_object" },
                 // max_tokens: 4096 // 必要なら設定
            });
            const responseContent = completion.choices[0]?.message?.content;
            if (!responseContent) throw new Error("OpenAI response content is empty.");

            let translatedJson;
            try {
                 translatedJson = JSON.parse(responseContent);
            } catch (parseError) {
                 console.error("[Translator] Failed to parse OpenAI JSON response:", responseContent);
                 throw new Error(`Failed to parse OpenAI JSON response: ${parseError.message}`);
            }

            promptIndices.forEach((promptIndex, i) => {
                const key = promptIndex.toString();
                const originalText = textsToTranslate[i];
                if (translatedJson.hasOwnProperty(key) && typeof translatedJson[key] === 'string') {
                    resultsMap.set(promptIndex, translatedJson[key]);
                } else {
                    const maxLogLength = 100;
                    const truncatedOriginalText = originalText.length > maxLogLength
                        ? originalText.substring(0, maxLogLength) + "..." : originalText;
                    console.warn(`[Translator] Missing/invalid translation for prompt index ${promptIndex}. Using original text: "${truncatedOriginalText}"`);
                    resultsMap.set(promptIndex, originalText);
                }
            });
            return resultsMap;

        } catch (error) {
            console.error(`[Translator] Error during OpenAI API call: ${error.message}`);
             if (error instanceof OpenAI.APIError) {
                 if (error.status === 401) throw new Error("OpenAI Authorization Failed. Check API Key.");
                 if (error.status === 429) throw new Error("OpenAI Rate Limit or Quota Exceeded.");
             }
             console.warn("[Translator] API error occurred, returning original texts for this batch.");
             promptIndices.forEach((promptIndex, i) => {
                 resultsMap.set(promptIndex, textsToTranslate[i]);
             });
             return resultsMap;
        }
    }

    // 公開バッチ翻訳メソッド (変更なし)
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
         const finalResults = [...texts];
         if (textsToTranslate.length > 0) {
             const promptIndices = textsToTranslate.map((_, idx) => idx);
             const translatedMap = await this.translateBatchInternal(textsToTranslate, promptIndices);
             translatedMap.forEach((translatedText, promptIndex) => {
                 const originalIndex = originalIndices[promptIndex];
                 finalResults[originalIndex] = translatedText;
             });
         }
         return finalResults;
     }
}

module.exports = OpenAITranslator;