// worker.js
const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');
const path = require('path');

const { jarPath } = workerData;

// 通常の言語ファイル用正規表現 (変更なし)
const langFileRegex = /^assets\/([^/]+)\/lang\/(en_us\.(?:json|local))$/i;

// Patchouliブックファイル用正規表現 (修正)
// キャプチャグループ:
// 1: namespace (例: ad_astra)
// 2: book_id_folder (例: astrodux)
// 3: path_and_filename_under_en_us (例: entries/the_moon/space_station.json または category.json)
const patchouliFileRegex = /^assets\/([^/]+)\/patchouli_books\/([^/]+)\/en_us\/(.+)$/i;
// 注意: Patchouliのファイルは .json のみと仮定。必要なら (.+\.(?:json|txt)) などに拡張。


async function processJar() {
    const results = [];
    const jarName = path.basename(jarPath);

    try {
        const zip = new AdmZip(jarPath);
        const zipEntries = zip.getEntries();

        for (const entry of zipEntries) {
            if (entry.isDirectory) {
                continue;
            }

            const entryPath = entry.entryName.replace(/\\/g, '/');
            let match;

            match = entryPath.match(patchouliFileRegex);
            if (match && entryPath.toLowerCase().endsWith('.json')) { // Ensure it's a JSON file
                const namespace = match[1];
                const bookIdFolder = match[2];
                const pathUnderEnUs = match[3]; // これが 'entries/the_moon/space_station.json' などになる

                try {
                    const content = entry.getData().toString('utf8');
                    results.push({
                        fileType: 'patchouli_book',
                        namespace: namespace,
                        bookIdFolder: bookIdFolder,         // ★変更: ブックIDフォルダ名
                        pathAndFilenameUnderSourceLang: pathUnderEnUs, // ★変更: en_us以下のパス+ファイル名
                        content: content,
                        originalJar: jarName,
                        originalPathInJar: entryPath,
                        isJson: true
                    });
                } catch (readError) {
                     parentPort.postMessage({ type: 'error', error: `Error reading Patchouli entry ${entryPath} in ${jarName}: ${readError.message}` });
                }
            } else {
                match = entryPath.match(langFileRegex);
                if (match) {
                    const namespace = match[1];
                    const sourceFilename = match[2];
                    const isJson = sourceFilename.toLowerCase().endsWith('.json');

                    try {
                        const content = entry.getData().toString('utf8');
                        results.push({
                            fileType: 'lang_file',
                            namespace: namespace,
                            sourceFilename: sourceFilename,
                            isJson: isJson,
                            content: content,
                            originalJar: jarName,
                            originalPathInJar: entryPath,
                        });
                    } catch (readError) {
                         parentPort.postMessage({ type: 'error', error: `Error reading lang entry ${entryPath} in ${jarName}: ${readError.message}` });
                    }
                }
            }
        }
        if (results.length > 0) {
             parentPort.postMessage({ type: 'data', payload: results });
        }

    } catch (zipError) {
         parentPort.postMessage({ type: 'error', error: `Error processing JAR ${jarName}: ${zipError.message}` });
    } finally {
        parentPort.postMessage({ type: 'done' });
    }
}

processJar();