// worker.js
const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');
const path = require('path');

// workerDataから必要な情報を受け取る
const {
    jarPath,
    sourceJsonFilename, // 例: 'en_us.json'
    sourceLocalFilename // 例: 'en_us.local'
} = workerData;

// 言語ファイルを見つけるための正規表現
// assets/<namespace>/lang/<en_us.(json|local)>
// namespace と ファイル名(拡張子含む) をキャプチャする
const langFileRegex = /^assets\/([^/]+)\/lang\/(en_us\.(?:json|local))$/i;

async function processJar() {
    const results = []; // このJARから見つかったファイル情報を格納する配列
    const jarName = path.basename(jarPath);
    // console.log(`[Worker ${process.pid}] Processing: ${jarName}`); // デバッグ用ログ

    try {
        // AdmZipを使ってJARファイルを開く
        const zip = new AdmZip(jarPath);
        const zipEntries = zip.getEntries(); // JAR内の全エントリを取得

        // 各エントリをチェック
        for (const entry of zipEntries) {
            // ディレクトリエントリは無視
            if (entry.isDirectory) {
                continue;
            }

            // パス区切り文字を '/' に正規化して正規表現でマッチング
            const entryPath = entry.entryName.replace(/\\/g, '/');
            const match = entryPath.match(langFileRegex);

            // 正規表現にマッチした場合 (言語ファイルが見つかった場合)
            if (match) {
                const namespace = match[1];        // キャプチャグループ1: namespace (modid)
                const sourceFilename = match[2]; // キャプチャグループ2: 'en_us.json' or 'en_us.local'
                const isJson = sourceFilename.toLowerCase().endsWith('.json');

                // console.log(`[Worker ${process.pid}] Found: ${entryPath}`); // デバッグ用ログ

                try {
                    // ファイル内容をUTF-8文字列として読み込む
                    const content = entry.getData().toString('utf8');

                    // メインスレッドに送信するための情報をまとめる
                    results.push({
                        namespace: namespace,
                        sourceFilename: sourceFilename, // 元のファイル名
                        isJson: isJson,                 // JSONファイルかどうかのフラグ
                        content: content,               // ファイルの内容
                        originalJar: jarName,           // どのJARファイルから来たか (ログ用)
                        originalPathInJar: entryPath,   // JAR内の元のパス (出力パス生成用)
                    });
                } catch (readError) {
                    // エントリの読み込みエラー
                     parentPort.postMessage({
                         type: 'error',
                         error: `Error reading entry ${entryPath} in ${jarName}: ${readError.message}`
                     });
                }
            }
        } // エントリのループ終了

        // このJARで見つかった全てのファイル情報をメインスレッドに送信
        if (results.length > 0) {
             parentPort.postMessage({ type: 'data', payload: results });
        }

    } catch (zipError) {
        // JARファイル自体の読み込みエラー
         parentPort.postMessage({ type: 'error', error: `Error processing JAR ${jarName}: ${zipError.message}` });
    } finally {
        // このWorkerの処理が完了したことをメインスレッドに通知
        parentPort.postMessage({ type: 'done' });
    }
}

// Workerが開始されたらすぐに処理を開始
processJar();