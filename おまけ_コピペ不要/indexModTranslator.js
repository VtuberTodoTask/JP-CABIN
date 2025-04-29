// mainWorkerScript.js
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const OpenAITranslator = require('./openaiTranslator'); // OpenAI対応版のTranslator
// p-limit は動的インポートするためここでは require しない

// --- Configuration ---
const MODS_DIRECTORY = process.env.SOURCE_DIRECTORY + '/mods' || './mods';
const OUTPUT_RESOURCE_PACK_DIR = process.env.OUTPUT_DIRECTORY || './translated_rp_openai';
const TARGET_LANG_CODE_RP = 'ja_jp';          // リソースパック内の言語コード (ファイル名用)
const TARGET_OPENAI_LANG_NAME = 'Japanese'; // OpenAIプロンプト用の言語名
const OPENAI_MODEL = 'gpt-4o-mini';          // 使用するOpenAIモデル
const MINECRAFT_VERSION = '1.20.1';        // pack.mcmeta生成用
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 同時に実行するWorkerの最大数 (CPUコア数をデフォルトに)
const MAX_CONCURRENT_WORKERS = parseInt(process.env.MAX_WORKERS || os.cpus().length, 10);
// 1バッチあたりの最大テキスト数（応答が途切れないように調整する）
const MAX_TEXTS_PER_BATCH = 100; // 例: 100件ずつAPIに送る
// 同時に実行するファイル書き込みの最大数
const MAX_CONCURRENT_WRITES = 15;
// 同時に実行するOpenAI API呼び出しの最大数 (現在は逐次実行だが、並列化する場合に使う)
const MAX_CONCURRENT_API_CALLS = 5;
// ---------------------

// Pack Format Calculation
const PACK_FORMAT_MAP = {
    "1.20.1": 15, "1.19.4": 13, "1.18.2": 9, "1.17.1": 7, "1.16.5": 6,
};
const PACK_FORMAT = PACK_FORMAT_MAP[MINECRAFT_VERSION] || 15;

// Filenames
const sourceJsonFilename = `en_us.json`;
const sourceLocalFilename = `en_us.local`;
const targetJsonFilename = `${TARGET_LANG_CODE_RP}.json`;
const targetLocalFilename = `${TARGET_LANG_CODE_RP}.local`;


// --- Helper Function for .local Parsing ---
function parseLocalContent(localContent) {
    const lines = localContent.split(/\r?\n/);
    const parsed = []; // { type: 'kv'|'comment'|'empty'|'other', key?: string, value?: string, originalLine: string, lineNumber: number }
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
            // Use item.translatedValue if it exists, otherwise original value
            const valueToUse = item.translatedValue !== undefined ? item.translatedValue : item.value;
            return `${item.key}=${valueToUse}`;
        } else {
            // Preserve comments, empty lines, other lines
            return item.originalLine;
        }
    }).join('\n'); // Use '\n' as the standard newline for output
}


// --- Main Execution Function ---
async function main() {
    // --- Dynamic Import for p-limit ---
    const pLimit = (await import('p-limit')).default;

    console.log("=============================================");
    console.log(" MOD Lang Translation (OpenAI Worker Threads)");
    console.log("=============================================");
    console.log(`Model: ${OPENAI_MODEL}, Target: ${TARGET_OPENAI_LANG_NAME}`);
    console.log(`Max Concurrent Workers: ${MAX_CONCURRENT_WORKERS}`);
    console.log(`Max Texts per API Batch: ${MAX_TEXTS_PER_BATCH}`);
    const startTime = Date.now();

    // --- Initial Checks & Setup ---
    if (!OPENAI_API_KEY) {
        console.error("[Main Error] OPENAI_API_KEY is not set in .env");
        process.exit(1);
    }
    if (!MODS_DIRECTORY) {
        console.error("[Main Error] SOURCE_DIRECTORY is not set in .env");
        process.exit(1);
    }

    let translator;
    try {
        translator = new OpenAITranslator(OPENAI_API_KEY, TARGET_OPENAI_LANG_NAME, OPENAI_MODEL);
        console.log("[Main] OpenAI Translator initialized.");
    } catch (initError) {
        console.error("[Main] Failed to initialize Translator:", initError.message);
        process.exit(1);
    }

    const absoluteOutputDir = path.resolve(OUTPUT_RESOURCE_PACK_DIR);
    try {
        await fs.mkdir(absoluteOutputDir, { recursive: true });
        const packMetaContent = { pack: { pack_format: PACK_FORMAT, description: `Mod Language Translations (${TARGET_LANG_CODE_RP}) using ${OPENAI_MODEL}` } };
        await fs.writeFile(path.join(absoluteOutputDir, 'pack.mcmeta'), JSON.stringify(packMetaContent, null, 2), 'utf8');
        console.log(`[Main] Output directory and pack.mcmeta prepared: ${absoluteOutputDir}`);
    } catch (dirError) {
        console.error(`[Main] Failed to prepare output directory (${absoluteOutputDir}):`, dirError);
        process.exit(1);
    }

    // --- Scan for JAR files ---
    let modFiles = [];
    const absoluteModsDir = path.resolve(MODS_DIRECTORY);
    try {
        const entries = await fs.readdir(absoluteModsDir, { withFileTypes: true });
        modFiles = entries
            .filter(dirent => dirent.isFile() && dirent.name.toLowerCase().endsWith('.jar'))
            .map(dirent => path.join(absoluteModsDir, dirent.name)); // Use absolute paths
        console.log(`[Main] Found ${modFiles.length} JAR files in ${absoluteModsDir}.`);
    } catch (readDirError) {
        console.error(`[Main] Failed to read mods directory (${absoluteModsDir}):`, readDirError);
        process.exit(1);
    }

    if (modFiles.length === 0) {
        console.log("[Main] No JAR files found. Exiting.");
        return;
    }

    // --- Process JARs using Workers ---
    const workerLimit = pLimit(MAX_CONCURRENT_WORKERS);
    const allFileInfos = []; // Collects { namespace, isJson, content, originalJar, originalPathInJar }
    console.log(`[Main] Starting worker tasks with concurrency limit: ${MAX_CONCURRENT_WORKERS}...`);

    const workerPromises = modFiles.map(jarPath => workerLimit(() => {
        return new Promise((resolve, reject) => {
            const worker = new Worker(path.resolve('./worker.js'), {
                workerData: { jarPath, sourceJsonFilename, sourceLocalFilename }
            });
            worker.on('message', (message) => {
                if (message.type === 'data') allFileInfos.push(...message.payload);
                else if (message.type === 'error') console.error(`[Worker Error][${path.basename(jarPath)}] ${message.error}`);
            });
            worker.on('error', reject);
            worker.on('exit', (code) => { if (code !== 0) console.warn(`Worker for ${path.basename(jarPath)} exited code ${code}`); resolve(); });
        });
    }));

    try {
        await Promise.all(workerPromises);
        console.log("[Main] All worker tasks completed processing JARs.");
    } catch (workerError) {
        console.error("[Main] A critical worker error occurred during JAR processing, stopping:", workerError);
        process.exit(1);
    }
    const processingEndTime = Date.now();
    console.log(`[Main] JAR processing took ${((processingEndTime - startTime) / 1000).toFixed(2)} seconds.`);
    console.log(`[Main] Collected ${allFileInfos.length} language file contents.`);


    // --- Step 1: Extract Individual Texts ---
    const individualTextsToTranslate = []; // { text: string, originalFileIndex: number, originalKey?: string, originalLineNumber?: number }
    const fileReconstructionData = new Map(); // Map<number, { type: 'json'|'local'|'error', data: any | Array<parsedLine>, namespace: string, originalPathInJar: string }>

    console.log("[Main] Extracting individual texts from file contents...");
    allFileInfos.forEach((fileInfo, fileIndex) => {
        try {
            if (!fileInfo || typeof fileInfo.content !== 'string') {
                 console.warn(`[Main] Skipping file index ${fileIndex} due to invalid fileInfo or missing content (from ${fileInfo?.originalJar || 'unknown JAR'}).`);
                 fileReconstructionData.set(fileIndex, { type: 'error', data: 'Invalid content received', namespace: fileInfo?.namespace || 'unknown', originalPathInJar: fileInfo?.originalPathInJar || 'unknown' });
                 return;
            }

            if (fileInfo.isJson) {
                const jsonData = JSON.parse(fileInfo.content);
                // Initialize reconstruction data with original parsed JSON
                const reconstructionInfo = { type: 'json', data: jsonData, namespace: fileInfo.namespace, originalPathInJar: fileInfo.originalPathInJar };
                Object.entries(jsonData).forEach(([key, value]) => {
                    if (typeof value === 'string' && value.trim() !== '') {
                        individualTextsToTranslate.push({
                            text: value,
                            originalFileIndex: fileIndex,
                            originalKey: key
                        });
                    }
                    // Note: reconstructionInfo.data already holds the original key-value
                });
                fileReconstructionData.set(fileIndex, reconstructionInfo);
            } else { // .local file
                const parsedLines = parseLocalContent(fileInfo.content);
                // Initialize reconstruction data with parsed lines
                const reconstructionInfo = { type: 'local', data: parsedLines, namespace: fileInfo.namespace, originalPathInJar: fileInfo.originalPathInJar };
                parsedLines.forEach((lineData) => { // No need for lineIndex here
                    if (lineData.type === 'kv' && typeof lineData.value === 'string' && lineData.value.trim() !== '') {
                        individualTextsToTranslate.push({
                            text: lineData.value,
                            originalFileIndex: fileIndex,
                            originalLineNumber: lineData.lineNumber // Use lineNumber to identify the line later
                        });
                    }
                    // Note: reconstructionInfo.data already holds the original line objects
                });
                 fileReconstructionData.set(fileIndex, reconstructionInfo);
            }
        } catch (parseError) {
            console.warn(`[Main] Failed to parse content from ${fileInfo.originalJar} - ${fileInfo.originalPathInJar}: ${parseError.message}. Skipping this file.`);
            fileReconstructionData.set(fileIndex, { type: 'error', data: fileInfo.content, namespace: fileInfo.namespace, originalPathInJar: fileInfo.originalPathInJar });
        }
    });
    console.log(`[Main] Extracted ${individualTextsToTranslate.length} individual text strings to translate.`);


    // --- Step 2: Batch Translate Individual Texts ---
    const translatedTextMap = new Map(); // Map<number, string> - Maps index in individualTextsToTranslate -> translated text
    if (individualTextsToTranslate.length > 0) {
        console.log("[Main] Preparing translation batches for individual texts...");
        const translationStartTime = Date.now();
        const batches = [];
        let currentBatchTexts = [];
        let currentBatchIndices = []; // Stores indices from individualTextsToTranslate

        individualTextsToTranslate.forEach((textInfo, index) => {
            currentBatchTexts.push(textInfo.text);
            currentBatchIndices.push(index); // Store index within individualTextsToTranslate

            if (currentBatchTexts.length >= MAX_TEXTS_PER_BATCH) {
                batches.push({ texts: currentBatchTexts, indices: currentBatchIndices });
                currentBatchTexts = [];
                currentBatchIndices = [];
            }
        });
        if (currentBatchTexts.length > 0) {
            batches.push({ texts: currentBatchTexts, indices: currentBatchIndices });
        }
        console.log(`[Main] Split into ${batches.length} translation batches (max ${MAX_TEXTS_PER_BATCH} texts per batch).`);

        // Process batches sequentially for simplicity, add p-limit here if needed
        const translationLimit = pLimit(MAX_CONCURRENT_API_CALLS);
        let translationFailed = false;
        let fatalErrorOccurred = false;

        const translationPromises = batches.map((batch, i) => translationLimit(async () => {
        // async function processBatchesSequentially() { // Alternative: Sequential Loop
        //    for (let i = 0; i < batches.length; i++) { // Alternative: Sequential Loop
                if (fatalErrorOccurred) return; // Skip if fatal error already happened
                // const batch = batches[i]; // Alternative: Sequential Loop
                console.log(`[Main] Translating batch ${i + 1}/${batches.length} (${batch.texts.length} texts)...`);
                try {
                    // Create prompt indices (0 to N-1) for the current batch
                    const promptIndices = batch.texts.map((_, idx) => idx);
                    // Call internal translation method
                    const internalResultMap = await translator.translateBatchInternal(batch.texts, promptIndices);

                    // Map results back using the batch's original index mapping
                    internalResultMap.forEach((translatedText, promptIndex) => {
                        const originalIndividualTextIndex = batch.indices[promptIndex]; // Get index in individualTextsToTranslate
                        translatedTextMap.set(originalIndividualTextIndex, translatedText); // Store translation mapped to its overall index
                    });

                } catch (translationError) {
                    console.error(`[Main] Batch ${i + 1} translation failed: ${translationError.message}`);
                    if (translationError.message.includes("Quota Exceeded") || translationError.message.includes("Authorization Failed")) {
                        fatalErrorOccurred = true; // Signal fatal error
                        throw translationError; // Re-throw to stop Promise.all (if using it)
                    }
                    // Non-fatal: Mark items in this batch as untranslated (they won't be in translatedTextMap)
                    console.warn(`[Main] Original text will be used for items in failed batch ${i + 1}.`);
                }
        //    } // Alternative: Sequential Loop
        // } // Alternative: Sequential Loop
        // await processBatchesSequentially(); // Alternative: Sequential Loop
         })); // End batches.map for Promise.all

        try {
             await Promise.all(translationPromises); // Wait for all concurrent batches
        } catch (batchError) {
             // Catch fatal errors re-thrown from the batch processing
             console.error("[Main] Fatal error during batch translation processing. Aborting.");
             translationFailed = true; // Ensure flag is set
             // process.exit(1); // Exit directly or let it flow down
        }


        if (translationFailed) {
            console.error("[Main] Translation process aborted due to fatal API error.");
            process.exit(1);
        }
        const translationEndTime = Date.now();
        console.log(`[Main] All batch translations finished in ${((translationEndTime - translationStartTime) / 1000).toFixed(2)}s.`);

    } else {
        console.log("[Main] No individual texts found to translate.");
    }


    // --- Step 3: Reconstruct Files and Write ---
    console.log("[Main] Reconstructing and writing translated files...");
    const writeStartTime = Date.now();
    const writeLimit = pLimit(MAX_CONCURRENT_WRITES);
    let writeCount = 0;
    const writePromises = [];

    // Map individual results back to their original files before writing
    individualTextsToTranslate.forEach((textInfo, index) => {
         const translatedText = translatedTextMap.get(index) ?? textInfo.text; // Get translated or fallback to original
         const fileIndex = textInfo.originalFileIndex;
         const reconData = fileReconstructionData.get(fileIndex);

         if (reconData && reconData.type !== 'error') { // Only process if reconstruction data exists and no prior error
             if (reconData.type === 'json') {
                 // Update the JSON data object stored in reconData
                 if (textInfo.originalKey && reconData.data.hasOwnProperty(textInfo.originalKey)) {
                     reconData.data[textInfo.originalKey] = translatedText;
                 }
             } else if (reconData.type === 'local') {
                 // Find the corresponding line in parsed data array and set translatedValue
                 const lineToUpdate = reconData.data.find(line => line.lineNumber === textInfo.originalLineNumber && line.type === 'kv');
                 if (lineToUpdate) {
                     lineToUpdate.translatedValue = translatedText; // Store translation temporarily
                 }
             }
         }
    });

    // Now, iterate through the updated reconstruction data to finalize content and create write promises
    for (const [fileIndex, reconData] of fileReconstructionData.entries()) {
        let finalContent = '';
        let outputPath = '';

        // Skip files that had errors during initial parsing or don't exist in map
        if (!reconData || reconData.type === 'error') {
            console.warn(`[Main] Skipping write for file originally at ${reconData?.originalPathInJar || `index ${fileIndex}`} due to initial processing error.`);
            continue;
        }

        try {
            // Determine output path
            const targetFilename = reconData.type === 'json' ? targetJsonFilename : targetLocalFilename;
            const relativeDir = path.dirname(reconData.originalPathInJar);
            const outputLangDir = path.join(OUTPUT_RESOURCE_PACK_DIR, relativeDir); // Use relativeDir directly
            outputPath = path.join(outputLangDir, targetFilename);

            // Reconstruct content based on type
            if (reconData.type === 'json') {
                // Use the data object which has been updated with translations
                finalContent = JSON.stringify(reconData.data, null, 2); // Pretty print
            } else if (reconData.type === 'local') {
                // Use the reconstructLocal helper with the updated data array
                 finalContent = reconstructLocal(reconData.data);
            } else {
                 console.warn(`[Main] Unknown reconstruction type for file index ${fileIndex}`);
                 continue; // Skip unknown types
            }

            // Create write promise and add to array
            writePromises.push(writeLimit(async () => {
                 try {
                     await fs.mkdir(path.dirname(outputPath), { recursive: true }); // Ensure directory exists
                     await fs.writeFile(outputPath, finalContent, 'utf8');
                     writeCount++;
                 } catch (writeError) {
                     console.error(`[Main] Failed to write reconstructed file ${outputPath}: ${writeError.message}`);
                 }
             }));

        } catch (reconError) {
             console.error(`[Main] Failed to reconstruct or prepare write for file index ${fileIndex} (original: ${reconData.originalPathInJar}): ${reconError.message}`);
        }
    } // End loop through fileReconstructionData


    // Wait for all file write operations to complete
    await Promise.all(writePromises);
    const writeEndTime = Date.now();
    console.log(`[Main] File writing complete (${writeCount} files written) in ${((writeEndTime - writeStartTime) / 1000).toFixed(2)}s.`);


    // --- Final Timing ---
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