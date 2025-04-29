// translateFiles.js
require('dotenv').config(); // .env ファイルから環境変数をロード

const fs = require('fs').promises;
const path = require('path');
const LangTranslate = require('./langTranslator'); // LangTranslate モジュールをインポート
const FileSearcher = require('./fileSearcher');   // FileSearcher モジュールをインポート (再帰対応版)

// --- 設定項目 ---
const SOURCE_DIRECTORY = process.env.SOURCE_DIRECTORY;
const OUTPUT_DIRECTORY = './dist';               // 翻訳結果を保存するルートフォルダ
const SOURCE_LANG_CODE = 'en_us';          // 翻訳元ファイルの言語コード (例: en_us)
const TARGET_LANG_CODE = 'ja_jp';          // 翻訳先ファイルの言語コード (例: ja_jp)
const TARGET_DEEPL_LANG = 'JA';            // DeepL APIに渡すターゲット言語 (例: 'JA', 'DE', 'FR')
const DEEPL_API_KEY = process.env.DEEPL_API_KEY; // 環境変数からAPIキーを取得
// ----------------

// 設定に基づいてファイル名を生成
const sourceJsonFile = `${SOURCE_LANG_CODE}.json`; // 例: en_us.json
const sourceLocalFile = `${SOURCE_LANG_CODE}.local`; // 例: en_us.local
const targetJsonFile = `${TARGET_LANG_CODE}.json`; // 例: ja_jp.json
const targetLocalFile = `${TARGET_LANG_CODE}.local`; // 例: ja_jp.local

// --- メイン実行関数 ---
async function runTranslationProcess() {
    console.log("===================================");
    console.log("   言語ファイル翻訳処理 開始 (再帰検索対応)");
    console.log("===================================");
    // 絶対パスで表示して分かりやすくする
    const absoluteSourceDir = path.resolve(SOURCE_DIRECTORY);
    const absoluteOutputDir = path.resolve(OUTPUT_DIRECTORY);
    console.log(`翻訳元フォルダ: ${absoluteSourceDir}`);
    console.log(`出力先フォルダ: ${absoluteOutputDir}`);
    console.log(`翻訳元言語コード: ${SOURCE_LANG_CODE}`);
    console.log(`翻訳先言語コード: ${TARGET_LANG_CODE} (DeepL: ${TARGET_DEEPL_LANG})`);

    // 1. APIキーの確認 (変更なし)
    if (!DEEPL_API_KEY) {
        console.error("[エラー] DeepL APIキーが環境変数 'DEEPL_API_KEY' に設定されていません。");
        process.exit(1);
    }

    // 2. LangTranslate インスタンスの初期化 (変更なし)
    let translator;
    try {
        translator = new LangTranslate(DEEPL_API_KEY, TARGET_DEEPL_LANG);
        console.log("[情報] DeepL Translator の準備完了。");
    } catch (initError) {
        console.error("[エラー] DeepL Translatorの初期化に失敗しました:", initError.message);
        process.exit(1);
    }

    // 3. 出力先ルートフォルダの確認と作成 (変更なし、ただし確認のみ)
    try {
        // ここではルートフォルダの存在を確認・作成するだけで良い
        // サブフォルダはファイル書き込み直前に作成する
        await fs.mkdir(absoluteOutputDir, { recursive: true });
        console.log(`[情報] 出力先ルートフォルダを確認/作成しました: ${absoluteOutputDir}`);
    } catch (dirError) {
        console.error(`[エラー] 出力先ルートフォルダの作成に失敗しました (${absoluteOutputDir}):`, dirError);
        process.exit(1);
    }

    // --- ★★★ コールバック関数の修正 ★★★ ---
    // ファイルパスから相対パスを計算し、出力パスを決定・フォルダ作成する共通ロジック
    const calculateAndPrepareOutputPath = async (sourceFilePath) => {
        // SOURCE_DIRECTORYからの相対パスを取得 (例: 'subdir/subsubdir/en_us.json')
        const relativePathWithFile = path.relative(absoluteSourceDir, sourceFilePath);
        // 相対パスからディレクトリ部分を取得 (例: 'subdir/subsubdir')
        const relativeDir = path.dirname(relativePathWithFile);
        // 出力先ディレクトリのフルパスを構築 (例: './dist/subdir/subsubdir')
        const outputDir = path.join(absoluteOutputDir, relativeDir);
        // 出力先ディレクトリが存在することを確認・作成
        await fs.mkdir(outputDir, { recursive: true });
        // 出力ディレクトリパスを返す
        return outputDir;
    };

    // JSONファイルが見つかった場合の処理 (修正)
    const handleJsonFile = async (filePath) => {
        const fileName = path.basename(filePath);
        console.log(`\n-> JSONファイル処理開始: ${filePath}`); // フルパス表示

        try {
            // 出力先ディレクトリパスを計算し、ディレクトリを作成
            const outputDir = await calculateAndPrepareOutputPath(filePath);
            // 最終的な出力ファイルパスを生成
            const outputFilePath = path.join(outputDir, targetJsonFile);
            console.log(`   翻訳を実行し、結果を ${outputFilePath} に保存します...`);

            const fileContent = await fs.readFile(filePath, 'utf8');
            const jsonData = JSON.parse(fileContent);
            const translatedData = await translator.execJSON(jsonData);
            const outputContent = JSON.stringify(translatedData, null, 2);
            await fs.writeFile(outputFilePath, outputContent, 'utf8');
            console.log(`   [成功] JSONファイルの翻訳結果を保存しました: ${outputFilePath}`);
        } catch (error) {
            console.error(`   [エラー] JSONファイル処理中にエラーが発生しました (${fileName}): ${error.message}`);
            if (error.message === "DeepL Quota Exceeded" || error.message.startsWith("DeepL Authorization Failed")) {
                throw error; // 致命的エラーは再throw
            }
        }
    };

    // .localファイルが見つかった場合の処理 (修正)
    const handleLocalFile = async (filePath) => {
        const fileName = path.basename(filePath);
        console.log(`\n-> .localファイル処理開始: ${filePath}`); // フルパス表示

        try {
            // 出力先ディレクトリパスを計算し、ディレクトリを作成
            const outputDir = await calculateAndPrepareOutputPath(filePath);
             // 最終的な出力ファイルパスを生成
            const outputFilePath = path.join(outputDir, targetLocalFile);
            console.log(`   翻訳を実行し、結果を ${outputFilePath} に保存します...`);

            const fileContent = await fs.readFile(filePath, 'utf8');
            const translatedContent = await translator.execLOCAL(fileContent);
            await fs.writeFile(outputFilePath, translatedContent, 'utf8');
            console.log(`   [成功] .localファイルの翻訳結果を保存しました: ${outputFilePath}`);
        } catch (error) {
            console.error(`   [エラー] .localファイル処理中にエラーが発生しました (${fileName}): ${error.message}`);
            if (error.message === "DeepL Quota Exceeded" || error.message.startsWith("DeepL Authorization Failed")) {
                throw error; // 致命的エラーは再throw
            }
        }
    };
    // --- ★★★ コールバック関数の修正ここまで ★★★ ---

    // 5. FileSearcher を実行して処理を開始 (変更なし)
    try {
        console.log("\n[情報] 指定フォルダ内のファイル検索を開始します (サブフォルダ含む)...");
        await FileSearcher.search(
            absoluteSourceDir, // 検索開始パスは絶対パスで渡すのが確実
            sourceJsonFile,
            sourceLocalFile,
            handleJsonFile,
            handleLocalFile
        );
        console.log("\n===================================");
        console.log("   言語ファイル翻訳処理 正常終了");
        console.log("===================================");
    } catch (error) {
        console.error("\n===================================");
        console.error("   言語ファイル翻訳処理 異常終了");
        console.error("===================================");
        console.error("[致命的エラー]:", error.message);
        process.exit(1);
    }
}

// --- スクリプトの実行 ---
runTranslationProcess();