// fileSearcher.js
const fs = require('fs').promises;
const path = require('path');

class FileSearcher {
    /**
     * 指定されたフォルダ内を **再帰的に** 検索し、特定のJSONファイルと.localファイルを見つけてコールバックを実行します。
     *
     * @param {string} folderPath - 検索を開始するフォルダパス。
     * @param {string} jsonFileName - 検索するJSONファイルの正確な名前。
     * @param {string} localFileName - 検索する.localファイルの正確な名前。
     * @param {function(string): Promise<void> | void} jsonCallback - JSONファイルが見つかった場合に実行されるコールバック関数。
     * @param {function(string): Promise<void> | void} localCallback - .localファイルが見つかった場合に実行されるコールバック関数。
     * @returns {Promise<void>} 全ての検索処理が完了したときに解決されるPromise。
     * @throws {Error} 最初のfolderPathが存在しない、フォルダでない、またはコールバックが関数でない場合にエラーをスローします。
     */
    static async search(folderPath, jsonFileName, localFileName, jsonCallback, localCallback) {
        // --- 引数の検証 (初回呼び出し時のみ厳密にチェック) ---
        if (typeof folderPath !== 'string' || !folderPath) {
            throw new Error('引数エラー: folderPathは空でない文字列である必要があります。');
        }
        if (typeof jsonFileName !== 'string') {
            throw new Error('引数エラー: jsonFileNameは文字列である必要があります。');
        }
        if (typeof localFileName !== 'string') {
            throw new Error('引数エラー: localFileNameは文字列である必要があります。');
        }
        if (typeof jsonCallback !== 'function') {
            throw new Error('引数エラー: jsonCallbackは関数である必要があります。');
        }
        if (typeof localCallback !== 'function') {
            throw new Error('引数エラー: localCallbackは関数である必要があります。');
        }

        console.log(`[FileSearcher] ルートフォルダ検索を開始します: ${folderPath}`);

        // 再帰処理のための内部ヘルパー関数
        async function _recursiveSearch(currentPath) {
            console.log(`[FileSearcher] -> 検索中: ${currentPath}`);
            let entries;
            try {
                // 現在のパスの情報を取得（フォルダかどうかの確認）
                const stats = await fs.stat(currentPath);
                if (!stats.isDirectory()) {
                    // 万が一ファイルパスが渡された場合は何もしない
                    console.warn(`[FileSearcher] スキップ（フォルダではありません）: ${currentPath}`);
                    return;
                }
                // ディレクトリの内容を読み取る
                entries = await fs.readdir(currentPath, { withFileTypes: true });
            } catch (error) {
                // ディレクトリの読み取りエラー（例: アクセス権限なし）
                console.error(`[FileSearcher] エラー: ディレクトリを読み取れませんでした (${currentPath}): ${error.message}。このディレクトリをスキップします。`);
                return; // このディレクトリの処理を中断し、他の検索は続行
            }

            // ディレクトリ内の各エントリを処理
            for (const dirent of entries) {
                const entryPath = path.join(currentPath, dirent.name);

                if (dirent.isFile()) {
                    // --- ファイルの場合: ファイル名チェックとコールバック実行 ---
                    const currentFileName = dirent.name;
                    if (currentFileName === jsonFileName) {
                        console.log(`[FileSearcher]   JSONファイルを発見: ${entryPath}`);
                        try {
                            await jsonCallback(entryPath); // コールバック実行
                            console.log(`[FileSearcher]   jsonCallbackを実行しました: ${currentFileName}`);
                        } catch (callbackError) {
                            console.error(`[FileSearcher]   jsonCallbackの実行中にエラー (${entryPath}):`, callbackError);
                            // コールバックのエラーで全体を止めたくない場合はここでは throw しない
                        }
                    } else if (currentFileName === localFileName) {
                        console.log(`[FileSearcher]   .localファイルを発見: ${entryPath}`);
                        try {
                            await localCallback(entryPath); // コールバック実行
                            console.log(`[FileSearcher]   localCallbackを実行しました: ${currentFileName}`);
                        } catch (callbackError) {
                            console.error(`[FileSearcher]   localCallbackの実行中にエラー (${entryPath}):`, callbackError);
                        }
                    }
                } else if (dirent.isDirectory()) {
                    // --- フォルダの場合: 再帰的に探索 ---
                    // console.log(`[FileSearcher] -> サブフォルダに入ります: ${entryPath}`); // 詳細ログが必要な場合
                    await _recursiveSearch(entryPath); // ヘルパー関数を再帰呼び出し
                }
                // dirent.isSymbolicLink() など、他のタイプを扱うことも可能
            }
             // console.log(`[FileSearcher] <- 検索完了: ${currentPath}`); // 詳細ログ
        } // _recursiveSearch 関数の終わり

        // --- 再帰検索の開始 ---
        try {
            // 最初に指定されたフォルダパスで再帰ヘルパーを開始
            await _recursiveSearch(folderPath);
            console.log(`[FileSearcher] 全ての再帰検索が完了しました (ルート: ${folderPath})。`);
        } catch (error) {
            // _recursiveSearch内で捕捉されなかった予期せぬエラー、またはアクセス権等の初期エラー
             console.error(`[FileSearcher] 検索処理中に予期せぬエラーが発生しました:`, error);
             // 必要に応じてエラーを再スロー
             throw error;
        }
    }
}

// CommonJS形式でクラスをエクスポート
module.exports = FileSearcher;