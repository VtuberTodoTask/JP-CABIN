// mainWorkerScript.js
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const os =require('os');
const crypto = require('crypto'); // キャッシュキー生成用
const { Worker } = require('worker_threads');
const OpenAITranslator = require('./openaiTranslator'); // OpenAI対応版のTranslator
// p-limit は main 関数内で動的にインポート

// --- Configuration ---
const MODS_DIRECTORY = process.env.SOURCE_DIRECTORY || './mods';
const OUTPUT_RESOURCE_PACK_DIR = process.env.OUTPUT_DIRECTORY || './translated_rp_openai';
const CACHE_DIRECTORY = path.join(__dirname, '.translation_cache_v3'); // キャッシュ用フォルダ
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false'; // デフォルトでキャッシュ有効
const PROMPT_VERSION = "1.1"; // プロンプトを変更したらここを更新してキャッシュを無効化

const TARGET_LANG_CODE_RP = 'ja_jp';          // リソースパック内の言語コード (ファイル名用)
const TARGET_OPENAI_LANG_NAME = 'Japanese'; // OpenAIプロンプト用の言語名
const OPENAI_MODEL = 'gpt-4o-mini';          // 使用するOpenAIモデル
const MINECRAFT_VERSION = '1.20.1';        // pack.mcmeta生成用
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MAX_CONCURRENT_WORKERS = parseInt(process.env.MAX_WORKERS || os.cpus().length, 10);
const MAX_TEXTS_PER_BATCH = 100; // 1回のOpenAI API呼び出しに含める最大テキスト数
const MAX_CONCURRENT_WRITES = 15; // 同時に実行するファイル書き込みの最大数
const MAX_CONCURRENT_API_CALLS = 5; // 同時に実行するOpenAI API呼び出しの最大数
// ---------------------

// Pack Format Calculation
const PACK_FORMAT_MAP = {
    "1.20.1": 15, "1.19.4": 13, "1.18.2": 9, "1.17.1": 7, "1.16.5": 6,
};
const PACK_FORMAT = PACK_FORMAT_MAP[MINECRAFT_VERSION] || 15;

// Target Filenames for regular lang files
const targetJsonFilename = `${TARGET_LANG_CODE_RP}.json`;
const targetLocalFilename = `${TARGET_LANG_CODE_RP}.local`;

// --- Helper Function for .local Parsing ---
function parseLocalContent(localContent) {
    const lines = localContent.split(/\r?\n/);
    const parsed = [];
    lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        const lineNumber = index + 1;
        if (trimmedLine === '') parsed.push({ type: 'empty', originalLine: line, lineNumber });
        else if (trimmedLine.startsWith('#')) parsed.push({ type: 'comment', originalLine: line, lineNumber });
        else {
            const separatorIndex = line.indexOf('=');
            if (separatorIndex > 0) {
                const key = line.substring(0, separatorIndex).trimEnd();
                const value = line.substring(separatorIndex + 1);
                if (key.trim() !== '') parsed.push({ type: 'kv', key, value, originalLine: line, lineNumber });
                else parsed.push({ type: 'other', originalLine: line, lineNumber });
            } else parsed.push({ type: 'other', originalLine: line, lineNumber });
        }
    });
    return parsed;
}

// --- Helper Function for .local Reconstruction ---
function reconstructLocal(parsedData) {
     return parsedData.map(item => {
        if (item.type === 'kv') {
            const valueToUse = item.translatedValue !== undefined ? item.translatedValue : item.value;
            return `${item.key}=${valueToUse}`;
        } else { return item.originalLine; }
    }).join('\n');
}

// --- Cache Helper Functions ---
function getCacheKey(fileInfo, targetLangCode, promptVer = PROMPT_VERSION) {
    const keyString = `${fileInfo.originalJar}-${fileInfo.originalPathInJar}-${targetLangCode}-${promptVer}`;
    return crypto.createHash('md5').update(keyString).digest('hex');
}

async function readFromCache(cacheKey) {
    if (!CACHE_ENABLED) return null;
    const cacheFilePath = path.join(CACHE_DIRECTORY, `${cacheKey}.json`); // Cache content as JSON string
    try {
        const cachedData = await fs.readFile(cacheFilePath, 'utf8');
        return JSON.parse(cachedData); // Returns the stored object or string
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`[Cache] Error reading cache for key ${cacheKey}:`, error.message);
        return null;
    }
}

async function writeToCache(cacheKey, dataToCache) {
    if (!CACHE_ENABLED) return;
    const cacheFilePath = path.join(CACHE_DIRECTORY, `${cacheKey}.json`);
    try {
        await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
        await fs.writeFile(cacheFilePath, JSON.stringify(dataToCache, null, 2), 'utf8'); // Store as pretty JSON
        // console.log(`[Cache] SAVED key ${cacheKey}`);
    } catch (error) {
        console.warn(`[Cache] Error writing cache for key ${cacheKey}:`, error.message);
    }
}

// --- Main Execution Function ---
async function main() {
    const pLimit = (await import('p-limit')).default;

    console.log("==================================================");
    console.log(" Minecraft Mod Translation (OpenAI + Cache + Workers)");
    console.log("==================================================");
    console.log(`Model: ${OPENAI_MODEL}, Target: ${TARGET_OPENAI_LANG_NAME}, PromptVer: ${PROMPT_VERSION}`);
    console.log(`Cache Enabled: ${CACHE_ENABLED}, Dir: ${CACHE_DIRECTORY}`);
    const startTime = Date.now();

    if (!OPENAI_API_KEY) { console.error("[Main Error] OPENAI_API_KEY is not set in .env"); process.exit(1); }
    if (!MODS_DIRECTORY) { console.error("[Main Error] SOURCE_DIRECTORY is not set in .env"); process.exit(1); }

    let translator;
    try {
        translator = new OpenAITranslator(OPENAI_API_KEY, TARGET_OPENAI_LANG_NAME, OPENAI_MODEL);
        console.log("[Main] OpenAI Translator initialized.");
    } catch (e) { console.error("[Main] Failed to initialize Translator:", e.message); process.exit(1); }

    const absoluteOutputDir = path.resolve(OUTPUT_RESOURCE_PACK_DIR);
    try {
        await fs.mkdir(absoluteOutputDir, { recursive: true });
        const packMeta = { pack: { pack_format: PACK_FORMAT, description: `Mod Translations (${TARGET_LANG_CODE_RP}) [${OPENAI_MODEL}, PV${PROMPT_VERSION}]` } };
        await fs.writeFile(path.join(absoluteOutputDir, 'pack.mcmeta'), JSON.stringify(packMeta, null, 2), 'utf8');
        console.log(`[Main] Output directory and pack.mcmeta prepared: ${absoluteOutputDir}`);
    } catch (e) { console.error(`[Main] Failed to prepare output directory:`, e); process.exit(1); }

    if (CACHE_ENABLED) {
        try { await fs.mkdir(CACHE_DIRECTORY, { recursive: true }); console.log(`[Cache] Cache directory ensured: ${CACHE_DIRECTORY}`); }
        catch (e) { console.warn(`[Cache] Could not create cache directory: ${e.message}`); }
    }

    let modFiles = [];
    const absoluteModsDir = path.resolve(MODS_DIRECTORY);
    try {
        const entries = await fs.readdir(absoluteModsDir, { withFileTypes: true });
        modFiles = entries.filter(d => d.isFile() && d.name.toLowerCase().endsWith('.jar')).map(d => path.join(absoluteModsDir, d.name));
        console.log(`[Main] Found ${modFiles.length} JAR files in ${absoluteModsDir}.`);
    } catch (e) { console.error(`[Main] Failed to read mods directory:`, e); process.exit(1); }
    if (modFiles.length === 0) { console.log("[Main] No JAR files found. Exiting."); return; }

    const workerLimit = pLimit(MAX_CONCURRENT_WORKERS);
    const langFileInfos = [];
    const patchouliBookInfos = [];
    console.log(`[Main] Starting worker tasks (concurrency: ${MAX_CONCURRENT_WORKERS})...`);
    const workerPromises = modFiles.map(jarPath => workerLimit(() => new Promise((resolve, reject) => {
        const worker = new Worker(path.resolve('./worker.js'), { workerData: { jarPath } });
        worker.on('message', msg => {
            if (msg.type === 'data') msg.payload.forEach(fi => fi.fileType === 'patchouli_book' ? patchouliBookInfos.push(fi) : langFileInfos.push(fi));
            else if (msg.type === 'error') console.error(`[Worker Error][${path.basename(jarPath)}] ${msg.error}`);
        });
        worker.on('error', reject);
        worker.on('exit', code => { if (code !== 0) console.warn(`Worker for ${path.basename(jarPath)} exited code ${code}`); resolve(); });
    })));
    try { await Promise.all(workerPromises); console.log("[Main] All workers finished JAR processing."); }
    catch (e) { console.error("[Main] Critical worker error:", e); process.exit(1); }
    const jarProcessingEndTime = Date.now();
    console.log(`[Main] JAR processing took ${((jarProcessingEndTime - startTime) / 1000).toFixed(2)}s.`);
    console.log(`[Main] Collected ${langFileInfos.length} regular lang file(s) and ${patchouliBookInfos.length} Patchouli book file(s).`);

    // --- Prepare data for writing ---
    const filesToWrite = []; // { outputPath: string, finalContent: string, outputDirToCreate: string }

    // --- Process Regular Lang Files ---
    const individualLangTextsToTranslate = [];
    const langFileReconstructionData = new Map(); // fileInfoIndex -> { type, data, namespace, originalPathInJar }

    if (langFileInfos.length > 0) {
        console.log("[Main] Processing regular lang files (checking cache)...");
        for (let fileIndex = 0; fileIndex < langFileInfos.length; fileIndex++) {
            const fileInfo = langFileInfos[fileIndex];
            const cacheKey = getCacheKey(fileInfo, TARGET_LANG_CODE_RP);
            const cachedFinalContent = await readFromCache(cacheKey);

            const targetFilename = fileInfo.isJson ? targetJsonFilename : targetLocalFilename;
            const relativeDir = path.dirname(fileInfo.originalPathInJar);
            const outputDir = path.join(absoluteOutputDir, relativeDir);
            const outputPath = path.join(outputDir, targetFilename);

            if (cachedFinalContent !== null) {
                console.log(`  [Cache HIT] Lang: ${fileInfo.originalPathInJar}`);
                filesToWrite.push({ outputPath, finalContent: cachedFinalContent, outputDirToCreate: outputDir });
                langFileReconstructionData.set(fileIndex, { type: 'cached' }); // Mark as cached
            } else {
                console.log(`  [Cache MISS] Lang: ${fileInfo.originalPathInJar}`);
                try {
                    if (!fileInfo.content) throw new Error("Missing content");
                    if (fileInfo.isJson) {
                        const jsonData = JSON.parse(fileInfo.content);
                        langFileReconstructionData.set(fileIndex, { type: 'json', data: jsonData, namespace: fileInfo.namespace, originalPathInJar: fileInfo.originalPathInJar });
                        Object.entries(jsonData).forEach(([key, value]) => {
                            if (typeof value === 'string' && value.trim() !== '') {
                                individualLangTextsToTranslate.push({ text: value, originalFileIndex: fileIndex, originalKey: key });
                            }
                        });
                    } else { // .local
                        const parsedLines = parseLocalContent(fileInfo.content);
                        langFileReconstructionData.set(fileIndex, { type: 'local', data: parsedLines, namespace: fileInfo.namespace, originalPathInJar: fileInfo.originalPathInJar });
                        parsedLines.forEach((lineData) => {
                            if (lineData.type === 'kv' && typeof lineData.value === 'string' && lineData.value.trim() !== '') {
                                individualLangTextsToTranslate.push({ text: lineData.value, originalFileIndex: fileIndex, originalLineNumber: lineData.lineNumber });
                            }
                        });
                    }
                } catch (e) { console.warn(`[Main] Error parsing lang file ${fileInfo.originalPathInJar}: ${e.message}`); langFileReconstructionData.set(fileIndex, { type: 'error' });}
            }
        }
        console.log(`[Main] Extracted ${individualLangTextsToTranslate.length} individual lang texts for API translation.`);

        if (individualLangTextsToTranslate.length > 0) {
            const langTextBatches = []; let currentBatchTexts = []; let currentBatchIndices = [];
            individualLangTextsToTranslate.forEach((textInfo, index) => {
                currentBatchTexts.push(textInfo.text); currentBatchIndices.push(index);
                if (currentBatchTexts.length >= MAX_TEXTS_PER_BATCH) {
                    langTextBatches.push({ texts: currentBatchTexts, indices: currentBatchIndices });
                    currentBatchTexts = []; currentBatchIndices = [];
                }
            });
            if (currentBatchTexts.length > 0) langTextBatches.push({ texts: currentBatchTexts, indices: currentBatchIndices });
            console.log(`[Main] Split lang texts into ${langTextBatches.length} API batches.`);

            const apiLimit = pLimit(MAX_CONCURRENT_API_CALLS); let fatalApiError = false;
            const translatedLangTextMap = new Map(); // index in individualLangTextsToTranslate -> translated_text

            const langTranslationPromises = langTextBatches.map((batch, i) => apiLimit(async () => {
                if (fatalApiError) return;
                console.log(`[Main] Translating lang batch ${i + 1}/${langTextBatches.length} (${batch.texts.length} texts)...`);
                try {
                    const promptIndices = batch.texts.map((_, idx) => idx);
                    const internalResultMap = await translator.translateBatchInternal(batch.texts, promptIndices, 0);
                    internalResultMap.forEach((txt, pIdx) => translatedLangTextMap.set(batch.indices[pIdx], txt));
                } catch (e) {
                    console.error(`[Main] Lang batch ${i + 1} failed: ${e.message}`);
                    if (e.message.includes("Quota Exceeded")||e.message.includes("Authorization Failed")){fatalApiError=true; throw e;}
                }
            }));
            try { await Promise.all(langTranslationPromises); } catch (e) { console.error("[Main] Fatal API error during lang translation."); process.exit(1); }
            console.log("[Main] Lang text API translation finished.");

            // Reconstruct and add to filesToWrite
            individualLangTextsToTranslate.forEach((textInfo, index) => {
                const translatedText = translatedLangTextMap.get(index) ?? textInfo.text;
                const reconData = langFileReconstructionData.get(textInfo.originalFileIndex);
                if (reconData && reconData.type !== 'error' && reconData.type !== 'cached') {
                    if (reconData.type === 'json' && textInfo.originalKey) reconData.data[textInfo.originalKey] = translatedText;
                    else if (reconData.type === 'local') {
                        const lineToUpdate = reconData.data.find(l => l.lineNumber === textInfo.originalLineNumber && l.type === 'kv');
                        if (lineToUpdate) lineToUpdate.translatedValue = translatedText;
                    }
                }
            });

            for (const [fileIndex, reconData] of langFileReconstructionData.entries()) {
                if (reconData && reconData.type !== 'error' && reconData.type !== 'cached') {
                    const fileInfo = langFileInfos[fileIndex];
                    const targetFilename = reconData.type === 'json' ? targetJsonFilename : targetLocalFilename;
                    const relativeDir = path.dirname(reconData.originalPathInJar);
                    const outputDir = path.join(absoluteOutputDir, relativeDir);
                    const outputPath = path.join(outputDir, targetFilename);
                    const finalContent = reconData.type === 'json' ? JSON.stringify(reconData.data, null, 2) : reconstructLocal(reconData.data);
                    filesToWrite.push({ outputPath, finalContent, outputDirToCreate: outputDir });
                    await writeToCache(getCacheKey(fileInfo, TARGET_LANG_CODE_RP), finalContent);
                }
            }
        }
    }

    // --- Translate Patchouli Books (キャッシュ対応) ---
    if (patchouliBookInfos.length > 0) {
        console.log(`\n[Main] Processing ${patchouliBookInfos.length} Patchouli book files (checking cache)...`);
        const patchouliApiLimit = pLimit(MAX_CONCURRENT_API_CALLS);
        let fatalPatchouliError = false;

        const patchouliPromises = patchouliBookInfos.map((bookInfo, index) => patchouliApiLimit(async () => {
            if (fatalPatchouliError) return;
            const cacheKey = getCacheKey(bookInfo, TARGET_LANG_CODE_RP, translator.getSystemPromptString());
            const cachedTranslatedObject = await readFromCache(cacheKey);

            const outputDir = path.join(absoluteOutputDir, 'assets', bookInfo.namespace, 'patchouli_books', bookInfo.bookIdFolder, TARGET_LANG_CODE_RP);
            const outputFilePath = path.join(outputDir, bookInfo.pathAndFilenameUnderSourceLang); // Filename from worker
            const outputDirForThisFile = path.dirname(outputFilePath); // path.dirname to get the actual directory for mkdir

            if (cachedTranslatedObject !== null) {
                console.log(`  [Cache HIT] Patchouli: ${bookInfo.originalPathInJar}`);
                filesToWrite.push({ outputPath: outputFilePath, finalContent: JSON.stringify(cachedTranslatedObject, null, 2), outputDirToCreate: outputDirForThisFile });
                return;
            }

            console.log(`  [Cache MISS] Translating Patchouli book: ${bookInfo.originalPathInJar}`);
            try {
                const jsonData = JSON.parse(bookInfo.content);
                const translatedBookJson = await translator.translatePatchouliBookObject(jsonData);
                const finalContent = JSON.stringify(translatedBookJson, null, 2);
                filesToWrite.push({ outputPath: outputFilePath, finalContent, outputDirToCreate: outputDirForThisFile });
                await writeToCache(cacheKey, translatedBookJson); // Cache the translated object
            } catch (error) {
                console.error(`  [Error] Failed to translate Patchouli book ${bookInfo.originalPathInJar}: ${error.message}`);
                if (error.message.includes("Quota Exceeded") || error.message.includes("Authorization Failed")) {
                    fatalPatchouliError = true; throw error;
                }
                // Non-fatal, write original content if possible
                filesToWrite.push({ outputPath: outputFilePath, finalContent: bookInfo.content, outputDirToCreate: outputDirForThisFile });
            }
        }));
        try { await Promise.all(patchouliPromises); } catch(e) { console.error("[Main] Fatal API error during Patchouli translation."); process.exit(1); }
        console.log("[Main] Patchouli book translation/cache check finished.");
    }

    // --- Write All Files ---
    if (filesToWrite.length > 0) {
        console.log(`[Main] Writing ${filesToWrite.length} processed files...`);
        const writeStartTime = Date.now();
        const writeLimit = pLimit(MAX_CONCURRENT_WRITES);
        let totalFilesWritten = 0;

        const allWritePromises = filesToWrite.map(writeInfo => writeLimit(async () => {
            try {
                await fs.mkdir(writeInfo.outputDirToCreate, { recursive: true });
                await fs.writeFile(writeInfo.outputPath, writeInfo.finalContent, 'utf8');
                totalFilesWritten++;
            } catch (e) { console.error(`[Main] Failed to write file to ${writeInfo.outputPath}: ${e.message}`); }
        }));

        try { await Promise.all(allWritePromises); }
        catch (finalWriteError) { console.error("[Main] Error during aggregated file write operations:", finalWriteError); }
        const writeEndTime = Date.now();
        console.log(`[Main] All file writing complete (${totalFilesWritten} files written) in ${((writeEndTime - writeStartTime) / 1000).toFixed(2)}s.`);
    } else {
        console.log("[Main] No files to write.");
    }

    // --- Final Timing & Log ---
    const mainEndTime = Date.now();
    console.log("\n=============================================");
    console.log(` Resource Pack Creation Finished (Total Time: ${((mainEndTime - startTime) / 1000).toFixed(2)}s)`);
    console.log("=============================================");
    console.log(`Output located at: ${path.resolve(OUTPUT_RESOURCE_PACK_DIR)}`);
}

// --- Run Main Function ---
main().catch(err => {
    console.error("\n[Main] Unhandled error during execution:", err);
    process.exit(1);
});